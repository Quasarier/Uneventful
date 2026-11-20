import { Injectable } from '@nestjs/common';
import type { AuthPrincipal } from '../auth/auth.types';
import type { ListEventAttendeesDto } from './dto/list-event-attendees.dto';
import { RsvpsRepository } from './rsvps.repository';

@Injectable()
export class RsvpsService {
  constructor(private readonly repository: RsvpsRepository) {}

  listMine(userId: string) {
    return this.repository.listMine(userId);
  }

  listEventAttendees(eventId: string, actor: AuthPrincipal, query: ListEventAttendeesDto) {
    return this.repository.listEventAttendees(eventId, actor, query);
  }

  getStatus(eventId: string, userId: string) {
    return this.repository.getStatus(eventId, userId);
  }

  rsvp(eventId: string, userId: string, checkConflicts: boolean) {
    return this.repository.rsvp(eventId, userId, checkConflicts);
  }

  cancel(eventId: string, userId: string) {
    return this.repository.cancel(eventId, userId);
  }

  issueTicket(eventId: string, userId: string) {
    return this.repository.issueTicket(eventId, userId);
  }
}
