import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Environment } from '../config/environment';
import { AuthRateLimitModule } from '../auth/auth-rate-limit.module';
import { DatabaseModule } from '../database/database.module';
import { AppConfigModule } from '../config/config.module';
import {
  LocalEmailProvider,
  NOTIFICATION_EMAIL_PROVIDER,
  ResendEmailProvider,
} from './email-provider';
import { NOTIFICATION_DELIVERY_QUEUE } from './notification.constants';
import { NotificationDeliveryProcessor } from './notification-delivery.processor';
import { NotificationDeliveryService } from './notification-delivery.service';
import { NotificationOutboxDispatcher } from './notification-outbox.dispatcher';
import { NotificationsController } from './notifications.controller';
import { NotificationsService, PUSH_HOST_LOOKUP } from './notifications.service';
import { resolvePushHost } from './push-endpoint';
import { NOTIFICATION_PUSH_PROVIDER, VapidPushProvider } from './web-push-provider';
import { UnsubscribeService } from './unsubscribe.service';

@Module({
  imports: [
    AppConfigModule,
    AuthRateLimitModule,
    DatabaseModule,
    BullModule.registerQueue({ name: NOTIFICATION_DELIVERY_QUEUE }),
  ],
  controllers: [NotificationsController],
  providers: [
    LocalEmailProvider,
    ResendEmailProvider,
    {
      provide: NOTIFICATION_EMAIL_PROVIDER,
      inject: [ConfigService, LocalEmailProvider, ResendEmailProvider],
      useFactory: (
        config: ConfigService<Environment, true>,
        local: LocalEmailProvider,
        resend: ResendEmailProvider,
      ) =>
        config.get('NOTIFICATION_EMAIL_PROVIDER', { infer: true }) === 'resend' ? resend : local,
    },
    VapidPushProvider,
    { provide: NOTIFICATION_PUSH_PROVIDER, useExisting: VapidPushProvider },
    { provide: PUSH_HOST_LOOKUP, useValue: resolvePushHost },
    NotificationsService,
    UnsubscribeService,
    NotificationDeliveryService,
    NotificationDeliveryProcessor,
    NotificationOutboxDispatcher,
  ],
  exports: [NotificationsService, UnsubscribeService, NotificationDeliveryService],
})
export class NotificationsModule {}
