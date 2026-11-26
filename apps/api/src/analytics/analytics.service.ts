import {
  BadRequestException,
  Injectable,
  NotFoundException,
  PayloadTooLargeException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventStatus, NotificationConsentAction, RsvpStatus } from '../../generated/prisma/client';
import type { AuthPrincipal } from '../auth/auth.types';
import type { Environment } from '../config/environment';
import { PrismaService } from '../database/prisma.service';
import { EventResponseDto } from '../events/event-response.dto';
import { AnalyticsCacheService } from './analytics-cache.service';
import { csvRow, safeCsvFilename } from './csv';
import { rankRecommendations } from './recommendation-ranking';
import type { AnalyticsQueryDto } from './dto/analytics-query.dto';
import type { RecommendationPreferenceDto } from './dto/recommendation-preference.dto';

const MAX_RANGE_DAYS = 90;
const MAX_BUCKETS = 100;
const MAX_EXPORT_ROWS = 2_000;

interface Range {
  from: Date;
  to: Date;
  bucket: 'day' | 'week';
}

interface TrendRow {
  bucket: Date;
  total: number;
  going: number;
  waitlisted: number;
  cancelled: number;
  checkedIn: number;
}

export interface EventAnalytics {
  eventId: string;
  period: { from: string; to: string; bucket: 'day' | 'week' };
  rsvps: {
    going: number | null;
    waitlisted: number | null;
    cancelled: number | null;
    checkedIn: number | null;
  };
  noShowRate: number | null;
  repeatAttendeeRate: number | null;
  rsvpsOverTime: Array<{
    bucket: string;
    total: number | null;
    going: number | null;
    waitlisted: number | null;
    cancelled: number | null;
    checkedIn: number | null;
  }>;
  checkInsByTime: Array<{ bucket: string; count: number }>;
  peakSignupHours: Array<{ hour: number; signups: number }>;
}

export interface ClubAnalytics {
  clubId: string;
  period: { from: string; to: string; bucket: 'day' | 'week' };
  rsvps: EventAnalytics['rsvps'];
  noShowRate: number | null;
  repeatAttendeeRate: number | null;
  rsvpsOverTime: EventAnalytics['rsvpsOverTime'];
  checkInsByTime: EventAnalytics['checkInsByTime'];
  peakSignupHours: EventAnalytics['peakSignupHours'];
  followerGrowth: Array<{ bucket: string; count: number }>;
  memberGrowth: Array<{ bucket: string; count: number }>;
}

interface Recommendation {
  event: Pick<EventResponseDto, 'id' | 'title' | 'slug' | 'club' | 'category'> & {
    startAt: string;
    endAt: string;
  };
  reason: string;
}

export interface RecommendationResponse {
  data: Recommendation[];
  personalized: boolean;
}

interface CsvExport {
  filename: string;
  rowCount: number;
  chunks: AsyncGenerator<string>;
}

interface AnalyticsRaw {
  going: number;
  waitlisted: number;
  cancelled: number;
  checkedIn: number;
  noShows: number;
  denominator: number;
}

