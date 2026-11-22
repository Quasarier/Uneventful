import type { VenueRecord } from './venues.repository';

export interface VenueResponseDto {
  id: string;
  name: string;
  building: string | null;
  capacity: number;
  bufferMinutes: number;
  isActive: boolean;
  availabilityHours: Array<{
    weekday: number;
    opensAt: string;
    closesAt: string;
  }>;
}

export function toVenueResponseDto(venue: VenueRecord): VenueResponseDto {
  return {
    id: venue.id,
    name: venue.name,
    building: venue.building,
    capacity: venue.capacity,
    bufferMinutes: venue.bufferMinutes,
    isActive: venue.isActive,
    availabilityHours: venue.availability.map(({ weekday, opensAt, closesAt }) => ({
      weekday,
      opensAt,
      closesAt,
    })),
  };
}
