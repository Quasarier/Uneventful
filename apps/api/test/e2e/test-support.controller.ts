import {
  Controller,
  Delete,
  Headers,
  HttpStatus,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Body,
  Res,
  Header,
  OnModuleDestroy,
  BadRequestException,
} from '@nestjs/common';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { AuthService } from '../../src/auth/auth.service';
import { Public } from '../../src/auth/auth.decorators';
import { PrismaService } from '../../src/database/prisma.service';
import type { Response } from 'express';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { E2eImageUploadDto, E2eSessionDto } from './test-support.dto';
import { MAX_EVENT_IMAGE_SIZE } from '../../src/events/event-image.constants';

const REFRESH_COOKIE = '__Secure-uneventful_refresh';
const REFRESH_COOKIE_PATH = '/api/v1/auth';

interface Fixture {
  eventId: string;
  title: string;
  userIds: { first: string; second: string };
  organizerId: string;
  adminId: string;
  clubId: string;
  categoryId: string;
}

@Controller('__test/e2e')
export class E2eTestSupportController implements OnModuleDestroy {
  private readonly fixtures = new Map<string, Fixture>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly auth: AuthService,
  ) {}

  @Public()
  @Post('fixtures')
  @Header('Cache-Control', 'no-store')
  async createFixture(
    @Headers('x-uneventful-e2e-secret') secret: string | undefined,
  ): Promise<{ fixtureId: string; eventId: string; title: string }> {
    this.assertTestSecret(secret);
    const fixtureId = randomUUID();
    const title = `E2E capacity test ${fixtureId}`;
    const adminId = randomUUID();
    const organizerId = randomUUID();
    const firstId = randomUUID();
    const secondId = randomUUID();
    const clubId = randomUUID();
    const categoryId = randomUUID();
    const eventId = randomUUID();
    const slug = `e2e-${fixtureId}`;
    const now = new Date();
    const startAt = new Date(now.getTime() + 60 * 60 * 1_000);
    const endAt = new Date(startAt.getTime() + 60 * 60 * 1_000);

    await this.prisma.$transaction(async (transaction) => {
      await transaction.user.createMany({
        data: [
          this.newUser(adminId, fixtureId, 'admin', 'ADMIN'),
          this.newUser(organizerId, fixtureId, 'organizer', 'ORGANIZER'),
          this.newUser(firstId, fixtureId, 'first', 'STUDENT'),
          this.newUser(secondId, fixtureId, 'second', 'STUDENT'),
        ],
      });
      await transaction.club.create({
        data: {
          id: clubId,
          name: `E2E Club ${fixtureId}`,
          slug,
          createdById: organizerId,
        },
      });
      await transaction.clubMembership.create({
        data: {
          clubId,
          userId: organizerId,
          role: 'PRESIDENT',
          status: 'ACTIVE',
          joinedAt: now,
        },
      });
      await transaction.eventCategory.create({
        data: { id: categoryId, name: `E2E Category ${fixtureId}`, slug },
      });
      await transaction.event.create({
        data: {
          id: eventId,
          title,
          slug,
          description: 'An end-to-end capacity and waitlist test.',
          status: 'APPROVED',
          startAt,
          endAt,
          timeZone: 'UTC',
          capacity: 1,
          isPublic: true,
          clubId,
          categoryId,
          createdById: organizerId,
          approvedById: adminId,
          approvedAt: now,
        },
      });
    });

    this.fixtures.set(fixtureId, {
      eventId,
      title,
      userIds: { first: firstId, second: secondId },
      organizerId,
      adminId,
      clubId,
      categoryId,
    });
    return { fixtureId, eventId, title };
  }

  @Public()
  @Post('fixtures/:fixtureId/session')
  @Header('Cache-Control', 'no-store')
  async createSession(
    @Headers('x-uneventful-e2e-secret') secret: string | undefined,
    @Param('fixtureId', ParseUUIDPipe) fixtureId: string,
    @Body() body: E2eSessionDto,
    @Res() response: Response,
  ): Promise<void> {
    this.assertTestSecret(secret);
    const fixture = this.getFixture(fixtureId);
    const userId =
      body.user === 'organizer'
        ? fixture.organizerId
        : body.user === 'admin'
          ? fixture.adminId
          : fixture.userIds[body.user];
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    const session = await this.auth.completeGoogleLogin({
      googleSubject: user.googleSubject,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      avatarUrl: user.avatarUrl,
    });

    response
      .cookie(REFRESH_COOKIE, session.refreshToken, {
        httpOnly: true,
        secure: true,
        sameSite: 'lax',
        path: REFRESH_COOKIE_PATH,
        maxAge: this.auth.getRefreshCookieMaxAgeMs(),
      })
      .status(HttpStatus.NO_CONTENT)
      .send();
  }

  @Public()
  @Post('fixtures/:fixtureId/image')
  @Header('Cache-Control', 'no-store')
  async uploadImage(
    @Headers('x-uneventful-e2e-secret') secret: string | undefined,
    @Param('fixtureId', ParseUUIDPipe) fixtureId: string,
    @Body() body: E2eImageUploadDto,
    @Res() response: Response,
  ): Promise<void> {
    this.assertTestSecret(secret);
    const fixture = this.getFixture(fixtureId);
    const event = await this.prisma.event.findUnique({
      where: { id: fixture.eventId },
      select: {
        pendingImageKey: true,
        pendingImageExpiresAt: true,
        pendingImageOwnerId: true,
      },
    });
    if (
      !event?.pendingImageKey ||
      event.pendingImageOwnerId !== fixture.organizerId ||
      !event.pendingImageExpiresAt ||
      event.pendingImageExpiresAt <= new Date()
    ) {
      throw new NotFoundException();
    }

    const bytes = Buffer.from(body.imageBase64, 'base64');
    if (
      bytes.length < 1 ||
      bytes.length > MAX_EVENT_IMAGE_SIZE ||
      bytes.toString('base64') !== body.imageBase64
    ) {
      throw new BadRequestException('The E2E image fixture is invalid.');
    }

    const endpoint = process.env.OBJECT_STORAGE_ENDPOINT;
    const accessKey = process.env.AWS_ACCESS_KEY_ID;
    const secretKey = process.env.AWS_SECRET_ACCESS_KEY;
    if (!endpoint || !accessKey || !secretKey) {
      throw new Error('E2E object storage endpoint and credentials are required.');
    }
    const client = new S3Client({
      region: 'us-east-1',
      endpoint,
      forcePathStyle: true,
      credentials: { accessKeyId: accessKey, secretAccessKey: secretKey },
    });
    try {
      await client.send(
        new PutObjectCommand({
          Bucket: 'uneventful-e2e-assets',
          Key: event.pendingImageKey,
          Body: bytes,
          ContentLength: bytes.length,
          ContentType: 'image/png',
        }),
      );
    } finally {
      client.destroy();
    }

    response.status(HttpStatus.NO_CONTENT).send();
  }

  @Public()
  @Delete('fixtures/:fixtureId')
  @Header('Cache-Control', 'no-store')
  async deleteFixture(
    @Headers('x-uneventful-e2e-secret') secret: string | undefined,
    @Param('fixtureId', ParseUUIDPipe) fixtureId: string,
    @Res() response: Response,
  ): Promise<void> {
    this.assertTestSecret(secret);
    const fixture = this.getFixture(fixtureId);
    await this.cleanupFixture(fixture);
    this.fixtures.delete(fixtureId);
    response.status(HttpStatus.NO_CONTENT).send();
  }

  async cleanupAllFixtures(): Promise<void> {
    for (const fixture of this.fixtures.values()) {
      await this.cleanupFixture(fixture);
    }
    this.fixtures.clear();
  }

  onModuleDestroy(): Promise<void> {
    return this.cleanupAllFixtures();
  }

  private newUser(
    id: string,
    fixtureId: string,
    suffix: string,
    role: 'STUDENT' | 'ORGANIZER' | 'ADMIN',
  ) {
    return {
      id,
      googleSubject: `e2e-${fixtureId}-${suffix}`,
      email: `e2e-${fixtureId}-${suffix}@example.edu`,
      firstName: suffix,
      lastName: 'E2E',
      role,
    };
  }

  private async cleanupFixture(fixture: Fixture): Promise<void> {
    const userIds = [
      fixture.userIds.first,
      fixture.userIds.second,
      fixture.organizerId,
      fixture.adminId,
    ];
    await this.prisma.$transaction(async (transaction) => {
      const rsvps = await transaction.rsvp.findMany({
        where: { eventId: fixture.eventId },
        select: { id: true },
      });
      const rsvpIds = rsvps.map(({ id }) => id);
      await transaction.ticket.deleteMany({ where: { rsvpId: { in: rsvpIds } } });
      await transaction.rsvp.deleteMany({ where: { id: { in: rsvpIds } } });
      await transaction.rsvpPromotionOutbox.deleteMany({ where: { eventId: fixture.eventId } });
      await transaction.notification.deleteMany({ where: { eventId: fixture.eventId } });
      await transaction.refreshToken.deleteMany({ where: { userId: { in: userIds } } });
      await transaction.event.delete({ where: { id: fixture.eventId } });
      await transaction.clubMembership.deleteMany({ where: { clubId: fixture.clubId } });
      await transaction.club.delete({ where: { id: fixture.clubId } });
      await transaction.eventCategory.delete({ where: { id: fixture.categoryId } });
      const auditActors = await transaction.auditLog.findMany({
        where: { actorId: { in: userIds } },
        select: { actorId: true },
      });
      // Append-only audit records retain their actor FK, so keep those fixture users.
      const retainedUserIds = new Set(
        auditActors.flatMap(({ actorId }) => (actorId ? [actorId] : [])),
      );
      const deletableUserIds = userIds.filter((userId) => !retainedUserIds.has(userId));
      await transaction.user.deleteMany({ where: { id: { in: deletableUserIds } } });
    });
  }

  private getFixture(fixtureId: string): Fixture {
    const fixture = this.fixtures.get(fixtureId);
    if (!fixture) {
      throw new NotFoundException();
    }
    return fixture;
  }

  private assertTestSecret(secret: string | undefined): void {
    const expected = process.env.E2E_TEST_AUTH_BYPASS_SECRET;
    if (!expected || !secret) {
      throw new NotFoundException();
    }
    const expectedBytes = Buffer.from(expected);
    const suppliedBytes = Buffer.from(secret);
    if (
      suppliedBytes.length !== expectedBytes.length ||
      !timingSafeEqual(suppliedBytes, expectedBytes)
    ) {
      throw new NotFoundException();
    }
  }
}
