'use strict';
const { getKnowledge, publicSources } = require('./ask-knowledge');
const { datasets } = require('./ask-query-plan');
const { renderExplanation } = require('./ask-explanation');
const { formatAnalyticsDate, formatAnalyticsRange } = require('../../../../lib/ask/analytics-presentation');
async function queryReply(evidence, input, run, locale, answerTaskFor) {
    const result = evidence.result, records = getKnowledge([datasets[result.plan.dataset].topic]);
    // Native rows carry the complete result. Narrative can discuss the first two
    // rows, multiple measures and verified calculations, without dumping a list.
    const facts = Object.fromEntries(Object.entries(evidence.facts).filter(([key]) => !/^row_/.test(key) || /^row_[ab]_/.test(key)));
    facts.window_start = formatAnalyticsDate(result.plan.start, locale);
    facts.window_end = formatAnalyticsDate(result.plan.end, locale);
    facts.indexed_through = new Date(result.coverage.indexedThrough).toLocaleString(locale, { timeZone: 'UTC' }) + ' UTC';
    for (const [i, row] of result.rows.slice(0, 2).entries())
        for (const c of result.columns) {
            if (c.type !== 'date' || !row[c.key].value)
                continue;
            const start = row[c.key].value, end = new Date(start + 'T00:00:00Z');
            if (result.plan.bucket === 'week')
                end.setUTCDate(end.getUTCDate() + 6);
            if (result.plan.bucket === 'month') {
                end.setUTCMonth(end.getUTCMonth() + 1);
                end.setUTCDate(0);
            }
            facts[`row_${String.fromCharCode(97 + i)}_${c.key.replace(/\d/g, digit => String.fromCharCode(97 + Number(digit)))}`] = formatAnalyticsRange(start < result.plan.start ? result.plan.start : start, end.toISOString().slice(0, 10) > result.plan.end ? result.plan.end : end.toISOString().slice(0, 10), locale);
        }
    const task = answerTaskFor(facts, records, true, true);
    task.instruction += '\nWrite only one short leading finding in summary. Leave observations empty. The table displays every requested rank: never announce a list, enumerate other ranks, repeat a date as another period, or claim remaining rows are absent because their placeholders are not provided. Use natural metric language, such as public deshielding volume, rather than merely repeating internal field labels. This is a validated relational query result. Directly answer the question with one leading finding and at most one useful comparison or interpretation. Use the supplied column labels and fact placeholders, including calculated ratio/difference facts when present. Do not calculate new percentages mentally. A ratio means left divided by right times one hundred; it is not a percent change or a share of a larger total unless that denominator was queried. The native table already contains all rows; do not repeat the entire ranking. Read order.column and direction before describing a peak. Measures count records or sum/average the named public fields, not users or private transfer amounts. Missing measures and zero-denominator ratios are unavailable, never zero. Per-measure missing counts indicate partial aggregate totals; do not describe these as complete. Last uses the last dated snapshot, even when null. For flows, busiest without an explicit volume metric means record count; explicitly name the chosen measure. Date windows are clipped to completed UTC days, and edge calendar buckets may be partial. Use observed/indexed/tracked rather than claiming an exhaustive historical maximum when completeness is unverified. Sparse event dates do not establish missing database days or zero activity. The canonical-chain indexed-through timestamp is not certification of flow backfill coverage. Distinguish estimates, observations and documented protocol context. Do not infer causes, identities, or direct migration from pool stock ratios. Mention only limitations that matter to this question.';
    const raw = await run({ question: input.question, history: input.history, locale, documents: records, evidence: { ...result, facts } }, task);
    const rendered = renderExplanation({ summary: raw.summary, observations: raw.observations, limitation: raw.limitation }, facts);
    return { answer: [rendered.summary, ...rendered.observations, rendered.limitation].filter(Boolean).join('\n\n'), sources: publicSources(records), spec: null, locale, analytics: result, evidenceKey: evidence.evidenceKey };
}
module.exports = { queryReply };
