import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppConfigModule } from '../config/config.module';
import type { Environment } from '../config/environment';
import { AuthRateLimitModule } from '../auth/auth-rate-limit.module';
import { DatabaseModule } from '../database/database.module';
import { RsvpPromotionOutboxDispatcher } from './rsvp-promotion-outbox.dispatcher';
import { RsvpPromotionProcessor } from './rsvp-promotion.processor';
import { RSVP_PROMOTION_QUEUE } from './rsvp-queue.constants';
import { CheckinsController } from './checkins.controller';
import { CheckinsRepository } from './checkins.repository';
import { CheckinsService } from './checkins.service';
import { MyRsvpsController } from './my-rsvps.controller';
import { RsvpsController } from './rsvps.controller';
import { RsvpsRepository } from './rsvps.repository';
import { RsvpsService } from './rsvps.service';
import { TicketSigningService } from './ticket-signing.service';

function redisConnection(redisUrl: string) {
  const url = new URL(redisUrl);
  const database = url.pathname.length > 1 ? Number(url.pathname.slice(1)) : undefined;
  return {
    host: url.hostname.replace(/^\[|\]$/g, ''),
    port: url.port ? Number(url.port) : url.protocol === 'rediss:' ? 6380 : 6379,
    ...(url.username ? { username: decodeURIComponent(url.username) } : {}),
    ...(url.password ? { password: decodeURIComponent(url.password) } : {}),
    ...(database !== undefined ? { db: database } : {}),
    maxRetriesPerRequest: null,
    ...(url.protocol === 'rediss:' ? { tls: {} } : {}),
  };
}

@Module({
  imports: [
    AppConfigModule,
    AuthRateLimitModule,
    DatabaseModule,
    BullModule.forRootAsync({
      imports: [AppConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService<Environment, true>) => ({
        connection: redisConnection(config.get('REDIS_URL', { infer: true })),
      }),
    }),
    BullModule.registerQueue({ name: RSVP_PROMOTION_QUEUE }),
  ],
  controllers: [RsvpsController, MyRsvpsController, CheckinsController],
  providers: [
    RsvpsRepository,
    RsvpsService,
    CheckinsRepository,
    CheckinsService,
    TicketSigningService,
    RsvpPromotionProcessor,
    RsvpPromotionOutboxDispatcher,
  ],
})
export class RsvpsModule {}
