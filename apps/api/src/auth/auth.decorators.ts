import { SetMetadata } from '@nestjs/common';
import type { UserRole } from '../../generated/prisma/client';

export const IS_PUBLIC_KEY = 'auth:is-public';
export const IS_OPTIONAL_AUTH_KEY = 'auth:is-optional';
export const ROLES_KEY = 'auth:roles';
export const SKIP_GLOBAL_RATE_LIMIT_KEY = 'auth:skip-global-rate-limit';

export const Public = (): MethodDecorator & ClassDecorator => SetMetadata(IS_PUBLIC_KEY, true);
export const OptionalAuth = (): MethodDecorator & ClassDecorator =>
  SetMetadata(IS_OPTIONAL_AUTH_KEY, true);
export const SkipGlobalRateLimit = (): MethodDecorator & ClassDecorator =>
  SetMetadata(SKIP_GLOBAL_RATE_LIMIT_KEY, true);

export const Roles = (...roles: UserRole[]): MethodDecorator & ClassDecorator =>
  SetMetadata(ROLES_KEY, roles);
