import { ConflictException } from '@nestjs/common';
import type { VenueConflictResponse } from './venue-bookings.service';

export class VenueConflictException extends ConflictException {
  constructor(readonly conflict: VenueConflictResponse) {
    super(conflict);
  }
}
