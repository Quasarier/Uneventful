import { IsString, Length, Matches } from 'class-validator';
import { UpdateVenueDto } from '../../venues/dto/update-venue.dto';

export class AdminUpdateVenueDto extends UpdateVenueDto {
  @IsString()
  @Length(1, 1000)
  @Matches(/\S/)
  reason!: string;
}
