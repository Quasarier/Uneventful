import { ValidationPipe } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { CreateEventDto } from './create-event.dto';
import { CreateImageUploadDto } from './create-image-upload.dto';
import { ListEventsDto } from './list-events.dto';
import { UpdateEventDto } from './update-event.dto';

const validationPipe = new ValidationPipe({
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
});

const validCreateEvent = {
  title: 'Campus meetup',
  description: '<p>Meet students</p>',
  startAt: '2027-03-01T10:00:00.000Z',
  endAt: '2027-03-01T12:00:00.000Z',
  timeZone: 'UTC',
  capacity: 100,
  isPublic: true,
  clubId: '7c683bc4-2911-4f4d-aa95-167fd0dd9a32',
  categoryId: '65cad59a-8af7-4e8d-a527-1fe0eccf26da',
};

describe('event DTO validation', () => {
  it('rejects unknown fields instead of allowing callers to assign event state', async () => {
    await expect(
      validationPipe.transform(
        { ...validCreateEvent, status: 'APPROVED', createdById: 'attacker' },
        { type: 'body', metatype: CreateEventDto },
      ),
    ).rejects.toThrow();
  });

  it('enforces event title and description length limits', async () => {
    await expect(
      validationPipe.transform(
        { ...validCreateEvent, title: 'x'.repeat(201) },
        { type: 'body', metatype: CreateEventDto },
      ),
    ).rejects.toThrow();
    await expect(
      validationPipe.transform(
        { ...validCreateEvent, description: 'x'.repeat(20_001) },
        { type: 'body', metatype: CreateEventDto },
      ),
    ).rejects.toThrow();
  });

  it('rejects update payloads without whitelisted properties', async () => {
    await expect(
      validationPipe.transform({ status: 'APPROVED' }, { type: 'body', metatype: UpdateEventDto }),
    ).rejects.toThrow();
    await expect(
      validationPipe.transform({ capacity: null }, { type: 'body', metatype: UpdateEventDto }),
    ).resolves.toMatchObject({ capacity: null });
    await expect(
      validationPipe.transform({ title: null }, { type: 'body', metatype: UpdateEventDto }),
    ).rejects.toThrow();
  });

  it('limits pagination and text search and validates image type and size', async () => {
    await expect(
      validationPipe.transform({ limit: '101' }, { type: 'query', metatype: ListEventsDto }),
    ).rejects.toThrow();
    await expect(
      validationPipe.transform({ page: '10001' }, { type: 'query', metatype: ListEventsDto }),
    ).rejects.toThrow();
    await expect(
      validationPipe.transform({ q: 'x'.repeat(101) }, { type: 'query', metatype: ListEventsDto }),
    ).rejects.toThrow();
    await expect(
      validationPipe.transform(
        { contentType: 'image/svg+xml', size: 10 },
        { type: 'body', metatype: CreateImageUploadDto },
      ),
    ).rejects.toThrow();
    await expect(
      validationPipe.transform(
        { contentType: 'image/png', size: 5 * 1024 * 1024 + 1 },
        { type: 'body', metatype: CreateImageUploadDto },
      ),
    ).rejects.toThrow();
  });
});
