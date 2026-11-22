import { IsString, IsUUID, Length } from 'class-validator';

export class CheckinTicketDto {
  @IsString()
  @Length(1, 8192)
  ticket!: string;

  @IsUUID()
  deviceId!: string;
}
