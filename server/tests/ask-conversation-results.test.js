'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), Module = require('node:module');
const ts = require('typescript'), React = require('react'), { renderToStaticMarkup } = require('react-dom/server');
const root = path.resolve(__dirname, '../..');
function loadComponent(file, imports) {
  const filename = path.join(root, file);
  const m = new Module(filename, module); m.filename = filename; m.paths = Module._nodeModulePaths(path.dirname(filename));
  const base = m.require.bind(m);
  m.require = name => Object.hasOwn(imports, name) ? imports[name] : name.endsWith('.module.css') ? new Proxy({}, {get:(_,key) => key}) : base(name);
  m._compile(ts.transpileModule(fs.readFileSync(filename,'utf8'), {compilerOptions:{target:ts.ScriptTarget.ES2022, jsx:ts.JsxEmit.ReactJSX, module:ts.ModuleKind.CommonJS}}).outputText, filename);
  return m.exports;
}
function workspace(handoff) {
  const record = key => function Record({result}) { return result ? React.createElement('p', {'data-record':key}, result.label) : null; };
  const imports = {
    'next/link': {default:({children, ...props}) => React.createElement('a', props, children)},
    '@/lib/ask/contract': require('../../lib/ask/contract'),
    '@/lib/ask/api-base': {getAskApiUrl:() => '/v1/ask', isAuthenticatedAskStaging:() => false}, '@/lib/api-client': {},
    './ResearchWorkbench': {useResearchTools:() => ({library:{documents:[]}, importing:false, title:'Analysis'}), ResearchLibrary:() => null, ResearchEditor:() => null, ResearchDashboard:() => null, ResearchPanel:({result,embedded,actions}) => React.createElement('div', {'data-embedded':embedded}, actions, React.createElement('table', {'data-record':'research'}, React.createElement('caption', null, result.label))), ResearchData:record('research')},
    '@/lib/ask/research-job-contract': {}, '@/lib/ask/research-client': {}, '@/lib/ask/research-contract': {},
    '@/components/ask/AskChallenge': {AskChallenge:() => null},
    '@/components/ask/AskTransactions': {AskTransactions:record('transactions')}, '@/components/ask/AskBlocks': {AskBlocks:record('blocks')}, '@/components/ask/AskTransfers': {AskTransfers:record('transfers')}, '@/components/ask/AskAnalytics': {AskAnalytics:record('analytics')}, '@/components/ask/AskSources': {AskSources:({sources}) => React.createElement('aside', {'aria-label':'Sources'}, sources.map(source => source.label).join(' '))},
    '@/lib/ask/client': {peekAskHandoff:() => handoff}, '@/lib/ask/composer': {sqlDraft:() => null},
    '@/components/ask/AskFeedback': {AskFeedback:() => null, AskFailureFeedback:() => null, useAskFeedback:() => ({blocked:false})},
    '@/lib/ask/data': require('../../lib/ask/data'),
    '@/lib/ask/research-share': require('../../lib/ask/research-share'),
    '@/lib/ask/follow-ups': require('../../lib/ask/follow-ups'),
    './AskAnalysis': {AskAnalysis:({spec}) => React.createElement('article', {'data-record':'preset', 'data-period':spec.period}, spec.metric)},
  };
  return renderToStaticMarkup(React.createElement(loadComponent('app/ask/AskWorkspace.tsx', imports).AskWorkspace));
}
const spec = {version:1, metric:'flows', period:'1y', pool:'all', view:'line', start:null, end:null};
const records = ['blocks', 'transactions', 'transfers', 'analytics', 'research'];
const turns = records.map((key,i) => ({question:`Question ${i}`, answer:`Reply ${i}`, sources:[{label:`source-${key}`}], [key]:{label:`retained-${key}`, query:{}, plan:{version:1}}, spec:null}));
turns.push({question:'Annual flows', answer:'Annual reply', sources:[], spec});
test('every result remains beneath its own reply in one conversation when a preset becomes current', () => {
  const html = workspace({turns, spec, page:'ask'});
  const conversation = html.slice(html.indexOf('aria-label="Conversation"'), html.indexOf('</section>', html.indexOf('aria-label="Conversation"')));
  for (const key of records) assert.match(conversation, new RegExp(`data-record="${key}"[^>]*>(?:<caption>)?retained-${key}`));
  assert.match(conversation, /data-record="preset" data-period="1y">flows/);
  assert.equal((conversation.match(/Expand results ↗/g)||[]).length, 5);
  assert.ok(conversation.indexOf('data-record="preset"') < conversation.indexOf('<form'));
  assert.doesNotMatch(html, /aria-label="Current analysis"/);
});

