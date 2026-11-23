import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsEnum,
  ValidateNested,
} from 'class-validator';
import { NotificationChannel, NotificationType } from '../../../generated/prisma/client';

export class NotificationPreferenceChangeDto {
  @IsEnum(NotificationChannel)
  channel!: NotificationChannel;

  @IsEnum(NotificationType)
  type!: NotificationType;

  @IsBoolean()
  enabled!: boolean;
}

export class PatchNotificationPreferencesDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(24)
  @ValidateNested({ each: true })
  @Type(() => NotificationPreferenceChangeDto)
  preferences!: NotificationPreferenceChangeDto[];
}
