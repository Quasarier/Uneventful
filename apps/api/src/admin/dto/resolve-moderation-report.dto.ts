import { IsEnum } from 'class-validator';
import { ModerationAction } from '../../../generated/prisma/client';
import { AdminReasonDto } from './admin-reason.dto';

export class ResolveModerationReportDto extends AdminReasonDto {
  @IsEnum(ModerationAction)
  action!: ModerationAction;
}
