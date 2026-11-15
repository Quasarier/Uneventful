import {
  ConflictException,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Query,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Response } from 'express';
import type { Environment } from '../config/environment';
import { Public } from './auth.decorators';
import { AuthRateLimitService } from './auth-rate-limit.service';
import { AuthService, type AuthSession } from './auth.service';
import { GoogleCallbackDto } from './google-callback.dto';
import { GoogleOidcService } from './google-oidc.service';
import type { AuthenticatedRequest } from './auth.types';

const REFRESH_COOKIE = '__Secure-uneventful_refresh';
const OAUTH_COOKIE = '__Secure-uneventful_oauth';
const AUTH_COOKIE_PATH = '/api/v1/auth';
const CALLBACK_COOKIE_PATH = `${AUTH_COOKIE_PATH}/google/callback`;
const AUTH_RATE_WINDOW_MS = 15 * 60_000;

@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly googleOidc: GoogleOidcService,
    private readonly config: ConfigService<Environment, true>,
    private readonly rateLimit: AuthRateLimitService,
  ) {}

  @Public()
  @Get('google')
  async startGoogleLogin(
    @Req() request: AuthenticatedRequest,
    @Res() response: Response,
  ): Promise<void> {
    await this.rateLimit.consume(
      'google-start-ip',
      this.getClientIp(request),
      this.config.get('GOOGLE_OAUTH_START_RATE_LIMIT_PER_15_MINUTES', { infer: true }),
      AUTH_RATE_WINDOW_MS,
    );
    const login = this.googleOidc.createLoginStart();
    response.cookie(OAUTH_COOKIE, login.transactionCookie, {
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      path: CALLBACK_COOKIE_PATH,
      maxAge: 10 * 60_000,
    });
    response.setHeader('Cache-Control', 'no-store');
    response.redirect(login.authorizationUrl);
  }

  @Public()
  @Get('google/callback')
  async finishGoogleLogin(
    @Query() query: GoogleCallbackDto,
    @Req() request: AuthenticatedRequest,
    @Res() response: Response,
  ): Promise<void> {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Referrer-Policy', 'no-referrer');
    try {
      await this.rateLimit.consume(
        'google-callback-ip',
        this.getClientIp(request),
        this.config.get('GOOGLE_OAUTH_CALLBACK_RATE_LIMIT_PER_15_MINUTES', { infer: true }),
        AUTH_RATE_WINDOW_MS,
      );
      if (query.error || !query.code || !query.state) {
        throw new UnauthorizedException('Google authorization was not completed.');
      }

      const identity = await this.googleOidc.verifyCallback(
        query.code,
        query.state,
        this.getCookie(request, OAUTH_COOKIE),
      );
      await this.rateLimit.consume('google-account', identity.email, 10, AUTH_RATE_WINDOW_MS);
      const session = await this.authService.completeGoogleLogin(identity);
      this.setRefreshCookie(response, session);
      this.clearOAuthCookie(response);
      this.redirectToPopupResult(response, 'success');
    } catch (error) {
      this.clearOAuthCookie(response);
      if (error instanceof UnauthorizedException || error instanceof ConflictException) {
        this.redirectToPopupResult(response, 'error');
        return;
      }
      throw error;
    }
  }

  @Public()
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  async refresh(
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) response: Response,
  ): Promise<PublicSession> {
    this.assertCookieRequest(request);
    let session: AuthSession;
    try {
      session = await this.authService.refresh(this.getCookie(request, REFRESH_COOKIE));
    } catch (error) {
      if (error instanceof UnauthorizedException) {
        this.clearRefreshCookie(response);
      }
      throw error;
    }
    this.setRefreshCookie(response, session);
    response.setHeader('Cache-Control', 'no-store');
    return this.toPublicSession(session);
  }

  @Public()
  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  async logout(
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) response: Response,
  ): Promise<void> {
    this.assertCookieRequest(request);
    this.clearRefreshCookie(response);
    await this.authService.logout(this.getCookie(request, REFRESH_COOKIE));
  }

  @Post('logout-all')
  @HttpCode(HttpStatus.NO_CONTENT)
  async logoutAll(
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) response: Response,
  ): Promise<void> {
    const userId = request.user?.id;
    if (!userId) {
      throw new UnauthorizedException();
    }

    await this.authService.logoutAll(userId);
    this.clearRefreshCookie(response);
  }

  private assertCookieRequest(request: AuthenticatedRequest): void {
    if (
      request.headers.origin !== this.config.get('WEB_ORIGIN', { infer: true }) ||
      request.headers['x-uneventful-csrf'] !== '1'
    ) {
      throw new ForbiddenException('Request origin or CSRF header is not allowed.');
    }
  }

  private getClientIp(request: AuthenticatedRequest): string {
    return request.ip || request.socket.remoteAddress || 'unknown';
  }

  private getCookie(request: AuthenticatedRequest, name: string): string | undefined {
    const cookieHeader = request.headers.cookie;
    if (!cookieHeader) {
      return undefined;
    }

    const matches = cookieHeader
      .split(';')
      .map((cookie) => cookie.trim())
      .filter((cookie) => cookie.startsWith(`${name}=`));

    if (matches.length !== 1) {
      return undefined;
    }

    const matchedCookie = matches[0];
    return matchedCookie?.slice(name.length + 1);
  }

  private setRefreshCookie(response: Response, session: AuthSession): void {
    response.cookie(REFRESH_COOKIE, session.refreshToken, {
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      path: AUTH_COOKIE_PATH,
      maxAge: this.authService.getRefreshCookieMaxAgeMs(),
    });
  }

  private clearRefreshCookie(response: Response): void {
    response.clearCookie(REFRESH_COOKIE, {
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      path: AUTH_COOKIE_PATH,
    });
  }

  private clearOAuthCookie(response: Response): void {
    response.clearCookie(OAUTH_COOKIE, {
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      path: CALLBACK_COOKIE_PATH,
    });
  }

  private redirectToPopupResult(response: Response, status: 'success' | 'error'): void {
    const popupUrl = new URL('/auth/popup', this.config.get('WEB_ORIGIN', { infer: true }));
    popupUrl.searchParams.set('status', status);
    response.redirect(303, popupUrl.toString());
  }

  private toPublicSession(session: AuthSession): PublicSession {
    return {
      accessToken: session.accessToken,
      tokenType: 'Bearer',
      expiresIn: session.expiresIn,
    };
  }
}

interface PublicSession {
  accessToken: string;
  tokenType: 'Bearer';
  expiresIn: number;
}
