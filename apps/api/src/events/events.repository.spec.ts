import { EventStatus, type Prisma } from '../../generated/prisma/client';
import { describe, expect, it, vi } from 'vitest';
import { PrismaService } from '../database/prisma.service';
import { EventsRepository } from './events.repository';

const event = {
  id: 'c5a59258-67d1-457a-a93f-e7993f31befa',
  status: EventStatus.PENDING_APPROVAL,
  club: { id: '7c683bc4-2911-4f4d-aa95-167fd0dd9a32', name: 'Robotics', slug: 'robotics' },
  category: { id: '65cad59a-8af7-4e8d-a527-1fe0eccf26da', name: 'Workshop', slug: 'workshop' },
};

describe('EventsRepository audit transactions', () => {
  it('records event creation together with the initial state audit', async () => {
    const transaction = {
      event: { create: vi.fn().mockResolvedValue({ ...event, status: EventStatus.DRAFT }) },
      auditLog: { create: vi.fn().mockResolvedValue({}) },
    };
    const prisma = {
      $transaction: vi.fn((callback: (tx: typeof transaction) => Promise<unknown>) =>
        callback(transaction),
      ),
    };
    const repository = new EventsRepository(prisma as unknown as PrismaService);
    const actorId = '93b1a3e8-0dfd-4c8c-a0a5-1f1790730011';

    await repository.createEvent(
      { title: 'Campus meetup' } as Prisma.EventUncheckedCreateInput,
      actorId,
    );

    expect(transaction.auditLog.create).toHaveBeenCalledWith({
      data: {
        actorId,
        action: 'EVENT_CREATED',
        entityType: 'Event',
        entityId: event.id,
        metadata: { toStatus: EventStatus.DRAFT },
      },
    });
  });

  it('writes state updates and their audit records in the same transaction', async () => {
    const transaction = {
      event: {
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        findUnique: vi.fn().mockResolvedValue(event),
      },
      auditLog: { create: vi.fn().mockResolvedValue({}) },
    };
    const prisma = {
      $transaction: vi.fn((callback: (tx: typeof transaction) => Promise<unknown>) =>
        callback(transaction),
      ),
    };
    const repository = new EventsRepository(prisma as unknown as PrismaService);
    const actorId = '93b1a3e8-0dfd-4c8c-a0a5-1f1790730011';

    await repository.updateEvent(
      event.id,
      EventStatus.DRAFT,
      { status: EventStatus.PENDING_APPROVAL },
      actorId,
      {
        action: 'EVENT_SUBMITTED',
        metadata: { fromStatus: EventStatus.DRAFT, toStatus: EventStatus.PENDING_APPROVAL },
      },
    );

    expect(transaction.event.updateMany).toHaveBeenCalledOnce();
    expect(transaction.auditLog.create).toHaveBeenCalledWith({
      data: {
        actorId,
        action: 'EVENT_SUBMITTED',
        entityType: 'Event',
        entityId: event.id,
        metadata: { fromStatus: EventStatus.DRAFT, toStatus: EventStatus.PENDING_APPROVAL },
      },
    });
  });

  it('does not write an audit record when a concurrent state transition loses', async () => {
    const transaction = {
      event: {
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
        findUnique: vi.fn(),
      },
      auditLog: { create: vi.fn() },
    };
    const prisma = {
      $transaction: vi.fn((callback: (tx: typeof transaction) => Promise<unknown>) =>
        callback(transaction),
      ),
    };
    const repository = new EventsRepository(prisma as unknown as PrismaService);

    await expect(
      repository.updateEvent(
        event.id,
        EventStatus.DRAFT,
        { status: EventStatus.PENDING_APPROVAL },
        '93b1a3e8-0dfd-4c8c-a0a5-1f1790730011',
        { action: 'EVENT_SUBMITTED', metadata: { toStatus: EventStatus.PENDING_APPROVAL } },
      ),
    ).resolves.toBeNull();
    expect(transaction.auditLog.create).not.toHaveBeenCalled();
  });

  it('audits a confirmed replacement image that moves an approved event back to review', async () => {
    const transaction = {
      event: {
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        findUnique: vi.fn().mockResolvedValue({
          ...event,
          status: EventStatus.PENDING_APPROVAL,
        }),
      },
      auditLog: { create: vi.fn().mockResolvedValue({}) },
    };
    const prisma = {
      $transaction: vi.fn((callback: (tx: typeof transaction) => Promise<unknown>) =>
        callback(transaction),
      ),
    };
    const repository = new EventsRepository(prisma as unknown as PrismaService);
    const actorId = '93b1a3e8-0dfd-4c8c-a0a5-1f1790730011';
    const uploadKey = `event-uploads/staging/${event.id}/${actorId}.png`;
    const finalKey = `events/${event.id}/${actorId}.png`;

    await repository.completeImageUpload(
      event.id,
      uploadKey,
      finalKey,
      new Date(),
      EventStatus.APPROVED,
      actorId,
      true,
    );

    expect(transaction.event.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: EventStatus.APPROVED,
          pendingImageKey: uploadKey,
          pendingImageOwnerId: actorId,
        }),
        data: expect.objectContaining({
          status: EventStatus.PENDING_APPROVAL,
          imageKey: finalKey,
          approvedById: null,
        }),
      }),
    );
    expect(transaction.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        actorId,
        action: 'EVENT_IMAGE_CHANGED_REQUIRES_APPROVAL',
        entityType: 'Event',
        entityId: event.id,
        metadata: { fromStatus: EventStatus.APPROVED, toStatus: EventStatus.PENDING_APPROVAL },
      }),
    });
  });
});