interface RecommendationCandidate {
  id: string;
  title: string;
  slug: string;
  startAt: Date;
  endAt: Date;
  clubId: string;
  clubName: string;
  clubSlug: string;
  categoryId: string;
  categoryName: string;
  categorySlug: string;
  tags: string[];
  popularity: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNumberOrNull(value: unknown): value is number | null {
  return value === null || (typeof value === 'number' && Number.isFinite(value));
}

function isPeriod(value: unknown): value is EventAnalytics['period'] {
  return (
    isRecord(value) &&
    typeof value.from === 'string' &&
    typeof value.to === 'string' &&
    (value.bucket === 'day' || value.bucket === 'week')
  );
}

function isRsvpCounts(value: unknown): value is EventAnalytics['rsvps'] {
  return (
    isRecord(value) &&
    isNumberOrNull(value.going) &&
    isNumberOrNull(value.waitlisted) &&
    isNumberOrNull(value.cancelled) &&
    isNumberOrNull(value.checkedIn)
  );
}

function isTrend(value: unknown): value is EventAnalytics['rsvpsOverTime'][number] {
  return (
    isRecord(value) &&
    typeof value.bucket === 'string' &&
    isNumberOrNull(value.total) &&
    isNumberOrNull(value.going) &&
    isNumberOrNull(value.waitlisted) &&
    isNumberOrNull(value.cancelled) &&
    isNumberOrNull(value.checkedIn)
  );
}

function isBucketCount(value: unknown): value is { bucket: string; count: number } {
  return (
    isRecord(value) &&
    typeof value.bucket === 'string' &&
    typeof value.count === 'number' &&
    Number.isFinite(value.count)
  );
}

function isSignupHour(value: unknown): value is { hour: number; signups: number } {
  return (
    isRecord(value) &&
    typeof value.hour === 'number' &&
    Number.isInteger(value.hour) &&
    value.hour >= 0 &&
    value.hour <= 23 &&
    typeof value.signups === 'number' &&
    Number.isFinite(value.signups)
  );
}

function isRecommendation(value: unknown): value is Recommendation {
  if (!isRecord(value) || typeof value.reason !== 'string' || !isRecord(value.event)) return false;
  const event = value.event;
  if (!isRecord(event.club) || !isRecord(event.category)) return false;
  return (
    typeof event.id === 'string' &&
    typeof event.title === 'string' &&
    typeof event.slug === 'string' &&
    typeof event.startAt === 'string' &&
    Number.isFinite(Date.parse(event.startAt)) &&
    typeof event.endAt === 'string' &&
    Number.isFinite(Date.parse(event.endAt)) &&
    typeof event.club.name === 'string' &&
    typeof event.club.slug === 'string' &&
    typeof event.category.name === 'string' &&
    typeof event.category.slug === 'string'
  );
}

function decodeEventAnalytics(value: unknown): EventAnalytics | null {
  if (
    !isRecord(value) ||
    typeof value.eventId !== 'string' ||
    !isPeriod(value.period) ||
    !isRsvpCounts(value.rsvps) ||
    !isNumberOrNull(value.noShowRate) ||
    !isNumberOrNull(value.repeatAttendeeRate) ||
    !Array.isArray(value.rsvpsOverTime) ||
    !value.rsvpsOverTime.every(isTrend) ||
    !Array.isArray(value.checkInsByTime) ||
    !value.checkInsByTime.every(isBucketCount) ||
    !Array.isArray(value.peakSignupHours) ||
    !value.peakSignupHours.every(isSignupHour)
  ) {
    return null;
  }
  return {
    eventId: value.eventId,
    period: value.period,
    rsvps: value.rsvps,
    noShowRate: value.noShowRate,
    repeatAttendeeRate: value.repeatAttendeeRate,
    rsvpsOverTime: value.rsvpsOverTime,
    checkInsByTime: value.checkInsByTime,
    peakSignupHours: value.peakSignupHours,
  };
}

function decodeClubAnalytics(value: unknown): ClubAnalytics | null {
  if (
    !isRecord(value) ||
    typeof value.clubId !== 'string' ||
    !isPeriod(value.period) ||
    !isRsvpCounts(value.rsvps) ||
    !isNumberOrNull(value.noShowRate) ||
    !isNumberOrNull(value.repeatAttendeeRate) ||
    !Array.isArray(value.rsvpsOverTime) ||
    !value.rsvpsOverTime.every(isTrend) ||
    !Array.isArray(value.checkInsByTime) ||
    !value.checkInsByTime.every(isBucketCount) ||
    !Array.isArray(value.peakSignupHours) ||
    !value.peakSignupHours.every(isSignupHour) ||
    !Array.isArray(value.followerGrowth) ||
    !value.followerGrowth.every(isBucketCount) ||
    !Array.isArray(value.memberGrowth) ||
    !value.memberGrowth.every(isBucketCount)
  ) {
    return null;
  }
  return {
    clubId: value.clubId,
    period: value.period,
    rsvps: value.rsvps,
    noShowRate: value.noShowRate,
    repeatAttendeeRate: value.repeatAttendeeRate,
    rsvpsOverTime: value.rsvpsOverTime,
    checkInsByTime: value.checkInsByTime,
    peakSignupHours: value.peakSignupHours,
    followerGrowth: value.followerGrowth,
    memberGrowth: value.memberGrowth,
  };
}

function decodeRecommendations(value: unknown): RecommendationResponse | null {
  if (
    !isRecord(value) ||
    typeof value.personalized !== 'boolean' ||
    !Array.isArray(value.data) ||
    !value.data.every(isRecommendation)
  ) {
    return null;
  }
  return {
    personalized: value.personalized,
    data: value.data,
  };
}

function suppress(value: number, minimum: number): number | null {
  return value < minimum ? null : value;
}

function roundedPercent(numerator: number, denominator: number, minimum: number): number | null {
  if (numerator < minimum || denominator - numerator < minimum || denominator < minimum) {
    return null;
  }
  return Math.round((numerator / denominator) * 10_000) / 100;
}

function trendBucket(row: TrendRow, minimum: number) {
  return {
    bucket: row.bucket.toISOString(),
    total: suppress(row.total, minimum),
    going: suppress(row.going, minimum),
    waitlisted: suppress(row.waitlisted, minimum),
    cancelled: suppress(row.cancelled, minimum),
    checkedIn: suppress(row.checkedIn, minimum),
  };
}

function parseRange(query: AnalyticsQueryDto): Range {
  const to = query.to ? new Date(query.to) : new Date();
  const from = query.from
    ? new Date(query.from)
    : new Date(to.getTime() - 30 * 24 * 60 * 60 * 1_000);
  if (from >= to || to.getTime() - from.getTime() > MAX_RANGE_DAYS * 24 * 60 * 60 * 1_000) {
    throw new BadRequestException('The analytics date range is invalid or exceeds 90 days.');
  }
  const bucket = query.bucket ?? 'day';
  const approximateBuckets = Math.ceil(
    (to.getTime() - from.getTime()) / (bucket === 'day' ? 86_400_000 : 604_800_000),
  );
  if (approximateBuckets > MAX_BUCKETS) {
    throw new BadRequestException('The analytics range exceeds the maximum bucket count.');
  }
  return { from, to, bucket };
}

@Injectable()
export class AnalyticsService {
  private readonly minimumGroupSize: number;
  private readonly minimumRecommendationSupport: number;
  private readonly campusTimeZone: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<Environment, true>,
    private readonly cache: AnalyticsCacheService,
  ) {
    this.minimumGroupSize = config.get('ANALYTICS_MIN_GROUP_SIZE', { infer: true });
    this.minimumRecommendationSupport = config.get('RECOMMENDATIONS_MIN_SUPPORT', { infer: true });
    this.campusTimeZone = config.get('CAMPUS_TIME_ZONE', { infer: true });
  }

