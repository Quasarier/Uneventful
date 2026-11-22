import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsDateString,
  IsString,
  IsUUID,
  Matches,
  ValidateNested,
} from 'class-validator';

export const MAX_OFFLINE_CHECKINS_PER_BATCH = 50;

export class OfflineCheckinDto {
  @IsString()
  @Matches(/^[a-f0-9]{64}$/i)
  ticketIdHash!: string;

  @IsUUID()
  deviceId!: string;

  @IsDateString()
  scannedAt!: string;
}

export class SyncCheckinsDto {
  @IsArray()
  @ArrayMaxSize(MAX_OFFLINE_CHECKINS_PER_BATCH)
  @ValidateNested({ each: true })
  @Type(() => OfflineCheckinDto)
  scans!: OfflineCheckinDto[];
}