// Balance articles so nested preset cards cannot accidentally end a reply.
function assistantReplies(html) {
  const replies = []; let start = null, depth = 0;
  for (const token of html.matchAll(/<\/?article\b[^>]*>/g)) {
    if (start === null) {
      if (token[0].includes('aria-label="ZecBlock response"')) { start = token.index; depth = 1; }
    } else {
      depth += token[0].startsWith('</') ? -1 : 1;
      if (depth === 0) { replies.push(html.slice(start, token.index + token[0].length)); start = null; }
    }
  }
  assert.equal(start, null, 'Assistant reply must close');
  return replies;
}
test('each assistant reply owns its prose, result, actions and sources, outside the user question', () => {
  const html = workspace({turns, spec, page:'ask'}), replies = assistantReplies(html);
  assert.equal(replies.length, turns.length);
  for (const [i,key] of records.entries()) {
    const reply = replies[i];
    assert.match(reply, new RegExp(`>Reply ${i}</p>`));
    assert.match(reply, new RegExp(`data-record="${key}"`));
    assert.match(reply, /role="group" aria-label="Query results"/);
    assert.match(reply, /<button[^>]*aria-haspopup="dialog"[^>]*>Expand results ↗<\/button>/);
    assert.match(reply, new RegExp(`source-${key}`));
    assert.ok(reply.indexOf(`Reply ${i}`) < reply.indexOf(`data-record="${key}"`));
    assert.ok(reply.indexOf(`data-record="${key}"`) < reply.indexOf(`source-${key}`));
    for (const other of records.filter(item => item !== key)) assert.doesNotMatch(reply, new RegExp(`retained-${other}`));
    assert.doesNotMatch(reply, /Question \d/);
  }
  assert.match(replies[4], /data-embedded="true"/);
  assert.match(replies[4], />Edit query<\/button>/);
  assert.match(replies.at(-1), />Annual reply<\/p>[\s\S]*data-record="preset"/);
  assert.doesNotMatch(replies.at(-1), /Query results|Expand results/);
  assert.match(html, /<dialog[^>]*aria-labelledby="expanded-result-title"/);
});

function panelFixture(overrides = {}, embedded = true) {
  const elements = [], runtime = require('react/jsx-runtime');
  const capture = fn => (type,props,...rest) => { elements.push({type,props}); return fn(type,props,...rest); };
  const imports = {
    'react/jsx-runtime': {...runtime, jsx:capture(runtime.jsx), jsxs:capture(runtime.jsxs)},
    'next/dynamic': {default:() => () => null}, 'next/link': {default:({children,...props}) => React.createElement('a',props,children)},
    '@/lib/ask/research-display': require('../../lib/ask/research-display'),
    '@/lib/ask/research-contract': require('../../lib/ask/research-contract'),
    '@/lib/ask/research-library': require('../../lib/ask/research-library'),
    '@/lib/ask/research-share': require('../../lib/ask/research-share'),
  };
  const calls = [], tools = {ready:true, importing:false, id:null, title:'Known block fees', notes:'', dashboard:'', chart:{view:'table',x:0,y:0}, setTitle:value => calls.push(['title',value]), save:() => calls.push(['save']), setChart:value => calls.push(['chart',value]), ...overrides};
  const result = {columns:[{key:'c0',label:'mean_fee_zec',type:'number'}], rows:[['0.0013379257']], indexedThrough:'2026-10-19T00:00:00Z', retrievedAt:'2026-10-19T00:01:00Z', coverage:'Public analytics', units:'ZEC', fingerprint:'a'.repeat(64)};
  const actions = React.createElement('button', {'aria-haspopup':'dialog'}, 'Expand results ↗');
  const html = renderToStaticMarkup(React.createElement(loadComponent('app/ask/ResearchWorkbench.tsx',imports).ResearchPanel,{tools,result,busy:overrides.busy || false,embedded,actions}));
  return {html,elements,calls};
}
test('embedded results retain exact data, editable labelled title, save and chart controls', () => {
  const {html,elements,calls} = panelFixture();
  assert.match(html, /<td[^>]*><span title="0\.0013379257">0\.0013379257<\/span>/);
  assert.equal((html.match(/name="title"/g)||[]).length,1);
  const title = elements.find(item => item.type === 'input' && item.props.name === 'title');
  assert.equal(title.props.value,'Known block fees'); assert.equal(title.props.maxLength,120);
  assert.ok(elements.some(item => item.type === 'label' && item.props.htmlFor === title.props.id));
  title.props.onChange({target:{value:'Renamed fee analysis'}});
  const save = elements.find(item => item.type === 'button' && item.props.children === 'Save analysis');
  assert.equal(save.props.disabled,false); save.props.onClick();
  const bar = elements.find(item => item.type === 'button' && item.props.children === 'Bar chart');
  assert.equal(bar.props.disabled,false); bar.props.onClick();
  assert.deepEqual(calls,[['title','Renamed fee analysis'],['save'],['chart',{view:'bar',x:0,y:0}]]);
  assert.match(html, /aria-haspopup="dialog">Expand results ↗/);
  assert.match(html, /<summary>Notes &amp; downloads<\/summary>/);
  for (const state of [{ready:false},{importing:true},{busy:true}]) {
    const fixture = panelFixture(state);
    assert.equal(fixture.elements.find(item => item.type === 'button' && item.props.children === 'Save analysis').props.disabled,true);
  }
  const expanded = panelFixture({id:'saved-analysis'},false);
  assert.equal(expanded.elements.find(item => item.type === 'button' && item.props.children === 'Save changes').props.disabled,false);
  assert.equal((expanded.html.match(/name="title"/g)||[]).length,1);
});
test('switching current result to SQL retains earlier preset and record replies', () => {
  const reordered = [turns.at(-1), ...turns.slice(0,-1)];
  const html = workspace({turns:reordered, spec:null, page:'ask'});
  for (const key of [...records,'preset']) assert.match(html, new RegExp(`data-record="${key}"`));
  assert.equal((html.match(/data-record="research"/g)||[]).length, 1);
  assert.doesNotMatch(html, /aria-label="Current analysis"/);
});
