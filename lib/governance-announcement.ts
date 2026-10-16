import { GRANTS, catalogIsStale, isGrantsRound, selectAnnouncement, type Announcement, type Catalog } from './governance';

const CATALOG_REFRESH_MS = 60_000;
const CATALOG_MAX_AGE_MS = 10 * 60_000;
const RESULTS_WINDOW_MS = 5 * 86_400_000;

export type AnnouncementSnapshot = {
  announcement: Announcement | null;
  generatedAt: number;
  nextChangeAt: number | null;
};

export function buildAnnouncementSnapshot(catalog: Catalog, now: number) {
  // Include every clock-driven selection boundary, including a currently empty
  // banner becoming eligible. Only a new catalog may announce a vote opening.
  const boundaries = [catalog.checkedAt + CATALOG_MAX_AGE_MS + 1];
  if (!catalog.votes.some(vote => isGrantsRound(vote.round))) {
    const opening = Date.parse(`${GRANTS.opensOn}T00:00:00Z`);
    boundaries.push(opening - 7 * 86_400_000, opening);
  }
  for (const vote of catalog.votes) {
    if (vote.state === 'active' || vote.state === 'results') boundaries.push(vote.round.vote_end_time * 1000);
    if (vote.state === 'results') boundaries.push(vote.round.vote_end_time * 1000 + RESULTS_WINDOW_MS);
  }
  const futureBoundaries = boundaries.filter(time => Number.isFinite(time) && time > now);
  const nextChangeAt = futureBoundaries.length ? Math.min(...futureBoundaries) : null;
  // Do not stack a fresh CDN minute on top of the catalog's existing minute.
  // A stale catalog can trigger its own refresh but cannot seed another CDN TTL.
  const ttl = catalogIsStale(catalog, now) ? 0 : Math.max(0, Math.floor(Math.min(
    CATALOG_REFRESH_MS,
    catalog.checkedAt + CATALOG_REFRESH_MS - now,
    nextChangeAt === null ? CATALOG_REFRESH_MS : nextChangeAt - now,
  ) / 1000));
  const snapshot: AnnouncementSnapshot = { announcement: selectAnnouncement(catalog, now), generatedAt: now, nextChangeAt };
  return { snapshot, ttl };
}

export function announcementCacheHeaders(ttl: number) {
  const cdn = ttl > 0 ? `public, s-maxage=${ttl}, must-revalidate` : 'no-store';
  return {
    'Cache-Control': ttl > 0 ? 'public, max-age=0, must-revalidate' : 'no-store',
    'CDN-Cache-Control': cdn,
    'Vercel-CDN-Cache-Control': cdn,
    'X-Robots-Tag': 'noindex, follow',
  };
}
