import { IsEnum } from 'class-validator';
import { ClubVerificationStatus } from '../../../generated/prisma/client';
import { AdminReasonDto } from './admin-reason.dto';

export class ChangeClubVerificationDto extends AdminReasonDto {
  @IsEnum(ClubVerificationStatus)
  status!: ClubVerificationStatus;
}
