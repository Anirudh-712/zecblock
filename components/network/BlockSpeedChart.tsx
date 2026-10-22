'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { formatDay, formatSeconds, formatWait, SPENDABLE_CONFIRMATIONS, type SpeedActivation, type SpeedPoint } from '@/lib/block-speed';

const LEFT = 40;
const RIGHT = 8;
const BOTTOM = 24;
const TOP = 30;

function niceStep(maxMinutes: number) {
  return [1, 2, 5, 10, 15, 20].find(step => maxMinutes / step <= 4) ?? Math.ceil(maxMinutes / 4 / 10) * 10;
}

const totalMinutes = (point: SpeedPoint) => point.averageSeconds * SPENDABLE_CONFIRMATIONS / 60;

function barClass(point: SpeedPoint, first: boolean) {
  if (point.kind === 'projected') return first ? 'fill-none stroke-cipher-gold' : 'fill-none stroke-muted';
  return `${first ? 'fill-cipher-gold' : 'fill-muted'}${point.kind === 'irregular' ? ' opacity-30' : ''}`;
}

function describe(point: SpeedPoint) {
  const waits = `first confirmation ${formatWait(point.averageSeconds)} · ${SPENDABLE_CONFIRMATIONS} confirmations ${formatWait(point.averageSeconds * SPENDABLE_CONFIRMATIONS)}`;
  if (point.kind === 'projected') return `${formatDay(point.date)} · projected at the ${point.targetSeconds}s block target · ${waits}`;
  const era = point.kind === 'irregular' ? ' · minimum-difficulty era' : point.nu7 ? ' · NU7' : '';
  return `${formatDay(point.date)}${era} · average block ${formatSeconds(point.averageSeconds)} · ${waits}`;
}

/** Consecutive points sharing a target, so each era draws its own target line. */
function targetSegments(points: SpeedPoint[]) {
  const segments: { target: number; from: number; to: number }[] = [];
  points.forEach((point, index) => {
    const last = segments.at(-1);
    if (point.targetSeconds == null) return;
    if (last && last.target === point.targetSeconds && last.to === index - 1) last.to = index;
    else segments.push({ target: point.targetSeconds, from: index, to: index });
  });
  return segments;
}

