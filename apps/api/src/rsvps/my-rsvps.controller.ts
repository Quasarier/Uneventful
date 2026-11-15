import { Controller, Get, Header, Inject, Req, UnauthorizedException } from '@nestjs/common';
import { UserRole } from '../../generated/prisma/client';
import { Roles } from '../auth/auth.decorators';
import type { AuthenticatedRequest } from '../auth/auth.types';
import { RsvpsService } from './rsvps.service';

@Controller('rsvps')
@Roles(UserRole.STUDENT)
export class MyRsvpsController {
  constructor(
    @Inject(RsvpsService)
    private readonly rsvps: RsvpsService,
  ) {}

  @Get('me')
  @Header('Cache-Control', 'private, no-store')
  listMine(@Req() request: AuthenticatedRequest) {
    const userId = request.user?.id;
    if (!userId) {
      throw new UnauthorizedException();
    }
    return this.rsvps.listMine(userId);
  }
}
