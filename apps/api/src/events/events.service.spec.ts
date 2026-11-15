import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { EventStatus } from '../../generated/prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthPrincipal } from '../auth/auth.types';
import type { EventRecord, EventsRepository } from './events.repository';
import type { EventImageStorageService } from './event-image-storage.service';
import { ListEventsDto } from './dto/list-events.dto';
import { EventsService } from './events.service';

const userId = '93b1a3e8-0dfd-4c8c-a0a5-1f1790730011';
const otherUserId = '9bdcf6c8-6ab5-4c7f-9f7d-4560192ed7b8';
const clubId = '7c683bc4-2911-4f4d-aa95-167fd0dd9a32';
const categoryId = '65cad59a-8af7-4e8d-a527-1fe0eccf26da';
const eventId = 'c5a59258-67d1-457a-a93f-e7993f31befa';
const startAt = new Date('2027-03-01T10:00:00.000Z');
const endAt = new Date('2027-03-01T12:00:00.000Z');

function principal(role: AuthPrincipal['role'], id = userId): AuthPrincipal {
  return { id, role, tokenVersion: 0 };
}

function makeEvent(
  status: EventStatus = EventStatus.DRAFT,
  overrides: Partial<EventRecord> = {},
): EventRecord {
  return {
    id: eventId,
    title: 'Campus meetup',
    slug: 'campus-meetup-a1b2c3d4e5f6',
    description: '<p>Meet students</p>',
    status,
    startAt,
    endAt,
    timeZone: 'UTC',
    capacity: 100,
    isPublic: true,
    clubId,
    categoryId,
    createdById: userId,
    approvedById: status === EventStatus.APPROVED ? userId : null,
    approvedAt: status === EventStatus.APPROVED ? startAt : null,
    rejectionReason: status === EventStatus.REJECTED ? 'Please revise.' : null,
    imageKey: null,
    pendingImageKey: null,
    pendingImageExpiresAt: null,
    pendingImageOwnerId: null,
    deletedAt: null,
    createdAt: startAt,
    updatedAt: startAt,
    club: { id: clubId, name: 'Robotics Club', slug: 'robotics' },
    category: { id: categoryId, name: 'Workshop', slug: 'workshop' },
    ...overrides,
  } as EventRecord;
}

