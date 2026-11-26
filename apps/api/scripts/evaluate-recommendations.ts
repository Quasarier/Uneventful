import {
  rankRecommendations,
  type AttendanceHistoryItem,
  type RankedCandidate,
} from '../src/analytics/recommendation-ranking';

const SEED = 20_261_125;
const K = 5;
const evaluationTime = Date.parse('2026-01-01T00:00:00.000Z');

function randomGenerator(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

function sequence(length: number): number[] {
  const indexes: number[] = [];
  for (let index = 0; index < length; index += 1) indexes.push(index);
  return indexes;
}

const random = randomGenerator(SEED);
const categories = sequence(5).map((index) => `category-${index}`);
const tags = sequence(12).map((index) => `tag-${index}`);
const clubs = sequence(6).map((index) => `club-${index}`);
const historicalEvents: AttendanceHistoryItem[] = sequence(60).map((index) => ({
  id: `history-${index}`,
  title: `Past event ${index}`,
  categoryId: categories.at(Math.floor(random() * categories.length))!,
  tags: [tags.at(Math.floor(random() * tags.length))!],
}));
const candidates: RankedCandidate[] = sequence(80).map((index) => ({
  id: `upcoming-${index}`,
  title: `Upcoming event ${index}`,
  startAt: new Date(evaluationTime + (index + 1) * 3_600_000),
  clubId: clubs.at(Math.floor(random() * clubs.length))!,
  categoryId: categories.at(Math.floor(random() * categories.length))!,
  tags: [tags.at(Math.floor(random() * tags.length))!],
  popularity: Math.floor(random() * 100),
}));
const userHistories = sequence(40).map(() => {
  const attended = new Set<number>();
  while (attended.size < 5) attended.add(Math.floor(random() * historicalEvents.length));
  return {
    history: [...attended].map((index) => historicalEvents.at(index)!),
    followed: new Set([clubs.at(Math.floor(random() * clubs.length))!]),
    heldOut: candidates.filter(() => random() < 0.1).map(({ id }) => id),
  };
});

let relevantAtK = 0;
let totalAtK = 0;
const recommendedEventIds = new Set<string>();

for (const user of userHistories) {
  const relevantCandidates = candidates.filter(
    (candidate) =>
      user.history.some(
        (event) =>
          event.categoryId === candidate.categoryId ||
          event.tags.some((tag) => candidate.tags.includes(tag)),
      ) || user.followed.has(candidate.clubId),
  );
  const relevance = new Set([...user.heldOut, ...relevantCandidates.map(({ id }) => id)]);
  const ranked = rankRecommendations(
    candidates,
    user.history,
    user.followed,
    new Map(),
    evaluationTime,
  ).slice(0, K);
  relevantAtK += ranked.filter(({ candidate }) => relevance.has(candidate.id)).length;
  totalAtK += K;
  ranked.forEach(({ candidate }) => recommendedEventIds.add(candidate.id));
}

const precisionAtK = totalAtK === 0 ? 0 : relevantAtK / totalAtK;
const coverage = recommendedEventIds.size / candidates.length;
process.stdout.write(
  `${JSON.stringify(
    {
      seed: SEED,
      users: userHistories.length,
      candidates: candidates.length,
      k: K,
      precisionAtK: Number(precisionAtK.toFixed(4)),
      coverage: Number(coverage.toFixed(4)),
      note: 'Synthetic deterministic smoke evaluation; not a production-quality offline metric.',
    },
    null,
    2,
  )}\n`,
);
