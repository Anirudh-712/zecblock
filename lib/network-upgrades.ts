import { scheduledSeconds, type BlockSchedule } from './block-timing';
import { NETWORK_UPGRADES, type NetworkUpgrade } from './config';
import type { AppNetwork } from './network';

export type UpgradeSnapshot = {
  height: number;
  schedule: BlockSchedule & { nu7Height: number | null };
  observedBlockTime: number | null;
  tipTimestamp: number | null;
};

/** Editorial announcement only. Never insert this into the serving-node schedule. */
export const ANNOUNCED_MAINNET_NU7 = {
  height: 3543405,
  date: '2026-11-05',
  dateLabel: 'around November 5, 2026',
  sourceUrl: 'https://zakura.com/nu7/',
} as const;

export type FutureBlockUpgrade = NetworkUpgrade & {
  authority: 'node' | 'announcement' | 'historical';
  announcedDate?: string;
};

/** Validate the serving node's schedule, including its network identity. */
export function readUpgradeSnapshot(data: unknown, network: AppNetwork): UpgradeSnapshot | null {
  if (network === 'crosslink-testnet' || !data || typeof data !== 'object') return null;
  const stats = data as { blockchain?: { height?: unknown; latestBlockTime?: unknown }; mining?: { schedule?: unknown; avgBlockTime?: unknown } };
  const height = stats.blockchain?.height;
  const schedule = stats.mining?.schedule as (BlockSchedule & { network?: string; source?: string; nu7Height?: unknown }) | undefined;
  if (typeof height !== 'number' || !Number.isSafeInteger(height) || height < 0 || height >= 500000000
    || schedule?.network !== (network === 'mainnet' ? 'main' : 'test')
    || schedule.source !== 'node-upgrade-schedule'
    || scheduledSeconds(schedule, height, height) === null) return null;
  const nu7Height = schedule.nu7Height;
  if (nu7Height !== null && (typeof nu7Height !== 'number' || !Number.isSafeInteger(nu7Height)
    || nu7Height <= 0 || nu7Height >= 500000000
    || !schedule.eras.some(era => era.height === nu7Height && era.seconds === 25))) return null;
  const avg = stats.mining?.avgBlockTime;
  const timestamp = stats.blockchain?.latestBlockTime;
  return {
    height,
    schedule: { eras: schedule.eras, nu7Height: nu7Height as number | null },
    observedBlockTime: typeof avg === 'number' && Number.isFinite(avg) && avg > 0 ? avg : null,
    tipTimestamp: typeof timestamp === 'number' && Number.isSafeInteger(timestamp) && timestamp > 0 && timestamp < 8640000000000 ? timestamp : null,
  };
}

export function getBlockUpgrade(height: number, network: AppNetwork, snapshot: UpgradeSnapshot | null): NetworkUpgrade | null {
  if (network === 'crosslink-testnet') return null;
  if (snapshot?.schedule.nu7Height === height) {
    const label = network === 'testnet' ? 'testnet' : 'mainnet';
    return {
      name: 'NU7 activation', zip: '', badge: 'NU7 ACTIVATION',
      description: `NU7 begins on Zcash ${label} at block #${height.toLocaleString('en-US')}. From that block, the target block time is 25 seconds.`,
      link: '/network#network-accounting', linkText: 'Explore the upgrade →',
    };
  }
  // Historical milestone heights belong to their own network.
  if (network === 'testnet' ? height !== 4134000 : height === 4134000) return null;
  return NETWORK_UPGRADES[height] ?? null;
}

/** Future-page copy may describe an announcement; mined activation stays node-only. */
export function getFutureBlockUpgrade(height: number, network: AppNetwork, snapshot: UpgradeSnapshot | null): FutureBlockUpgrade | null {
  const upgrade = getBlockUpgrade(height, network, snapshot);
  if (upgrade) return { ...upgrade, authority: snapshot?.schedule.nu7Height === height ? 'node' : 'historical' };
  if (network !== 'mainnet' || height !== ANNOUNCED_MAINNET_NU7.height || snapshot?.schedule.nu7Height != null) return null;
  return {
    name: 'NU7 announcement', zip: '', badge: 'ANNOUNCED', authority: 'announcement',
    announcedDate: ANNOUNCED_MAINNET_NU7.date,
    description: `Zakura has announced NU7 for mainnet block #${height.toLocaleString('en-US')}, ${ANNOUNCED_MAINNET_NU7.dateLabel}. Activation is pending confirmation from the serving node.`,
    link: ANNOUNCED_MAINNET_NU7.sourceUrl, linkText: 'View the announcement ↗',
  };
}

export function getPendingNu7Upgrade(network: AppNetwork, snapshot: UpgradeSnapshot | null): { height: number; upgrade: FutureBlockUpgrade } | null {
  if (network === 'crosslink-testnet') return null;
  const height = snapshot?.schedule.nu7Height ?? (network === 'mainnet' ? ANNOUNCED_MAINNET_NU7.height : null);
  if (height === null || (snapshot && snapshot.height >= height)) return null;
  const upgrade = getFutureBlockUpgrade(height, network, snapshot);
  return upgrade ? { height, upgrade } : null;
}

export function estimateBlockArrival(snapshot: UpgradeSnapshot | null, target: number): { seconds: number; basis: 'recent block times' | 'target spacing' } | null {
  if (!snapshot) return null;
  const seconds = scheduledSeconds(snapshot.schedule, snapshot.height, target);
  if (seconds === null) return null;
  const targetInterval = snapshot.schedule.eras.findLast(era => era.height <= snapshot.height)?.seconds;
  if (snapshot.observedBlockTime !== null && targetInterval) {
    return { seconds: seconds * snapshot.observedBlockTime / targetInterval, basis: 'recent block times' };
  }
  return { seconds, basis: 'target spacing' };
}

/** Anchor UTC estimates to the same verified block as the remaining-block count. */
export function estimateBlockArrivalDate(snapshot: UpgradeSnapshot | null, target: number): { dateTime: string; label: string } | null {
  const estimate = estimateBlockArrival(snapshot, target);
  if (!estimate || snapshot?.tipTimestamp == null) return null;
  const date = new Date((snapshot.tipTimestamp + estimate.seconds) * 1000);
  if (!Number.isFinite(date.getTime())) return null;
  return {
    dateTime: date.toISOString(),
    label: `${date.toLocaleString('en-US', { timeZone: 'UTC', month: 'long', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })} UTC`,
  };
}

export function formatUpgradeDuration(seconds: number): string {
  if (seconds < 60) return `${Math.max(1, Math.round(seconds))}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ${Math.floor(seconds % 3600 / 60)}m`;
  return `${Math.floor(seconds / 86400)}d ${Math.floor(seconds % 86400 / 3600)}h`;
}

/** Approximate, readable timing for the small site announcement. */
export function formatUpgradeTime(seconds: number): string {
  const [value, unit] = seconds >= 86400 ? [Math.round(seconds / 86400), 'day']
    : seconds >= 3600 ? [Math.round(seconds / 3600), 'hour']
      : [Math.max(1, Math.round(seconds / 60)), 'minute'];
  return `${value} ${unit}${value === 1 ? '' : 's'}`;
}