describe('EventsService authorization and workflow', () => {
  let service: EventsService;
  let repository: {
    isActiveClub: ReturnType<typeof vi.fn>;
    clubExists: ReturnType<typeof vi.fn>;
    isActiveCategory: ReturnType<typeof vi.fn>;
    hasActiveMembership: ReturnType<typeof vi.fn>;
    activeMembershipClubIds: ReturnType<typeof vi.fn>;
    findEvent: ReturnType<typeof vi.fn>;
    listEvents: ReturnType<typeof vi.fn>;
    createEvent: ReturnType<typeof vi.fn>;
    updateEvent: ReturnType<typeof vi.fn>;
    startImageUpload: ReturnType<typeof vi.fn>;
    completeImageUpload: ReturnType<typeof vi.fn>;
  };
  let storage: {
    createUploadForm: ReturnType<typeof vi.fn>;
    sanitizeAndStoreUploadedObject: ReturnType<typeof vi.fn>;
    getFinalImage: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    repository = {
      isActiveClub: vi.fn().mockResolvedValue(true),
      clubExists: vi.fn().mockResolvedValue(true),
      isActiveCategory: vi.fn().mockResolvedValue(true),
      hasActiveMembership: vi.fn().mockResolvedValue(true),
      activeMembershipClubIds: vi.fn().mockResolvedValue(new Set()),
      findEvent: vi.fn().mockResolvedValue(makeEvent()),
      listEvents: vi.fn().mockResolvedValue({ events: [], total: 0 }),
      createEvent: vi.fn().mockResolvedValue(makeEvent()),
      updateEvent: vi.fn().mockResolvedValue(makeEvent()),
      startImageUpload: vi.fn().mockResolvedValue(makeEvent()),
      completeImageUpload: vi.fn().mockResolvedValue(makeEvent()),
    };
    storage = {
      createUploadForm: vi
        .fn()
        .mockResolvedValue({ url: 'https://storage.example/upload', fields: {} }),
      sanitizeAndStoreUploadedObject: vi.fn().mockResolvedValue(undefined),
      getFinalImage: vi.fn().mockResolvedValue({
        body: Buffer.from('image'),
        contentType: 'image/png',
        extension: 'png',
      }),
    };
    service = new EventsService(
      repository as unknown as EventsRepository,
      storage as unknown as EventImageStorageService,
    );
  });

  it('lets students list only approved events and applies the query filters', async () => {
    repository.listEvents.mockResolvedValue({
      events: [makeEvent(EventStatus.APPROVED)],
      total: 31,
    });
    const result = await service.list(principal('STUDENT'), {
      page: 2,
      limit: 10,
      categoryId,
      clubId,
      startDate: '2027-03-01T00:00:00.000Z',
      endDate: '2027-03-02T00:00:00.000Z',
      q: 'meetup',
    });

    expect(result).toMatchObject({ page: 2, limit: 10, total: 31, totalPages: 4 });
    expect(repository.listEvents).toHaveBeenCalledWith(
      {
        AND: expect.arrayContaining([
          { deletedAt: null },
          { status: EventStatus.APPROVED, isPublic: true },
          { categoryId },
          { clubId },
          {
            startAt: {
              gte: new Date('2027-03-01T00:00:00.000Z'),
              lte: new Date('2027-03-02T00:00:00.000Z'),
            },
          },
          {
            OR: [
              { title: { contains: 'meetup', mode: 'insensitive' } },
              { description: { contains: 'meetup', mode: 'insensitive' } },
            ],
          },
        ]),
      },
      2,
      10,
    );
  });

  it('treats a date-only endDate as inclusive of that full UTC day', async () => {
    await service.list(principal('ADMIN'), {
      page: 1,
      limit: 20,
      endDate: '2027-03-01',
    });

    expect(repository.listEvents).toHaveBeenCalledWith(
      {
        AND: [{ deletedAt: null }, { startAt: { lt: new Date('2027-03-02T00:00:00.000Z') } }],
      },
      1,
      20,
    );
  });

  it('limits organizer global visibility to public approved events plus member-club events', async () => {
    await service.list(principal('ORGANIZER'), { page: 1, limit: 20 });

    expect(repository.listEvents).toHaveBeenCalledWith(
      {
        AND: [
          { deletedAt: null },
          {
            OR: [
              { status: EventStatus.APPROVED, isPublic: true },
              {
                club: {
                  is: {
                    deletedAt: null,
                    memberships: {
                      some: {
                        userId,
                        status: 'ACTIVE',
                        user: { isActive: true, deletedAt: null },
                      },
                    },
                  },
                },
              },
            ],
          },
        ],
      },
      1,
      20,
    );
  });

  it('uses bounded pagination defaults when DTO transformation is unavailable', async () => {
    const query = Object.assign(new ListEventsDto(), { page: undefined, limit: undefined });

    await expect(service.list(principal('ADMIN'), query)).resolves.toMatchObject({
      page: 1,
      limit: 20,
      totalPages: 0,
    });
    expect(repository.listEvents).toHaveBeenCalledWith({ AND: [{ deletedAt: null }] }, 1, 20);
  });

  it('rejects invalid date ranges', async () => {
    await expect(
      service.list(principal('ADMIN'), {
        page: 1,
        limit: 20,
        startDate: '2027-03-02T00:00:00.000Z',
        endDate: '2027-03-01T00:00:00.000Z',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.create(principal('ADMIN'), {
        title: 'Invalid time zone',
        description: 'Details',
        startAt: startAt.toISOString(),
        endAt: endAt.toISOString(),
        timeZone: 'not/a-real-zone',
        isPublic: true,
        clubId,
        categoryId,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('allows organizers to create only for active member clubs and allows admins without membership', async () => {
    const dto = {
      title: 'Campus meetup',
      description:
        '<p>Meet <script>alert(1)</script><a href="javascript:alert(1)">students</a></p>',
      startAt: startAt.toISOString(),
      endAt: endAt.toISOString(),
      timeZone: 'UTC',
      capacity: 100,
      isPublic: true,
      clubId,
      categoryId,
    };

    repository.hasActiveMembership.mockResolvedValue(false);
    await expect(service.create(principal('STUDENT'), dto)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    await expect(service.create(principal('ORGANIZER'), dto)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(repository.createEvent).not.toHaveBeenCalled();

    await service.create(principal('ADMIN'), dto);
    const [createData] = repository.createEvent.mock.calls[0] as [
      { description: string; createdById: string },
    ];
    expect(createData.description).not.toContain('script');
    expect(createData.description).not.toContain('javascript:');
    expect(createData.createdById).toBe(userId);

    repository.hasActiveMembership.mockResolvedValue(true);
    await service.create(principal('ORGANIZER'), dto);
    expect(repository.createEvent).toHaveBeenCalledTimes(2);
  });

  it('allows students to read approved events only and scopes organizer reads to memberships', async () => {
    repository.findEvent.mockResolvedValue(makeEvent(EventStatus.PENDING_APPROVAL));
    await expect(service.get(principal('STUDENT'), eventId)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(service.get(principal('ORGANIZER'), eventId)).resolves.toMatchObject({
      status: EventStatus.PENDING_APPROVAL,
    });

    repository.hasActiveMembership.mockResolvedValue(false);
    await expect(service.get(principal('ORGANIZER'), eventId)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(service.get(principal('ADMIN'), eventId)).resolves.toMatchObject({
      status: EventStatus.PENDING_APPROVAL,
    });

    repository.findEvent.mockResolvedValue(makeEvent(EventStatus.APPROVED));
    await expect(service.get(principal('STUDENT'), eventId)).resolves.toMatchObject({
      status: EventStatus.APPROVED,
    });
    repository.findEvent.mockResolvedValue(makeEvent(EventStatus.APPROVED, { isPublic: false }));
    await expect(service.get(principal('STUDENT'), eventId)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    repository.hasActiveMembership.mockResolvedValue(false);
    await expect(service.get(principal('ORGANIZER'), eventId)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    repository.hasActiveMembership.mockResolvedValue(true);
    await expect(service.get(principal('ORGANIZER'), eventId)).resolves.toMatchObject({
      status: EventStatus.APPROVED,
      isPublic: false,
    });
  });

  it('returns only explicitly whitelisted event response fields', async () => {
    repository.findEvent.mockResolvedValue(
      makeEvent(EventStatus.APPROVED, {
        imageKey: 'private-storage-key',
        pendingImageKey: 'pending-storage-key',
        pendingImageOwnerId: otherUserId,
        pendingImageExpiresAt: endAt,
      }),
    );

    const result = await service.get(principal('STUDENT'), eventId);

    expect(Object.keys(result).sort()).toEqual(
      [
        'id',
        'title',
        'slug',
        'description',
        'status',
        'startAt',
        'endAt',
        'timeZone',
        'capacity',
        'isPublic',
        'clubId',
        'categoryId',
        'rejectionReason',
        'createdAt',
        'updatedAt',
        'hasImage',
        'club',
        'category',
      ].sort(),
    );
    expect(result).not.toHaveProperty('createdById');
    expect(result).not.toHaveProperty('approvedById');
    expect(result).not.toHaveProperty('imageKey');
    expect(result).not.toHaveProperty('pendingImageKey');
    expect(result).not.toHaveProperty('pendingImageOwnerId');
    expect(result.club).toEqual({ name: 'Robotics Club', slug: 'robotics' });
    expect(result.category).toEqual({ name: 'Workshop', slug: 'workshop' });
  });

  it('denies student and non-member updates, while an admin can edit any event', async () => {
    await expect(
      service.update(principal('STUDENT'), eventId, { title: 'New title' }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    repository.hasActiveMembership.mockResolvedValue(false);
    await expect(
      service.update(principal('ORGANIZER'), eventId, { title: 'New title' }),
    ).rejects.toBeInstanceOf(NotFoundException);
    await service.update(principal('ADMIN'), eventId, { title: 'New title' });
    expect(repository.updateEvent).toHaveBeenCalledOnce();
  });

  it('allows admins to manage existing events after their club is soft-deleted', async () => {
    repository.isActiveClub.mockResolvedValue(false);

    await service.cancel(principal('ADMIN'), eventId);

    expect(repository.clubExists).toHaveBeenCalledWith(clubId);
    expect(repository.updateEvent).toHaveBeenCalledOnce();
  });

  it('moves an approved event back to review and audits that state change', async () => {
    repository.findEvent.mockResolvedValue(makeEvent(EventStatus.APPROVED));
    repository.updateEvent.mockResolvedValue(makeEvent(EventStatus.PENDING_APPROVAL));

    await service.update(principal('ORGANIZER'), eventId, { title: 'Updated title' });

    expect(repository.updateEvent).toHaveBeenCalledWith(
      eventId,
      EventStatus.APPROVED,
      expect.objectContaining({ status: EventStatus.PENDING_APPROVAL, approvedById: null }),
      userId,
      {
        action: 'EVENT_UPDATED_REQUIRES_APPROVAL',
        metadata: { fromStatus: EventStatus.APPROVED, toStatus: EventStatus.PENDING_APPROVAL },
      },
    );
  });

  it('restricts submit, approve, reject, and cancel by role and club membership', async () => {
    await expect(service.submit(principal('STUDENT'), eventId)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    repository.hasActiveMembership.mockResolvedValue(false);
    await expect(service.submit(principal('ORGANIZER'), eventId)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(service.cancel(principal('ORGANIZER'), eventId)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(service.approve(principal('STUDENT'), eventId)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    await expect(
      service.reject(principal('ORGANIZER'), eventId, { reason: 'Reason' }),
    ).rejects.toBeInstanceOf(ForbiddenException);

    repository.hasActiveMembership.mockResolvedValue(true);
    repository.updateEvent.mockResolvedValue(makeEvent(EventStatus.PENDING_APPROVAL));
    await service.submit(principal('ORGANIZER'), eventId);
    expect(repository.updateEvent).toHaveBeenCalledWith(
      eventId,
      EventStatus.DRAFT,
      expect.objectContaining({ status: EventStatus.PENDING_APPROVAL }),
      userId,
      expect.objectContaining({ action: 'EVENT_SUBMITTED' }),
    );

    repository.findEvent.mockResolvedValue(makeEvent(EventStatus.PENDING_APPROVAL));
    repository.updateEvent.mockResolvedValue(makeEvent(EventStatus.APPROVED));
    await service.approve(principal('ADMIN', otherUserId), eventId);
    expect(repository.updateEvent).toHaveBeenLastCalledWith(
      eventId,
      EventStatus.PENDING_APPROVAL,
      expect.objectContaining({ status: EventStatus.APPROVED, approvedById: otherUserId }),
      otherUserId,
      expect.objectContaining({ action: 'EVENT_APPROVED' }),
    );

    repository.updateEvent.mockResolvedValue(makeEvent(EventStatus.REJECTED));
    await service.reject(principal('ADMIN'), eventId, { reason: 'Missing details' });
    expect(repository.updateEvent).toHaveBeenLastCalledWith(
      eventId,
      EventStatus.PENDING_APPROVAL,
      expect.objectContaining({ status: EventStatus.REJECTED, rejectionReason: 'Missing details' }),
      userId,
      expect.objectContaining({
        action: 'EVENT_REJECTED',
        metadata: expect.objectContaining({ reason: 'Missing details' }),
      }),
    );

    repository.findEvent.mockResolvedValue(makeEvent(EventStatus.APPROVED));
    repository.updateEvent.mockResolvedValue(makeEvent(EventStatus.CANCELLED));
    await service.cancel(principal('ADMIN'), eventId);
    expect(repository.updateEvent).toHaveBeenLastCalledWith(
      eventId,
      EventStatus.APPROVED,
      expect.objectContaining({ status: EventStatus.CANCELLED }),
      userId,
      expect.objectContaining({ action: 'EVENT_CANCELLED' }),
    );
  });

  it('prevents an event creator from approving their own submission', async () => {
    repository.findEvent.mockResolvedValue(
      makeEvent(EventStatus.PENDING_APPROVAL, { createdById: userId }),
    );

    await expect(service.approve(principal('ADMIN'), eventId)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(repository.updateEvent).not.toHaveBeenCalled();
  });

  it('rejects invalid event time ranges and prevents workflow transitions from invalid states', async () => {
    await expect(
      service.create(principal('ADMIN'), {
        title: 'Invalid time',
        description: 'Details',
        startAt: endAt.toISOString(),
        endAt: startAt.toISOString(),
        timeZone: 'UTC',
        isPublic: true,
        clubId,
        categoryId,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    repository.findEvent.mockResolvedValue(makeEvent(EventStatus.PENDING_APPROVAL));
    await expect(service.submit(principal('ADMIN'), eventId)).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it('creates a bounded image-upload form only for authorized club members', async () => {
    repository.hasActiveMembership.mockResolvedValue(false);
    await expect(
      service.createImageUpload(principal('STUDENT'), eventId, {
        contentType: 'image/png',
        size: 12,
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      service.createImageUpload(principal('ORGANIZER'), eventId, {
        contentType: 'image/png',
        size: 12,
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      service.createImageUpload(principal('ADMIN'), eventId, {
        contentType: 'image/png',
        size: 12,
      }),
    ).resolves.toMatchObject({ maxSizeBytes: 5 * 1024 * 1024 });

    repository.hasActiveMembership.mockResolvedValue(true);
    const result = await service.createImageUpload(principal('ORGANIZER'), eventId, {
      contentType: 'image/png',
      size: 12,
    });
    expect(result).toMatchObject({
      url: 'https://storage.example/upload',
      expiresIn: 300,
      maxSizeBytes: 5 * 1024 * 1024,
    });
    expect(repository.startImageUpload).toHaveBeenCalledWith(
      eventId,
      EventStatus.DRAFT,
      expect.stringMatching(new RegExp(`^event-uploads/staging/${eventId}/.+\\.png$`)),
      expect.any(Date),
      userId,
    );
    expect(storage.createUploadForm).toHaveBeenCalledWith(expect.any(String), 'image/png');
  });

  it('verifies image content before making the object available', async () => {
    const key = `event-uploads/staging/${eventId}/93b1a3e8-0dfd-4c8c-a0a5-1f1790730011.png`;
    repository.findEvent.mockResolvedValue(
      makeEvent(EventStatus.DRAFT, {
        pendingImageKey: key,
        pendingImageExpiresAt: new Date(Date.now() + 60_000),
        pendingImageOwnerId: userId,
      }),
    );
    repository.completeImageUpload.mockResolvedValue(
      makeEvent(EventStatus.DRAFT, { imageKey: `events/${eventId}/normalized.png` }),
    );

    const result = await service.confirmImageUpload(principal('ORGANIZER'), eventId);

    expect(storage.sanitizeAndStoreUploadedObject).toHaveBeenCalledWith(
      key,
      expect.stringMatching(new RegExp(`^events/${eventId}/.+\\.png$`)),
      'image/png',
    );
    expect(repository.completeImageUpload).toHaveBeenCalledWith(
      eventId,
      key,
      expect.stringMatching(new RegExp(`^events/${eventId}/.+\\.png$`)),
      expect.any(Date),
      EventStatus.DRAFT,
      userId,
      false,
    );
    expect(result).toMatchObject({ hasImage: true });

    storage.sanitizeAndStoreUploadedObject.mockRejectedValue(new BadRequestException('Bad image'));
    await expect(
      service.confirmImageUpload(principal('ORGANIZER'), eventId),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('requires review when an organizer confirms a replacement image for an approved event', async () => {
    const key = `event-uploads/staging/${eventId}/93b1a3e8-0dfd-4c8c-a0a5-1f1790730011.png`;
    repository.findEvent.mockResolvedValue(
      makeEvent(EventStatus.APPROVED, {
        pendingImageKey: key,
        pendingImageExpiresAt: new Date(Date.now() + 60_000),
        pendingImageOwnerId: userId,
      }),
    );
    repository.completeImageUpload.mockResolvedValue(
      makeEvent(EventStatus.PENDING_APPROVAL, { imageKey: `events/${eventId}/normalized.png` }),
    );

    await service.confirmImageUpload(principal('ORGANIZER'), eventId);

    expect(repository.completeImageUpload).toHaveBeenCalledWith(
      eventId,
      key,
      expect.stringMatching(new RegExp(`^events/${eventId}/.+\\.png$`)),
      expect.any(Date),
      EventStatus.APPROVED,
      userId,
      true,
    );
  });

  it('does not allow another club member to attach an upload owned by someone else', async () => {
    const key = `event-uploads/staging/${eventId}/93b1a3e8-0dfd-4c8c-a0a5-1f1790730011.png`;
    repository.findEvent.mockResolvedValue(
      makeEvent(EventStatus.DRAFT, {
        pendingImageKey: key,
        pendingImageExpiresAt: new Date(Date.now() + 60_000),
        pendingImageOwnerId: userId,
      }),
    );

    await expect(
      service.confirmImageUpload(principal('ORGANIZER', otherUserId), eventId),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(storage.sanitizeAndStoreUploadedObject).not.toHaveBeenCalled();
    expect(repository.completeImageUpload).not.toHaveBeenCalled();
  });

  it('rejects a staging key issued for a different event', async () => {
    const otherEventId = 'c0d0ab5f-0c46-4e27-a911-a1dd54fc019c';
    const key = `event-uploads/staging/${otherEventId}/93b1a3e8-0dfd-4c8c-a0a5-1f1790730011.png`;
    repository.findEvent.mockResolvedValue(
      makeEvent(EventStatus.DRAFT, {
        pendingImageKey: key,
        pendingImageExpiresAt: new Date(Date.now() + 60_000),
        pendingImageOwnerId: userId,
      }),
    );

    await expect(
      service.confirmImageUpload(principal('ORGANIZER'), eventId),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(storage.sanitizeAndStoreUploadedObject).not.toHaveBeenCalled();
    expect(repository.completeImageUpload).not.toHaveBeenCalled();
  });
});
