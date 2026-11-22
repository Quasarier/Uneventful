import { Injectable } from '@nestjs/common';
import type { AuthPrincipal } from '../auth/auth.types';
import { CheckinsRepository } from './checkins.repository';
import type { CheckinManifestQueryDto } from './dto/checkin-manifest-query.dto';
import type { CheckinTicketDto } from './dto/checkin-ticket.dto';
import type { ManualCheckinLookupDto } from './dto/manual-checkin-lookup.dto';
import type { ManualCheckinDto } from './dto/manual-checkin.dto';
import type { SyncCheckinsDto } from './dto/sync-checkins.dto';

@Injectable()
export class CheckinsService {
  constructor(private readonly repository: CheckinsRepository) {}

  getManifest(eventId: string, actor: AuthPrincipal, query: CheckinManifestQueryDto) {
    return this.repository.getManifest(eventId, actor, query);
  }

  checkIn(eventId: string, actor: AuthPrincipal, dto: CheckinTicketDto) {
    return this.repository.checkIn(eventId, actor, dto);
  }

  syncCheckins(eventId: string, actor: AuthPrincipal, dto: SyncCheckinsDto) {
    return this.repository.syncCheckins(eventId, actor, dto.scans);
  }

  lookup(eventId: string, actor: AuthPrincipal, query: ManualCheckinLookupDto) {
    return this.repository.lookup(eventId, actor, query);
  }

  manualCheckIn(eventId: string, actor: AuthPrincipal, dto: ManualCheckinDto) {
    return this.repository.manualCheckIn(eventId, actor, dto);
  }
}
