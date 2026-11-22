import { IsInt, Matches, Max, Min } from 'class-validator';

export class VenueAvailabilityHourDto {
  @IsInt()
  @Min(1)
  @Max(7)
  weekday!: number;

  @Matches(/^(?:[01]\d|2[0-3]):[0-5]\d$/)
  opensAt!: string;

  @Matches(/^(?:[01]\d|2[0-3]):[0-5]\d$/)
  closesAt!: string;
}
