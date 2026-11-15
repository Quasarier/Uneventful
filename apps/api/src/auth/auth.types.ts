import type { Request } from 'express';
import type { UserRole } from '../../generated/prisma/client';

export interface AuthPrincipal {
  id: string;
  role: UserRole;
  tokenVersion: number;
}

export interface AuthenticatedRequest extends Request {
  user?: AuthPrincipal;
}
