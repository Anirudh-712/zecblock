'use client';

import { useEffect, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import type { ResearchChart, ResearchDocument, ResearchLibrary, ResearchResult } from '@/lib/ask/research-contract';
import { researchDocumentSchema } from '@/lib/ask/research-contract';
import { emptyLibrary, readLibrary, writeLibrary, readPortable, mergePortable, markdownReport, MAX_BYTES } from '@/lib/ask/research-library';
import styles from './research.module.css';
import askStyles from './ask.module.css';

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

export function useResearchTools(initial?: ResearchResult, initialTitle = 'My Zcash analysis') {
  const [library, setLibrary] = useState<ResearchLibrary>(emptyLibrary);
  const [ready, setReady] = useState(false);
  const raw = useRef<string | null>(null);
  const [id, setId] = useState<string | null>(null);
  const [title, setTitle] = useState(initialTitle.slice(0, 120));
  const [notes, setNotes] = useState('');
  const [sql, setSQL] = useState(initial?.query.sql || initialSQL);
  const [limit, setLimit] = useState(initial?.query.limit || 100);
  const [result, setResult] = useState<ResearchResult | null>(initial || null);
  const [chart, setChart] = useState<ResearchChart>({ view: 'table', x: 0, y: Math.max(0, initial?.columns.findIndex((c, i) => i > 0 && c.type === 'number') ?? 1) });
  const [boardId, setBoardId] = useState<string | null>(null);
  const [dashboard, setDashboard] = useState('');
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [importing, setImporting] = useState(false);
  useEffect(() => {
    try { const loaded = readLibrary(window.localStorage); raw.current = loaded.raw; setLibrary(loaded.library); setReady(true); }
    catch { setError('Browser storage is unavailable or contains an invalid library. Existing saves have been preserved.'); }
  }, []);
  function persist(next: ResearchLibrary) { raw.current = writeLibrary(window.localStorage, next, raw.current); setLibrary(next); }
  function accept(data: ResearchResult, label: string, fresh = true) {
    setResult(data); setSQL(data.query.sql); setLimit(data.query.limit); setTitle(label.slice(0, 120)); setBoardId(null); setError(''); setNotice('');
    setChart({ view: 'table', x: 0, y: Math.max(0, data.columns.findIndex((c, i) => i > 0 && c.type === 'number')) });
    if (fresh) { setId(null); setNotes(''); }
  }
  function open(doc: ResearchDocument) {
    setId(doc.id); setTitle(doc.title); setNotes(doc.notes); setSQL(doc.query.sql); setLimit(doc.query.limit); setChart(doc.chart); setResult(doc.result); setBoardId(null); setError('');
    setNotice('Saved snapshot. Run the query to refresh its data.');
  }
  function reset() { setId(null); setResult(null); setNotes(''); setTitle('My Zcash analysis'); setSQL(initialSQL); setLimit(100); setBoardId(null); setError(''); setNotice(''); }
  function document(): ResearchDocument {
    const current = result?.query.sql === sql && result.query.limit === limit ? result : null;
    return researchDocumentSchema.parse({ format: 'zecblock-research', version: 1, id: id || crypto.randomUUID(), title, notes, query: { version: 3, sql, limit }, chart, result: current, savedAt: new Date().toISOString() });
  }
  function save() {
    try { const doc = document(); persist({ ...library, documents: [...library.documents.filter(d => d.id !== doc.id), doc] }); setId(doc.id); setNotice('Saved in this browser. Download a copy to keep it elsewhere.'); setError(''); }
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
  return { library, ready, id, title, setTitle, notes, setNotes, sql, setSQL, limit, setLimit, result, chart, setChart, boardId, setBoardId, dashboard, setDashboard, notice, error, importing, accept, open, reset, save, importFile, exportFile, remove, addToDashboard, removeDashboard, downloadLibrary: () => download('zecblock-library.json', JSON.stringify(library, null, 2), 'application/json') };
}
type Tools = ReturnType<typeof useResearchTools>;

export function ResearchLibrary({ tools, busy, onOpen }: { tools: Tools; busy: boolean; onOpen: (doc: ResearchDocument) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const disabled = busy || tools.importing;
  return <div className={styles.libraryContent}>
    <p className={styles.eyebrow}>SAVED ANALYSES</p>
    {tools.library.documents.length ? tools.library.documents.map(doc => <button key={doc.id} className={`${askStyles.session} ${tools.id === doc.id ? askStyles.selectedSession : ''}`} disabled={disabled} onClick={() => onOpen(doc)} title={doc.title}>{doc.title}</button>) : <p className={styles.caption}>Save an analysis to keep exploring later.</p>}
    {tools.library.dashboards.length ? <><p className={styles.eyebrow}>DASHBOARDS</p>{tools.library.dashboards.map(board => <button key={board.id} className={askStyles.session} disabled={disabled} onClick={() => tools.setBoardId(board.id)} title={board.title}>{board.title}</button>)}</> : null}
    <div className={styles.libraryActions}><button className={styles.textButton} disabled={!tools.ready || disabled} onClick={() => input.current?.click()}>Import research ↗</button><button className={styles.textButton} disabled={disabled} onClick={tools.downloadLibrary}>Download library ↓</button></div>
    <input type="file" ref={input} className="sr-only" tabIndex={-1} accept=".json,application/json" aria-label="Import research file" onChange={event => { const selected = event.target.files?.[0]; event.target.value = ''; void tools.importFile(selected); }} />
  </div>;
}

export function ResearchEditor({ tools, busy, onOpen }: { tools: Tools; busy: boolean; onOpen: (doc: ResearchDocument) => void }) {
  return <details className={styles.disclosure}>
    <summary>Data catalogue</summary>
    <div className={styles.advanced}>
      <p className={styles.caption}>Use SQL mode in the composer to write a query or edit the query behind your analysis.</p>
      <details className={styles.catalogue}><summary>Browse available data</summary>
        <h3 className={styles.dataset}>Blocks</h3><p className={styles.caption}>Canonical block heights, hashes, timestamps, miners, transaction counts, sizes and fees.</p>
        <h3 className={styles.dataset}>Transactions</h3><p className={styles.caption}>Confirmed transaction IDs, block heights, timestamps, pool participation, sizes and fees. Excludes coinbase.</p>
        <h3 className={styles.dataset}>Public pool flows</h3><p className={styles.caption}>Public shielding/deshielding amounts, transaction IDs, pool names and timestamps.</p>
        <pre className={styles.schema} translate="no">{`blocks(height, hash, timestamp, miner, transactions, bytes, fees)\ntransactions(txid, height, timestamp, miner, shielded, orchard, ironwood, sapling, bytes, fees)\nflows(txid, height, timestamp, direction, pool, amount)`}</pre>
        <p className={styles.caption}>Timestamps: Unix seconds, UTC. Amounts/fees: zatoshis; divide by 100000000 for ZEC. Join transactions.height to blocks.height, flows.txid to transactions.txid. Aggregate flows before joining to avoid double counting. Blocks include coinbase. Missing measures remain unavailable. Flow-history completeness is unverified.</p>
      </details>
      <details className={styles.mobileLibrary}><summary>Saved analyses & files</summary><ResearchLibrary tools={tools} busy={busy} onOpen={onOpen} /></details>
      <ResearchStatus tools={tools} />
    </div>
  </details>;
}
export function ResearchStatus({ tools }: { tools: Tools }) { return <>{tools.error ? <p className={styles.error} role="alert">{tools.error}</p> : null}{tools.notice ? <p className={styles.caption} role="status">{tools.notice}</p> : null}</>; }

export function ResearchData({ result, chart }: { result: ResearchResult; chart: ResearchChart }) {
  return <>
    <p className={styles.caption}>Indexed through {utcDate(result.indexedThrough)} · {result.rows.length} rows{result.truncated ? ' (limited)' : ''}</p>
    {chart.view !== 'table' ? <Plot result={result} chart={chart} /> : null}
    <details open={chart.view === 'table'} className={styles.exactTable}><summary>Exact data</summary><div className={styles.scroll}><table className={styles.table}><caption className="sr-only">Query results, preserving exact decimals</caption><thead><tr>{result.columns.map(column => <th key={column.key} scope="col">{column.label.replaceAll('_', ' ')}</th>)}</tr></thead><tbody>{result.rows.map((row, index) => <tr key={index}>{row.map((cell, i) => <td key={i} data-numeric={result.columns[i].type === 'number'}>{exactDisplay(cell, result.columns[i].type)}</td>)}</tr>)}</tbody></table>{!result.rows.length ? <p className={styles.caption}>No matching records were returned.</p> : null}</div></details>
    <details className={styles.caption}><summary>Source & methodology</summary><p>{result.coverage}. This describes source admission, not a certification of your SQL calculations.</p><p>{result.units}</p><p>Charts use approximate plotting numbers; the table preserves exact decimals. Rows follow query order.</p><p>Retrieved {utcDate(result.retrievedAt)}. Query fingerprint: {result.fingerprint}</p></details>
  </>;
}

export function ResearchPanel({ tools, result, busy }: { tools: Tools; result: ResearchResult; busy: boolean }) {
  return <div className={styles.panelBody}>
    <div className={styles.toolbar}><label className="sr-only" htmlFor="research-title">Analysis title</label><input id="research-title" name="title" autoComplete="off" className={styles.titleInput} maxLength={120} value={tools.title} onChange={event => tools.setTitle(event.target.value)} /><button className={styles.button} disabled={!tools.ready || busy || tools.importing} onClick={tools.save}>{tools.id ? 'Save changes' : 'Save analysis'}</button></div>
    <div className={styles.viewControls} aria-label="Result view">{(['table', 'bar', 'line'] as const).map(view => <button key={view} className={`${styles.button} ${tools.chart.view === view ? styles.viewSelected : ''}`} aria-pressed={tools.chart.view === view} onClick={() => tools.setChart({ ...tools.chart, view })}>{view === 'table' ? 'Table' : view === 'bar' ? 'Bar chart' : 'Line chart'}</button>)}</div>
    {tools.chart.view !== 'table' ? <div className={styles.columns}>{(['x', 'y'] as const).map(axis => <label className={styles.field} key={axis}>{axis === 'x' ? 'Labels' : 'Values'}<select className={styles.input} value={tools.chart[axis]} onChange={event => tools.setChart({ ...tools.chart, [axis]: Number(event.target.value) })}>{result.columns.map((column, index) => <option key={column.key} value={index}>{column.label.replaceAll('_', ' ')}</option>)}</select></label>)}</div> : null}
    <ResearchData result={result} chart={tools.chart} />
    <details className={styles.disclosure}><summary>Notes & downloads</summary><div className={styles.advanced}>
      <label className={styles.field}>Research notes<textarea name="notes" autoComplete="off" className={styles.input} maxLength={4000} value={tools.notes} onChange={event => tools.setNotes(event.target.value)} rows={3} /></label>
      <div className={styles.actions}><button className={styles.button} onClick={() => tools.exportFile(false)}>Download research</button><button className={styles.button} onClick={() => tools.exportFile(true)}>Download report</button></div>
      <p className={styles.caption}>Research files include your query, notes and saved results. Reports are readable Markdown documents. Edited queries need a new run to include verified results.</p>
      <label className={styles.field}>Dashboard name<input name="dashboard" autoComplete="off" className={styles.input} value={tools.dashboard} maxLength={120} onChange={event => tools.setDashboard(event.target.value)} placeholder="My Zcash research…" /></label>
      <div className={styles.actions}><button className={styles.button} disabled={!tools.ready || busy || tools.importing || !tools.id || !tools.dashboard.trim()} onClick={tools.addToDashboard}>Add to dashboard</button>{tools.id ? <button className={styles.button} disabled={busy || tools.importing} onClick={tools.remove}>Remove local save</button> : null}</div>
    </div></details><ResearchStatus tools={tools} />
  </div>;
}
export function ResearchDashboard({ tools, busy, onOpen }: { tools: Tools; busy: boolean; onOpen: (doc: ResearchDocument) => void }) {
  const board = tools.library.dashboards.find(d => d.id === tools.boardId);
  if (!board) return null;
  return <section aria-label="Saved dashboard"><div className={styles.toolbar}><h2 className={styles.resultTitle}>{board.title}</h2><button className={styles.button} onClick={() => tools.setBoardId(null)}>Back to analysis</button></div><p className={styles.caption}>Saved snapshots · open an analysis to refresh it</p><div className={styles.dashboard}>{board.items.map(id => { const doc = tools.library.documents.find(d => d.id === id)!; return <article key={id} className={askStyles.analysis}><div className={styles.panelBody}><button className={styles.textButton} disabled={busy} onClick={() => onOpen(doc)}>{doc.title} →</button>{doc.result ? <ResearchData result={doc.result} chart={doc.chart} /> : <p className={styles.caption}>Run this query to add its results.</p>}</div></article>; })}</div><div className={styles.actions}><button className={styles.button} onClick={tools.downloadLibrary}>Download dashboard library</button><button className={styles.button} onClick={tools.removeDashboard}>Remove dashboard</button></div><ResearchStatus tools={tools} /></section>;
}
