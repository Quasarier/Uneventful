import {
  IsBoolean,
  IsDateString,
  IsInt,
  IsString,
  IsUUID,
  Length,
  Matches,
  Max,
  Min,
  ValidateIf,
} from 'class-validator';

export class UpdateEventDto {
  @ValidateIf((_object, value) => value !== undefined)
  @IsString()
  @Length(1, 200)
  @Matches(/\S/)
  title?: string;

  @ValidateIf((_object, value) => value !== undefined)
  @IsString()
  @Length(1, 20_000)
  @Matches(/\S/)
  description?: string;

  @ValidateIf((_object, value) => value !== undefined)
  @IsDateString({ strict: true })
  @Matches(/(?:Z|[+-]\d{2}:\d{2})$/)
  startAt?: string;

  @ValidateIf((_object, value) => value !== undefined)
  @IsDateString({ strict: true })
  @Matches(/(?:Z|[+-]\d{2}:\d{2})$/)
  endAt?: string;

  @ValidateIf((_object, value) => value !== undefined)
  @IsString()
  @Length(1, 64)
  timeZone?: string;

  @ValidateIf((_object, value) => value !== undefined && value !== null)
  @IsInt()
  @Min(1)
  @Max(100_000)
  capacity?: number | null;

  @ValidateIf((_object, value) => value !== undefined && value !== null)
  @IsInt()
  @Min(1)
  @Max(100_000)
  expectedAttendance?: number | null;

  @ValidateIf((_object, value) => value !== undefined)
  @IsBoolean()
  isPublic?: boolean;

  @ValidateIf((_object, value) => value !== undefined)
  @IsUUID()
  categoryId?: string;

  @ValidateIf((_object, value) => value !== undefined && value !== null)
  @IsUUID()
  venueId?: string | null;
}
