import { IsEnum, IsOptional } from 'class-validator';
import { ModerationReportStatus } from '../../../generated/prisma/client';
import { AdminPageDto } from './admin-page.dto';

export class ListModerationReportsDto extends AdminPageDto {
  @IsOptional()
  @IsEnum(ModerationReportStatus)
  status?: ModerationReportStatus;
}
