import {
  Controller,
  Get,
  Header,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import { ClubMembershipStatus } from '../../generated/prisma/client';
import type { AuthenticatedRequest } from '../auth/auth.types';
import { PrismaService } from '../database/prisma.service';

@Controller('clubs')
export class ClubVerificationController {
  constructor(private readonly prisma: PrismaService) {}

  @Get(':clubId/verification')
  @Header('Cache-Control', 'private, no-store')
  async getClubVerification(
    @Req() request: AuthenticatedRequest,
    @Param('clubId', ParseUUIDPipe) clubId: string,
  ) {
    const userId = request.user?.id;
    if (!userId) throw new UnauthorizedException();
    const club = await this.prisma.club.findFirst({
      where: {
        id: clubId,
        deletedAt: null,
        memberships: {
          some: { userId, status: ClubMembershipStatus.ACTIVE },
        },
      },
      select: {
        id: true,
        verificationStatus: true,
        verificationReason: true,
        updatedAt: true,
      },
    });
    if (!club) throw new NotFoundException('Club verification not found.');
    return club;
  }
}
