import type { Request } from 'express';
import type { UserRole } from '../../generated/prisma/client';
import type { AuthenticatedAccessSession } from './auth.service';

export interface AuthPrincipal {
  id: string;
  role: UserRole;
  tokenVersion: number;
}

export interface AuthenticatedRequest extends Request {
  user?: AuthPrincipal;
  accessSession?: AuthenticatedAccessSession;
  adminOnly?: boolean;
}
