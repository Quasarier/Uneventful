export const RSVP_PROMOTION_QUEUE = 'rsvp-promotions';
export const RSVP_PROMOTION_JOB = 'promote-next-waitlisted';

export interface RsvpPromotionJobData {
  eventId: string;
  outboxId: string;
}
