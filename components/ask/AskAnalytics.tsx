import type { AskAnalytics as AnalyticsResult } from '@/lib/ask/chat';

export function AskAnalytics({ result }: { result?: AnalyticsResult }) {
  if (!result) return null;
  return <section aria-label="Analytics results" className="mt-4 rounded-lg border border-cipher-border p-4 text-sm">
    <p className="font-medium text-primary">{result.label}</p>
    <p className="mt-1 text-xs text-muted">{result.plan.start} – {result.plan.end} UTC · {result.plan.bucket} · {result.plan.order}</p>
    {result.rows.length ? <div className="mt-3 overflow-x-auto"><table className="w-full text-left text-xs">
      <caption className="sr-only">{result.label} by {result.plan.bucket}</caption>
      <thead><tr className="border-b border-cipher-border text-muted"><th scope="col" className="pb-2 font-normal">Period starts</th><th scope="col" className="pb-2 text-right font-normal">Value</th><th scope="col" className="pb-2 pl-3 font-normal">Observed through</th></tr></thead>
      <tbody>{result.rows.map(row => <tr key={row.date} className="border-b border-cipher-border last:border-0"><th scope="row" className="py-2 font-mono font-normal text-secondary">{row.date}</th><td className="py-2 text-right font-mono text-primary">{row.formatted}</td><td className="py-2 pl-3 text-muted">{row.observedThrough} · {row.observedDays} days</td></tr>)}</tbody>
    </table></div> : <p className="mt-3 text-secondary">No observations were returned for this period.</p>}
    {result.coverage.missingDays > 0 ? <p className="mt-3 text-xs text-cipher-gold">{result.coverage.missingDays} days have no observations. Rankings cover the available data.</p> : null}
    <details className="mt-3 text-xs text-muted"><summary className="cursor-pointer">Source and methodology</summary><p className="mt-2 leading-relaxed">{result.methodology}</p><p className="mt-2">Retrieved {result.retrievedAt} · public daily snapshots</p></details>
  </section>;
}
