import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { VenueAvailabilityHourDto } from './venue-availability-hour.dto';

export class CreateVenueDto {
  @IsString()
  @Length(1, 160)
  name!: string;

  @IsOptional()
  @IsString()
  @Length(1, 160)
  building?: string | null;

  @IsInt()
  @Min(1)
  @Max(100_000)
  capacity!: number;

  @IsInt()
  @Min(0)
  @Max(1440)
  bufferMinutes!: number;

  @IsArray()
  @ArrayMaxSize(7)
  @ArrayUnique((hour: VenueAvailabilityHourDto) => hour.weekday)
  @ValidateNested({ each: true })
  @Type(() => VenueAvailabilityHourDto)
  availabilityHours!: VenueAvailabilityHourDto[];
}
