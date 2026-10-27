'use client';

import { useMemo, useState } from 'react';
import { CartesianGrid, Line, LineChart, ResponsiveContainer, XAxis, YAxis } from 'recharts';
import { ChartTooltip } from '@/components/charts/ChartTooltip';
import { ShareableCard } from '@/components/ShareableCard';
import { PeriodPillTags } from '@/components/ui/PeriodPillTags';
import { ChartSkeleton } from '@/components/ui/Skeleton';
import { useTheme } from '@/contexts/ThemeContext';
import { useApiQuery } from '@/hooks/useApiQuery';
import { NETWORK } from '@/lib/api-config';
import type { CatalogChart } from '@/lib/chart-catalog';
import type { ChartExportData } from '@/lib/chart-sharing';
import { CHART_DATE_AXIS, getChartColors, getChartTooltipStyle } from '@/lib/chart-theme';
import {
  ACTIVITY_NOTE, ACTIVITY_POOLS, activityNumber, activityValue, poolActivityRows,
  type ActivityMode, type ActivityPeriod, type PoolActivityData,
} from './pool-activity';

const PERIODS = [
  { key: '7d', label: '7D' }, { key: '30d', label: '30D' },
  { key: '90d', label: '90D' }, { key: '1y', label: '1Y' },
] as const;
const MODES = [{ key: 'count', label: 'Tx count' }, { key: 'share', label: '%' }] as const;

function dateLabel(value: string | number, full = false): string {
  return new Date(Number(value)).toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', ...(full ? { year: 'numeric' } : {}), timeZone: 'UTC',
  });
}

