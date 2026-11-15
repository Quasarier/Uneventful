import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import type { Queue } from 'bullmq';
import { PrismaService } from '../database/prisma.service';
import { RSVP_PROMOTION_JOB, RSVP_PROMOTION_QUEUE } from './rsvp-queue.constants';

@Injectable()
export class RsvpPromotionOutboxDispatcher implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RsvpPromotionOutboxDispatcher.name);
  private timer: NodeJS.Timeout | undefined;
  private dispatching = false;

  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue(RSVP_PROMOTION_QUEUE)
    private readonly queue: Queue,
  ) {}

  onModuleInit(): void {
    this.timer = setInterval(() => {
      void this.dispatchPending().catch(() => {
        this.logger.error('Unable to dispatch RSVP promotion jobs; they remain pending.');
      });
    }, 5_000);
    this.timer.unref();
    void this.dispatchPending().catch(() => {
      this.logger.error('Unable to dispatch RSVP promotion jobs; they remain pending.');
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
      const pending = await this.prisma.rsvpPromotionOutbox.findMany({
        where: { dispatchedAt: null },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        take: 100,
      });
      for (const record of pending) {
        await this.queue.add(
          RSVP_PROMOTION_JOB,
          { eventId: record.eventId, outboxId: record.id },
          {
            jobId: record.id,
            attempts: 5,
            backoff: { type: 'exponential', delay: 1_000 },
            removeOnComplete: 1_000,
            removeOnFail: 1_000,
          },
        );
        await this.prisma.rsvpPromotionOutbox.updateMany({
          where: { id: record.id, dispatchedAt: null },
          data: { dispatchedAt: new Date() },
        });
      }
    } finally {
      this.dispatching = false;
    }
  }
}