  async getEventAnalytics(
    actor: AuthPrincipal,
    eventId: string,
    query: AnalyticsQueryDto,
  ): Promise<EventAnalytics> {
    const event = await this.authorizeEvent(actor, eventId);
    const range = parseRange(query);
    const key = `analytics:event:${event.clubId}:${eventId}:${range.from.toISOString()}:${range.to.toISOString()}:${range.bucket}`;
    return this.cache.getOrCompute(
      key,
      [`analytics:event:index:${eventId}`],
      decodeEventAnalytics,
      () => this.queryEventAnalytics(eventId, range),
    );
  }

  async getClubAnalytics(
    actor: AuthPrincipal,
    clubId: string,
    query: AnalyticsQueryDto,
  ): Promise<ClubAnalytics> {
    await this.authorizeClub(actor, clubId);
    const range = parseRange(query);
    const key = `analytics:club:${clubId}:${range.from.toISOString()}:${range.to.toISOString()}:${range.bucket}`;
    return this.cache.getOrCompute(
      key,
      [`analytics:club:index:${clubId}`],
      decodeClubAnalytics,
      () => this.queryClubAnalytics(clubId, range),
    );
  }

  async exportAttendees(actor: AuthPrincipal, eventId: string): Promise<CsvExport> {
    const event = await this.authorizeEvent(actor, eventId);
    const rowCount = await this.prisma.rsvp.count({ where: { eventId } });
    if (rowCount > MAX_EXPORT_ROWS) {
      throw new PayloadTooLargeException('The attendee export exceeds the 2,000-row limit.');
    }
    const attendees = await this.prisma.rsvp.findMany({
      where: { eventId },
      orderBy: [{ createdAt: 'asc' }, { userId: 'asc' }],
      take: MAX_EXPORT_ROWS,
      select: {
        status: true,
        checkedInAt: true,
        user: { select: { firstName: true, lastName: true } },
      },
    });
    await this.prisma.auditLog.create({
      data: {
        actorId: actor.id,
        action: 'EVENT_ATTENDEES_EXPORTED',
        entityType: 'Event',
        entityId: eventId,
        metadata: { rowCount: attendees.length, exportedAt: new Date().toISOString() },
      },
    });
    const header = '\uFEFF' + csvRow(['Display name', 'Status', 'Check-in time']);
    const chunks = async function* (): AsyncGenerator<string> {
      yield header;
      for (const attendee of attendees) {
        yield csvRow([
          [attendee.user.firstName, attendee.user.lastName]
            .filter((part) => part.length > 0)
            .join(' '),
          attendee.status,
          attendee.checkedInAt?.toISOString() ?? '',
        ]);
      }
    };
    return {
      filename: safeCsvFilename(event.slug),
      rowCount,
      chunks: chunks(),
    };
  }

  async getRecommendationPreference(userId: string): Promise<{ personalized: boolean }> {
    const preference = await this.prisma.recommendationPreference.findUnique({
      where: { userId },
      select: { personalized: true },
    });
    return { personalized: preference?.personalized ?? true };
  }

