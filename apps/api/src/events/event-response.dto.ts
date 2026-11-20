import type { EventStatus } from '../../generated/prisma/client';
import type { EventRecord } from './events.repository';

type EventClubResponse = Pick<EventRecord['club'], 'name' | 'slug'>;
type EventCategoryResponse = Pick<EventRecord['category'], 'name' | 'slug'>;

export interface EventResponseDto {
  id: string;
  title: string;
  slug: string;
  description: string;
  status: EventStatus;
  startAt: Date;
  endAt: Date;
  timeZone: string;
  capacity: number | null;
  isPublic: boolean;
  clubId: string;
  categoryId: string;
  rejectionReason: string | null;
  createdAt: Date;
  updatedAt: Date;
  hasImage: boolean;
  club: EventClubResponse;
  category: EventCategoryResponse;
}

export function toEventResponseDto(
  event: EventRecord,
  includeRejectionReason = false,
): EventResponseDto {
  return {
    id: event.id,
    title: event.title,
    slug: event.slug,
    description: event.description,
    status: event.status,
    startAt: event.startAt,
    endAt: event.endAt,
    timeZone: event.timeZone,
    capacity: event.capacity,
    isPublic: event.isPublic,
    clubId: event.clubId,
    categoryId: event.categoryId,
    rejectionReason: includeRejectionReason ? event.rejectionReason : null,
    createdAt: event.createdAt,
    updatedAt: event.updatedAt,
    hasImage: event.imageKey !== null,
    club: {
      name: event.club.name,
      slug: event.club.slug,
    },
    category: {
      name: event.category.name,
      slug: event.category.slug,
    },
  };
}
