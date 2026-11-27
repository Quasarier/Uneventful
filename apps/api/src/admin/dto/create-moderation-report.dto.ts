import { IsEnum, IsOptional, IsString, IsUUID, Length, Matches } from 'class-validator';
import { ModerationReportReason, ModerationTargetType } from '../../../generated/prisma/client';

export class CreateModerationReportDto {
  @IsEnum(ModerationTargetType)
  targetType!: ModerationTargetType;

  @IsUUID()
  targetId!: string;

  @IsEnum(ModerationReportReason)
  reason!: ModerationReportReason;

  @IsOptional()
  @IsString()
  @Length(1, 1000)
  @Matches(/\S/)
  note?: string;
}
