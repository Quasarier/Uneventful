import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { DatabaseModule } from '../database/database.module';
import { AuthRateLimitModule } from './auth-rate-limit.module';
import { AuthRateLimitService } from './auth-rate-limit.service';
import { AuthController } from './auth.controller';
import { AuthRepository } from './auth.repository';
import { AuthService } from './auth.service';
import { GoogleOidcService } from './google-oidc.service';
import { GlobalApiRateLimitGuard } from './global-api-rate-limit.guard';
import { JwtAuthGuard } from './jwt-auth.guard';
import { RolesGuard } from './roles.guard';

@Module({
  imports: [DatabaseModule, AuthRateLimitModule],
  controllers: [AuthController],
  providers: [
    AuthRepository,
    AuthService,
    GoogleOidcService,
    GlobalApiRateLimitGuard,
    JwtAuthGuard,
    RolesGuard,
    { provide: APP_GUARD, useExisting: JwtAuthGuard },
    { provide: APP_GUARD, useExisting: GlobalApiRateLimitGuard },
    { provide: APP_GUARD, useExisting: RolesGuard },
  ],
  exports: [AuthService, AuthRateLimitService],
})
export class AuthModule {}
