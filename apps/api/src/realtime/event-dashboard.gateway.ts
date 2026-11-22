import { Logger, OnModuleDestroy, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { createAdapter } from '@socket.io/redis-adapter';
import { createClient } from 'redis';
import Redis from 'ioredis';
import type { Namespace, Socket } from 'socket.io';
import { z } from 'zod';
import type { Environment } from '../config/environment';
import { AuthRateLimitService, SESSION_REVOCATION_CHANNEL } from '../auth/auth-rate-limit.service';
import { AuthService, type AuthenticatedAccessSession } from '../auth/auth.service';
import { EventDashboardRepository } from './event-dashboard.repository';
import { MAX_REALTIME_MESSAGE_BYTES } from './realtime-io.adapter';
import type { EventDashboardPublisher } from './event-dashboard.types';

const MAX_CONNECTIONS_PER_USER = 3;
const CONNECTION_LEASE_MS = 30_000;
const CONNECTION_RENEW_INTERVAL_MS = 5_000;
const MEMBERSHIP_RECHECK_INTERVAL_MS = 3_000;
const MAX_MESSAGES_PER_WINDOW = 20;
const MESSAGE_WINDOW_MS = 10_000;
const MAX_EVENT_ROOMS_PER_CONNECTION = 10;

const socketAuthSchema = z.object({ accessToken: z.string().min(1).max(8_192) }).strict();
const eventPayloadSchema = z.object({ eventId: z.string().uuid() }).strict();
const revocationSchema = z.union([
  z.object({ familyId: z.string().uuid() }).strict(),
  z.object({ userId: z.string().uuid() }).strict(),
]);

interface DashboardSocketData {
  session: AuthenticatedAccessSession;
  joinedEventIds: Set<string>;
  messageWindowStartedAt: number;
  messageCount: number;
  expiryTimer?: NodeJS.Timeout;
}

type DashboardSocket = Socket & { data: DashboardSocketData };
type Acknowledgement = (response: Record<string, unknown>) => void;

function roomName(eventId: string): string {
  return `event-dashboard:${eventId}`;
}

function isAcknowledgement(value: unknown): value is Acknowledgement {
  return typeof value === 'function';
}

@WebSocketGateway({
  namespace: '/realtime',
  transports: ['websocket'],
  maxHttpBufferSize: MAX_REALTIME_MESSAGE_BYTES,
})
export class EventDashboardGateway
  implements
    OnGatewayInit<Namespace>,
    OnGatewayConnection<DashboardSocket>,
    OnGatewayDisconnect<DashboardSocket>,
    OnModuleDestroy,
    EventDashboardPublisher
{
  @WebSocketServer()
  private namespace!: Namespace;

  private readonly logger = new Logger(EventDashboardGateway.name);
  private redisPublisher?: ReturnType<typeof createClient>;
  private redisAdapterSubscriber?: ReturnType<typeof createClient>;
  private sessionSubscriber?: Redis;
  private membershipTimer?: NodeJS.Timeout;
  private connectionRenewTimer?: NodeJS.Timeout;
  private ready = false;

  constructor(
    private readonly auth: AuthService,
    private readonly rateLimit: AuthRateLimitService,
    private readonly config: ConfigService<Environment, true>,
    private readonly repository: EventDashboardRepository,
  ) {}

  async afterInit(namespace: Namespace): Promise<void> {
    this.namespace = namespace;
    namespace.use((socket, next) => {
      if (!this.ready) {
        next(new Error('Connection rejected.'));
        return;
      }
      void this.authenticateHandshake(socket as DashboardSocket).then(
        () => next(),
        () => next(new Error('Connection rejected.')),
      );
    });
    try {
      const redisUrl = this.config.get('REDIS_URL', { infer: true });
      const publisher = createClient({ url: redisUrl });
      const adapterSubscriber = publisher.duplicate();
      this.redisPublisher = publisher;
      this.redisAdapterSubscriber = adapterSubscriber;
      publisher.on('error', () => this.logger.error('Socket.IO Redis publisher error.'));
      adapterSubscriber.on('error', () => this.logger.error('Socket.IO Redis subscriber error.'));

      const sessionSubscriber = new Redis(redisUrl, {
        maxRetriesPerRequest: 1,
        retryStrategy: (attempt) => (attempt >= 3 ? null : Math.min(attempt * 250, 1_000)),
      });
      this.sessionSubscriber = sessionSubscriber;
      sessionSubscriber.on('error', () =>
        this.logger.error('Socket.IO session revocation subscriber error.'),
      );
      sessionSubscriber.on('message', (_channel, message) => {
        this.handleSessionRevocation(message);
      });

      await Promise.all([publisher.connect(), adapterSubscriber.connect()]);
      namespace.server.adapter(createAdapter(publisher, adapterSubscriber));
      await sessionSubscriber.subscribe(SESSION_REVOCATION_CHANNEL);
      this.ready = true;
      this.membershipTimer = setInterval(
        () => void this.recheckConnections(),
        MEMBERSHIP_RECHECK_INTERVAL_MS,
      );
      this.connectionRenewTimer = setInterval(
        () => void this.renewConnections(),
        CONNECTION_RENEW_INTERVAL_MS,
      );
      this.membershipTimer.unref();
      this.connectionRenewTimer.unref();
    } catch {
      this.logger.error(
        'Socket.IO Redis initialization failed; real-time connections are disabled.',
      );
      this.redisPublisher?.destroy();
      this.redisAdapterSubscriber?.destroy();
      this.sessionSubscriber?.disconnect();
      this.redisPublisher = undefined;
      this.redisAdapterSubscriber = undefined;
      this.sessionSubscriber = undefined;
    }
  }

  isReady(): boolean {
    return this.ready;
  }

  handleConnection(socket: DashboardSocket): void {
    socket.data.expiryTimer = setTimeout(
      () => socket.disconnect(true),
      Math.max(0, socket.data.session.expiresAt - Date.now()),
    );
    socket.data.expiryTimer.unref();
    socket.onAny((event, ...args: unknown[]) => this.validateIncomingMessage(socket, event, args));
    socket.on('dashboard:join', (payload: unknown, acknowledgement?: unknown) => {
      void this.joinDashboard(socket, payload, acknowledgement).catch(() => {
        this.logger.error('Could not authorize or join a dashboard room.');
        this.getAcknowledgement(acknowledgement)?.({
          ok: false,
          error: 'Dashboard unavailable.',
        });
      });
    });
    socket.on('dashboard:leave', (payload: unknown, acknowledgement?: unknown) => {
      void this.leaveDashboard(socket, payload, acknowledgement).catch(() => {
        this.logger.error('Could not leave a dashboard room.');
        this.getAcknowledgement(acknowledgement)?.({
          ok: false,
          error: 'Dashboard unavailable.',
        });
      });
    });
  }

  handleDisconnect(socket: DashboardSocket): void {
    if (socket.data?.expiryTimer) {
      clearTimeout(socket.data.expiryTimer);
    }
    if (socket.data?.session) {
      void this.rateLimit
        .releaseSocketConnection(socket.data.session.principal.id, socket.id)
        .catch(() => this.logger.error('Could not release a Socket.IO connection lease.'));
    }
  }

  async publishCheckIn(eventId: string): Promise<void> {
    const snapshot = await this.repository.snapshot(eventId);
    if (snapshot) {
      this.namespace.to(roomName(eventId)).emit('dashboard:update', snapshot);
    }
  }

  async onModuleDestroy(): Promise<void> {
    this.ready = false;
    if (this.membershipTimer) {
      clearInterval(this.membershipTimer);
    }
    if (this.connectionRenewTimer) {
      clearInterval(this.connectionRenewTimer);
    }
    await Promise.all([
      this.redisPublisher?.quit(),
      this.redisAdapterSubscriber?.quit(),
      this.sessionSubscriber?.quit(),
    ]);
  }

  private async authenticateHandshake(socket: DashboardSocket): Promise<void> {
    const origin = socket.handshake.headers.origin;
    const query = socket.handshake.query;
    if (
      origin !== this.config.get('WEB_ORIGIN', { infer: true }) ||
      'token' in query ||
      'accessToken' in query ||
      'access_token' in query
    ) {
      throw new UnauthorizedException();
    }

    const parsed = socketAuthSchema.safeParse(socket.handshake.auth);
    if (!parsed.success) {
      throw new UnauthorizedException();
    }
    const session = await this.auth.authenticateAccessTokenSession(parsed.data.accessToken);
    if (session.expiresAt <= Date.now()) {
      throw new UnauthorizedException();
    }
    const reserved = await this.rateLimit.reserveSocketConnection(
      session.principal.id,
      socket.id,
      MAX_CONNECTIONS_PER_USER,
      CONNECTION_LEASE_MS,
    );
    if (!reserved) {
      throw new UnauthorizedException();
    }

    socket.data = {
      session,
      joinedEventIds: new Set<string>(),
      messageWindowStartedAt: Date.now(),
      messageCount: 0,
    };
  }

  private validateIncomingMessage(socket: DashboardSocket, event: string, args: unknown[]): void {
    const acknowledgement = args.at(-1);
    const payloads = args.filter((argument) => !isAcknowledgement(argument));
    let payloadSize: number;
    try {
      payloadSize = Buffer.byteLength(JSON.stringify(payloads) ?? '');
    } catch {
      payloadSize = Number.POSITIVE_INFINITY;
    }
    if (
      !['dashboard:join', 'dashboard:leave'].includes(event) ||
      payloadSize > MAX_REALTIME_MESSAGE_BYTES
    ) {
      if (isAcknowledgement(acknowledgement)) {
        acknowledgement({ ok: false, error: 'Invalid request.' });
      }
      socket.disconnect(true);
      return;
    }

    const now = Date.now();
    if (now - socket.data.messageWindowStartedAt >= MESSAGE_WINDOW_MS) {
      socket.data.messageWindowStartedAt = now;
      socket.data.messageCount = 0;
    }
    socket.data.messageCount += 1;
    if (socket.data.messageCount > MAX_MESSAGES_PER_WINDOW) {
      if (isAcknowledgement(acknowledgement)) {
        acknowledgement({ ok: false, error: 'Message rate limit exceeded.' });
      }
      socket.disconnect(true);
    }
  }

  private async joinDashboard(
    socket: DashboardSocket,
    payload: unknown,
    acknowledgement?: unknown,
  ): Promise<void> {
    if (socket.disconnected) return;
    const acknowledge = this.getAcknowledgement(acknowledgement);
    const parsed = eventPayloadSchema.safeParse(payload);
    if (!parsed.success) {
      acknowledge?.({ ok: false, error: 'Invalid request.' });
      return;
    }
    const { eventId } = parsed.data;
    if (!(await this.repository.canJoin(eventId, socket.data.session.principal))) {
      acknowledge?.({ ok: false, error: 'Event not found.' });
      return;
    }
    if (
      !socket.data.joinedEventIds.has(eventId) &&
      socket.data.joinedEventIds.size >= MAX_EVENT_ROOMS_PER_CONNECTION
    ) {
      acknowledge?.({ ok: false, error: 'Too many event rooms.' });
      return;
    }

    const snapshot = await this.repository.snapshot(eventId);
    if (!snapshot) {
      acknowledge?.({ ok: false, error: 'Event not found.' });
      return;
    }
    await socket.join(roomName(eventId));
    socket.data.joinedEventIds.add(eventId);
    acknowledge?.({ ok: true, data: snapshot });
  }

  private async leaveDashboard(
    socket: DashboardSocket,
    payload: unknown,
    acknowledgement?: unknown,
  ): Promise<void> {
    if (socket.disconnected) return;
    const acknowledge = this.getAcknowledgement(acknowledgement);
    const parsed = eventPayloadSchema.safeParse(payload);
    if (!parsed.success) {
      acknowledge?.({ ok: false, error: 'Invalid request.' });
      return;
    }
    await socket.leave(roomName(parsed.data.eventId));
    socket.data.joinedEventIds.delete(parsed.data.eventId);
    acknowledge?.({ ok: true });
  }

  private async recheckConnections(): Promise<void> {
    for (const socket of this.namespace.sockets.values() as IterableIterator<DashboardSocket>) {
      try {
        const sessionActive = await this.auth.isAccessSessionActive(socket.data.session);
        if (!sessionActive) {
          socket.disconnect(true);
          continue;
        }
        for (const eventId of socket.data.joinedEventIds) {
          if (!(await this.repository.canJoin(eventId, socket.data.session.principal))) {
            await socket.leave(roomName(eventId));
            socket.data.joinedEventIds.delete(eventId);
            socket.emit('dashboard:access-revoked', { eventId });
          }
        }
      } catch {
        this.logger.error('Could not revalidate a Socket.IO session or room membership.');
        socket.disconnect(true);
      }
    }
  }

  private async renewConnections(): Promise<void> {
    for (const socket of this.namespace.sockets.values() as IterableIterator<DashboardSocket>) {
      try {
        const renewed = await this.rateLimit.refreshSocketConnection(
          socket.data.session.principal.id,
          socket.id,
          CONNECTION_LEASE_MS,
        );
        if (!renewed) {
          socket.disconnect(true);
        }
      } catch {
        this.logger.error('Could not renew a Socket.IO connection lease.');
        socket.disconnect(true);
      }
    }
  }

  private handleSessionRevocation(message: string): void {
    let parsedMessage: unknown;
    try {
      parsedMessage = JSON.parse(message);
    } catch {
      this.logger.error('Received an invalid session revocation message.');
      return;
    }
    const parsed = revocationSchema.safeParse(parsedMessage);
    if (!parsed.success) {
      this.logger.error('Received an invalid session revocation message.');
      return;
    }
    for (const socket of this.namespace.sockets.values() as IterableIterator<DashboardSocket>) {
      if (
        ('familyId' in parsed.data && socket.data.session.familyId === parsed.data.familyId) ||
        ('userId' in parsed.data && socket.data.session.principal.id === parsed.data.userId)
      ) {
        socket.disconnect(true);
      }
    }
  }

  private getAcknowledgement(value: unknown): Acknowledgement | undefined {
    return isAcknowledgement(value) ? value : undefined;
  }
}
