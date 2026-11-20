import { Transform, Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, Max, Min } from 'class-validator';
import { RsvpStatus } from '../../../generated/prisma/client';

export const MAX_ATTENDEE_PAGE_SIZE = 100;

export class ListEventAttendeesDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(10_000)
  page = 1;

  @IsOptional()
  @Transform(({ value }) => {
    if (value === undefined) {
      return undefined;
    }
    const parsed = Number(value);
    return Number.isFinite(parsed) ? Math.min(parsed, MAX_ATTENDEE_PAGE_SIZE) : value;
  })
  @IsInt()
  @Min(1)
  limit = 20;

  @IsOptional()
  @IsEnum(RsvpStatus)
  status?: RsvpStatus;
}

export type EventAttendeeStatus = 'GOING' | 'WAITLISTED' | 'CHECKED_IN' | 'CANCELLED';

export class EventAttendeeDto {
  displayName!: string;
  status!: EventAttendeeStatus;
  waitlistPosition!: number | null;
}

export class EventAttendeePageDto {
  data!: EventAttendeeDto[];
  page!: number;
  limit!: number;
  total!: number;
}
