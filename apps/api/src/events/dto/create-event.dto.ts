import {
  IsBoolean,
  IsDateString,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  Max,
  Min,
  ValidateIf,
} from 'class-validator';

export class CreateEventDto {
  @IsString()
  @Length(1, 200)
  @Matches(/\S/)
  title!: string;

  @IsString()
  @Length(1, 20_000)
  @Matches(/\S/)
  description!: string;

  @IsDateString({ strict: true })
  @Matches(/(?:Z|[+-]\d{2}:\d{2})$/)
  startAt!: string;

  @IsDateString({ strict: true })
  @Matches(/(?:Z|[+-]\d{2}:\d{2})$/)
  endAt!: string;

  @IsString()
  @Length(1, 64)
  timeZone!: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100_000)
  capacity?: number | null;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100_000)
  expectedAttendance?: number | null;

  @IsBoolean()
  isPublic!: boolean;

  @IsUUID()
  clubId!: string;

  @IsUUID()
  categoryId!: string;

  @ValidateIf((_object, value) => value !== undefined && value !== null)
  @IsUUID()
  venueId?: string | null;
}
