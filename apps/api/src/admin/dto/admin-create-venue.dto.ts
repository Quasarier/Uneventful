import { IsString, Length, Matches } from 'class-validator';
import { CreateVenueDto } from '../../venues/dto/create-venue.dto';

export class AdminCreateVenueDto extends CreateVenueDto {
  @IsString()
  @Length(1, 1000)
  @Matches(/\S/)
  reason!: string;
}
