'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { analysisSchema, resolveShortcut, starters, type AnalysisSpec } from '@/lib/ask/contract';
import { getAskApiUrl, isAuthenticatedAskStaging } from '@/lib/ask/api-base';
import { readApiResponse } from '@/lib/api-client';
import styles from './ask.module.css';
import { useResearchTools, ResearchLibrary, ResearchEditor, ResearchPanel, ResearchData, ResearchDashboard, SharedResearchDraft } from './ResearchWorkbench';
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
import { askChat, peekAskHandoff, clearAskHandoff, type AskCapability } from '@/lib/ask/client';
import type { AskReply, AskSource } from '@/lib/ask/chat';
import { sqlDraft } from '@/lib/ask/composer';
import { AskFeedback, AskFailureFeedback, useAskFeedback } from '@/components/ask/AskFeedback';
import { describeMetric } from '@/lib/ask/data';
import { AskAnalysis } from './AskAnalysis';
import { readResearchLink, type ResearchShare } from '@/lib/ask/research-share';

const categories = ['Featured', 'Pools', 'Ironwood', 'Cross-chain', 'Network'];
type Message = { state?: 'pending' | 'complete' | 'failed' | 'cancelled'; sql?: string; research?: ResearchResult; analytics?: AskReply['analytics']; transactions?: AskReply['transactions']; blocks?: AskReply['blocks']; dataContext?: AskReply['dataContext']; id: number; question: string; answer: string; spec?: AnalysisSpec; viewSpec?: AnalysisSpec; sources?: AskSource[]; transfers?: AskReply['transfers']; locale?: string; scope?: string };
type Session = { transaction?: string; block?: string; id: number; title: string; messages: Message[]; spec: AnalysisSpec | null; page?: string };
type Capability = AskCapability;
const initialSession: Session = { id: 0, title: 'New analysis', messages: [], spec: null };
const analysisScopeKey = (spec: AnalysisSpec | null) => spec ? JSON.stringify([spec.metric, spec.period, spec.pool, spec.start, spec.end]) : '';

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
  const [sharedResearch, setSharedResearch] = useState<ResearchShare | null>(null);
  const [sqlInput, setSQLInput] = useState('');
  const [sqlLimit, setSQLLimit] = useState(100);
  const [expanded, setExpanded] = useState<Message | null>(null);
  const resultDialog = useRef<HTMLDialogElement>(null);
  const [inputMode, setInputMode] = useState<'ask' | 'sql'>('ask');
  const [phase, setPhase] = useState<'thinking' | 'submitting' | 'explaining'>('thinking');
  const [notice, setNotice] = useState('');
  const feedback = useAskFeedback();
  const [busy, setBusy] = useState(false);
  const [jobStatus,setJobStatus]=useState<ResearchJobStatus|null>(null);
  const [jobClock,setJobClock]=useState(()=>Date.now());
  const [capability, setCapability] = useState<Capability>({ mode: 'guided', provider: null });
  const authenticatedStaging = isAuthenticatedAskStaging(capability);
  const verified = authenticatedStaging || !!token;
  const [capabilityReady, setCapabilityReady] = useState(false);
  const [connectionFailed, setConnectionFailed] = useState(false);
  const reconnect = useRef<() => void>(() => {});
  const [chatError, setChatError] = useState('');
  const [exampleCategory, setExampleCategory] = useState('Featured');
  const request = useRef<AbortController | null>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const composerStatus = useRef<HTMLDivElement>(null);
  const serial = useRef(handoff?.turns.length || 0);
  const transcript = useRef<HTMLDivElement>(null);
  const latestTurn = useRef<HTMLDivElement>(null);
  const workspace = useRef<HTMLDivElement>(null);
  const session = sessions.find(item => item.id === activeId)!;
  const spec = session.spec;
  const ranking = Boolean(spec?.metric.startsWith('chain_'));
  const poolMetric = !spec || ['balances', 'flows', 'activity'].includes(spec.metric);
  const examples = starters.filter(starter => exampleCategory === 'Featured' ? ['balances', 'ironwood-balance', 'swap-volume', 'pulse'].includes(starter.id) : exampleCategory === 'Pools' ? ['balances', 'compare', 'flows', 'activity'].includes(starter.id) : starter.category === exampleCategory);
  const hasMessages = session.messages.length > 0;
  const latestRecords = session.messages.filter(message => message.research || message.analytics || message.transfers || message.blocks || message.transactions).at(-1);
  const blocks = latestRecords?.blocks;
  const transactions = latestRecords?.transactions;
  const analytics = latestRecords?.analytics;
  const research = latestRecords?.research;
  useEffect(() => {
    const readShare = () => {
      try { setSharedResearch(readResearchLink(window.location.hash)); }
      catch (failure) { setSharedResearch(null); setChatError(failure instanceof Error ? failure.message : 'This research link is invalid.'); }
    };
    readShare(); window.addEventListener('hashchange', readShare);
    return () => window.removeEventListener('hashchange', readShare);
  }, []);
  useEffect(() => { if (expanded && !resultDialog.current?.open) resultDialog.current?.showModal(); else if(!expanded && resultDialog.current?.open) resultDialog.current.close(); }, [expanded]);

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
      fetch(getAskApiUrl(), { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]), cache: 'no-store' })
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

  useEffect(() => {
    if (busy || feedback.failure || notice || chatError) composerStatus.current?.scrollIntoView({ block: 'nearest', behavior: 'instant' });
  }, [busy, feedback.failure, notice, chatError]);

  useEffect(() => { latestTurn.current?.scrollIntoView({block:'nearest',behavior:'instant'}); }, [session.messages.length]);

  function updateSpec(next: AnalysisSpec, restore = false) {
    if (!restore && (next.metric !== spec?.metric || next.period !== spec?.period || next.pool !== spec?.pool)) next = { ...next, start: null, end: null };
    const validated = analysisSchema.parse(next);
    setSessions(all => all.map(item => item.id === activeId ? { ...item, spec: validated } : item));
  }

  function switchSession(id: number) {
    request.current?.abort(); request.current = null; setBusy(false); setJobStatus(null); setNotice(''); feedback.clear(); setChatError(''); setSessions(all=>all.map(item=>({...item,messages:item.messages.map(message=>message.state==='pending'?{...message,state:'cancelled' as const,answer:'Stopped when you changed conversations.'}:message)}))); setActiveId(id); setQuestion(''); setSQLInput(''); setExpanded(null); setInputMode('ask');
    const saved = sessions.find(item => item.id === id)?.messages.filter(message => message.research).at(-1);
    const doc = saved?.research ? tools.library.documents.find(item => item.result?.fingerprint === saved.research?.fingerprint) : undefined;
    if (doc) tools.open(doc); else if(saved?.research)tools.accept(saved.research,saved.sql ? 'My Zcash analysis' : saved.question);else tools.reset();
  }

  function newSession() {
    tools.reset();
    if (!hasMessages) { input.current?.focus(); return; }
    const id = ++serial.current;
    setSessions(all => [{ id, title: 'New analysis', messages: [], spec: null }, ...all].slice(0, 12));
    switchSession(id);
    requestAnimationFrame(() => input.current?.focus());
  }

  async function ask(text: string, context: AnalysisSpec | null = spec) {
    const trimmed = text.trim();
    const detected = capability.researchEnabled ? sqlDraft(trimmed) : null;
    if (detected) { selectSQL(detected); return; }
    const next = resolveShortcut(trimmed, context);
    if (!trimmed || trimmed.length > 1000 || feedback.blocked && !next || busy || request.current || !capabilityReady && !next || capability.mode === 'ai' && !verified && !next) return;
    setInputMode('ask'); setQuestion(''); setBusy(true); setPhase('thinking'); setNotice(''); feedback.clear(); setChatError('');
    const controller = new AbortController();
    request.current = controller;
    const timeout = setTimeout(() => controller.abort(new DOMException('Request timed out', 'TimeoutError')), 300000);
    const id = ++serial.current;
    setSessions(all => all.map(item => item.id === activeId ? { ...item, title: item.messages.length ? item.title : trimmed, messages: [...item.messages, { id, question: trimmed, answer: '', state: 'pending' as const }].slice(-30) } : item));
    const append = (answer: string, next?: AnalysisSpec, sources?: AskSource[], answerLocale?: string, scope?: string, transfers?: AskReply['transfers'], dataContext?: AskReply['dataContext'], blocks?: AskReply['blocks'], transactions?: AskReply['transactions'], analytics?: AskReply['analytics'], research?: ResearchResult) => setSessions(all => all.map(item => item.id === activeId ? {
      ...item, title: item.messages.length ? item.title : trimmed,
      messages: item.messages.map(message => message.id === id ? { id, state: 'complete' as const, question: trimmed, answer, spec: next, sources, transfers, blocks, transactions, analytics, research, dataContext, locale: answerLocale, scope } : message),
      block: blocks?.rows[0]?.hash || item.block,
      transaction: transactions ? transactions.query.txid || transactions.rows[0]?.txid : item.transaction,
      spec: research || analytics || transfers || blocks || transactions ? null : next ?? item.spec,
    } : item));
    try {
      if (!next || capability.mode === 'ai' && verified && !feedback.blocked) {
        let reply = await askChat(trimmed, session.page || 'ask', context, 'auto', session.messages.filter(message => !message.sql && (!message.state || message.state === 'complete')).map(message => message.question), token, controller.signal, context ? undefined : session.block, context ? undefined : session.transaction, !context && analytics?.plan.version === 2 ? analytics.plan : undefined, !context && capability.researchEnabled ? research?.query : undefined);
        if(reply.job){
          const ticket=jobTicketSchema.parse(reply.job);
          const result=await waitResearch(ticket,controller.signal,setJobStatus);
          // Display validated data even if a paid explanation is unavailable.
          setPhase('explaining');
          try{reply=await explainResearch(ticket,trimmed,reply.locale,controller.signal);}
          catch(cause){if(controller.signal.aborted)throw cause;reply={answer:'Your query is complete. The results are below; an AI explanation is temporarily unavailable.',sources:[],spec:null,locale:reply.locale,mode:'ai',research:result};}
        }
        if (controller.signal.aborted) return;
        append(reply.answer, reply.spec ? analysisSchema.parse(reply.spec) : undefined, reply.sources, reply.locale, reply.scope, reply.transfers, reply.dataContext, reply.blocks, reply.transactions, reply.analytics, reply.research ? researchResultSchema.parse(reply.research) : undefined);
        if(reply.research)tools.accept(researchResultSchema.parse(reply.research),trimmed);
      } else {
        append(`Opened ${describeMetric(next.metric).title.toLowerCase()} for ${next.period === '1y' ? 'the past year' : `the past ${next.period.slice(0, -1)} days`}${next.pool === 'all' ? '' : `, filtered to ${next.pool}`}. The analysis shows the source observations and updates as you change the controls.`, next);
      }
      setQuestion(''); setNotice('Answer ready.');

    } catch (cause) {
      if (request.current === controller) {
        setQuestion(trimmed);
        setSessions(all => all.map(item => item.id === activeId ? { ...item, messages: item.messages.map(message => message.id === id ? { ...message, state: controller.signal.aborted && controller.signal.reason?.name !== 'TimeoutError' ? 'cancelled' as const : 'failed' as const, answer: controller.signal.aborted && controller.signal.reason?.name !== 'TimeoutError' ? 'Stopped. Your question has been restored to the input.' : 'This request did not complete. Your question has been restored to the input; see the error below.' } : message) } : item));
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

  function openSaved(doc: ResearchDocument, shared = false) {
    if(busy||tools.importing)return;
    tools.open(doc, shared);const id=++serial.current;
    setSessions(all=>[{id,title:doc.title,spec:null,messages:[{id,question:doc.title,sql:doc.query.sql,answer:shared?'Opened a shared query draft. Review the SQL, then choose Run SQL. No query has run.':doc.result?'Opened your saved analysis. These are saved results; run its SQL to refresh them.':'Opened your saved query. Choose Run SQL to refresh its results.',research:doc.result||undefined}]},...all].slice(0,12));
    setActiveId(id);setQuestion('');setSQLInput(doc.result ? '' : doc.query.sql);setSQLLimit(doc.query.limit);setInputMode('sql');setNotice(shared ? 'Shared query loaded. Review it before running.' : doc.result ? 'Saved results loaded. Choose Edit query to run them again.' : 'Saved query loaded. Run SQL to refresh its results.');feedback.clear();setChatError('');
  }
  async function runSQL() {
    if(busy||request.current||tools.importing||feedback.blocked||!sqlInput.trim()||!capabilityReady)return;
    if(!verified){setChatError('Verification is still loading. Retry verification before running SQL.');return;}
    const query={version:3 as const,sql:sqlInput,limit:sqlLimit};
    const id=++serial.current, title=tools.title;
    setSQLInput('');setBusy(true);setPhase('submitting');setNotice('');feedback.clear();setChatError('');
    setSessions(all=>all.map(item=>item.id===activeId?{...item,title:item.messages.length?item.title:title,messages:[...item.messages,{id,question:'SQL query',sql:query.sql,answer:'',state:'pending' as const}].slice(-30)}:item));
    const controller=new AbortController();request.current=controller;
    try{
      const signal=AbortSignal.any([controller.signal,AbortSignal.timeout(300000)]);
      const result=capability.jobsEnabled?await waitResearch(await submitResearch(query,token,signal),signal,setJobStatus):await runResearch(query,token,AbortSignal.any([signal,AbortSignal.timeout(20000)]));
      if (request.current !== controller || controller.signal.aborted) return;
      tools.accept(result,title,false); setNotice('');
      setSessions(all=>all.map(item=>item.id===activeId?{...item,spec:null,messages:item.messages.map(message=>message.id===id?{...message,state:'complete' as const,answer:`${result.rows.length} rows returned. No AI was used.`,research:result}:message)}:item));
    }catch(error){
      if(request.current!==controller)return;
      setSQLInput(query.sql);setSQLLimit(query.limit);
      setSessions(all=>all.map(item=>item.id===activeId?{...item,messages:item.messages.map(message=>message.id===id?{...message,state:controller.signal.aborted?'cancelled' as const:'failed' as const,answer:controller.signal.aborted?'Stopped. Your SQL has been restored to the input.':'This query did not complete. Your SQL has been restored to the input; see the error below.'}:message)}:item));
      if(!controller.signal.aborted)feedback.report(error);else setNotice('Stopped. Your SQL is still here.');
    }finally{if(request.current===controller){setBusy(false);setToken('');setChallengeReset(value=>value+1);request.current=null;setJobStatus(null);}}
  }
  function editQuery(message: Message) {
    const sql=message.sql || message.research?.query.sql;
    if(!sql||busy)return;
    setSQLInput(sql);setSQLLimit(message.research?.query.limit || 100);setInputMode('sql');setNotice('Query loaded for editing. Choose Run SQL when ready.');
    requestAnimationFrame(()=>{input.current?.focus();input.current?.scrollIntoView({block:'center'});});
  }
  function selectSQL(sql: string) {
    if (busy) return;
    if (sql.length > 8192) { setChatError('SQL can contain up to 8,192 characters. Shorten the query before pasting it.'); return; }
    setSQLInput(sql); setInputMode('sql'); setChatError('');
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
  function resultActions(message: Message) {
    return <>{message.research ? <button disabled={busy} onClick={() => editQuery(message)}>Edit query</button> : null}<button aria-haspopup="dialog" onClick={() => setExpanded(message)}>Expand results ↗</button></>;
  }
  function renderRecords(message: Message, expandedView = false) {
    if (message.research) return message.id === latestRecords?.id ? <ResearchPanel embedded={!expandedView} actions={expandedView ? undefined : resultActions(message)} tools={tools} result={message.research} busy={busy} titleId={expandedView ? 'expanded-analysis-title' : undefined}/> : <div className="p-5"><ResearchData result={message.research} chart={{view:'table',x:0,y:0}}/></div>;
    return <div className="p-4 sm:p-5"><AskAnalytics result={message.analytics}/><AskBlocks result={message.blocks} expanded/><AskTransactions result={message.transactions} expanded/>{message.transfers ? <AskTransfers result={message.transfers}/> : null}</div>;
  }
  const researchEditor=capability.researchEnabled?<ResearchEditor extended={capability.researchExtended===true} tools={tools} busy={busy} onOpen={openSaved}/>:null;
  const sqlMode = inputMode === 'sql';
  const canSend = sqlMode ? capabilityReady && verified && !!sqlInput.trim() && !tools.importing && !feedback.blocked : !!question.trim() && ((!feedback.blocked && capabilityReady && (capability.mode !== 'ai' || verified)) || !!resolveShortcut(question, spec));
  const submit = () => sqlMode ? void runSQL() : void ask(question);
  const statusTitle = jobStatus?.state === 'queued' ? 'Waiting for a query slot…' : jobStatus?.state === 'running' ? 'Running your query…' : phase === 'explaining' ? 'Explaining the results…' : phase === 'submitting' ? 'Submitting your query…' : 'Thinking…';
  const statusDetail = jobStatus?.state === 'queued' ? jobStatus.queuePosition > 1 ? `${jobStatus.queuePosition - 1} queries ahead. You can stop while waiting.` : 'Your query is queued. It will start when a worker is available.' : jobStatus?.state === 'running' ? 'Reading the public analytics data. Your previous results stay available.' : phase === 'explaining' ? 'The query is complete. Preparing an explanation from its results.' : phase === 'submitting' ? 'Checking the SQL and requesting a query slot. No AI is used.' : 'Interpreting your question and checking public sources.';
  const composer = <div className={styles.composerGroup}><form onSubmit={event => { event.preventDefault(); submit(); }} className={styles.composer} aria-busy={busy}>
    <label htmlFor="ask-question" className="sr-only">{sqlMode ? 'SQL query' : 'Ask a question about Zcash'}</label>
    <textarea ref={input} id="ask-question" value={sqlMode ? sqlInput : question} dir={sqlMode ? 'ltr' : 'auto'} disabled={busy} onChange={event => sqlMode ? setSQLInput(event.target.value) : setQuestion(event.target.value)} rows={sqlMode && sqlInput ? 9 : hasMessages ? 2 : 3} maxLength={sqlMode ? 8192 : 1000}
      className={sqlMode && sqlInput ? styles.sqlInput : undefined} spellCheck={!sqlMode} autoComplete="off" aria-describedby="ask-input-hint"
      placeholder={sqlMode ? 'SELECT height, transactions FROM blocks ORDER BY height DESC LIMIT 10' : hasMessages ? 'Ask a follow-up, or refine this view…' : 'Ask about Zcash, or paste a SQL query…'}
      onPaste={event => { if (sqlMode || !capability.researchEnabled) return; const sql = sqlDraft(event.clipboardData.getData('text')); if (sql) { event.preventDefault(); selectSQL(sql); } }}
      onKeyDown={event => { if (event.key === 'Enter' && !event.nativeEvent.isComposing && (sqlMode ? event.metaKey || event.ctrlKey : !event.shiftKey)) { event.preventDefault(); if (!busy && canSend) submit(); } }} />
    <div className={styles.composerActions}><div className={styles.composerModes} role="group" aria-label="Input mode">
      <button type="button" aria-pressed={!sqlMode} disabled={busy} onClick={() => changeMode('ask')}>Ask</button>
      {capability.researchEnabled ? <button type="button" aria-pressed={sqlMode} disabled={busy} onClick={() => changeMode('sql')}>SQL</button> : null}
    </div>{sqlMode ? <label className={styles.rowLimit}>Rows<select aria-label="Maximum rows" disabled={busy} value={sqlLimit} onChange={event => setSQLLimit(Number(event.target.value))}>{[10,50,100,200].map(value => <option key={value}>{value}</option>)}</select></label> : null}
      {busy ? <button type="button" className={styles.submit} onClick={() => request.current?.abort()} aria-label="Stop request">■</button>
        : <button type="submit" className={sqlMode ? styles.runSQL : styles.submit} disabled={!canSend} aria-label={sqlMode ? 'Run SQL' : 'Send question'}>{sqlMode ? 'Run SQL' : '↑'}</button>}
    </div>
  </form><p id="ask-input-hint" className={styles.inputHint}>{sqlMode ? 'Direct SQL · no AI · Ctrl / ⌘ + Enter to run' : !capabilityReady ? 'Connecting to Ask…' : capability.mode === 'ai' ? 'Ask AI · Enter to send · Shift + Enter for a new line' : 'Guides & public data · Enter to send'}</p>
    <div ref={composerStatus}>{busy && !hasMessages ? <AskFeedback working title={statusTitle} detail={statusDetail} extra={jobStatus?.state === 'running' ? `${Math.max(0,Math.floor((jobClock-Date.parse(jobStatus.startedAt || new Date(jobClock).toISOString()))/1000))}s elapsed · ${jobStatus.maxRunSeconds}s execution limit` : undefined}/> : feedback.failure ? <AskFailureFeedback failure={feedback.failure} blocked={feedback.blocked} onRetry={submit}/> : connectionFailed ? <AskFeedback error title="Could not connect to Ask" detail="Your draft is still here. Check your connection and try again." onRetry={() => {setConnectionFailed(false);reconnect.current();}} retryLabel="Reconnect"/> : chatError ? <AskFeedback error title="Check your request" detail={chatError}/> : notice ? <AskFeedback title={notice}/> : null}</div>
    {authenticatedStaging ? null : <AskChallenge siteKey={capability.siteKey} onToken={setToken} reset={challengeReset}/>}
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

    <div className={`${styles.main} ${hasMessages && !tools.boardId ? styles.threadMain : ''}`}>
      {sharedResearch ? <SharedResearchDraft share={sharedResearch} tools={tools} busy={busy} enabled={capability.researchEnabled === true} onDismiss={() => setSharedResearch(null)} onOpen={doc => { openSaved(doc, true); setSharedResearch(null); }} /> : null}
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
          <div className={`${styles.transcript} ${styles.threadTranscript}`} ref={transcript}>
            {session.messages.map(message => <div key={message.id} ref={message.id === session.messages.at(-1)?.id ? latestTurn : undefined} className="mb-7">
              <div className={styles.sentMessage}>{message.sql ? <><span className={styles.sqlPreview}>{message.sql.split('\n').slice(0,3).join('\n')}</span><details className={styles.sentSQL}><summary>View submitted SQL</summary><pre translate="no">{message.sql}</pre></details></> : message.question}</div>
              <article className={styles.assistantReply} aria-label="ZecBlock response"><AskMark small /><div className={styles.replyBody}><p className="text-caption font-mono text-muted mb-2">ZecBlock</p>{message.state === 'pending' ? <AskFeedback working title={statusTitle} detail={statusDetail} extra={jobStatus?.state === 'running' ? `${Math.max(0,Math.floor((jobClock-Date.parse(jobStatus.startedAt || new Date(jobClock).toISOString()))/1000))}s elapsed · ${jobStatus.maxRunSeconds}s execution limit` : undefined}/> : null}<p dir="auto" lang={message.locale} className="text-sm text-secondary leading-relaxed whitespace-pre-wrap">{message.answer}</p>{message.scope ? <p className="mt-2 text-caption text-muted">{message.scope}</p> : null}
              {message.spec ? <AskAnalysis spec={message.viewSpec || message.spec} changed={!!message.viewSpec && analysisScopeKey(message.viewSpec) !== analysisScopeKey(message.spec)} onChange={next => {
                const previous = message.viewSpec || message.spec!;
                const validated = analysisSchema.parse(next.period !== previous.period || next.pool !== previous.pool || next.metric !== previous.metric ? {...next, start:null, end:null} : next);
                setSessions(all => all.map(item => item.id === activeId ? {...item, spec:validated, messages:item.messages.map(turn => turn.id === message.id ? {...turn, viewSpec:validated} : turn)} : item));
              }} onExplain={() => void ask('Explain this view', message.viewSpec || message.spec!)} canExplain={capability.mode === 'ai' && verified && !feedback.blocked} busy={busy}/> : null}
              {message.research || message.analytics || message.blocks || message.transactions || message.transfers ? <div className={styles.replyResults} role="group" aria-label="Query results">{message.research && message.id === latestRecords?.id ? null : <div className={styles.resultActions}>{resultActions(message)}</div>}{renderRecords(message)}</div> : message.sql && message.state !== 'pending' ? <button className={styles.followup} disabled={busy} onClick={()=>editQuery(message)}>Edit query</button> : null}
              <AskSources sources={message.sources || []} dataContext={message.dataContext} />
              </div></article>
            </div>)}

          </div>
          <div className={styles.conversationFooter}>
            <div className="flex flex-wrap gap-2 mb-3">{(spec ? ranking ? ['Show as a bar chart', 'Show as a table'] : ['Show 90 days', poolMetric ? spec.pool === 'ironwood' ? 'Just Orchard' : 'Just Ironwood' : 'Show as a line chart', 'Show as a table'] : transactions ? ['Show the latest 5 transactions', 'Explain this transaction'] : blocks ? ['Tell me about the latest block', 'Explain this block'] : research ? ['Compare the leading results', 'Group these results by day'] : starters.slice(0, 2).map(item => item.title)).map(text => <button key={text} disabled={busy} onClick={() => void ask(text)} className={styles.followup}>{text}</button>)}</div>
            {composer}{researchEditor}<p className="mt-3 text-caption text-muted leading-relaxed">{sqlMode ? 'SQL runs directly against public data. Your SQL is not sent to AI.' : capability.mode === 'ai' ? `Questions are sent to ${capability.provider}. Use public information only.` : 'Guided preview · No AI provider connected.'}</p>
          </div>
        </section>


      </>}
    </div>
    <dialog ref={resultDialog} className={styles.resultDialog} aria-labelledby="expanded-result-title" onClose={()=>setExpanded(null)}>
      {expanded ? <><div className={styles.dialogHeader}><h2 id="expanded-result-title">Results</h2><button autoFocus onClick={()=>resultDialog.current?.close()}>Back to conversation ×</button></div>{renderRecords(expanded, true)}</> : null}
    </dialog>
    <span className="sr-only" role="status" aria-live="polite">{busy ? '' : session.messages.at(-1)?.answer ?? ''}</span>
  </div>;
}