export function PoolActivityChart() {
  const { theme } = useTheme();
  const colors = getChartColors(theme);
  const [period, setPeriod] = useState<ActivityPeriod>('30d');
  const [mode, setMode] = useState<ActivityMode>('count');
  const query = useApiQuery<PoolActivityData>('/v1/shielded-pools/activity', { period }, { refreshInterval: 300_000 });
  // The query hook retains previous data; never label another period's rows as this selection.
  const data = query.data?.period === period ? query.data : null;
  const rows = useMemo(() => poolActivityRows(data?.points ?? [], mode), [data, mode]);
  const hasObservations = rows.some(row => ACTIVITY_POOLS.some(({ key }) => row[key] != null));
  const loading = query.loading || (!data && query.isRefreshing);
  const coverage = data ? `${data.coverage.completeDays} of ${data.coverage.expectedDays} complete UTC days` : '';
  const total = data?.totals.totalTransactions ?? null;
  const dateRange = data ? `${dateLabel(Date.parse(data.startDate), true)} – ${dateLabel(Date.parse(data.endDate), true)} UTC` : '';
  const exportData = useMemo<ChartExportData>(() => {
    const chart: CatalogChart = {
      id: 'pool-transaction-activity',
      title: mode === 'share' ? 'Shielded pool transaction share' : 'Shielded pool transaction counts',
      description: ACTIVITY_NOTE,
      category: 'Supply & flows', href: '/pools#activity',
      endpoint: `/v1/shielded-pools/activity?period=${period}`, rows: 'points', x: 'date',
      window: period.toUpperCase(), unit: mode === 'share' ? '%' : 'Transactions',
      series: [...ACTIVITY_POOLS], kind: 'line', percent: mode === 'share',
    };
    return {
      chart, rows, network: NETWORK, source: 'ZecBlock indexed transactions',
      asOf: data ? `${coverage}${data.sourceHeight != null ? ` · through block ${data.sourceHeight.toLocaleString('en-US')}` : ''}` : undefined,
    };
  }, [mode, period, rows, data, coverage]);

  return (
    <ShareableCard
      title="Transaction activity by pool"
      shareText={`Zcash transaction activity by shielded pool (${period.toUpperCase()}). ${ACTIVITY_NOTE}`}
      sharePath="/pools#activity"
      fileName={`zecblock-pool-transactions-${mode}-${period}.png`}
      exportData={exportData}
      exportDisabled={!hasObservations || !data || query.isRefreshing || Boolean(query.error)}
      sourceHeight={data?.sourceHeight ?? undefined}
      footerNote={data ? `${coverage}${data.sourceHeight != null ? ` · block ${data.sourceHeight.toLocaleString('en-US')}` : ''}` : 'Complete UTC days'}
      className=""
    >
      <p className="mb-4 text-caption leading-relaxed text-muted">{ACTIVITY_NOTE}</p>
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3" data-html2canvas-ignore="true">
        <PeriodPillTags options={MODES} value={mode} onChange={setMode} aria-label="Activity metric" />
        <PeriodPillTags options={PERIODS} value={period} onChange={setPeriod} aria-label="Activity period" />
      </div>

      {loading ? <ChartSkeleton height={320} /> : !data ? (
        <div className="flex h-80 flex-col items-center justify-center gap-3 text-caption text-muted" role="status">
          <p>Pool activity is temporarily unavailable.</p>
          <button type="button" onClick={() => void query.refetch()} className="text-secondary underline underline-offset-4">Try again</button>
        </div>
      ) : (
        <>
          <div className="mb-5 grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-4" aria-label="Period totals">
            {ACTIVITY_POOLS.map(({ key, label, color }) => (
              <div key={key}>
                <p className="mb-1 flex items-center gap-2 text-caption text-muted"><span className="h-2 w-2 rounded-full" style={{ backgroundColor: colors[color] }} />{label}</p>
                <p className="font-mono text-lg tabular-nums text-primary" aria-label={`${label} total`}>
                  {activityNumber(activityValue(data.totals[key], total, mode), mode)}
                </p>
              </div>
            ))}
          </div>
          <p className="mb-3 text-caption text-muted">
            {dateRange}{total != null ? ` · ${total.toLocaleString('en-US')} non-coinbase transactions` : ''}
          </p>
          {hasObservations ? (
            <div className="h-80" role="img" aria-label={`Daily shielded pool transaction ${mode === 'share' ? 'percentages' : 'counts'}. ${ACTIVITY_NOTE}`}>
              <ResponsiveContainer initialDimension={{ width: 500, height: 320 }} width="100%" height="100%">
                <LineChart data={rows} margin={{ top: 8, right: 12, left: 0, bottom: 22 }}>
                  <CartesianGrid vertical={false} stroke={colors.gridStroke} />
                  <XAxis
                    {...CHART_DATE_AXIS} dataKey="x" type="number" domain={['dataMin', 'dataMax']}
                    scale="time" tickFormatter={value => dateLabel(value)} tick={{ fill: colors.axis, fontSize: 12 }}
                    tickLine={false} axisLine={false}
                    label={{ value: 'Date (UTC)', position: 'insideBottom', offset: -14, fill: colors.axis, fontSize: 12 }}
                  />
                  <YAxis
                    width={64} domain={mode === 'share' ? [0, 100] : [0, 'auto']} allowDecimals={mode === 'share'}
                    tick={{ fill: colors.axis, fontSize: 12 }} tickLine={false} axisLine={false}
                    tickFormatter={value => mode === 'share' ? `${value}%` : new Intl.NumberFormat('en-US', { notation: 'compact' }).format(Number(value))}
                    label={{ value: mode === 'share' ? '% of transactions' : 'Transactions', angle: -90, position: 'insideLeft', fill: colors.axis, fontSize: 12 }}
                  />
                  <ChartTooltip
                    contentStyle={getChartTooltipStyle(colors)} labelFormatter={label => dateLabel(Number(label), true)}
                    formatter={(value, name) => [activityNumber(Number(value), mode), ACTIVITY_POOLS.find(pool => pool.key === name)?.label ?? String(name)]}
                  />
                  {ACTIVITY_POOLS.map(({ key, color }) => (
                    <Line key={key} dataKey={key} type="linear" stroke={colors[color]} strokeWidth={2}
                      dot={{ r: 2, strokeWidth: 0, fill: colors[color] }} activeDot={{ r: 4 }} connectNulls={false} isAnimationActive={false} />
                  ))}
                </LineChart>
              </ResponsiveContainer>
            </div>
          ) : (
            <div className="flex h-80 items-center justify-center text-caption text-muted" role="status">
              {mode === 'share' && total === 0 ? 'No non-coinbase transactions in this period.' : 'No complete activity observations are available.'}
            </div>
          )}
          {data.coverage.completeDays < data.coverage.expectedDays && (
            <p className="mt-3 text-caption text-muted">Some days are unavailable. Gaps are not counted as zero.</p>
          )}
          {query.error && <p className="mt-3 text-caption text-muted" role="status">Update unavailable. Showing the last loaded data.</p>}
        </>
      )}
    </ShareableCard>
  );
}
