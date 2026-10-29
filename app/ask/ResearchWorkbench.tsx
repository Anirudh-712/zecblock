'use client';

import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import {defaultResearchChart,shortLabel,supportsLine,cellLink} from '@/lib/ask/research-display';
import type { ResearchChart, ResearchDocument, ResearchLibrary, ResearchResult, ResearchNarrative } from '@/lib/ask/research-contract';
import { researchDocumentSchema, researchNarrativeSchema } from '@/lib/ask/research-contract';
import { emptyLibrary, readLibrary, writeLibrary, readPortable, mergePortable, markdownReport, csvReport, MAX_BYTES } from '@/lib/ask/research-library';
import { queryShare, dashboardShare, researchLink, sharedLibrary, type ResearchShare } from '@/lib/ask/research-share';
import styles from './research.module.css';
import askStyles from './ask.module.css';
import {catalogueFor} from '../../lib/ask/research-catalogue';

const Plot = dynamic(() => import('./ResearchPlot'), { loading: () => <p className={styles.caption}>Loading chart…</p> });
const initialSQL = 'SELECT height, transactions, bytes, fees::numeric / 100000000 AS fees_zec\nFROM blocks\nORDER BY height DESC\nLIMIT 10';
function download(name: string, contents: string, type: string) {
  const url = URL.createObjectURL(new Blob([contents], { type }));
  const link = document.createElement('a'); link.href = url; link.download = name; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function exactDisplay(cell: string | null, type: string) {
  if (cell === null) return 'Unavailable';
  if (type !== 'number' || !/^[-+]?\d+(?:\.\d+)?$/.test(cell)) return cell;
  const [whole, fraction] = cell.split('.'); const tail = fraction?.replace(/0+$/, '');
  return whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + (tail ? '.' + tail : '');
}
function utcDate(value: string) { return new Date(value).toLocaleString(undefined, { timeZone: 'UTC' }) + ' UTC'; }

function matchingNarrative(value: ResearchNarrative | undefined | null, result?: ResearchResult | null) {
  const parsed = researchNarrativeSchema.safeParse(value);
  return parsed.success && result && parsed.data.fingerprint === result.fingerprint ? parsed.data : null;
}

export function useResearchTools(initial?: ResearchResult, initialTitle = 'My Zcash analysis', initialNarrative?: ResearchNarrative) {
  const [library, setLibrary] = useState<ResearchLibrary>(emptyLibrary);
  const [ready, setReady] = useState(false);
  const raw = useRef<string | null>(null);
  const [id, setId] = useState<string | null>(null);
  const [title, setTitle] = useState(initialTitle.slice(0, 120));
  const [notes, setNotes] = useState('');
  const [sql, setSQL] = useState(initial?.query.sql || initialSQL);
  const [limit, setLimit] = useState(initial?.query.limit || 100);
  const [result, setResult] = useState<ResearchResult | null>(initial || null);
  const resultRef = useRef<ResearchResult | null>(initial || null);
  const [narrative, setNarrative] = useState<ResearchNarrative | null>(() => matchingNarrative(initialNarrative, initial));
  const narrativeRef = useRef<ResearchNarrative | null>(narrative);
  const [chart, setChart] = useState<ResearchChart>(()=>defaultResearchChart(initial));
  const [boardId, setBoardId] = useState<string | null>(null);
  const [dashboard, setDashboard] = useState('');
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [importing, setImporting] = useState(false);
  const [shareURL, setShareURL] = useState('');
  useEffect(() => {
    try { const loaded = readLibrary(window.localStorage); raw.current = loaded.raw; setLibrary(loaded.library); setReady(true); }
    catch { setError('Browser storage is unavailable or contains an invalid library. Existing saves have been preserved.'); }
  }, []);
  function persist(next: ResearchLibrary) { raw.current = writeLibrary(window.localStorage, next, raw.current); setLibrary(next); }
  function accept(data: ResearchResult, label: string, fresh = true, context?: ResearchNarrative) {
    resultRef.current = data;
    const nextNarrative = matchingNarrative(context, data);
    narrativeRef.current = nextNarrative; setNarrative(nextNarrative);
    setResult(data); setSQL(data.query.sql); setLimit(data.query.limit); setTitle(label.slice(0, 120)); setBoardId(null); setError(''); setNotice(''); setShareURL('');
    setChart(defaultResearchChart(data));
    if (fresh) { setId(null); setNotes(''); }
  }
  function annotate(context: ResearchNarrative) {
    const next = matchingNarrative(context, resultRef.current);
    if (!next) return false;
    narrativeRef.current = next; setNarrative(next);
    return true;
  }
  function open(doc: ResearchDocument, shared = false) {
    resultRef.current = doc.result;
    const nextNarrative = matchingNarrative(doc.narrative, doc.result);
    narrativeRef.current = nextNarrative; setNarrative(nextNarrative);
    setId(doc.id); setTitle(doc.title); setNotes(doc.notes); setSQL(doc.query.sql); setLimit(doc.query.limit); setChart(doc.chart); setResult(doc.result); setBoardId(null); setError('');
    setShareURL(''); setNotice(shared ? 'Shared SQL is an unverified draft. Review it before running.' : 'Saved snapshot. Run the query to refresh its data.');
  }
  function reset() { resultRef.current = null; narrativeRef.current = null; setNarrative(null); setId(null); setResult(null); setNotes(''); setTitle('My Zcash analysis'); setSQL(initialSQL); setLimit(100); setBoardId(null); setError(''); setNotice(''); setShareURL(''); }
  function document(): ResearchDocument {
    const snapshot = resultRef.current;
    const current = snapshot?.query.sql === sql && snapshot.query.limit === limit ? snapshot : null;
    const context = matchingNarrative(narrativeRef.current, current);
    return researchDocumentSchema.parse({ format: 'zecblock-research', version: 2, id: id || crypto.randomUUID(), title, notes, query: { version: 3, sql, limit }, chart, result: current, ...(context ? { narrative: context } : {}), savedAt: new Date().toISOString() });
  }
  function save() {
    try { const doc = document(); persist({ ...library, documents: [...library.documents.filter(d => d.id !== doc.id), doc] }); setId(doc.id); setNotice('Saved in this browser.'); setError(''); }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'Could not save this analysis.'); }
  }
  async function importFile(file: File | undefined) {
    if (!file) return;
    setImporting(true); const previous = raw.current;
    try { if (file.size > MAX_BYTES) throw Error('Too large'); const incoming = readPortable(await file.text()); const next = mergePortable(library, incoming, () => crypto.randomUUID()); raw.current = writeLibrary(window.localStorage, next, previous); setLibrary(next); setNotice('Imported saved analyses. Open one and run its query to refresh the data.'); setError(''); }
    catch { setError('Use a ZecBlock research JSON file under 2 MB. The browser library holds up to 25 analyses and 12 dashboards.'); }
    finally { setImporting(false); }
  }
  function exportFile(report: boolean) {
    try { const doc = document(); download(report ? 'zecblock-research.md' : 'zecblock-research.json', report ? markdownReport(doc) : JSON.stringify(doc, null, 2), report ? 'text/markdown' : 'application/json'); setError(''); }
    catch { setError('Give this analysis a title and valid SQL before downloading.'); }
  }
  function exportCSV() {
    try { download('zecblock-results.csv', csvReport(document()), 'text/csv;charset=utf-8'); setError(''); }
    catch { setError('Run this query before downloading its results as CSV.'); }
  }
  async function copyLink(board = false) {
    try {
      const share = board && boardId ? dashboardShare(library, boardId) : queryShare(document());
      const url = researchLink(share, window.location.origin); setShareURL(url); setError('');
      try { await navigator.clipboard.writeText(url); setNotice(board ? 'Dashboard draft link copied.' : 'Query draft link copied.'); }
      catch { setNotice('Link ready. Copy it from the field below.'); }
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'Could not create this research link.'); }
  }
  function saveShared(share: ResearchShare) {
    try {
      const incoming = sharedLibrary(share, () => crypto.randomUUID(), new Date().toISOString());
      const next = mergePortable(library, incoming, () => crypto.randomUUID()); persist(next);
      setNotice('Shared queries saved in this browser. Review each query before running; no SQL has run.'); setError('');
      if (share.kind === 'dashboard') setBoardId(next.dashboards.at(-1)!.id);
      return true;
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'Could not save this shared research.'); return false; }
  }
  function remove() {
    if (!id || !window.confirm('Remove this saved analysis from this browser? Download a copy first if you want to keep it.')) return;
    try { persist({ ...library, documents: library.documents.filter(d => d.id !== id), dashboards: library.dashboards.map(d => ({ ...d, items: d.items.filter(item => item !== id) })) }); setId(null); setNotice('Removed the local save. The open analysis is still available.'); }
    catch { setError('Could not remove this local save.'); }
  }
  function addToDashboard() {
    try { if (!id) throw Error('Save this analysis first.'); const existing = library.dashboards.find(d => d.title === dashboard.trim()); const board = existing ? { ...existing, items: [...new Set([...existing.items, id])] } : { id: crypto.randomUUID(), title: dashboard.trim(), items: [id] }; persist({ ...library, dashboards: [...library.dashboards.filter(d => d.id !== board.id), board] }); setNotice('Added to your dashboard.'); setError(''); }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'Could not update the dashboard.'); }
  }
  function removeDashboard() {
    if (!boardId || !window.confirm('Remove this dashboard from this browser? Its saved analyses will remain.')) return;
    try { persist({ ...library, dashboards: library.dashboards.filter(d => d.id !== boardId) }); setBoardId(null); }
    catch { setError('Could not remove this dashboard.'); }
  }
  return { library, ready, id, title, setTitle, notes, setNotes, sql, setSQL, limit, setLimit, result, narrative, chart, setChart, boardId, setBoardId, dashboard, setDashboard, notice, error, importing, shareURL, copyLink, saveShared, accept, annotate, open, reset, document, save, importFile, exportFile, exportCSV, remove, addToDashboard, removeDashboard, downloadLibrary: () => download('zecblock-library.json', JSON.stringify(library, null, 2), 'application/json') };
}
type Tools = ReturnType<typeof useResearchTools>;

