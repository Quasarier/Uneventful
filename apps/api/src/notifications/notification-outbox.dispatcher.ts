import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import type { Queue } from 'bullmq';
import { NotificationDeliveryStatus } from '../../generated/prisma/client';
import { PrismaService } from '../database/prisma.service';
import {
  MAX_NOTIFICATION_JOB_ATTEMPTS,
  NOTIFICATION_DELIVERY_JOB,
  NOTIFICATION_DELIVERY_LEASE_MS,
  NOTIFICATION_DELIVERY_QUEUE,
  NOTIFICATION_OUTBOX_POLL_INTERVAL_MS,
  NOTIFICATION_RETRY_DELAY_MS,
} from './notification.constants';

@Injectable()
export class NotificationOutboxDispatcher implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(NotificationOutboxDispatcher.name);
  private timer: NodeJS.Timeout | undefined;
  private dispatching = false;

  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue(NOTIFICATION_DELIVERY_QUEUE)
    private readonly queue: Queue,
  ) {}

  onModuleInit(): void {
    this.timer = setInterval(() => {
      void this.dispatchPending().catch(() => {
        this.logger.error('Unable to dispatch notification jobs; they remain pending.');
      });
    }, NOTIFICATION_OUTBOX_POLL_INTERVAL_MS);
    this.timer.unref();
    void this.dispatchPending().catch(() => {
      this.logger.error('Unable to dispatch notification jobs; they remain pending.');
    });
  }

  onModuleDestroy(): void {
    if (this.timer) {
      clearInterval(this.timer);
    }
  }

  async dispatchPending(): Promise<void> {
    if (this.dispatching) {
      return;
    }
    this.dispatching = true;
    try {
      const now = new Date();
      const pending = await this.prisma.notificationDelivery.findMany({
        where: {
          OR: [
            { status: NotificationDeliveryStatus.PENDING, availableAt: { lte: now } },
            {
              status: NotificationDeliveryStatus.PROCESSING,
              lockedAt: { lt: new Date(now.getTime() - NOTIFICATION_DELIVERY_LEASE_MS) },
            },
          ],
        },
        orderBy: [{ availableAt: 'asc' }, { id: 'asc' }],
        take: 100,
        select: { id: true, availableAt: true },
      });
      for (const delivery of pending) {
        await this.queue.add(
          NOTIFICATION_DELIVERY_JOB,
          { deliveryId: delivery.id },
          {
            jobId: `notification_${delivery.id}_${delivery.availableAt.getTime()}`,
            attempts: MAX_NOTIFICATION_JOB_ATTEMPTS,
            backoff: { type: 'exponential', delay: NOTIFICATION_RETRY_DELAY_MS },
            removeOnComplete: true,
            removeOnFail: 1_000,
          },
        );
      }
    } finally {
      this.dispatching = false;
    }
  }
}
