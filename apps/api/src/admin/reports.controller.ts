import { Body, Controller, Header, Post, Req, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Roles } from '../auth/auth.decorators';
import type { AuthenticatedRequest, AuthPrincipal } from '../auth/auth.types';
import type { Environment } from '../config/environment';
import { UserRole } from '../../generated/prisma/client';
import { AdminService } from './admin.service';
import { CreateModerationReportDto } from './dto/create-moderation-report.dto';

function requirePrincipal(request: AuthenticatedRequest): AuthPrincipal {
  if (!request.user) throw new UnauthorizedException();
  return request.user;
}

@Controller('reports')
export class ReportsController {
  constructor(
    private readonly admin: AdminService,
    private readonly config: ConfigService<Environment, true>,
  ) {}

  @Post()
  @Roles(UserRole.STUDENT, UserRole.ORGANIZER)
  @Header('Cache-Control', 'private, no-store')
  async create(@Req() request: AuthenticatedRequest, @Body() dto: CreateModerationReportDto) {
    const principal = requirePrincipal(request);
    await this.admin.enforceReportRateLimit(
      principal.id,
      this.config.get('MODERATION_REPORTS_PER_HOUR', { infer: true }),
    );
    return this.admin.createReport(
      principal,
      dto,
      request.ip || request.socket.remoteAddress || '',
    );
  }
}
