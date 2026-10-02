import type { AskAnalytics as AnalyticsResult } from '@/lib/ask/chat';
import { analyticsPeriod, formatAnalyticsDate, formatAnalyticsRange } from '../../lib/ask/analytics-presentation';

export function AskAnalytics({ result }: { result?: AnalyticsResult }) {
  if (!result) return null;
  return <section aria-label="Analytics results" className="mt-4 rounded-lg border border-cipher-border p-4 text-sm">
    <p className="font-medium text-primary">{result.label}</p>
    <p className="mt-1 text-xs text-muted">{formatAnalyticsRange(result.plan.start, result.plan.end)} UTC · {result.plan.bucket === 'day' ? 'Daily' : result.plan.bucket === 'week' ? 'Weekly' : 'Monthly'} · {result.plan.order === 'newest' ? 'Most recent first' : result.plan.order === 'highest' ? 'Highest first' : 'Lowest first'}</p>
    {result.rows.length ? <div className="mt-3 overflow-x-auto"><table className="w-full text-left text-xs">
      <caption className="sr-only">{result.label} by {result.plan.bucket}</caption>
      <thead><tr className="border-b border-cipher-border text-muted"><th scope="col" className="pb-2 pr-3 font-normal">{result.plan.order === 'newest' ? 'Order' : 'Rank'}</th><th scope="col" className="pb-2 font-normal">Period</th><th scope="col" className="pb-2 text-right font-normal">{result.kind === 'count' ? 'Transactions' : 'Balance'}</th><th scope="col" className="pb-2 pl-3 font-normal">{result.kind === 'count' ? 'Observed days' : 'Snapshot date'}</th></tr></thead>
      <tbody>{result.rows.map((row, index) => {
        const period = analyticsPeriod(result.plan, row);
        return <tr key={row.date} className="border-b border-cipher-border last:border-0"><td className="py-3 pr-3 font-mono text-muted">{index + 1}</td><th scope="row" className="py-3 pr-3 font-normal text-secondary"><time dateTime={period.start}>{formatAnalyticsRange(period.start, period.end)}</time>{period.partial ? <span className="mt-1 block text-muted">Partial {result.plan.bucket}</span> : null}</th><td className="py-3 text-right font-mono text-primary">{row.formatted}</td><td className="py-3 pl-3 text-muted">{result.kind === 'count' ? `${row.observedDays} ${row.observedDays === 1 ? 'day' : 'days'}` : <time dateTime={row.observedThrough}>{formatAnalyticsDate(row.observedThrough)}</time>}</td></tr>;
      })}</tbody>
    </table></div> : <p className="mt-3 text-secondary">No observations were returned for this period.</p>}
    {result.coverage.missingDays > 0 ? <p className="mt-3 text-xs text-cipher-gold">{result.coverage.missingDays} {result.coverage.missingDays === 1 ? 'day has' : 'days have'} no observations. Rankings cover the available data.</p> : null}
    <details className="mt-3 text-xs text-muted"><summary className="cursor-pointer">Source and methodology</summary><p className="mt-2 leading-relaxed">{result.methodology}</p><p className="mt-2">Retrieved {result.retrievedAt} · public daily snapshots</p></details>
  </section>;
}
