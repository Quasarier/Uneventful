import { Type } from 'class-transformer';
import {
  IsObject,
  IsString,
  IsUrl,
  Matches,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';

export class PushSubscriptionKeysDto {
  @IsString()
  @MinLength(80)
  @MaxLength(128)
  @Matches(/^[A-Za-z0-9_-]+$/)
  p256dh!: string;

  @IsString()
  @MinLength(20)
  @MaxLength(128)
  @Matches(/^[A-Za-z0-9_-]+$/)
  auth!: string;
}

export class PushSubscriptionDto {
  @IsString()
  @MaxLength(2048)
  @IsUrl({ protocols: ['https'], require_protocol: true, require_tld: true })
  endpoint!: string;

  @IsObject()
  @ValidateNested()
  @Type(() => PushSubscriptionKeysDto)
  keys!: PushSubscriptionKeysDto;
}

export class DeletePushSubscriptionDto {
  @IsString()
  @MaxLength(2048)
  @IsUrl({ protocols: ['https'], require_protocol: true, require_tld: true })
  endpoint!: string;
}
