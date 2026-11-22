import { IsUUID } from 'class-validator';

export class ManualCheckinDto {
  @IsUUID()
  rsvpId!: string;

  @IsUUID()
  deviceId!: string;
}
