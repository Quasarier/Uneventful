import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsDateString,
  IsInt,
  Matches,
  IsOptional,
  IsUUID,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import { RecurrenceRuleDto } from './recurrence-rule.dto';

export class CheckVenueConflictsDto {
  @IsUUID()
  venueId!: string;

  @IsDateString({ strict: true })
  @Matches(/(?:Z|[+-]\d{2}:\d{2})$/)
  startAt!: string;

  @IsDateString({ strict: true })
  @Matches(/(?:Z|[+-]\d{2}:\d{2})$/)
  endAt!: string;

  @IsInt()
  @Min(1)
  @Max(100_000)
  expectedAttendance!: number;

  @IsOptional()
  @IsUUID()
  eventId?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => RecurrenceRuleDto)
  recurrence?: RecurrenceRuleDto;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(52)
  @ArrayUnique()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { each: true })
  exceptionDates?: string[];
}