  async updateRecommendationPreference(
    actor: AuthPrincipal,
    dto: RecommendationPreferenceDto,
  ): Promise<{ personalized: boolean }> {
    if (actor.role !== 'STUDENT') throw new NotFoundException('Recommendation settings not found.');
    await this.prisma.$transaction(async (tx) => {
      await tx.recommendationPreference.upsert({
        where: { userId: actor.id },
        create: { userId: actor.id, personalized: dto.personalized },
        update: { personalized: dto.personalized },
      });
      await tx.recommendationConsent.create({
        data: {
          userId: actor.id,
          action: dto.personalized
            ? NotificationConsentAction.GRANTED
            : NotificationConsentAction.OPTED_OUT,
          source: 'settings',
        },
      });
      await tx.auditLog.create({
        data: {
          actorId: actor.id,
          action: 'RECOMMENDATION_PREFERENCE_UPDATED',
          entityType: 'User',
          entityId: actor.id,
          metadata: { personalized: dto.personalized },
        },
      });
    });
    await this.cache.invalidateRecommendations(actor.id);
    return { personalized: dto.personalized };
  }

  async followClub(actor: AuthPrincipal, clubId: string): Promise<{ followed: true }> {
    if (actor.role !== 'STUDENT') throw new NotFoundException('Club not found.');
    await this.prisma.$transaction(async (tx) => {
      const club = await tx.club.findFirst({
        where: { id: clubId, deletedAt: null },
        select: { id: true },
      });
      if (!club) throw new NotFoundException('Club not found.');
      await tx.clubFollow.upsert({
        where: { userId_clubId: { userId: actor.id, clubId } },
        create: { userId: actor.id, clubId },
        update: {},
      });
      await tx.auditLog.create({
        data: {
          actorId: actor.id,
          action: 'CLUB_FOLLOWED',
          entityType: 'Club',
          entityId: clubId,
        },
      });
    });
    await this.cache.invalidateClub(clubId, actor.id);
    return { followed: true };
  }

  async unfollowClub(actor: AuthPrincipal, clubId: string): Promise<{ followed: false }> {
    if (actor.role !== 'STUDENT') throw new NotFoundException('Club not found.');
    await this.prisma.$transaction(async (tx) => {
      const club = await tx.club.findFirst({
        where: { id: clubId, deletedAt: null },
        select: { id: true },
      });
      if (!club) throw new NotFoundException('Club not found.');
      await tx.clubFollow.deleteMany({ where: { userId: actor.id, clubId } });
      await tx.auditLog.create({
        data: {
          actorId: actor.id,
          action: 'CLUB_UNFOLLOWED',
          entityType: 'Club',
          entityId: clubId,
        },
      });
    });
    await this.cache.invalidateClub(clubId, actor.id);
    return { followed: false };
  }

  async getRecommendations(actor: AuthPrincipal): Promise<RecommendationResponse> {
    if (actor.role !== 'STUDENT') throw new NotFoundException('Recommendations not found.');
    const preference = await this.prisma.recommendationPreference.findUnique({
      where: { userId: actor.id },
      select: { personalized: true, updatedAt: true },
    });
    const version = preference?.updatedAt.toISOString() ?? 'default';
    const key = `recommendations:user:${actor.id}:${version}`;
    return this.cache.getOrCompute(
      key,
      [`recommendations:user:index:${actor.id}`],
      decodeRecommendations,
      () => this.buildRecommendations(actor.id, preference?.personalized ?? true),
    );
  }

  async deleteRecommendationData(actor: AuthPrincipal): Promise<{ deleted: true }> {
    if (actor.role !== 'STUDENT') throw new NotFoundException('Recommendations not found.');
    await this.cache.invalidateRecommendations(actor.id);
    await this.prisma.auditLog.create({
      data: {
        actorId: actor.id,
        action: 'RECOMMENDATION_DATA_DELETED',
        entityType: 'User',
        entityId: actor.id,
      },
    });
    return { deleted: true };
  }

  private async authorizeEvent(
    actor: AuthPrincipal,
    eventId: string,
  ): Promise<{ id: string; clubId: string; slug: string }> {
    if (actor.role !== 'ADMIN' && actor.role !== 'ORGANIZER') {
      throw new NotFoundException('Event not found.');
    }
    const event = await this.prisma.event.findFirst({
      where: {
        id: eventId,
        deletedAt: null,
        ...(actor.role === 'ADMIN'
          ? {}
          : {
              club: {
                is: {
                  deletedAt: null,
                  memberships: {
                    some: {
                      userId: actor.id,
                      status: 'ACTIVE',
                      user: { isActive: true, deletedAt: null },
                    },
                  },
                },
              },
            }),
      },
      select: { id: true, clubId: true, slug: true },
    });
    if (!event) throw new NotFoundException('Event not found.');
    return event;
  }

