import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
  UnauthorizedException,
} from '@nestjs/common';
import { AdminOnly } from '../auth/auth.decorators';
import type { AuthenticatedRequest, AuthPrincipal } from '../auth/auth.types';
import { AdminAccessGuard } from './admin-access.guard';
import { AdminService } from './admin.service';
import { AdminAuditQueryDto, AdminPageDto } from './dto/admin-page.dto';
import { AdminReasonDto } from './dto/admin-reason.dto';
import { ChangeClubVerificationDto } from './dto/change-club-verification.dto';
import { ResolveModerationReportDto } from './dto/resolve-moderation-report.dto';
import { ListModerationReportsDto } from './dto/list-moderation-reports.dto';
import { AdminCreateVenueDto } from './dto/admin-create-venue.dto';
import { AdminUpdateVenueDto } from './dto/admin-update-venue.dto';
import { VenuesService } from '../venues/venues.service';

function requirePrincipal(request: AuthenticatedRequest): AuthPrincipal {
  if (!request.user) throw new UnauthorizedException();
  return request.user;
}

function getClientIp(request: AuthenticatedRequest): string {
  return request.ip || request.socket.remoteAddress || '';
}

@Controller('admin')
@UseGuards(AdminAccessGuard)
@AdminOnly()
export class AdminController {
  constructor(
    private readonly admin: AdminService,
    private readonly venues: VenuesService,
  ) {}

  @Get('events/approval-queue')
  @Header('Cache-Control', 'private, no-store')
  listApprovalQueue(@Query() query: AdminPageDto) {
    return this.admin.listApprovalQueue(query);
  }

  @Post('events/:id/approve')
  @Header('Cache-Control', 'private, no-store')
  approveEvent(
    @Req() request: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AdminReasonDto,
  ) {
    return this.admin.approveEvent(requirePrincipal(request), id, dto.reason, getClientIp(request));
  }

  @Post('events/:id/reject')
  @Header('Cache-Control', 'private, no-store')
  rejectEvent(
    @Req() request: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AdminReasonDto,
  ) {
    return this.admin.rejectEvent(requirePrincipal(request), id, dto.reason, getClientIp(request));
  }

  @Get('clubs')
  @Header('Cache-Control', 'private, no-store')
  listClubs(@Query() query: AdminPageDto) {
    return this.admin.listClubs(query);
  }

  @Patch('clubs/:id/verification')
  @Header('Cache-Control', 'private, no-store')
  updateClubVerification(
    @Req() request: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ChangeClubVerificationDto,
  ) {
    return this.admin.changeClubVerification(
      requirePrincipal(request),
      id,
      dto,
      getClientIp(request),
    );
  }

  @Get('venues')
  @Header('Cache-Control', 'private, no-store')
  listVenues() {
    return this.admin.listVenues();
  }

  @Post('venues')
  @Header('Cache-Control', 'private, no-store')
  createVenue(@Req() request: AuthenticatedRequest, @Body() dto: AdminCreateVenueDto) {
    const { reason, ...venue } = dto;
    return this.venues.create(requirePrincipal(request), venue, {
      reason,
      actorIp: getClientIp(request),
    });
  }

  @Patch('venues/:id')
  @Header('Cache-Control', 'private, no-store')
  updateVenue(
    @Req() request: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AdminUpdateVenueDto,
  ) {
    const { reason, ...venue } = dto;
    return this.venues.update(requirePrincipal(request), id, venue, {
      reason,
      actorIp: getClientIp(request),
    });
  }

  @Delete('venues/:id')
  @Header('Cache-Control', 'private, no-store')
  retireVenue(
    @Req() request: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AdminReasonDto,
  ) {
    return this.venues.retire(requirePrincipal(request), id, {
      reason: dto.reason,
      actorIp: getClientIp(request),
    });
  }

  @Get('users')
  @Header('Cache-Control', 'private, no-store')
  searchUsers(@Query() query: AdminPageDto) {
    return this.admin.searchUsers(query);
  }

