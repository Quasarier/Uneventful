import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import type { Job } from 'bullmq';
import { isUUID } from 'class-validator';
import { RSVP_PROMOTION_JOB, RSVP_PROMOTION_QUEUE } from './rsvp-queue.constants';
import { RsvpsRepository } from './rsvps.repository';

@Injectable()
@Processor(RSVP_PROMOTION_QUEUE)
export class RsvpPromotionProcessor extends WorkerHost {
  constructor(private readonly repository: RsvpsRepository) {
    super();
  }

  async process(job: Job<{ eventId: string; outboxId: string }>): Promise<void> {
    if (
      job.name !== RSVP_PROMOTION_JOB ||
      !isUUID(job.data?.eventId) ||
      !isUUID(job.data?.outboxId)
    ) {
      throw new Error('Invalid RSVP promotion job.');
    }

    await this.repository.promoteNextWaitlisted(job.data.eventId, job.data.outboxId);
  }
}