  private async authorizeClub(actor: AuthPrincipal, clubId: string): Promise<void> {
    if (actor.role !== 'ADMIN' && actor.role !== 'ORGANIZER') {
      throw new NotFoundException('Club not found.');
    }
    const club = await this.prisma.club.findFirst({
      where: {
        id: clubId,
        deletedAt: null,
        ...(actor.role === 'ADMIN'
          ? {}
          : {
              memberships: {
                some: {
                  userId: actor.id,
                  status: 'ACTIVE',
                  user: { isActive: true, deletedAt: null },
                },
              },
            }),
      },
      select: { id: true },
    });
    if (!club) throw new NotFoundException('Club not found.');
  }

  private async queryEventAnalytics(eventId: string, range: Range): Promise<EventAnalytics> {
    const minimum = this.minimumGroupSize;
    const [summaryRows, trendRows, checkinRows, hourRows, repeatRows] = await Promise.all([
      this.prisma.$queryRaw<AnalyticsRaw[]>`
        SELECT
          COUNT(*) FILTER (WHERE r.status::text = 'GOING')::int AS going,
          COUNT(*) FILTER (WHERE r.status::text = 'WAITLISTED')::int AS waitlisted,
          COUNT(*) FILTER (WHERE r.status::text = 'CANCELLED')::int AS cancelled,
          COUNT(*) FILTER (WHERE r.status::text = 'CHECKED_IN')::int AS "checkedIn",
          COUNT(*) FILTER (WHERE r.status::text = 'GOING' AND e.start_at < NOW())::int AS "noShows",
          COUNT(*) FILTER (
            WHERE r.status::text IN ('GOING', 'CHECKED_IN') AND e.start_at < NOW()
          )::int AS denominator
        FROM rsvps r
        JOIN events e ON e.id = r.event_id
        WHERE r.event_id = ${eventId}::uuid
          AND r.created_at >= ${range.from}
          AND r.created_at < ${range.to}
      `,
      this.prisma.$queryRaw<TrendRow[]>`
        SELECT date_trunc(${range.bucket}, r.created_at AT TIME ZONE ${this.campusTimeZone}) AS bucket,
          COUNT(*)::int AS total,
          COUNT(*) FILTER (WHERE r.status::text = 'GOING')::int AS going,
          COUNT(*) FILTER (WHERE r.status::text = 'WAITLISTED')::int AS waitlisted,
          COUNT(*) FILTER (WHERE r.status::text = 'CANCELLED')::int AS cancelled,
          COUNT(*) FILTER (WHERE r.status::text = 'CHECKED_IN')::int AS "checkedIn"
        FROM rsvps r
        WHERE r.event_id = ${eventId}::uuid
          AND r.created_at >= ${range.from} AND r.created_at < ${range.to}
        GROUP BY 1 ORDER BY 1
      `,
      this.prisma.$queryRaw<Array<{ bucket: Date; count: number }>>`
        SELECT date_trunc(${range.bucket}, ci.checked_in_at AT TIME ZONE ${this.campusTimeZone}) AS bucket,
          COUNT(*)::int AS count
        FROM check_ins ci
        JOIN tickets t ON t.id = ci.ticket_id
        JOIN rsvps r ON r.id = t.rsvp_id
        WHERE r.event_id = ${eventId}::uuid
          AND ci.checked_in_at >= ${range.from} AND ci.checked_in_at < ${range.to}
        GROUP BY 1 ORDER BY 1
      `,
      this.prisma.$queryRaw<Array<{ hour: number; signups: number }>>`
        SELECT EXTRACT(HOUR FROM r.created_at AT TIME ZONE ${this.campusTimeZone})::int AS hour,
          COUNT(*)::int AS signups
        FROM rsvps r
        WHERE r.event_id = ${eventId}::uuid
          AND r.created_at >= ${range.from} AND r.created_at < ${range.to}
        GROUP BY 1 ORDER BY signups DESC, hour ASC
      `,
      this.prisma.$queryRaw<Array<{ attendees: number; repeat: number }>>`
        WITH target_attendees AS (
          SELECT user_id FROM rsvps
          WHERE event_id = ${eventId}::uuid AND status::text = 'CHECKED_IN'
        ), attendee_counts AS (
          SELECT target.user_id, COUNT(DISTINCT r.event_id)::int AS events_attended
          FROM target_attendees target
          JOIN rsvps r ON r.user_id = target.user_id
          JOIN events e ON e.id = r.event_id
          WHERE e.club_id = (SELECT club_id FROM events WHERE id = ${eventId}::uuid)
            AND r.status::text = 'CHECKED_IN'
          GROUP BY target.user_id
        )
        SELECT COUNT(*)::int AS attendees,
          COUNT(*) FILTER (WHERE events_attended >= 2)::int AS repeat
        FROM attendee_counts
      `,
    ]);
    const summary = summaryRows[0] ?? {
      going: 0,
      waitlisted: 0,
      cancelled: 0,
      checkedIn: 0,
      noShows: 0,
      denominator: 0,
    };
    const repeat = repeatRows[0] ?? { attendees: 0, repeat: 0 };
    return {
      eventId,
      period: { from: range.from.toISOString(), to: range.to.toISOString(), bucket: range.bucket },
      rsvps: {
        going: suppress(summary.going, minimum),
        waitlisted: suppress(summary.waitlisted, minimum),
        cancelled: suppress(summary.cancelled, minimum),
        checkedIn: suppress(summary.checkedIn, minimum),
      },
      noShowRate: roundedPercent(summary.noShows, summary.denominator, minimum),
      repeatAttendeeRate: roundedPercent(repeat.repeat, repeat.attendees, minimum),
      rsvpsOverTime: trendRows
        .filter((row) => row.total >= minimum)
        .map((row) => trendBucket(row, minimum)),
      checkInsByTime: checkinRows
        .filter((row) => row.count >= minimum)
        .map((row) => ({ bucket: row.bucket.toISOString(), count: row.count })),
      peakSignupHours: hourRows.filter((row) => row.signups >= minimum).slice(0, 5),
    };
  }

