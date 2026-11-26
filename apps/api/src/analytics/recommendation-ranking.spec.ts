import { describe, expect, it } from 'vitest';
import { rankRecommendations } from './recommendation-ranking';

describe('recommendation ranking', () => {
  it('orders attended category/tag matches above generic popularity and emits privacy-safe reasons', () => {
    const now = Date.parse('2026-03-01T00:00:00.000Z');
    const ranked = rankRecommendations(
      [
        {
          id: 'popular',
          title: 'Popular event',
          startAt: new Date(now + 7 * 86_400_000),
          clubId: 'club-b',
          categoryId: 'category-b',
          tags: ['music'],
          popularity: 100,
        },
        {
          id: 'matched',
          title: 'Matched event',
          startAt: new Date(now + 30 * 86_400_000),
          clubId: 'club-a',
          categoryId: 'category-a',
          tags: ['volunteer'],
          popularity: 1,
        },
      ],
      [
        {
          id: 'past',
          title: 'Your past event',
          categoryId: 'category-a',
          tags: ['volunteer'],
        },
      ],
      new Set(),
      new Map(),
      now,
    );

    expect(ranked[0]?.candidate.id).toBe('matched');
    expect(ranked[0]?.reason).toBe('Because you attended Your past event');
    expect(ranked.map(({ reason }) => reason).join(' ')).not.toContain('@');
  });

  it('uses followed-club popularity without adding attendance history to the reason', () => {
    const now = Date.now();
    const [recommendation] = rankRecommendations(
      [
        {
          id: 'upcoming',
          title: 'Upcoming',
          startAt: new Date(now + 86_400_000),
          clubId: 'followed-club',
          categoryId: 'category',
          tags: [],
          popularity: 6,
        },
      ],
      [],
      new Set(['followed-club']),
      new Map(),
      now,
    );

    expect(recommendation?.reason).toBe('Popular in clubs you follow');
  });
});
