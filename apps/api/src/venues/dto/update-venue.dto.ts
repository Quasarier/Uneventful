import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsInt,
  IsString,
  Length,
  Max,
  Min,
  ValidateNested,
  ValidateIf,
} from 'class-validator';
import { Type } from 'class-transformer';
import { VenueAvailabilityHourDto } from './venue-availability-hour.dto';

export class UpdateVenueDto {
  @ValidateIf((_object, value) => value !== undefined)
  @IsString()
  @Length(1, 160)
  name?: string;

  @ValidateIf((_object, value) => value !== undefined && value !== null)
  @IsString()
  @Length(1, 160)
  building?: string | null;

  @ValidateIf((_object, value) => value !== undefined)
  @IsInt()
  @Min(1)
  @Max(100_000)
  capacity?: number;

  @ValidateIf((_object, value) => value !== undefined)
  @IsInt()
  @Min(0)
  @Max(1440)
  bufferMinutes?: number;

  @ValidateIf((_object, value) => value !== undefined)
  @IsBoolean()
  isActive?: boolean;

  @ValidateIf((_object, value) => value !== undefined)
  @IsArray()
  @ArrayMaxSize(7)
  @ArrayUnique((hour: VenueAvailabilityHourDto) => hour.weekday)
  @ValidateNested({ each: true })
  @Type(() => VenueAvailabilityHourDto)
  availabilityHours?: VenueAvailabilityHourDto[];
}