  private async queryClubAnalytics(clubId: string, range: Range): Promise<ClubAnalytics> {
    const minimum = this.minimumGroupSize;
    const [summaryRows, trendRows, checkinRows, hourRows, followerRows, memberRows, repeatRows] =
      await Promise.all([
        this.prisma.$queryRaw<AnalyticsRaw[]>`
          SELECT
            COUNT(*) FILTER (WHERE r.status::text = 'GOING')::int AS going,
            COUNT(*) FILTER (WHERE r.status::text = 'WAITLISTED')::int AS waitlisted,
            COUNT(*) FILTER (WHERE r.status::text = 'CANCELLED')::int AS cancelled,
            COUNT(*) FILTER (WHERE r.status::text = 'CHECKED_IN')::int AS "checkedIn",
            COUNT(*) FILTER (WHERE r.status::text = 'GOING' AND e.start_at < NOW())::int AS "noShows",
            COUNT(*) FILTER (
              WHERE r.status::text IN ('GOING', 'CHECKED_IN') AND e.start_at < NOW()
            )::int AS denominator
          FROM rsvps r JOIN events e ON e.id = r.event_id
          WHERE e.club_id = ${clubId}::uuid
            AND r.created_at >= ${range.from} AND r.created_at < ${range.to}
        `,
        this.prisma.$queryRaw<TrendRow[]>`
          SELECT date_trunc(${range.bucket}, r.created_at AT TIME ZONE ${this.campusTimeZone}) AS bucket,
            COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE r.status::text = 'GOING')::int AS going,
            COUNT(*) FILTER (WHERE r.status::text = 'WAITLISTED')::int AS waitlisted,
            COUNT(*) FILTER (WHERE r.status::text = 'CANCELLED')::int AS cancelled,
            COUNT(*) FILTER (WHERE r.status::text = 'CHECKED_IN')::int AS "checkedIn"
          FROM rsvps r JOIN events e ON e.id = r.event_id
          WHERE e.club_id = ${clubId}::uuid
            AND r.created_at >= ${range.from} AND r.created_at < ${range.to}
          GROUP BY 1 ORDER BY 1
        `,
        this.prisma.$queryRaw<Array<{ bucket: Date; count: number }>>`
          SELECT date_trunc(${range.bucket}, ci.checked_in_at AT TIME ZONE ${this.campusTimeZone}) AS bucket,
            COUNT(*)::int AS count
          FROM check_ins ci
          JOIN tickets t ON t.id = ci.ticket_id
          JOIN rsvps r ON r.id = t.rsvp_id
          JOIN events e ON e.id = r.event_id
          WHERE e.club_id = ${clubId}::uuid
            AND ci.checked_in_at >= ${range.from} AND ci.checked_in_at < ${range.to}
          GROUP BY 1 ORDER BY 1
        `,
        this.prisma.$queryRaw<Array<{ hour: number; signups: number }>>`
          SELECT EXTRACT(HOUR FROM r.created_at AT TIME ZONE ${this.campusTimeZone})::int AS hour,
            COUNT(*)::int AS signups
          FROM rsvps r JOIN events e ON e.id = r.event_id
          WHERE e.club_id = ${clubId}::uuid
            AND r.created_at >= ${range.from} AND r.created_at < ${range.to}
          GROUP BY 1 ORDER BY signups DESC, hour ASC
        `,
        this.prisma.$queryRaw<Array<{ bucket: Date; count: number }>>`
          SELECT date_trunc(${range.bucket}, created_at AT TIME ZONE ${this.campusTimeZone}) AS bucket,
            COUNT(*)::int AS count FROM club_follows
          WHERE club_id = ${clubId}::uuid AND created_at >= ${range.from} AND created_at < ${range.to}
          GROUP BY 1 ORDER BY 1
        `,
        this.prisma.$queryRaw<Array<{ bucket: Date; count: number }>>`
          SELECT date_trunc(${range.bucket}, joined_at AT TIME ZONE ${this.campusTimeZone}) AS bucket,
            COUNT(*)::int AS count FROM club_memberships
          WHERE club_id = ${clubId}::uuid AND status::text = 'ACTIVE'
            AND joined_at >= ${range.from} AND joined_at < ${range.to}
          GROUP BY 1 ORDER BY 1
        `,
        this.prisma.$queryRaw<Array<{ attendees: number; repeat: number }>>`
          WITH attendee_counts AS (
            SELECT r.user_id, COUNT(DISTINCT r.event_id)::int AS events_attended
            FROM rsvps r JOIN events e ON e.id = r.event_id
            WHERE e.club_id = ${clubId}::uuid AND r.status::text = 'CHECKED_IN'
              AND r.created_at >= ${range.from} AND r.created_at < ${range.to}
            GROUP BY r.user_id
          )
          SELECT COUNT(*)::int AS attendees,
            COUNT(*) FILTER (WHERE events_attended >= 2)::int AS repeat
          FROM attendee_counts
        `,
      ]);
    const summary = summaryRows[0] ?? {
      going: 0,
      waitlisted: 0,
      cancelled: 0,
      checkedIn: 0,
      noShows: 0,
      denominator: 0,
    };
    const repeat = repeatRows[0] ?? { attendees: 0, repeat: 0 };
    return {
      clubId,
      period: { from: range.from.toISOString(), to: range.to.toISOString(), bucket: range.bucket },
      rsvps: {
        going: suppress(summary.going, minimum),
        waitlisted: suppress(summary.waitlisted, minimum),
        cancelled: suppress(summary.cancelled, minimum),
        checkedIn: suppress(summary.checkedIn, minimum),
      },
      noShowRate: roundedPercent(summary.noShows, summary.denominator, minimum),
      repeatAttendeeRate: roundedPercent(repeat.repeat, repeat.attendees, minimum),
      rsvpsOverTime: trendRows
        .filter((row) => row.total >= minimum)
        .map((row) => trendBucket(row, minimum)),
      checkInsByTime: checkinRows
        .filter((row) => row.count >= minimum)
        .map((row) => ({ bucket: row.bucket.toISOString(), count: row.count })),
      peakSignupHours: hourRows.filter((row) => row.signups >= minimum).slice(0, 5),
      followerGrowth: followerRows
        .filter((row) => row.count >= minimum)
        .map((row) => ({ bucket: row.bucket.toISOString(), count: row.count })),
      memberGrowth: memberRows
        .filter((row) => row.count >= minimum)
        .map((row) => ({ bucket: row.bucket.toISOString(), count: row.count })),
    };
  }

