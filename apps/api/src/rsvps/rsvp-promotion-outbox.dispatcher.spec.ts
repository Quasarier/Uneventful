import type { Queue } from 'bullmq';
import { describe, expect, it, vi } from 'vitest';
import { PrismaService } from '../database/prisma.service';
import { RSVP_PROMOTION_JOB } from './rsvp-queue.constants';
import { RsvpPromotionOutboxDispatcher } from './rsvp-promotion-outbox.dispatcher';

describe('RsvpPromotionOutboxDispatcher', () => {
  it('enqueues durable promotion records with idempotent BullMQ job IDs', async () => {
    const record = {
      id: '52f8a091-799c-4f90-bd7f-7c48266d45f1',
      eventId: '4a75d204-15d7-4e31-bd8b-561fb1fd1619',
    };
    const prisma = {
      rsvpPromotionOutbox: {
        findMany: vi.fn().mockResolvedValue([record]),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
    } as unknown as PrismaService;
    const queue = { add: vi.fn().mockResolvedValue(undefined) } as unknown as Queue;
    const dispatcher = new RsvpPromotionOutboxDispatcher(prisma, queue);

    await dispatcher.dispatchPending();

    expect(queue.add).toHaveBeenCalledWith(
      RSVP_PROMOTION_JOB,
      { eventId: record.eventId, outboxId: record.id },
      expect.objectContaining({
        jobId: record.id,
        attempts: 5,
        backoff: { type: 'exponential', delay: 1_000 },
      }),
    );
    expect(prisma.rsvpPromotionOutbox.updateMany).toHaveBeenCalledWith({
      where: { id: record.id, dispatchedAt: null },
      data: { dispatchedAt: expect.any(Date) },
    });
  });

  it('leaves an outbox record pending when Redis cannot enqueue it', async () => {
    const prisma = {
      rsvpPromotionOutbox: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: '52f8a091-799c-4f90-bd7f-7c48266d45f1',
            eventId: '4a75d204-15d7-4e31-bd8b-561fb1fd1619',
          },
        ]),
        updateMany: vi.fn(),
      },
    } as unknown as PrismaService;
    const queue = {
      add: vi.fn().mockRejectedValue(new Error('redis unavailable')),
    } as unknown as Queue;
    const dispatcher = new RsvpPromotionOutboxDispatcher(prisma, queue);

    await expect(dispatcher.dispatchPending()).rejects.toThrow('redis unavailable');
    expect(prisma.rsvpPromotionOutbox.updateMany).not.toHaveBeenCalled();
  });
});
