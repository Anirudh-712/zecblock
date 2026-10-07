'use client';

import { useEffect, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { analysisSchema, resolveShortcut, starters, type AnalysisSpec } from '@/lib/ask/contract';
import { fetchEvidence, formatValue, summarizeEvidence, type Evidence } from '@/lib/ask/evidence';
import { getApiUrl } from '@/lib/api-config';
import { readApiResponse } from '@/lib/api-client';
import { useTheme } from '@/contexts/ThemeContext';
import { getChartColors } from '@/lib/chart-theme';
import styles from './ask.module.css';
import { useResearchTools, ResearchLibrary, ResearchEditor, ResearchPanel, ResearchDashboard } from './ResearchWorkbench';
import type { ResearchDocument, ResearchResult } from '@/lib/ask/research-contract';
import type {ResearchJobStatus} from '@/lib/ask/research-job-contract';
import {jobTicketSchema} from '@/lib/ask/research-job-contract';
import { runResearch, submitResearch, waitResearch, explainResearch } from '@/lib/ask/research-client';
import { researchResultSchema } from '@/lib/ask/research-contract';
import { AskChallenge } from '@/components/ask/AskChallenge';
import { AskTransactions } from '@/components/ask/AskTransactions';
import { AskBlocks } from '@/components/ask/AskBlocks';
import { AskTransfers } from '@/components/ask/AskTransfers';
import { AskSources } from '@/components/ask/AskSources';
import { AskAnalytics } from '@/components/ask/AskAnalytics';
import { askChat, peekAskHandoff, clearAskHandoff } from '@/lib/ask/client';
import type { AskReply, AskSource } from '@/lib/ask/chat';
import { sqlDraft } from '@/lib/ask/composer';
import { AskFeedback, AskFailureFeedback, useAskFeedback } from '@/components/ask/AskFeedback';
import { describeMetric, formatChain } from '@/lib/ask/data';

const AskChart = dynamic(() => import('./AskChart'), { ssr: false, loading: () => <div className="h-80 grid place-items-center text-sm text-muted" role="status">Loading chart…</div> });
const categories = ['Featured', 'Pools', 'Ironwood', 'Cross-chain', 'Network'];
type Message = { research?: ResearchResult; analytics?: AskReply['analytics']; transactions?: AskReply['transactions']; blocks?: AskReply['blocks']; dataContext?: AskReply['dataContext']; id: number; question: string; answer: string; spec?: AnalysisSpec; sources?: AskSource[]; transfers?: AskReply['transfers']; locale?: string; scope?: string };
type Session = { transaction?: string; block?: string; id: number; title: string; messages: Message[]; spec: AnalysisSpec | null; page?: string };
type Capability = { mode: 'guided' | 'ai'; provider: string | null; siteKey?: string | null; researchEnabled?: boolean; jobsEnabled?: boolean };
const initialSession: Session = { id: 0, title: 'New analysis', messages: [], spec: null };
const viewKey = (spec: AnalysisSpec | null) => spec ? JSON.stringify([spec.metric, spec.period, spec.pool, spec.view, spec.start, spec.end]) : '';

function AskMark({ small = false }: { small?: boolean }) {
  return <span className={`inline-flex shrink-0 items-center justify-center border border-cipher-border bg-cipher-surface text-cipher-gold font-mono ${small ? 'h-7 w-7 text-sm rounded' : 'h-12 w-12 text-xl rounded-lg'}`} aria-hidden="true">&gt;_</span>;
}

export function AskWorkspace() {
  const [handoff] = useState(peekAskHandoff);
  const [token, setToken] = useState('');
  const [challengeReset, setChallengeReset] = useState(0);
  const [sessions, setSessions] = useState<Session[]>(() => handoff?.turns.length ? [{ id: 0, title: handoff.turns[0].question, spec: handoff.spec, page: handoff.page, block: handoff.block, transaction: handoff.transaction, messages: handoff.turns.map((turn, i) => ({ id: i + 1, question: turn.question, answer: turn.answer, sources: turn.sources, transfers: turn.transfers, blocks: turn.blocks, transactions: turn.transactions, analytics: turn.analytics, research: turn.research, locale: turn.locale, scope: turn.scope, dataContext: turn.dataContext, spec: turn.spec || undefined })) }] : [initialSession]);
  const tools = useResearchTools(handoff?.turns.at(-1)?.research, handoff?.turns.at(-1)?.question);
  const [activeId, setActiveId] = useState(0);
  const [question, setQuestion] = useState('');
  const [inputMode, setInputMode] = useState<'ask' | 'sql'>('ask');
  const [phase, setPhase] = useState<'thinking' | 'submitting' | 'explaining'>('thinking');
  const [notice, setNotice] = useState('');
  const feedback = useAskFeedback();
  const [busy, setBusy] = useState(false);
  const [jobStatus,setJobStatus]=useState<ResearchJobStatus|null>(null);
  const [jobClock,setJobClock]=useState(()=>Date.now());
  const [capability, setCapability] = useState<Capability>({ mode: 'guided', provider: null });
  const [capabilityReady, setCapabilityReady] = useState(false);
  const [connectionFailed, setConnectionFailed] = useState(false);
  const reconnect = useRef<() => void>(() => {});
  const [fetchedEvidence, setEvidence] = useState<Evidence | null>(null);
  const [loadingData, setLoadingData] = useState(false);
  const [error, setError] = useState('');
  const [chatError, setChatError] = useState('');
  const [sourcesOpen, setSourcesOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [tablePage, setTablePage] = useState(0);
  const [exampleCategory, setExampleCategory] = useState('Featured');
  const request = useRef<AbortController | null>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const composerStatus = useRef<HTMLDivElement>(null);
  const serial = useRef(handoff?.turns.length || 0);
  const transcript = useRef<HTMLDivElement>(null);
  const workspace = useRef<HTMLDivElement>(null);
  const session = sessions.find(item => item.id === activeId)!;
  const spec = session.spec;
  const info = spec ? describeMetric(spec.metric) : null;
  const ranking = Boolean(spec?.metric.startsWith('chain_'));
  const poolMetric = !spec || ['balances', 'flows', 'activity'].includes(spec.metric);
  const examples = starters.filter(starter => exampleCategory === 'Featured' ? ['balances', 'ironwood-balance', 'swap-volume', 'pulse'].includes(starter.id) : exampleCategory === 'Pools' ? ['balances', 'compare', 'flows', 'activity'].includes(starter.id) : starter.category === exampleCategory);
  const evidence = spec && fetchedEvidence?.key === `${spec.metric}:${spec.period}:${spec.pool}` ? fetchedEvidence : null;
  const start = spec?.start || '';
  const end = spec?.end || '';
  const { theme } = useTheme();
  const colors = getChartColors(theme);
  const hasMessages = session.messages.length > 0;
  const latestRecords = !spec ? session.messages.filter(message => message.research || message.analytics || message.transfers || message.blocks || message.transactions).at(-1) : undefined;
  const transfers = latestRecords?.transfers;
  const blocks = latestRecords?.blocks;
  const transactions = latestRecords?.transactions;
  const analytics = latestRecords?.analytics;
  const research = latestRecords?.research;
  const summary = evidence && spec ? summarizeEvidence(evidence, spec, start, end) : null;
  const invalidDates = Boolean(start && end && start > end);

  useEffect(() => {
    if(jobStatus?.state!=='running'||!jobStatus.startedAt)return;
    const timer=setInterval(()=>setJobClock(Date.now()),1000);
    return ()=>clearInterval(timer);
  },[jobStatus?.state,jobStatus?.startedAt]);

  useEffect(() => {
    clearAskHandoff();
    const controller = new AbortController();
    let pending = false;
    const refreshCapability = () => {
      if (pending || controller.signal.aborted) return;
      pending = true;
      fetch(`${getApiUrl()}/v1/ask`, { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]), cache: 'no-store' })
        .then(res => readApiResponse<Capability>(res))
        .then(({ data, meta }) => {
          if (!controller.signal.aborted && meta.network === 'mainnet' && ['guided', 'ai'].includes(data.mode)) { setCapability(data); setCapabilityReady(true); setConnectionFailed(false); }
        })
        .catch(() => { if (!controller.signal.aborted) setConnectionFailed(true); })
        .finally(() => { pending = false; });
    };
    reconnect.current = refreshCapability;
    refreshCapability();
    const refreshVisible = () => { if (document.visibilityState === 'visible') refreshCapability(); };
    const interval = setInterval(refreshVisible, 30000);
    window.addEventListener('online', refreshCapability);
    window.addEventListener('focus', refreshVisible);
    return () => {
      clearInterval(interval); window.removeEventListener('online', refreshCapability); window.removeEventListener('focus', refreshVisible);
      controller.abort(); request.current?.abort();
    };
  }, []);

  const metric = spec?.metric;
  const period = spec?.period;
  const pool = spec?.pool;
  useEffect(() => {
    setEvidence(null); setError(''); setTablePage(0);
    if (!metric || !period || !pool) { setLoadingData(false); return; }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error('The data request timed out. Please retry.')), 15000);
    setLoadingData(true);
    fetchEvidence({ version: 1, metric, period, pool, view: metric.startsWith('chain_') ? 'bar' : 'line', start: null, end: null }, controller.signal)
      .then(result => { if (!controller.signal.aborted) setEvidence(result); })
      .catch(() => { if (!controller.signal.aborted || controller.signal.reason instanceof Error && controller.signal.reason.name !== 'AbortError') setError('Source data is temporarily unavailable. Retry or open the source page.'); })
      .finally(() => { clearTimeout(timeout); if (!controller.signal.aborted || controller.signal.reason?.name !== 'AbortError') setLoadingData(false); });
    return () => { clearTimeout(timeout); controller.abort(); };
  }, [metric, period, pool, activeId, refresh]);

  useEffect(() => {
    if (busy || feedback.failure || notice || chatError) composerStatus.current?.scrollIntoView({ block: 'nearest', behavior: 'instant' });
  }, [busy, feedback.failure, notice, chatError]);

  useEffect(() => { transcript.current?.scrollTo({ top: transcript.current.scrollHeight, behavior: 'instant' }); }, [session.messages.length, busy]);

  function updateSpec(next: AnalysisSpec, restore = false) {
    if (!restore && (next.metric !== spec?.metric || next.period !== spec?.period || next.pool !== spec?.pool)) next = { ...next, start: null, end: null };
    const validated = analysisSchema.parse(next);
    setSessions(all => all.map(item => item.id === activeId ? { ...item, spec: validated } : item));
    setTablePage(0);
  }

  function switchSession(id: number) {
    request.current?.abort(); request.current = null; setBusy(false); setJobStatus(null); setNotice(''); feedback.clear(); setChatError(''); setActiveId(id); setQuestion(''); setInputMode('ask');
    const saved = sessions.find(item => item.id === id)?.messages.filter(message => message.research).at(-1);
    const doc = saved?.research ? tools.library.documents.find(item => item.result?.fingerprint === saved.research?.fingerprint) : undefined;
    if (doc) tools.open(doc); else if(saved?.research)tools.accept(saved.research,saved.question);else tools.reset(); setSourcesOpen(false); setEvidence(null);
  }

  function newSession() {
    tools.reset();
    if (!hasMessages) { input.current?.focus(); return; }
    const id = ++serial.current;
    setSessions(all => [{ id, title: 'New analysis', messages: [], spec: null }, ...all].slice(0, 12));
    switchSession(id);
    requestAnimationFrame(() => input.current?.focus());
  }

  async function ask(text: string) {
    const trimmed = text.trim();
    const detected = capability.researchEnabled ? sqlDraft(trimmed) : null;
    if (detected) { selectSQL(detected); return; }
    const next = resolveShortcut(trimmed, spec);
    if (!trimmed || trimmed.length > 1000 || feedback.blocked && !next || busy || request.current || !capabilityReady && !next || capability.mode === 'ai' && !token && !next) return;
    setInputMode('ask'); setQuestion(trimmed); setBusy(true); setPhase('thinking'); setNotice(''); feedback.clear(); setChatError(''); setCopied(false);
    const controller = new AbortController();
    request.current = controller;
    const timeout = setTimeout(() => controller.abort(new DOMException('Request timed out', 'TimeoutError')), 300000);
    const id = ++serial.current;
    const append = (answer: string, next?: AnalysisSpec, sources?: AskSource[], answerLocale?: string, scope?: string, transfers?: AskReply['transfers'], dataContext?: AskReply['dataContext'], blocks?: AskReply['blocks'], transactions?: AskReply['transactions'], analytics?: AskReply['analytics'], research?: ResearchResult) => setSessions(all => all.map(item => item.id === activeId ? {
      ...item, title: item.messages.length ? item.title : trimmed,
      messages: [...item.messages, { id, question: trimmed, answer, spec: next, sources, transfers, blocks, transactions, analytics, research, dataContext, locale: answerLocale, scope }].slice(-30),
      block: blocks?.rows[0]?.hash || item.block,
      transaction: transactions ? transactions.query.txid || transactions.rows[0]?.txid : item.transaction,
      spec: research || analytics || transfers || blocks || transactions ? null : next ?? item.spec,
    } : item));
    try {
      if (!next || capability.mode === 'ai' && token && !feedback.blocked) {
        let reply = await askChat(trimmed, session.page || 'ask', spec, 'auto', session.messages.map(message => message.question), token, controller.signal, session.block, session.transaction, analytics?.plan.version === 2 ? analytics.plan : undefined, capability.researchEnabled ? research?.query : undefined);
        if(reply.job){
          const ticket=jobTicketSchema.parse(reply.job);
          const result=await waitResearch(ticket,controller.signal,setJobStatus);
          // Display validated data even if a paid explanation is unavailable.
          setPhase('explaining');
          try{reply=await explainResearch(ticket,trimmed,reply.locale,controller.signal);}
          catch(cause){if(controller.signal.aborted)throw cause;reply={answer:'Your query is complete. The results are shown alongside this conversation; an AI explanation is temporarily unavailable.',sources:[],spec:null,locale:reply.locale,mode:'ai',research:result};}
        }
        if (controller.signal.aborted) return;
        append(reply.answer, reply.spec ? analysisSchema.parse(reply.spec) : undefined, reply.sources, reply.locale, reply.scope, reply.transfers, reply.dataContext, reply.blocks, reply.transactions, reply.analytics, reply.research ? researchResultSchema.parse(reply.research) : undefined);
        if(reply.research)tools.accept(researchResultSchema.parse(reply.research),trimmed);
      } else {
        append(`Opened ${describeMetric(next.metric).title.toLowerCase()} for ${next.period === '1y' ? 'the past year' : `the past ${next.period.slice(0, -1)} days`}${next.pool === 'all' ? '' : `, filtered to ${next.pool}`}. The analysis shows the source observations and updates as you change the controls.`, next);
      }
      setQuestion(''); setNotice('Answer ready.');
      if (!hasMessages) requestAnimationFrame(() => workspace.current?.scrollIntoView({ block: 'start', behavior: 'instant' }));
    } catch (cause) {
      if (request.current === controller) {
        setQuestion(trimmed);
        if (!controller.signal.aborted || controller.signal.reason?.name === 'TimeoutError') {
          feedback.report(controller.signal.aborted ? controller.signal.reason : cause);
          if (next) updateSpec(next, true);
        } else setNotice('Stopped. Your draft is still here.');
      }
    } finally {
      clearTimeout(timeout);
      if (request.current === controller) { request.current = null; setBusy(false); setToken(''); setChallengeReset(value => value + 1); setJobStatus(null); }
    }
  }

  function exportCsv() {
    if (!summary || !evidence) return;
    const rows = [[evidence.dimension === 'chain' ? 'chain' : 'date_utc', ...evidence.series.map(series => `${series.key}_${evidence.csvUnit}`)], ...summary.points.map(point => [point.date, ...evidence.series.map(series => point.values[series.key] ?? '')])];
    const url = URL.createObjectURL(new Blob([rows.map(row => row.join(',')).join('\n')], { type: 'text/csv;charset=utf-8' }));
    const a = document.createElement('a'); a.href = url; a.download = `zecblock-${spec?.metric}-${ranking ? spec?.period : `${summary.start}-${summary.end}`}.csv`; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function openSaved(doc: ResearchDocument) {
    if(busy||tools.importing)return;
    tools.open(doc);const id=++serial.current;
    setSessions(all=>[{id,title:doc.title,spec:null,messages:[{id,question:doc.title,answer:doc.result?'Opened your saved analysis. These are saved results; run its SQL to refresh them.':'Opened your saved query. Choose Run SQL to refresh its results.',research:doc.result||undefined}]},...all].slice(0,12));
    setActiveId(id);setQuestion('');setInputMode('sql');setNotice('Saved query loaded. Run SQL to refresh its results.');feedback.clear();setChatError('');setEvidence(null);
  }
  async function runSQL() {
    if(busy||tools.importing||feedback.blocked||!tools.sql.trim()||!capabilityReady)return;
    if(!token){setChatError('Verification is still loading. Retry verification before running SQL.');return;}
    setBusy(true);setPhase('submitting');setNotice('');feedback.clear();setChatError('');const controller=new AbortController();request.current=controller;
    try{
      const query={version:3 as const,sql:tools.sql,limit:tools.limit};
      const signal=AbortSignal.any([controller.signal,AbortSignal.timeout(300000)]);
      const result=capability.jobsEnabled?await waitResearch(await submitResearch(query,token,signal),signal,setJobStatus):await runResearch(query,token,AbortSignal.any([signal,AbortSignal.timeout(20000)]));
      if (request.current !== controller || controller.signal.aborted) return;
      const id=++serial.current;const title=tools.title;
      tools.accept(result,title,false); setNotice(`Query complete. ${result.rows.length} rows returned; no AI was used.`);
      setSessions(all=>all.map(item=>item.id===activeId?{...item,title: item.messages.length?item.title:title,spec:null,messages:[...item.messages,{id,question:title,answer:`Your query returned ${result.rows.length} records. The results are shown alongside this conversation.`,research:result}].slice(-30)}:item));
    }catch(error){if(!controller.signal.aborted)feedback.report(error);else setNotice('Stopped. Your SQL is still here.');}
    finally{if(request.current===controller){setBusy(false);setToken('');setChallengeReset(value=>value+1);request.current=null;setJobStatus(null);}}
  }
  function selectSQL(sql: string) {
    if (busy) return;
    if (sql.length > 8192) { setChatError('SQL can contain up to 8,192 characters. Shorten the query before pasting it.'); return; }
    tools.setSQL(sql); setInputMode('sql'); setChatError('');
    if (!feedback.blocked) feedback.clear();
    setNotice('SQL detected. Review it, then choose Run SQL. No AI request was sent.');
    requestAnimationFrame(() => input.current?.focus());
  }
  function changeMode(mode: 'ask' | 'sql') {
    if (busy) return;
    setInputMode(mode); setChatError(''); setNotice('');
    if (!feedback.blocked) feedback.clear();
    requestAnimationFrame(() => input.current?.focus());
  }
  const researchEditor=capability.researchEnabled?<ResearchEditor tools={tools} busy={busy} onOpen={openSaved}/>:null;
  const sqlMode = inputMode === 'sql';
  const canSend = sqlMode ? capabilityReady && !!token && !!tools.sql.trim() && !tools.importing && !feedback.blocked : !!question.trim() && ((!feedback.blocked && capabilityReady && (capability.mode !== 'ai' || !!token)) || !!resolveShortcut(question, spec));
  const submit = () => sqlMode ? void runSQL() : void ask(question);
  const statusTitle = jobStatus?.state === 'queued' ? 'Waiting for a query slot…' : jobStatus?.state === 'running' ? 'Running your query…' : phase === 'explaining' ? 'Explaining the results…' : phase === 'submitting' ? 'Submitting your query…' : 'Thinking…';
  const statusDetail = jobStatus?.state === 'queued' ? jobStatus.queuePosition > 1 ? `${jobStatus.queuePosition - 1} queries ahead. You can stop while waiting.` : 'Your query is queued. It will start when a worker is available.' : jobStatus?.state === 'running' ? 'Reading the public analytics data. Your previous results stay available.' : phase === 'explaining' ? 'The query is complete. Preparing an explanation from its results.' : phase === 'submitting' ? 'Checking the SQL and requesting a query slot. No AI is used.' : 'Interpreting your question and checking public sources.';
  const composer = <div className={styles.composerGroup}><form onSubmit={event => { event.preventDefault(); submit(); }} className={styles.composer} aria-busy={busy}>
    <label htmlFor="ask-question" className="sr-only">{sqlMode ? 'SQL query' : 'Ask a question about Zcash'}</label>
    <textarea ref={input} id="ask-question" value={sqlMode ? tools.sql : question} dir={sqlMode ? 'ltr' : 'auto'} disabled={busy} onChange={event => sqlMode ? tools.setSQL(event.target.value) : setQuestion(event.target.value)} rows={sqlMode ? 9 : hasMessages ? 2 : 3} maxLength={sqlMode ? 8192 : 1000}
      className={sqlMode ? styles.sqlInput : undefined} spellCheck={!sqlMode} autoComplete="off" aria-describedby="ask-input-hint"
      placeholder={sqlMode ? 'SELECT height, transactions FROM blocks ORDER BY height DESC LIMIT 10' : hasMessages ? 'Ask a follow-up, or refine this view…' : 'Ask about Zcash, or paste a SQL query…'}
      onPaste={event => { if (sqlMode || !capability.researchEnabled) return; const sql = sqlDraft(event.clipboardData.getData('text')); if (sql) { event.preventDefault(); selectSQL(sql); } }}
      onKeyDown={event => { if (event.key === 'Enter' && !event.nativeEvent.isComposing && (sqlMode ? event.metaKey || event.ctrlKey : !event.shiftKey)) { event.preventDefault(); if (!busy && canSend) submit(); } }} />
    <div className={styles.composerActions}><div className={styles.composerModes} role="group" aria-label="Input mode">
      <button type="button" aria-pressed={!sqlMode} disabled={busy} onClick={() => changeMode('ask')}>Ask</button>
      {capability.researchEnabled ? <button type="button" aria-pressed={sqlMode} disabled={busy} onClick={() => changeMode('sql')}>SQL</button> : null}
    </div>{sqlMode ? <label className={styles.rowLimit}>Rows<select aria-label="Maximum rows" disabled={busy} value={tools.limit} onChange={event => tools.setLimit(Number(event.target.value))}>{[10,50,100,200].map(value => <option key={value}>{value}</option>)}</select></label> : null}
      {busy ? <button type="button" className={styles.submit} onClick={() => request.current?.abort()} aria-label="Stop request">■</button>
        : <button type="submit" className={sqlMode ? styles.runSQL : styles.submit} disabled={!canSend} aria-label={sqlMode ? 'Run SQL' : 'Send question'}>{sqlMode ? 'Run SQL' : '↑'}</button>}
    </div>
  </form><p id="ask-input-hint" className={styles.inputHint}>{sqlMode ? 'Direct SQL · no AI · Ctrl / ⌘ + Enter to run' : !capabilityReady ? 'Connecting to Ask…' : capability.mode === 'ai' ? 'Ask AI · Enter to send · Shift + Enter for a new line' : 'Guides & public data · Enter to send'}</p>
    <div ref={composerStatus}>{busy ? <AskFeedback working title={statusTitle} detail={statusDetail} extra={jobStatus?.state === 'running' ? `${Math.max(0,Math.floor((jobClock-Date.parse(jobStatus.startedAt || new Date(jobClock).toISOString()))/1000))}s elapsed · ${jobStatus.maxRunSeconds}s execution limit` : undefined}/> : feedback.failure ? <AskFailureFeedback failure={feedback.failure} blocked={feedback.blocked} onRetry={submit}/> : connectionFailed ? <AskFeedback error title="Could not connect to Ask" detail="Your draft is still here. Check your connection and try again." onRetry={() => {setConnectionFailed(false);reconnect.current();}} retryLabel="Reconnect"/> : chatError ? <AskFeedback error title="Check your request" detail={chatError}/> : notice ? <AskFeedback title={notice}/> : null}</div>
    <AskChallenge siteKey={capability.siteKey} onToken={setToken} reset={challengeReset}/>
  </div>;

  return <div className={styles.workspace} ref={workspace}>
    <aside className={styles.sidebar} aria-label="Ask workspace navigation">
      <button type="button" onClick={newSession} className={styles.newButton} disabled={busy || tools.importing}><span aria-hidden="true">＋</span> New analysis</button>
      {sessions.some(item => item.messages.length) ? <label className={styles.mobileSessions}><span className="sr-only">Recent analyses</span><select aria-label="Recent analyses" value={activeId} onChange={event => switchSession(Number(event.target.value))}>{sessions.map(item => <option key={item.id} value={item.id}>{item.title}</option>)}</select></label> : null}
      <div className={styles.sidebarContent}><p className="text-caption font-mono text-muted mt-8 mb-3">THIS SESSION</p>
        {sessions.some(item => item.messages.length) ? sessions.filter(item => item.messages.length).map(item => <button key={item.id} className={`${styles.session} ${activeId === item.id ? styles.selectedSession : ''}`} aria-current={activeId === item.id ? 'true' : undefined} onClick={() => switchSession(item.id)} title={item.title}>{item.title}</button>) : <p className="text-xs leading-relaxed text-muted">Your analyses will appear here.</p>}
        {capability.researchEnabled || tools.library.documents.length ? <ResearchLibrary tools={tools} busy={busy} onOpen={openSaved}/> : null}
        <p className="text-caption font-mono text-muted mt-9 mb-3">EXPLORE THE DATA</p>
        <Link href="/pools" className={styles.sourceLink}>Shielded pools <span>↗</span></Link>
        <Link href="/ironwood" className={styles.sourceLink}>Ironwood <span>↗</span></Link>
        <Link href="/crosschain" className={styles.sourceLink}>Cross-chain swaps <span>↗</span></Link>
        <Link href="/pulse" className={styles.sourceLink}>Network Pulse <span>↗</span></Link>
        <Link href="/rich-list" className={styles.sourceLink}>Transparent addresses <span>↗</span></Link>
        <Link href="/privacy" className={styles.sourceLink}>Privacy score <span>↗</span></Link>
        <Link href="/charts" className={styles.sourceLink}>Chart library <span>↗</span></Link>
      </div>
      <div className={styles.sessionNote}><span className="text-secondary">A temporary workspace</span><p className="mt-2">Conversations stay in memory. Saved analyses stay in this browser; download a copy to keep them elsewhere. Never include wallet secrets.</p></div>
    </aside>

    <div className={`${styles.main} ${hasMessages && !tools.boardId ? styles.active : ''}`}>
      {tools.boardId ? <ResearchDashboard tools={tools} busy={busy} onOpen={openSaved}/> : !hasMessages ? <div className={styles.welcome}>
        <AskMark /><h2 className="text-3xl sm:text-4xl font-medium tracking-tight text-primary mt-6">Follow your curiosity.</h2>
        <p className="mt-3 mb-8 text-secondary text-sm sm:text-base leading-relaxed">Ask a question. Find the signal.<br className="sm:hidden" /> Make the data your own.</p>
        {composer}{researchEditor}
        <div className="flex flex-wrap gap-2 mt-6" role="group" aria-label="Example question categories">{categories.map(category => <button type="button" key={category} aria-pressed={exampleCategory === category} onClick={() => setExampleCategory(category)} className={`${styles.followup} ${exampleCategory === category ? styles.selectedCategory : ''}`}>{category}</button>)}</div>
        <div className={styles.starters}>{examples.map((starter, index) => <button key={starter.id} onClick={() => void ask(starter.title)} className={styles.starter}>
          <span className="flex justify-between items-center text-caption font-mono text-muted"><span>{starter.category}</span><span aria-hidden="true">0{index + 1}</span></span>
          <span className="block mt-3 text-sm text-primary font-medium">{starter.title}</span><span className="block mt-2 text-xs text-muted leading-relaxed">{starter.detail}</span>
        </button>)}</div>
        <p className="mt-6 text-caption leading-relaxed text-muted">{sqlMode ? 'SQL runs directly against public analytics data. Your SQL is not sent to AI.' : capability.mode === 'ai' ? `Questions, recent conversation context and public facts are sent to ${capability.provider}. Do not include wallet secrets or private information.` : 'Starter questions use indexed public data. Reviewed wallet and node guides are available; free-form AI is not connected yet.'}</p>
      </div> : <>
        <section className={styles.conversation} aria-label="Conversation">
          <div className={styles.transcript} ref={transcript}>
            {session.messages.map(message => <div key={message.id} className="mb-7">
              <div className="ml-8 border border-cipher-border bg-cipher-surface rounded-lg px-4 py-3 text-sm text-primary leading-relaxed break-words">{message.question}</div>
              <div className="flex gap-3 mt-5"><AskMark small /><div className="min-w-0"><p className="text-caption font-mono text-muted mb-2">ZecBlock</p><p dir="auto" lang={message.locale} className="text-sm text-secondary leading-relaxed whitespace-pre-wrap">{message.answer}</p><>{message.transfers && message.transfers !== transfers ? <details className="mt-3"><summary className="cursor-pointer text-caption text-cipher-gold">View transaction results</summary><AskTransfers result={message.transfers} /></details> : null}</><AskAnalytics result={message.analytics !== analytics ? message.analytics : undefined} /><AskBlocks result={message.blocks !== blocks ? message.blocks : undefined} /><AskTransactions result={message.transactions !== transactions ? message.transactions : undefined} /><AskSources sources={message.sources || []} dataContext={message.dataContext} />{message.scope ? <p className="mt-2 text-caption text-muted">{message.scope}</p> : null}
                {message.spec && viewKey(message.spec) !== viewKey(spec) ? <button onClick={() => updateSpec(message.spec!, true)} className="mt-3 text-caption font-mono text-cipher-gold hover:underline">Restore this view →</button> : null}
              </div></div>
            </div>)}
            {evidence && spec && summary?.points.length && !invalidDates && capability.mode === 'ai' ? <button type="button" onClick={() => void ask('Explain this view')} disabled={busy || !token} className="text-sm text-cipher-gold hover:underline disabled:opacity-40">Explain this view →</button> : null}

          </div>
          <div className={styles.conversationFooter}>
            <div className="flex flex-wrap gap-2 mb-3">{(spec ? ranking ? ['Show as a bar chart', 'Show as a table'] : ['Show 90 days', poolMetric ? spec.pool === 'ironwood' ? 'Just Orchard' : 'Just Ironwood' : 'Show as a line chart', 'Show as a table'] : transactions ? ['Show the latest 5 transactions', 'Explain this transaction'] : blocks ? ['Tell me about the latest block', 'Explain this block'] : research ? ['Compare the leading results', 'Group these results by day'] : starters.slice(0, 2).map(item => item.title)).map(text => <button key={text} disabled={busy} onClick={() => void ask(text)} className={styles.followup}>{text}</button>)}</div>
            {composer}{researchEditor}<p className="mt-3 text-caption text-muted leading-relaxed">{sqlMode ? 'SQL runs directly against public data. Your SQL is not sent to AI.' : capability.mode === 'ai' ? `Questions are sent to ${capability.provider}. Use public information only.` : 'Guided preview · No AI provider connected.'}</p>
          </div>
        </section>

        <section className={styles.analysis} aria-label="Current analysis" aria-busy={loadingData}>
          <div className="flex justify-between items-center gap-3 border-b border-cipher-border px-5 py-4"><span className="text-caption font-mono text-muted">{blocks ? 'BLOCKS' : transfers || transactions ? 'TRANSACTIONS' : 'ANALYSIS'}</span>{!research && !analytics && !transfers && !blocks && !transactions ? <div className="flex gap-4"><button className="text-caption text-muted hover:text-primary disabled:opacity-40" onClick={() => setRefresh(value => value + 1)} disabled={!spec || loadingData}>Refresh</button><button className="text-caption text-muted hover:text-primary disabled:opacity-40" onClick={exportCsv} disabled={!summary?.points.length || invalidDates}>Export CSV ↗</button></div> : null}</div>
          {research ? <ResearchPanel tools={tools} result={research} busy={busy}/> : analytics ? <div className="p-4 sm:p-5"><AskAnalytics result={analytics} /></div> : transactions ? <div className="p-4 sm:p-5"><h2 className="text-xl font-medium">{transactions.query.mode === 'latest' ? 'Latest indexed transactions' : 'Transaction lookup'}</h2><AskTransactions result={transactions} expanded /></div> : blocks ? <div className="p-4 sm:p-5"><h2 className="text-xl font-medium">{blocks.query.mode === 'recent' ? 'Latest indexed blocks' : 'Block lookup'}</h2><AskBlocks result={blocks} expanded /></div> : transfers ? <div className="p-4 sm:p-5"><h2 className="text-xl font-medium">Public {transfers.direction === 'deshield' ? 'deshielding' : 'shielding'} transactions</h2><AskTransfers result={transfers} /></div> : !spec ? <div className="p-8 text-sm text-muted leading-relaxed">Choose a starter question to open an analysis here. Its chart, controls and source data will stay alongside your conversation.</div> : <div className="p-4 sm:p-5">
            <h2 className="text-xl text-primary font-medium tracking-tight">{info?.title}</h2>
            <p className="mt-2 text-caption font-mono text-muted">MAINNET · {ranking ? 'LAST 30 DAYS · BY CHAIN' : 'DAILY'} · {spec.metric === 'activity' ? 'FLOW RECORDS' : info?.unit.toUpperCase()}</p>
            <div className={`${styles.controls} ${!poolMetric ? styles.twoControls : ''}`}>
              <label>Period<select disabled={ranking} value={spec.period} onChange={event => updateSpec({ ...spec, period: event.target.value as AnalysisSpec['period'] })}><option value="30d">Last 30 days</option>{!ranking ? <option value="90d">Last 90 days</option> : null}{!ranking && !spec.metric.startsWith('swap_') ? <option value="1y">Last year</option> : null}</select></label>
              {poolMetric ? <label>Pool<select value={spec.pool} onChange={event => updateSpec({ ...spec, pool: event.target.value as AnalysisSpec['pool'] })}><option value="all">All pools</option><option value="orchard">Orchard</option><option value="ironwood">Ironwood</option><option value="sapling">Sapling</option></select></label> : null}
              <label>View<select value={spec.view} onChange={event => updateSpec({ ...spec, view: event.target.value as AnalysisSpec['view'] })}>{!ranking ? <option value="line">Line chart</option> : null}<option value="bar">Bar chart</option><option value="table">Table</option></select></label>
            </div>
            {loadingData ? <div className="h-80 grid place-items-center text-sm text-muted" role="status">Reading indexed observations…</div> : error ? <div className="py-20 text-center text-sm text-secondary" role="alert"><p>{error}</p><button onClick={() => setRefresh(value => value + 1)} className="mt-4 text-cipher-gold hover:underline">Retry</button><Link href={describeMetric(spec.metric).source} className="ml-5 text-cipher-gold hover:underline">Open source ↗</Link></div> : evidence && summary ? <>
              {!ranking ? <div className={styles.dateRange}><label>From (UTC)<input type="date" value={start || evidence.points[0]?.date || ''} min={evidence.points[0]?.date} max={end || evidence.points.at(-1)?.date} onChange={event => { if (event.target.validity.valid) updateSpec({ ...spec, start: event.target.value || null }); }} /></label><label>To (UTC)<input type="date" value={end || evidence.points.at(-1)?.date || ''} min={start || evidence.points[0]?.date} max={evidence.points.at(-1)?.date} onChange={event => { if (event.target.validity.valid) updateSpec({ ...spec, end: event.target.value || null }); }} /></label></div> : null}
              {invalidDates ? <p role="alert" className="py-8 text-sm text-warning">Choose an end date on or after the start date.</p> : !summary.points.length ? <p className="py-20 text-sm text-muted text-center" role="status">{spec.metric === 'pulse' ? 'No recorded alerts are available for this window. This does not establish that every detector ran or that the network was healthy.' : 'No observations are available for this window.'}</p> : <>
                <div className={styles.metrics}>{summary.totals.map(item => <div key={item.key}><p className="flex gap-2 items-center text-caption text-muted"><span className="w-1.5 h-1.5 inline-block" style={{ backgroundColor: colors[item.color as keyof typeof colors] }} />{item.label}</p><p className="mt-2 font-mono text-lg tabular-nums text-primary">{formatValue(item.value, evidence.unit)}{evidence.unit === '%' ? '%' : ''}</p><p className="mt-1 text-caption text-muted">{spec.metric === 'migration_share' ? item.change === null ? 'Change unavailable' : `${formatValue(item.change, '%', true)} percentage points` : spec.metric === 'balances' ? item.change === null ? 'Change unavailable' : `${formatValue(item.change, evidence.unit, true)} ZEC change` : `${evidence.unit} ${ranking ? 'across ranked chains' : 'in returned days'}`}</p></div>)}</div>
                {spec.view === 'table' ? <div className="overflow-x-auto"><table className={styles.table}><caption className="sr-only">{ranking ? 'Chain rankings' : 'Daily observations'} in {evidence.unit}; displayed ZEC rounded to two decimal places. CSV uses {evidence.csvUnit}; USD valuations are approximate.</caption><thead><tr><th>{ranking ? 'Chain' : 'Date (UTC)'}</th>{evidence.series.map(series => <th key={series.key}>{series.label} ({evidence.unit})</th>)}</tr></thead><tbody>{summary.points.slice(tablePage * 15, (tablePage + 1) * 15).map(point => <tr key={point.date}><th>{ranking ? formatChain(point.date) : point.date}</th>{evidence.series.map(series => <td key={series.key}>{formatValue(point.values[series.key], evidence.unit)}</td>)}</tr>)}</tbody></table><div className="flex justify-between gap-3 py-4 text-caption text-muted"><button disabled={tablePage === 0} onClick={() => setTablePage(value => value - 1)} className="disabled:opacity-40">← Previous</button><span>Page {tablePage + 1} of {Math.ceil(summary.points.length / 15)}</span><button disabled={(tablePage + 1) * 15 >= summary.points.length} onClick={() => setTablePage(value => value + 1)} className="disabled:opacity-40">Next →</button></div></div> : <AskChart points={summary.points} evidence={evidence} view={spec.view} />}
                <div className="flex justify-between gap-3 text-caption font-mono text-muted pt-2"><span>{ranking ? 'Rolling past 30 days' : `${summary.start} — ${summary.end} UTC`}</span><span>zecblock.com</span></div>
                <div className="border-t border-cipher-border mt-5 pt-4"><p className="text-xs text-muted leading-relaxed mb-3">{evidence.note}</p><p className="text-sm text-secondary leading-relaxed">{ranking ? `Showing ${summary.points.length} chains ranked by tracked swap volume. Bar chart shows the top 10; the table and CSV include every returned chain.` : spec.metric === 'migration_share' ? `Latest observed share: ${summary.end}. Percentages compare pool balances on each returned day.` : spec.metric === 'balances' ? `Showing ${summary.points.length} daily snapshots. Headline balances are from ${summary.end}; changes compare the first and last returned observations.` : `Totals cover ${summary.points.length} returned daily buckets. Boundary days may be partial; absent days are not assumed to be zero.`}</p></div>
              </>}
              <div className="flex flex-wrap items-center justify-between gap-3 mt-5"><button onClick={() => setSourcesOpen(value => !value)} aria-expanded={sourcesOpen} aria-controls="ask-sources" className="text-caption font-mono text-cipher-gold hover:underline">{sourcesOpen ? '−' : '+'} Source & methodology</button><span className="text-caption text-muted">{evidence.meta.freshness?.status === 'stale' ? 'Source marked stale · ' : ''}{ranking ? `Retrieved ${new Date(evidence.receivedAt).toISOString().slice(0, 16).replace('T', ' ')} UTC` : `Observations through ${summary.end} UTC`}</span></div>
              {sourcesOpen ? <div id="ask-sources" className="border-t border-cipher-border mt-4 pt-4 text-xs text-muted leading-relaxed"><Link href={evidence.source} className="text-secondary hover:text-cipher-gold">{evidence.sourceLabel} · Indexed public data ↗</Link><p className="mt-3">{evidence.note}</p><p className="mt-3">Retrieved {evidence.receivedAt.replace('T', ' ').slice(0, 19)} UTC. Source observation time: {evidence.meta.source?.observedAt ?? 'unavailable'}. CSV exports use {evidence.csvUnit}. ZEC values retain exact zatoshis; USD valuations remain approximate.</p><button className="mt-3 text-cipher-gold hover:underline" onClick={async () => { try { await navigator.clipboard.writeText(`https://zecblock.com${evidence.source}`); setCopied(true); } catch { setCopied(false); } }}>{copied ? 'Source link copied' : 'Copy source link'}</button></div> : null}
            </> : null}
          </div>}
        </section>
      </>}
    </div>
    <span className="sr-only" role="status" aria-live="polite">{busy ? '' : loadingData ? 'Loading analysis.' : error ? 'Source unavailable.' : summary ? `Analysis ready. ${summary.points.length} observations.` : session.messages.at(-1)?.answer ?? ''}</span>
  </div>;
}