  private async buildRecommendations(
    userId: string,
    personalized: boolean,
  ): Promise<RecommendationResponse> {
    let attendedEvents: Array<{ id: string; title: string; categoryId: string; tags: string[] }> =
      [];
    let followedClubIds = new Set<string>();
    let collaborativeByEvent = new Map<string, number>();

    if (personalized) {
      const [history, followed, collaborative] = await Promise.all([
        this.prisma.rsvp.findMany({
          where: {
            userId,
            status: RsvpStatus.CHECKED_IN,
            event: { startAt: { lt: new Date() }, deletedAt: null },
          },
          orderBy: { event: { startAt: 'desc' } },
          take: 20,
          select: { event: { select: { id: true, title: true, categoryId: true, tags: true } } },
        }),
        this.prisma.clubFollow.findMany({ where: { userId }, select: { clubId: true } }),
        this.queryCollaborativeSupport(userId),
      ]);
      attendedEvents = history.map(({ event }) => event);
      followedClubIds = new Set(followed.map(({ clubId }) => clubId));
      collaborativeByEvent = new Map(
        collaborative.map(({ eventId, support }) => [eventId, support]),
      );
    }

    const candidates = await this.prisma.$queryRaw<RecommendationCandidate[]>`
      SELECT e.id, e.title, e.slug, e.start_at AS "startAt", e.end_at AS "endAt",
        e.club_id AS "clubId", c.name AS "clubName", e.category_id AS "categoryId",
        category.name AS "categoryName", c.slug AS "clubSlug",
        category.slug AS "categorySlug", e.tags,
        COUNT(r.id)::int AS popularity
      FROM events e
      JOIN clubs c ON c.id = e.club_id
      JOIN event_categories category ON category.id = e.category_id
      LEFT JOIN rsvps r ON r.event_id = e.id AND r.status::text IN ('GOING', 'CHECKED_IN')
      WHERE e.status = ${EventStatus.APPROVED}::event_status
        AND e.deleted_at IS NULL
        AND c.deleted_at IS NULL AND category.deleted_at IS NULL
        AND e.start_at > NOW()
        AND (
          e.is_public = TRUE
          OR EXISTS (
            SELECT 1 FROM club_memberships member
            WHERE member.club_id = e.club_id AND member.user_id = ${userId}::uuid
              AND member.status::text = 'ACTIVE'
          )
        )
        AND NOT EXISTS (
          SELECT 1 FROM rsvps own_r
            WHERE own_r.event_id = e.id AND own_r.user_id = ${userId}::uuid
              AND own_r.status::text IN ('GOING', 'WAITLISTED')
        )
        AND (
          e.capacity IS NULL
          OR (
              SELECT COUNT(*) FROM rsvps capacity_r
              WHERE capacity_r.event_id = e.id
                AND capacity_r.status::text IN ('GOING', 'CHECKED_IN')
          ) < e.capacity
          OR EXISTS (
              SELECT 1 FROM rsvps waitlist_r
              WHERE waitlist_r.event_id = e.id AND waitlist_r.status::text = 'WAITLISTED'
          )
        )
      GROUP BY e.id, c.name, c.slug, category.name, category.slug
      ORDER BY popularity DESC, e.start_at ASC
      LIMIT 200
    `;

    const scored = rankRecommendations(
      candidates,
      attendedEvents,
      followedClubIds,
      collaborativeByEvent,
      Date.now(),
    );
    const data: Recommendation[] = scored.slice(0, 20).map(({ candidate, reason }) => ({
      event: {
        id: candidate.id,
        title: candidate.title,
        slug: candidate.slug,
        startAt: candidate.startAt.toISOString(),
        endAt: candidate.endAt.toISOString(),
        club: { name: candidate.clubName, slug: candidate.clubSlug },
        category: { name: candidate.categoryName, slug: candidate.categorySlug },
      },
      reason,
    }));
    return { data, personalized };
  }