/** First confirmation plus the remaining blocks, stacked to the wallet's total confirmation depth. */
export function BlockSpeedChart({ points, activation, height = 260 }: { points: SpeedPoint[]; activation: SpeedActivation | null; height?: number }) {
  const wrapper = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(720);
  useEffect(() => {
    if (!wrapper.current) return;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.max(280, Math.floor(entry.contentRect.width))));
    observer.observe(wrapper.current);
    return () => observer.disconnect();
  }, []);
  if (!points.length) return <p role="status" className="py-16 text-center text-sm text-muted">Daily block observations are unavailable.</p>;

  const narrow = width < 520;
  const segments = targetSegments(points);
  const peak = Math.max(...points.map(totalMinutes), ...segments.map(segment => segment.target * SPENDABLE_CONFIRMATIONS / 60));
  const step = niceStep(peak);
  const max = Math.ceil(peak * 1.1 / step) * step;
  const plotHeight = height - TOP - BOTTOM;
  const y = (value: number) => TOP + plotHeight - value / max * plotHeight;
  const slot = (width - LEFT - RIGHT) / points.length;
  const barWidth = Math.max(2, slot * (narrow ? 0.7 : 0.72));
  const left = (index: number) => LEFT + index * slot + (slot - barWidth) / 2;
  const edge = (index: number) => LEFT + index * slot;
  const ticks = Array.from({ length: Math.floor(max / step) + 1 }, (_, i) => i * step);
  const nu7Index = points.findIndex(point => point.nu7);
  const todayIndex = points.findIndex(point => point.kind === 'projected');
  const nu7Label = 'NU7';
  const labelFits = (index: number, label: string) => edge(index) + 5 + label.length * 7 < width - RIGHT;
  const hasProjections = points.some(point => point.kind === 'projected');
  const hasIrregular = points.some(point => point.kind === 'irregular');
  const dateLabels = [0, ...(nu7Index > 0 && !narrow ? [nu7Index] : []), points.length - 1]
    .filter((index, i, all) => i === 0 || edge(index) - edge(all[i - 1]) > 64);

  return <div ref={wrapper}>
    <svg width="100%" height={height} viewBox={`0 0 ${width} ${height}`} role="group" className="font-mono text-caption"
      aria-label={`Daily confirmation waits in minutes: first confirmation and ${SPENDABLE_CONFIRMATIONS} confirmations total, ${formatDay(points[0].date)} to ${formatDay(points.at(-1)!.date)}`}>
      {ticks.map(tick => <g key={tick}>
        <line x1={LEFT} x2={width - RIGHT} y1={y(tick)} y2={y(tick)} className="stroke-cipher-border" />
        <text x={LEFT - 8} y={y(tick) + 4} textAnchor="end" className="fill-muted">{tick}m</text>
      </g>)}
      {points.map((point, index) => {
        const top = y(totalMinutes(point));
        const split = y(point.averageSeconds / 60);
        const body = <>
          <title>{describe(point)}</title>
          <rect data-confirmation-segment="remaining" x={left(index)} y={top} width={barWidth} height={Math.max(0, split - top)} rx={1.5} className={barClass(point, false)}
            strokeDasharray={point.kind === 'projected' ? '3 2' : undefined} />
          <rect data-confirmation-segment="first" x={left(index)} y={split} width={barWidth} height={Math.max(0, y(0) - split)} rx={1.5} className={barClass(point, true)}
            strokeDasharray={point.kind === 'projected' ? '3 2' : undefined} />
        </>;
        return point.lastHeight != null
          ? <a key={point.key} href={`/block/${point.lastHeight}`} aria-label={describe(point)} className="cadence-link">{body}</a>
          : <g key={point.key}>{body}</g>;
      })}
      {segments.map(segment => {
        const level = y(segment.target * SPENDABLE_CONFIRMATIONS / 60);
        const x1 = edge(segment.from); const x2 = edge(segment.to + 1);
        const tallest = y(Math.max(...points.slice(segment.from, segment.to + 1).map(totalMinutes)));
        const labelAtToday = todayIndex >= segment.from && todayIndex <= segment.to
          && x2 - edge(todayIndex) > 100;
        return <g key={`${segment.from}-${segment.target}`} pointerEvents="none">
          <line x1={x1} x2={x2} y1={level} y2={level} className="stroke-secondary" strokeDasharray="2 4" />
          {x2 - x1 > 86 && <text x={labelAtToday ? edge(todayIndex) + 6 : x2 - 4} y={Math.min(level, tallest) - 6} textAnchor={labelAtToday ? 'start' : 'end'} className="fill-secondary">{segment.target}s blocks</text>}
        </g>;
      })}
      {todayIndex > 0 && todayIndex !== nu7Index && <g>
        <line x1={edge(todayIndex)} x2={edge(todayIndex)} y1={TOP - 10} y2={y(0)} className="stroke-muted" />
        <text x={edge(todayIndex) + 5} y={TOP - 14} className="fill-muted">Today</text>
      </g>}
      {nu7Index > 0 && <g>
        <title>{activation?.status === 'active' ? 'NU7 activation' : activation?.status === 'announced' ? 'Announced NU7 activation' : 'Estimated NU7 activation'}</title>
        <line x1={edge(nu7Index)} x2={edge(nu7Index)} y1={TOP - 10} y2={y(0)} className="stroke-cipher-gold" strokeDasharray="3 4" />
        <text x={edge(nu7Index) + (labelFits(nu7Index, nu7Label) ? 5 : -5)} y={TOP - 14} textAnchor={labelFits(nu7Index, nu7Label) ? 'start' : 'end'} className="fill-cipher-gold">{nu7Label}</text>
      </g>}
      {dateLabels.map((index, i) => <text key={index} x={i === dateLabels.length - 1 ? width - RIGHT : edge(index)} y={height - 6}
        textAnchor={i === dateLabels.length - 1 ? 'end' : 'start'} className="fill-muted">{formatDay(points[index].date)}</text>)}
    </svg>
    <div className="flex flex-wrap gap-x-5 gap-y-2 mt-3 text-caption text-muted">
      <Legend swatch="bg-cipher-gold">First confirmation</Legend>
      <Legend swatch="bg-muted">{SPENDABLE_CONFIRMATIONS - 1} more confirmations</Legend>
      {hasProjections && <Legend swatch="border border-dashed border-secondary">Target projection</Legend>}
      {hasIrregular && <Legend swatch="bg-muted opacity-30">Earlier testnet · irregular</Legend>}
    </div>
  </div>;
}

function Legend({ swatch, children }: { swatch: string; children: ReactNode }) {
  return <span className="flex items-center gap-2"><span aria-hidden="true" className={`w-2.5 h-2.5 rounded-sm ${swatch}`} />{children}</span>;
}