export function ResearchLibrary({ tools, busy, onOpen }: { tools: Tools; busy: boolean; onOpen: (doc: ResearchDocument) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const disabled = busy || tools.importing;
  return <div className={styles.libraryContent}>
    <p className={styles.eyebrow}>SAVED ANALYSES</p>
    {tools.library.documents.length ? tools.library.documents.map(doc => <button key={doc.id} className={`${askStyles.session} ${tools.id === doc.id ? askStyles.selectedSession : ''}`} disabled={disabled} onClick={() => onOpen(doc)} title={doc.title}>{doc.title}</button>) : <p className={styles.caption}>Save an analysis to keep exploring later.</p>}
    {tools.library.dashboards.length ? <><p className={styles.eyebrow}>DASHBOARDS</p>{tools.library.dashboards.map(board => <button key={board.id} className={askStyles.session} disabled={disabled} onClick={() => tools.setBoardId(board.id)} title={board.title}>{board.title}</button>)}</> : null}
    <div className={styles.libraryActions}><button className={styles.textButton} disabled={!tools.ready || disabled} onClick={() => input.current?.click()}>Import research ↗</button><button className={styles.textButton} disabled={disabled} onClick={tools.downloadLibrary}>Download all saved research ↓</button></div>
    {tools.error || tools.notice.startsWith('Imported') ? <ResearchStatus tools={tools} /> : null}
    <input type="file" ref={input} className="sr-only" tabIndex={-1} accept=".json,application/json" aria-label="Import research file" onChange={event => { const selected = event.target.files?.[0]; event.target.value = ''; void tools.importFile(selected); }} />
  </div>;
}

export function ResearchEditor({ tools, extended=false }: { extended?:boolean; tools: Tools; busy: boolean; onOpen: (doc: ResearchDocument) => void }) {
  return <details className={styles.disclosure}>
    <summary>Data catalogue</summary>
    <div className={styles.advanced}>
      <p className={styles.caption}>Use SQL mode in the composer to write a query or edit the query behind your analysis.</p>
      <details className={styles.catalogue}><summary>Browse available data</summary>
        {catalogueFor(extended).map(dataset=><div key={dataset.id}><h3 className={styles.dataset}>{dataset.title}</h3><p className={styles.caption}>{dataset.description}</p><pre className={styles.schema} translate="no">{dataset.id+'('+dataset.columns+')'}</pre></div>)}
        {extended?<p className={styles.caption}>Added datasets are checked for copy and refresh readiness on each query. An unfinished or stale source returns an error, never an empty history. Daily summaries cover completed UTC days.</p>:null}
        <p className={styles.caption}>{extended ? 'Dates are UTC. Block, transaction and address timestamps use Unix seconds; swap timestamps are date/time values. Swap valuations use USD. ' : 'Timestamps: Unix seconds, UTC. '}Amounts/fees: zatoshis; divide by 100000000 for ZEC. Join transactions.height to blocks.height, flows.txid to transactions.txid. Aggregate flows before joining to avoid double counting. Blocks include coinbase. Missing measures remain unavailable. Flow-history completeness is unverified.</p>
      </details>
      <ResearchStatus tools={tools} />
    </div>
  </details>;
}
export function ResearchStatus({ tools }: { tools: Tools }) { return <>{tools.error ? <p className={styles.error} role="alert">{tools.error}</p> : null}{tools.notice ? <p className={styles.caption} role="status">{tools.notice}</p> : null}</>; }

export function ResearchData({ result, chart, sources, showDetails = true }: { result: ResearchResult; chart: ResearchChart; sources?: ReactNode; showDetails?: boolean }) {
  const table = <div className={styles.scroll} tabIndex={0} role="region" aria-label="Scrollable query results"><table className={styles.table}><caption className="sr-only">Query results, preserving exact decimals</caption><thead><tr>{result.columns.map(column => <th key={column.key} scope="col" data-numeric={column.type === 'number'}>{column.label.replaceAll('_', ' ')}</th>)}</tr></thead><tbody>{result.rows.map((row, index) => <tr key={index}>{row.map((cell, i) => <td key={i} data-numeric={result.columns[i].type === 'number'}>{cellLink(result.columns[i].label.toLowerCase(),cell) ? <Link href={cellLink(result.columns[i].label.toLowerCase(),cell)!} title={cell || undefined} aria-label={cell || undefined}>{result.columns[i].type==='number' ? exactDisplay(cell,'number') : shortLabel(cell)}</Link> : <span title={cell || undefined}>{result.columns[i].type==='number' ? exactDisplay(cell,'number') : cell && /^(?:txid|hash|miner|address)$/.test(result.columns[i].label.toLowerCase()) ? shortLabel(cell) : exactDisplay(cell,result.columns[i].type)}</span>}</td>)}</tr>)}</tbody></table>{!result.rows.length ? <p className={styles.caption}>No matching records were returned.</p> : null}</div>;
  return <>
    <p className={styles.caption}>Indexed through {utcDate(result.indexedThrough)} · {result.rows.length} {result.rows.length === 1 ? 'row' : 'rows'}{result.truncated ? ' (limited)' : ''}</p>
    {chart.view === 'table' ? table : <><Plot result={result} chart={chart} /><details className={styles.exactTable}><summary>View data</summary>{table}</details></>}
    {showDetails ? <details className={styles.disclosure}><summary>Sources &amp; details</summary><div className={styles.provenance}>
      {sources}
      <p>{result.coverage}. This describes source admission, not a certification of your SQL calculations.</p><p>{result.units}</p>
      <p>Charts use approximate plotting numbers; the table preserves exact decimals. Rows follow query order; repeated labels are separate records. Full identifiers remain in the results and downloads.</p>
      <p>Retrieved {utcDate(result.retrievedAt)}. Query fingerprint: <span className={styles.fingerprint}>{result.fingerprint}</span></p>
      {result.query?.sql ? <><p className={styles.detailLabel}>SQL query</p><pre className={styles.shareSQL} translate="no" tabIndex={0} aria-label="SQL behind this result">{result.query.sql}</pre></> : null}
    </div></details> : null}
  </>;
}

export function ResearchPanel({ tools, result, busy, titleId, embedded = false, actions, editAction, sources, saved }: { tools: Tools; result: ResearchResult; busy: boolean; titleId?: string; embedded?: boolean; actions?: ReactNode; editAction?: ReactNode; sources?: ReactNode; saved?: boolean }) {
  const generatedTitleId = useId();
  const analysisTitleId = titleId || generatedTitleId;
  const lineAllowed = supportsLine(result, tools.chart.x);
  const numeric = result.columns.some(column => column.type === 'number');
  const disabled = busy || tools.importing;
  const hasSnapshot = tools.result?.fingerprint === result.fingerprint && tools.sql === result.query?.sql && tools.limit === result.query?.limit;
  const hasSave = saved ?? Boolean(tools.id);
  return <div className={`${styles.panelBody} ${embedded ? styles.embeddedPanel : ''}`}>
    {!embedded ? <h2 className={styles.resultTitle}>{tools.title}</h2> : null}
    <div className={`${styles.resultToolbar} ${embedded ? styles.embeddedToolbar : ''}`}>
      <label className={styles.viewPicker}>Result view<select className={styles.viewSelect} value={tools.chart.view} onChange={event => tools.setChart({ ...tools.chart, view: event.target.value as ResearchChart['view'] })}>
        <option value="table">Table</option><option value="bar" disabled={!numeric}>Bar chart</option><option value="line" disabled={!lineAllowed}>Line chart</option>
      </select></label>
      <div className={styles.resultActions}>
        <button className={styles.button} disabled={!tools.ready || disabled} onClick={tools.save}>{hasSave ? 'Save changes' : 'Save'}</button>
        <button className={styles.button} disabled={disabled} onClick={() => void tools.copyLink()}>Share query</button>
        {actions}
      </div>
      <details className={styles.moreOptions}><summary>More</summary><div className={styles.moreBody}>
        {editAction ? <div className={styles.optionGroup}><p className={styles.optionHeading}>Query</p><div className={styles.actions}>{editAction}</div></div> : null}
        <fieldset className={styles.optionGroup}><legend>Name &amp; notes</legend>
          <label className={styles.field} htmlFor={analysisTitleId}>Analysis title<input id={analysisTitleId} name="title" autoComplete="off" className={styles.input} maxLength={120} value={tools.title} onChange={event => tools.setTitle(event.target.value)} /></label>
          <label className={styles.field}>Research notes<textarea name="notes" autoComplete="off" className={styles.input} maxLength={4000} value={tools.notes} onChange={event => tools.setNotes(event.target.value)} rows={3} /></label>
        </fieldset>
        <fieldset className={styles.optionGroup}><legend>Chart settings</legend>
          <div className={styles.columns}>{(['x', 'y'] as const).map(axis => <label className={styles.field} key={axis}>{axis === 'x' ? 'Labels' : 'Values'}<select className={styles.input} disabled={axis === 'y' && !numeric} value={tools.chart[axis]} onChange={event => { const index = Number(event.target.value); tools.setChart({ ...tools.chart, [axis]: index, view: axis === 'x' && tools.chart.view === 'line' && !supportsLine(result,index) ? 'bar' : tools.chart.view }); }}>{result.columns.map((column, index) => axis === 'y' && column.type !== 'number' ? null : <option key={column.key} value={index}>{column.label.replaceAll('_', ' ')}</option>)}</select></label>)}</div>
          <p className={styles.caption}>Charts follow query order. Line charts need an ordered date or numeric label column.</p>
        </fieldset>
        <fieldset className={styles.optionGroup}><legend>Download</legend>
          <div className={styles.actions}><button className={styles.button} disabled={disabled || !hasSnapshot} onClick={tools.exportCSV}>CSV results</button><button className={styles.button} disabled={disabled} onClick={() => tools.exportFile(false)}>Research file</button><button className={styles.button} disabled={disabled} onClick={() => tools.exportFile(true)}>Markdown report</button></div>
          <p className={styles.caption}>Research files and reports include the question, saved answer and exact results when available. Edited SQL needs a new run to include a result snapshot.</p>
        </fieldset>
        <fieldset className={styles.optionGroup}><legend>Local library</legend>
          <label className={styles.field}>Dashboard name<input name="dashboard" autoComplete="off" className={styles.input} value={tools.dashboard} maxLength={120} onChange={event => tools.setDashboard(event.target.value)} placeholder="My Zcash research…" /></label>
          <div className={styles.actions}><button className={styles.button} disabled={!tools.ready || disabled || !tools.id || !tools.dashboard.trim()} onClick={tools.addToDashboard}>Add to dashboard</button>{tools.id ? <button className={styles.button} disabled={disabled} onClick={tools.remove}>Remove local save</button> : null}</div>
          {!tools.id ? <p className={styles.caption}>Save this analysis before adding it to a dashboard.</p> : null}
        </fieldset>
      </div></details>
    </div>
    <ShareLinkField tools={tools} />
    {tools.shareURL ? <p className={styles.caption}>This link shares the SQL draft, title and chart settings. Answers, notes and result snapshots are excluded. It never runs automatically.</p> : null}
    <ResearchStatus tools={tools} />
    <ResearchData result={result} chart={tools.chart} sources={sources} />
  </div>;
}
export function ResearchDashboard({ tools, busy, onOpen }: { tools: Tools; busy: boolean; onOpen: (doc: ResearchDocument) => void }) {
  const board = tools.library.dashboards.find(d => d.id === tools.boardId);
  if (!board) return null;
  return <section aria-label="Saved dashboard"><div className={styles.toolbar}><h2 className={styles.resultTitle}>{board.title}</h2><button className={styles.button} onClick={() => tools.setBoardId(null)}>Back to analysis</button></div><p className={styles.caption}>Saved snapshots · open an analysis to refresh it</p><div className={styles.dashboard}>{board.items.map(id => { const doc = tools.library.documents.find(d => d.id === id)!; return <article key={id} className={askStyles.analysis}><div className={styles.panelBody}><button className={styles.textButton} disabled={busy} onClick={() => onOpen(doc)}>{doc.title} →</button>{doc.result ? <ResearchData result={doc.result} chart={doc.chart} /> : <p className={styles.caption}>Run this query to add its results.</p>}</div></article>; })}</div><div className={styles.actions}><button className={styles.button} onClick={() => void tools.copyLink(true)}>Copy dashboard link</button><button className={styles.button} onClick={tools.downloadLibrary}>Download all saved research</button><button className={styles.button} onClick={tools.removeDashboard}>Remove dashboard</button></div><ShareLinkField tools={tools} /><p className={styles.caption}>Dashboard links contain query drafts, titles and chart settings. Results and notes are excluded; queries never run automatically.</p><ResearchStatus tools={tools} /></section>;
}

function ShareLinkField({ tools }: { tools: Tools }) {
  return tools.shareURL ? <label className={styles.field}>Research link<input readOnly name="research-link" type="url" autoComplete="off" spellCheck={false} className={`${styles.input} ${styles.shareInput}`} value={tools.shareURL} onFocus={event => event.currentTarget.select()} /></label> : null;
}
export function SharedResearchDraft({ share, tools, busy, enabled, onOpen, onDismiss }: { share: ResearchShare; tools: Tools; busy: boolean; enabled: boolean; onOpen: (doc: ResearchDocument) => void; onDismiss: () => void }) {
  return <section className={styles.sharedDraft} aria-label="Shared research draft">
    <div className={styles.toolbar}><div><p className={styles.eyebrow}>{share.kind === 'dashboard' ? 'SHARED DASHBOARD' : 'SHARED QUERY'}</p><h2 className={styles.resultTitle}>{share.title}</h2></div><button className={styles.button} onClick={onDismiss}>Dismiss</button></div>
    <p className={styles.caption}>Unverified query drafts · no SQL has run. Review before running. Your existing saves have not changed.</p>
    {share.queries.map((item, index) => <article className={styles.sharedItem} key={index}>
      {share.kind === 'dashboard' ? <h3 className={styles.dataset}>{item.title}</h3> : null}
      <details className={styles.catalogue}><summary>Review SQL</summary><pre className={styles.shareSQL} translate="no" tabIndex={0} aria-label="SQL draft">{item.query.sql}</pre></details>
      <div className={styles.actions}><button className={styles.button} disabled={busy || tools.importing || !enabled} onClick={() => onOpen(sharedLibrary({ ...share, kind: 'query', title: item.title, queries: [item] }, () => crypto.randomUUID(), new Date().toISOString()).documents[0])}>Open query draft</button></div>
    </article>)}
    {!enabled ? <p className={styles.caption}>SQL research is not enabled on this connection. You can still inspect these drafts.</p> : null}
    <div className={styles.actions}><button className={styles.button} disabled={!tools.ready || busy || tools.importing} onClick={() => { if (tools.saveShared(share)) onDismiss(); }}>Save {share.kind === 'dashboard' ? 'dashboard' : 'query'} in this browser</button></div>
    <ResearchStatus tools={tools} />
  </section>;
}
