import { ConflictException, Injectable, UnauthorizedException } from '@nestjs/common';
import { Prisma, type User } from '../../generated/prisma/client';
import { PrismaService } from '../database/prisma.service';

const authUserSelect = {
  id: true,
  email: true,
  googleSubject: true,
  firstName: true,
  lastName: true,
  avatarUrl: true,
  role: true,
  tokenVersion: true,
  isActive: true,
  deletedAt: true,
} satisfies Prisma.UserSelect;

const authStateSelect = {
  id: true,
  role: true,
  tokenVersion: true,
  isActive: true,
  deletedAt: true,
} satisfies Prisma.UserSelect;

const profileSelect = {
  id: true,
  email: true,
  firstName: true,
  lastName: true,
  avatarUrl: true,
  role: true,
  isActive: true,
  deletedAt: true,
} satisfies Prisma.UserSelect;

const refreshUserSelect = {
  id: true,
  role: true,
  tokenVersion: true,
  isActive: true,
  deletedAt: true,
} satisfies Prisma.UserSelect;

export type AuthUser = Prisma.UserGetPayload<{ select: typeof authUserSelect }>;
export type AuthUserState = Prisma.UserGetPayload<{ select: typeof authStateSelect }>;
export type RefreshRecord = Prisma.RefreshTokenGetPayload<{
  include: { user: { select: typeof refreshUserSelect } };
}>;

export class RefreshRotationConflictError extends Error {
  constructor() {
    super('Refresh token was already consumed.');
    this.name = 'RefreshRotationConflictError';
  }
}

@Injectable()
export class AuthRepository {
  constructor(private readonly prisma: PrismaService) {}

  findUserByGoogleSubject(googleSubject: string): Promise<AuthUser | null> {
    return this.prisma.user.findUnique({
      where: { googleSubject },
      select: authUserSelect,
    });
  }

  findUserByEmail(email: string): Promise<AuthUser | null> {
    return this.prisma.user.findUnique({
      where: { email },
      select: authUserSelect,
    });
  }

  createGoogleUser(input: {
    email: string;
    googleSubject: string;
    firstName: string;
    lastName: string;
    avatarUrl: string | null;
  }): Promise<AuthUser> {
    return this.prisma.user.create({
      data: input,
      select: authUserSelect,
    });
  }

  updateGoogleUser(
    id: string,
    input: {
      email: string;
      firstName: string;
      lastName: string;
      avatarUrl: string | null;
    },
  ): Promise<AuthUser> {
    return this.prisma.user.update({
      where: { id },
      data: input,
      select: authUserSelect,
    });
  }

  findUserState(id: string): Promise<AuthUserState | null> {
    return this.prisma.user.findUnique({
      where: { id },
      select: authStateSelect,
    });
  }

  findUserProfile(id: string) {
    return this.prisma.user.findUnique({
      where: { id },
      select: profileSelect,
    });
  }

  findRefreshByHash(tokenHash: string): Promise<RefreshRecord | null> {
    return this.prisma.refreshToken.findUnique({
      where: { tokenHash },
      include: { user: { select: refreshUserSelect } },
    });
  }

  async hasActiveRefreshTokenFamily(
    userId: string,
    familyId: string,
    tokenVersion: number,
    now: Date,
  ): Promise<boolean> {
    const activeToken = await this.prisma.refreshToken.findFirst({
      where: {
        userId,
        familyId,
        tokenVersion,
        revokedAt: null,
        expiresAt: { gt: now },
      },
      select: { id: true },
    });
    return activeToken !== null;
  }

  createRefreshToken(input: {
    id: string;
    userId: string;
    familyId: string;
    tokenHash: string;
    expiresAt: Date;
    tokenVersion: number;
  }) {
    return this.prisma.refreshToken.create({ data: input });
  }

  async rotateRefreshToken(
    previousId: string,
    tokenVersion: number,
    replacement: {
      id: string;
      userId: string;
      familyId: string;
      tokenHash: string;
      expiresAt: Date;
      tokenVersion: number;
    },
    now: Date,
  ): Promise<void> {
    await this.prisma.$transaction(async (transaction) => {
      await transaction.refreshToken.create({ data: replacement });
      const consumed = await transaction.refreshToken.updateMany({
        where: {
          id: previousId,
          revokedAt: null,
          expiresAt: { gt: now },
          tokenVersion,
        },
        data: {
          revokedAt: now,
          replacedById: replacement.id,
        },
      });

      if (consumed.count !== 1) {
        throw new RefreshRotationConflictError();
      }
    });
  }

  revokeFamily(familyId: string, revokedAt: Date): Promise<Prisma.BatchPayload> {
    return this.prisma.refreshToken.updateMany({
      where: { familyId, revokedAt: null },
      data: { revokedAt },
    });
  }

  async revokeUserSessions(userId: string, revokedAt: Date): Promise<void> {
    await this.prisma.$transaction([
      this.prisma.refreshToken.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt },
      }),
      this.prisma.user.update({
        where: { id: userId },
        data: { tokenVersion: { increment: 1 } },
        select: { id: true },
      }),
    ]);
  }

  async createOrUpdateGoogleUser(input: {
    email: string;
    googleSubject: string;
    firstName: string;
    lastName: string;
    avatarUrl: string | null;
  }): Promise<AuthUser> {
    const existingSubject = await this.findUserByGoogleSubject(input.googleSubject);
    if (existingSubject) {
      this.assertAccountUsable(existingSubject);
      return this.updateGoogleUser(existingSubject.id, input);
    }

    const existingEmail = await this.findUserByEmail(input.email);
    if (existingEmail) {
      throw new ConflictException('This Google account cannot be linked.');
    }

    try {
      return await this.createGoogleUser(input);
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        const concurrentUser = await this.findUserByGoogleSubject(input.googleSubject);
        if (concurrentUser && concurrentUser.email === input.email) {
          this.assertAccountUsable(concurrentUser);
          return this.updateGoogleUser(concurrentUser.id, input);
        }
        throw new ConflictException('This Google account cannot be linked.');
      }
      throw error;
    }
  }

  assertAccountUsable(user: Pick<User, 'isActive' | 'deletedAt'>): void {
    if (!user.isActive || user.deletedAt) {
      throw new UnauthorizedException('This account is unavailable.');
    }
  }
}
