import { ApiError, readApiResponse } from '@/lib/api-client';
import { getAskApiUrl } from './api-base';
import type { AskLocale, AskReply, AskTurn } from './chat';
import type { AnalysisSpec } from './contract';
export function askErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === 'ask-quota-day') return 'Today’s limit of 20 requests for your connection has been reached. Ask and SQL share this limit; starter charts remain available.';
    if (error.code === 'ask-quota-minute') return 'Too many requests from your connection. Ask and SQL share a limit of 5 requests per minute.';
    if (error.status === 429) return 'Ask has reached its allowance. Try later; starter charts remain available.';
    if (error.code === 'ask-verification') return 'Verification expired or failed. Retry verification, then send your question again.';
    if (error.code === 'ask-resource') return 'This query exceeded its disk or result-size budget. Filter every joined table to your requested period and aggregate before joining. Your period has not been changed.';
    if (error.code === 'ask-query') return 'This SQL could not run. Check the column names and supported functions in the data catalogue.';
    if (error.code === 'ask-interrupted') return 'The research worker restarted. Run the query again; it was not retried automatically.';
    if (error.code === 'ask-job') return 'This research job has expired or is unavailable. Run the query again.';
    if (error.code === 'ask-dataset') return 'A dataset needed by this query is still copying or refreshing. Your draft is kept; try again after it becomes available.';
    if (error.code === 'ask-source') return 'Source data is temporarily unavailable. Try again shortly; your current analysis is still available.';
    if (error.code === 'ask-answer') return 'Ask could not validate the answer. Try a more specific question or open the source chart.';
    if (error.code === 'ask-provider') return 'The AI provider is temporarily unavailable. Starter charts remain available.';
    if (error.status === 400) return 'This query or question is not supported. Check the data catalogue and SQL syntax, then try again.';
    if (error.status === 504) return 'The request took too long. Review the filters on each joined table, then run it again. Your requested period has not been changed.';
  }
  if (error instanceof Error && error.name === 'TimeoutError') return 'The request took too long. Please try again.';
  return 'Ask is temporarily unavailable. Please try again or choose a starter chart.';
}
export interface AskCapability { mode: 'guided' | 'ai'; provider: string | null; siteKey?: string | null; researchEnabled?: boolean; jobsEnabled?: boolean; researchExtended?: boolean; authenticatedStaging?: boolean }
export async function askCapability(signal: AbortSignal): Promise<AskCapability> {
  const response = await fetch(getAskApiUrl(), { signal, cache: 'no-store' });
  const { data, meta } = await readApiResponse<AskCapability>(response);
  if (meta.network !== 'mainnet') throw new Error('Wrong network');
  return data;
}
export async function askChat(question: string, page: string, context: AnalysisSpec | null, locale: AskLocale, history: string[], challenge: string, signal: AbortSignal, block?: string, transaction?: string, currentAnalytics?: import('./chat').QueryPlan, currentResearch?: import('./research-contract').ResearchQuery): Promise<AskReply> {
  const response = await fetch(`${getAskApiUrl()}/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, cache: 'no-store', signal, body: JSON.stringify({ question, page, context, locale, currentAnalytics, currentResearch, history: history.slice(-4), challenge, block, transaction }) });
  const { data, meta } = await readApiResponse<AskReply>(response);
  if (meta.network !== 'mainnet') throw new Error('Wrong network');
  return data;
}
export interface AskHandoff { transaction?: string; block?: string; turns: AskTurn[]; spec: AnalysisSpec | null; page: string }
// Memory only, never URL parameters, browser storage or analytics.
let handoff: AskHandoff | null = null;
export function saveAskHandoff(value: AskHandoff) { handoff = { ...value, turns: value.turns.slice(-12) }; }
export function peekAskHandoff() { return handoff; }
export function clearAskHandoff() { handoff = null; }

export interface AskFailure { title: string; detail: string; retryAt?: number; retryable: boolean }
export function askFailure(error: unknown, now = Date.now()): AskFailure {
  const limited = error instanceof ApiError && error.status === 429;
  // Only known admission windows promise an automatic reset. Provider/budget
  // denials may need operator action; their generic header is not a reset time.
  const seconds = error instanceof ApiError && ['ask-quota-day', 'ask-quota-minute'].includes(error.code || '') && /^\d+$/.test(error.retryAfter || '') ? Number(error.retryAfter) : 0;
  return { title: limited ? 'Request limit reached' : error instanceof ApiError && error.code === 'ask-verification' ? 'Verification needed' : 'Request could not finish', detail: askErrorMessage(error), retryAt: seconds > 0 && seconds <= 86400 ? now + seconds * 1000 : undefined, retryable: !limited && !(error instanceof ApiError && error.code === 'ask-verification') };
}
