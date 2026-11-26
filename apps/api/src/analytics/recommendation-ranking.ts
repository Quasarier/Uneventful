export interface RankedCandidate {
  id: string;
  title: string;
  startAt: Date;
  clubId: string;
  categoryId: string;
  tags: string[];
  popularity: number;
}

export interface AttendanceHistoryItem {
  id: string;
  title: string;
  categoryId: string;
  tags: string[];
}

export interface RankedRecommendation<T extends RankedCandidate> {
  candidate: T;
  score: number;
  reason: string;
}

export function rankRecommendations<T extends RankedCandidate>(
  candidates: readonly T[],
  attendedEvents: readonly AttendanceHistoryItem[],
  followedClubIds: ReadonlySet<string>,
  collaborativeByEvent: ReadonlyMap<string, number>,
  now: number,
): RankedRecommendation<T>[] {
  const scored = candidates.map((candidate) => {
    const matchingEvent = attendedEvents.find(
      (event) =>
        event.categoryId === candidate.categoryId ||
        event.tags.some((tag) => candidate.tags.includes(tag)),
    );
    const followed = followedClubIds.has(candidate.clubId);
    const collaborative = collaborativeByEvent.get(candidate.id) ?? 0;
    const matchedTags = attendedEvents.reduce(
      (count, event) => count + event.tags.filter((tag) => candidate.tags.includes(tag)).length,
      0,
    );
    const daysUntil = Math.max(0, (candidate.startAt.getTime() - now) / 86_400_000);
    const score =
      matchedTags * 5 +
      (matchingEvent?.categoryId === candidate.categoryId ? 3 : 0) +
      (followed ? 4 : 0) +
      Math.min(collaborative, 100) * 2 +
      Math.log1p(candidate.popularity) +
      1 / (1 + daysUntil);
    const reason = matchingEvent
      ? `Because you attended ${matchingEvent.title}`
      : followed
        ? 'Popular in clubs you follow'
        : 'Popular and upcoming';
    return { candidate, score, reason };
  });
  return scored.sort(
    (left, right) =>
      right.score - left.score || left.candidate.id.localeCompare(right.candidate.id),
  );
}