  @Post('users/:id/organizer-memberships/:clubId')
  @Header('Cache-Control', 'private, no-store')
  grantOrganizerMembership(
    @Req() request: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) userId: string,
    @Param('clubId', ParseUUIDPipe) clubId: string,
    @Body() dto: AdminReasonDto,
  ) {
    return this.admin.grantOrganizerMembership(
      requirePrincipal(request),
      userId,
      clubId,
      dto.reason,
      getClientIp(request),
    );
  }

  @Delete('users/:id/organizer-memberships/:clubId')
  @Header('Cache-Control', 'private, no-store')
  revokeOrganizerMembership(
    @Req() request: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) userId: string,
    @Param('clubId', ParseUUIDPipe) clubId: string,
    @Body() dto: AdminReasonDto,
  ) {
    return this.admin.revokeOrganizerMembership(
      requirePrincipal(request),
      userId,
      clubId,
      dto.reason,
      getClientIp(request),
    );
  }

  @Post('users/:id/admin-grant-requests')
  @Header('Cache-Control', 'private, no-store')
  requestAdminRoleGrant(
    @Req() request: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) userId: string,
    @Body() dto: AdminReasonDto,
  ) {
    const familyId = request.accessSession?.familyId;
    if (!familyId) throw new UnauthorizedException();
    return this.admin.requestAdminRoleGrant(
      requirePrincipal(request),
      userId,
      familyId,
      dto.reason,
      getClientIp(request),
    );
  }

  @Get('admin-grant-requests')
  @Header('Cache-Control', 'private, no-store')
  listAdminRoleGrantRequests(@Query() query: AdminPageDto) {
    return this.admin.listAdminRoleGrantRequests(query);
  }

  @Post('admin-grant-requests/:id/approve')
  @Header('Cache-Control', 'private, no-store')
  approveAdminRoleGrant(
    @Req() request: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) requestId: string,
    @Body() dto: AdminReasonDto,
  ) {
    return this.admin.approveAdminRoleGrant(
      requirePrincipal(request),
      requestId,
      dto.reason,
      getClientIp(request),
    );
  }

  @Post('users/:id/admin-role/revoke')
  @Header('Cache-Control', 'private, no-store')
  revokeAdminRole(
    @Req() request: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) userId: string,
    @Body() dto: AdminReasonDto,
  ) {
    return this.admin.revokeAdminRole(
      requirePrincipal(request),
      userId,
      dto.reason,
      getClientIp(request),
    );
  }

  @Post('users/:id/suspend')
  @Header('Cache-Control', 'private, no-store')
  suspendUser(
    @Req() request: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) userId: string,
    @Body() dto: AdminReasonDto,
  ) {
    return this.admin.setUserActive(
      requirePrincipal(request),
      userId,
      false,
      dto.reason,
      getClientIp(request),
    );
  }

  @Post('users/:id/reactivate')
  @Header('Cache-Control', 'private, no-store')
  reactivateUser(
    @Req() request: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) userId: string,
    @Body() dto: AdminReasonDto,
  ) {
    return this.admin.setUserActive(
      requirePrincipal(request),
      userId,
      true,
      dto.reason,
      getClientIp(request),
    );
  }

  @Get('reports')
  @Header('Cache-Control', 'private, no-store')
  listReports(@Query() query: ListModerationReportsDto) {
    return this.admin.listReports(query);
  }

  @Post('reports/:id/resolve')
  @Header('Cache-Control', 'private, no-store')
  resolveReport(
    @Req() request: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) reportId: string,
    @Body() dto: ResolveModerationReportDto,
  ) {
    return this.admin.resolveReport(requirePrincipal(request), reportId, dto, getClientIp(request));
  }

  @Get('audit-logs')
  @Header('Cache-Control', 'private, no-store')
  listAuditLogs(@Req() request: AuthenticatedRequest, @Query() query: AdminAuditQueryDto) {
    return this.admin.listAuditLogs(requirePrincipal(request), query, getClientIp(request));
  }
}
