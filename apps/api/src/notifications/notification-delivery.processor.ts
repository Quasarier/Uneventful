import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Job } from 'bullmq';
import { isUUID } from 'class-validator';
import {
  MAX_NOTIFICATION_JOB_ATTEMPTS,
  NOTIFICATION_DELIVERY_JOB,
  NOTIFICATION_DELIVERY_QUEUE,
} from './notification.constants';
import { NotificationDeliveryService } from './notification-delivery.service';

@Injectable()
@Processor(NOTIFICATION_DELIVERY_QUEUE)
export class NotificationDeliveryProcessor extends WorkerHost {
  private readonly logger = new Logger(NotificationDeliveryProcessor.name);

  constructor(
    @Inject(NotificationDeliveryService)
    private readonly deliveryService: NotificationDeliveryService,
  ) {
    super();
  }

  async process(job: Job<{ deliveryId: string }>): Promise<void> {
    if (job.name !== NOTIFICATION_DELIVERY_JOB || !isUUID(job.data?.deliveryId)) {
      throw new Error('Invalid notification delivery job.');
    }
    await this.deliveryService.deliver(job.data.deliveryId);
  }

  @OnWorkerEvent('failed')
  async onFailed(job: Job<{ deliveryId: string }> | undefined): Promise<void> {
    if (
      !job ||
      job.name !== NOTIFICATION_DELIVERY_JOB ||
      !isUUID(job.data?.deliveryId) ||
      job.attemptsMade < (job.opts.attempts ?? MAX_NOTIFICATION_JOB_ATTEMPTS)
    ) {
      return;
    }
    await this.deliveryService.markDeadLettered(job.data.deliveryId);
    this.logger.error('A notification delivery was dead-lettered after retry exhaustion.');
  }
}
