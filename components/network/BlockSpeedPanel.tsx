import Link from 'next/link';
import { Card, CardBody } from '@/components/ui/Card';
import { SectionHeader } from '@/components/ui/SectionHeader';
import { ChartWatermark } from '@/components/ChartWatermark';
import { BlockSpeedChart } from '@/components/network/BlockSpeedChart';
import { BlockSpeedShareControl } from '@/components/network/BlockSpeedShareControl';
import { ANNOUNCED_MAINNET_NU7 } from '@/lib/network-upgrades';
import { formatSeconds, formatSpeedup, nu7Average, NU7_TARGET_SECONDS, SPENDABLE_CONFIRMATIONS, type SpeedStory } from '@/lib/block-speed';

export function formatLongDate(date: string | null) {
  return date ? new Date(`${date}T00:00:00Z`).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' }) : null;
}

function Stat({ label, before, value, hint, highlight = false, className }: { label: string; before?: string; value: string; hint: string; highlight?: boolean; className?: string }) {
  return <div className={className}>
    <dt className="type-label text-muted uppercase mb-2">{label}</dt>
    <dd>
      <div className="flex items-baseline gap-2 flex-wrap font-mono tabular-nums">
        {before != null && <><span className="text-xl text-muted">{before}</span><span aria-hidden="true" className="text-muted">→</span></>}
        <span className={`type-metric ${highlight ? 'text-cipher-gold' : 'text-primary'}`}>{value}</span>
      </div>
      <p className="text-caption text-muted mt-1">{hint}</p>
    </dd>
  </div>;
}

function Intro({ story }: { story: SpeedStory }) {
  const height = story.activation ? `block #${story.activation.height.toLocaleString('en-US')}` : null;
  const date = formatLongDate(story.activation?.date ?? null);
  if (story.network === 'testnet') {
    if (story.phase !== 'active') return <>Testnet · NU7 is not active yet.</>;
    return <>Testnet · NU7 active since {height}{date ? `, ${date}` : ''}.</>;
  }
  if (story.phase === 'active') {
    return <>Mainnet · NU7 active since {height}{date ? `, ${date}` : ''}.</>;
  }
  const when = story.activation?.status === 'announced' ? ANNOUNCED_MAINNET_NU7.dateLabel : date ? `estimated ${date}` : null;
  return <>NU7 · {NU7_TARGET_SECONDS}-second block target · {height}{when ? `, ${when}` : ''}.</>;
}

function Stats({ story }: { story: SpeedStory }) {
  const after = nu7Average(story);
  const perHour = (seconds: number | null | undefined) => seconds ? Math.round(3600 / seconds).toLocaleString('en-US') : '—';
  if (story.network === 'testnet') {
    const irregularMedian = story.irregular?.medianSeconds;
    return <>
      <Stat className="col-span-2 sm:col-span-1" label="Average block" value={formatSeconds(after)} highlight hint={`Last 7 days · ${NU7_TARGET_SECONDS}s target`} />
      <Stat label="Typical gap" value={formatSeconds(story.after?.medianSeconds)} hint={irregularMedian != null ? `Median · ${formatSeconds(irregularMedian)} before NU7` : 'Median time between blocks'} />
      <Stat label="Blocks per hour" value={perHour(after)} hint="At the measured average pace" />
    </>;
  }
  const before = story.before?.averageSeconds;
  const speedup = before != null && after ? before / after : null;
  return <>
    <Stat className="col-span-2 sm:col-span-1" label="Average block" before={formatSeconds(before)} value={formatSeconds(after)} highlight hint={story.phase === 'upcoming' ? '7-day average → NU7 target' : 'Before NU7 → last 7 days'} />
    <Stat label="Typical gap" value={formatSeconds(story.phase === 'active' ? story.after?.medianSeconds : story.before?.medianSeconds)} hint="Measured median · last 7 days" />
    <Stat label="Blocks per hour" before={perHour(before)} value={perHour(after)} hint={`${formatSpeedup(speedup)} as many blocks`} />
  </>;
}

function Footnote({ story }: { story: SpeedStory }) {
  return <>{story.phase === 'upcoming' && story.network === 'mainnet'
    ? `Total: ${SPENDABLE_CONFIRMATIONS} confirmations (ZIP 315). Outlined bars show targets.`
    : story.network === 'testnet' ? `Total: ${SPENDABLE_CONFIRMATIONS} confirmations (ZIP 315). Earlier testnet timing was irregular.` : `Total: ${SPENDABLE_CONFIRMATIONS} confirmations (ZIP 315).`}</>;
}

export function BlockSpeedPanel({ story, variant = 'compact' }: { story: SpeedStory | null; variant?: 'compact' | 'full' }) {
  const compact = variant === 'compact';
  return <Card className="card-static"><CardBody>
    <SectionHeader label="BLOCK_SPEED" actions={compact ? <Link href="/network/block-speed" className="text-caption font-mono text-muted hover:text-primary">Details →</Link> : story ? <BlockSpeedShareControl /> : undefined} />
    {!story ? <p role="status" className="py-12 text-center text-sm text-muted">Block speed observations are unavailable.</p> : <>
      <p className="text-sm text-secondary mb-5 max-w-3xl"><Intro story={story} /></p>
      <dl className="grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-5 mb-6"><Stats story={story} /></dl>
      <BlockSpeedChart points={story.points} activation={story.activation} height={compact ? 220 : 280} />
      <p className="text-caption text-muted mt-3 max-w-3xl"><Footnote story={story} /></p>
    </>}
    <ChartWatermark />
  </CardBody></Card>;
}
