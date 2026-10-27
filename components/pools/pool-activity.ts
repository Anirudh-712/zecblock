import type { ChartRow } from '@/lib/chart-catalog';

export type ActivityPeriod = '7d' | '30d' | '90d' | '1y';
export type ActivityMode = 'count' | 'share';
export type ActivityPool = 'ironwood' | 'orchard' | 'sapling' | 'sprout';

export interface PoolActivityPoint {
  date: string;
  totalTransactions: number | null;
  sprout: number | null;
  sapling: number | null;
  orchard: number | null;
  ironwood: number | null;
  complete: boolean;
}

export interface PoolActivityData {
  period: ActivityPeriod;
  startDate: string;
  endDate: string;
  sourceHeight: number | null;
  points: PoolActivityPoint[];
  totals: Omit<PoolActivityPoint, 'date' | 'complete'>;
  coverage: { completeDays: number; expectedDays: number };
}

export const ACTIVITY_POOLS = [
  { key: 'ironwood', label: 'Ironwood', color: 'ironwood' },
  { key: 'orchard', label: 'Orchard', color: 'orchard' },
  { key: 'sapling', label: 'Sapling', color: 'sapling' },
  { key: 'sprout', label: 'Sprout', color: 'sprout' },
] as const;

export const ACTIVITY_NOTE = 'Percentages use all confirmed non-coinbase transactions. Transactions can use multiple pools, so shares may total over 100%.';

function count(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/** A zero denominator is unavailable, while a real zero pool count is preserved. */
export function activityValue(value: number | null, denominator: number | null, mode: ActivityMode): number | null {
  if (!count(value) || !count(denominator) || value > denominator) return null;
  return mode === 'count' ? value : denominator > 0 ? value / denominator * 100 : null;
}

export function poolActivityRows(points: PoolActivityPoint[], mode: ActivityMode): ChartRow[] {
  return points.map(point => ({
    x: Date.parse(`${point.date}T00:00:00Z`),
    ...Object.fromEntries(ACTIVITY_POOLS.map(({ key }) => [
      key, point.complete ? activityValue(point[key], point.totalTransactions, mode) : null,
    ])),
  })).filter(row => Number.isFinite(row.x)).sort((a, b) => Number(a.x) - Number(b.x));
}

export function activityNumber(value: number | null, mode: ActivityMode): string {
  if (value == null) return '—';
  return mode === 'share'
    ? `${new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(value)}%`
    : value.toLocaleString('en-US');
}
