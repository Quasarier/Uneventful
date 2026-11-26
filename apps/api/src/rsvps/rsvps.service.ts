import { Injectable } from '@nestjs/common';
import type { AuthPrincipal } from '../auth/auth.types';
import { AnalyticsCacheService } from '../analytics/analytics-cache.service';
import type { ListEventAttendeesDto } from './dto/list-event-attendees.dto';
import { RsvpsRepository } from './rsvps.repository';

@Injectable()
export class RsvpsService {
  constructor(
    private readonly repository: RsvpsRepository,
    private readonly analyticsCache: AnalyticsCacheService,
  ) {}

  listMine(userId: string) {
    return this.repository.listMine(userId);
  }

  listEventAttendees(eventId: string, actor: AuthPrincipal, query: ListEventAttendeesDto) {
    return this.repository.listEventAttendees(eventId, actor, query);
  }

  getStatus(eventId: string, userId: string) {
    return this.repository.getStatus(eventId, userId);
  }

  async rsvp(eventId: string, userId: string, checkConflicts: boolean) {
    const result = await this.repository.rsvp(eventId, userId, checkConflicts);
    await this.analyticsCache.invalidateEvent(eventId, userId);
    return result;
  }

  async cancel(eventId: string, userId: string) {
    const result = await this.repository.cancel(eventId, userId);
    await this.analyticsCache.invalidateEvent(eventId, userId);
    return result;
  }

  issueTicket(eventId: string, userId: string) {
    return this.repository.issueTicket(eventId, userId);
  }
}
