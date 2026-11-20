import type { Job } from 'bullmq';
import { describe, expect, it, vi } from 'vitest';
import { RsvpPromotionProcessor } from './rsvp-promotion.processor';
import { RSVP_PROMOTION_JOB } from './rsvp-queue.constants';
import { RsvpsRepository } from './rsvps.repository';

describe('RsvpPromotionProcessor', () => {
  it('promotes waitlisted users for a valid queued job', async () => {
    const repository = {
      promoteNextWaitlisted: vi.fn().mockResolvedValue(undefined),
    } as unknown as RsvpsRepository;
    const processor = new RsvpPromotionProcessor(repository);
    const eventId = '4a75d204-15d7-4e31-bd8b-561fb1fd1619';
    const outboxId = '52f8a091-799c-4f90-bd7f-7c48266d45f1';
    const job = {
      name: RSVP_PROMOTION_JOB,
      data: { eventId, outboxId },
    } as Job<{ eventId: string; outboxId: string }>;

    await processor.process(job);

    expect(repository.promoteNextWaitlisted).toHaveBeenCalledWith(eventId, outboxId);
  });

  it('rejects malformed or unexpected jobs', async () => {
    const repository = {
      promoteNextWaitlisted: vi.fn(),
    } as unknown as RsvpsRepository;
    const processor = new RsvpPromotionProcessor(repository);
    const job = {
      name: RSVP_PROMOTION_JOB,
      data: { eventId: 'not-an-id', outboxId: 'also-not-an-id' },
    } as Job<{ eventId: string; outboxId: string }>;

    await expect(processor.process(job)).rejects.toThrow('Invalid RSVP promotion job.');
    expect(repository.promoteNextWaitlisted).not.toHaveBeenCalled();
  });
});