  private async queryCollaborativeSupport(
    userId: string,
  ): Promise<Array<{ eventId: string; support: number }>> {
    return this.prisma.$queryRaw<Array<{ eventId: string; support: number }>>`
      WITH attended AS (
        SELECT DISTINCT source.event_id
        FROM rsvps source
        JOIN events attended_event ON attended_event.id = source.event_id
        WHERE source.user_id = ${userId}::uuid
          AND source.status::text = 'CHECKED_IN'
          AND attended_event.start_at < NOW()
      )
      SELECT candidate.id AS "eventId", COUNT(DISTINCT other_rsvp.user_id)::int AS support
      FROM attended
      JOIN rsvps source_rsvp ON source_rsvp.event_id = attended.event_id
      JOIN rsvps other_rsvp ON other_rsvp.user_id = source_rsvp.user_id
      JOIN users support_user ON support_user.id = other_rsvp.user_id
      JOIN events candidate ON candidate.id = other_rsvp.event_id
      WHERE other_rsvp.user_id <> ${userId}::uuid
        AND support_user.role::text = 'STUDENT'
        AND support_user.is_active = TRUE AND support_user.deleted_at IS NULL
        AND other_rsvp.status::text IN ('GOING', 'CHECKED_IN')
        AND candidate.status = ${EventStatus.APPROVED}::event_status
        AND candidate.is_public = TRUE AND candidate.deleted_at IS NULL
        AND candidate.start_at > NOW()
        AND NOT EXISTS (
          SELECT 1 FROM rsvps own_r
          WHERE own_r.event_id = candidate.id AND own_r.user_id = ${userId}::uuid
            AND own_r.status::text IN ('GOING', 'WAITLISTED')
        )
      GROUP BY candidate.id
      HAVING COUNT(DISTINCT other_rsvp.user_id) >= ${this.minimumRecommendationSupport}
    `;
  }
}
