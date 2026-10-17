'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), Module = require('node:module');
const ts = require('typescript'), React = require('react'), { renderToStaticMarkup } = require('react-dom/server');
const root = path.resolve(__dirname, '../..');
function workspace(handoff) {
  const filename = path.join(root, 'app/ask/AskWorkspace.tsx');
  const m = new Module(filename, module); m.filename = filename; m.paths = Module._nodeModulePaths(path.dirname(filename));
  const base = m.require.bind(m);
  const record = key => function Record({result}) { return result ? React.createElement('p', {'data-record':key}, result.label) : null; };
  const imports = {
    'next/link': {default:({children, ...props}) => React.createElement('a', props, children)},
    '@/lib/ask/contract': require('../../lib/ask/contract'),
    '@/lib/ask/api-base': {getAskApiUrl:() => '/v1/ask', isAuthenticatedAskStaging:() => false}, '@/lib/api-client': {},
    './ResearchWorkbench': {useResearchTools:() => ({library:{documents:[]}, importing:false, title:'Analysis'}), ResearchLibrary:() => null, ResearchEditor:() => null, ResearchDashboard:() => null, ResearchPanel:record('research'), ResearchData:record('research')},
    '@/lib/ask/research-job-contract': {}, '@/lib/ask/research-client': {}, '@/lib/ask/research-contract': {},
    '@/components/ask/AskChallenge': {AskChallenge:() => null},
    '@/components/ask/AskTransactions': {AskTransactions:record('transactions')}, '@/components/ask/AskBlocks': {AskBlocks:record('blocks')}, '@/components/ask/AskTransfers': {AskTransfers:record('transfers')}, '@/components/ask/AskAnalytics': {AskAnalytics:record('analytics')}, '@/components/ask/AskSources': {AskSources:() => null},
    '@/lib/ask/client': {peekAskHandoff:() => handoff}, '@/lib/ask/composer': {sqlDraft:() => null},
    '@/components/ask/AskFeedback': {AskFeedback:() => null, AskFailureFeedback:() => null, useAskFeedback:() => ({blocked:false})},
    '@/lib/ask/data': require('../../lib/ask/data'),
    '@/lib/ask/research-share': require('../../lib/ask/research-share'),
    './AskAnalysis': {AskAnalysis:({spec}) => React.createElement('article', {'data-record':'preset', 'data-period':spec.period}, spec.metric)},
  };
  m.require = name => Object.hasOwn(imports, name) ? imports[name] : name.endsWith('.module.css') ? new Proxy({}, {get:(_,key) => key}) : base(name);
  m._compile(ts.transpileModule(fs.readFileSync(filename,'utf8'), {compilerOptions:{target:ts.ScriptTarget.ES2022, jsx:ts.JsxEmit.ReactJSX, module:ts.ModuleKind.CommonJS}}).outputText, filename);
  return renderToStaticMarkup(React.createElement(m.exports.AskWorkspace));
}
const spec = {version:1, metric:'flows', period:'1y', pool:'all', view:'line', start:null, end:null};
const records = ['blocks', 'transactions', 'transfers', 'analytics', 'research'];
const turns = records.map((key,i) => ({question:`Question ${i}`, answer:`Reply ${i}`, sources:[], [key]:{label:`retained-${key}`, query:{}, plan:{version:1}}, spec:null}));
turns.push({question:'Annual flows', answer:'Annual reply', sources:[], spec});
test('every result remains beneath its own reply in one conversation when a preset becomes current', () => {
  const html = workspace({turns, spec, page:'ask'});
  const conversation = html.slice(html.indexOf('aria-label="Conversation"'), html.indexOf('</section>', html.indexOf('aria-label="Conversation"')));
  for (const key of records) assert.match(conversation, new RegExp(`data-record="${key}"[^>]*>retained-${key}`));
  assert.match(conversation, /data-record="preset" data-period="1y">flows/);
  assert.equal((conversation.match(/Expand results ↗/g)||[]).length, 5);
  assert.ok(conversation.indexOf('data-record="preset"') < conversation.indexOf('<form'));
  assert.doesNotMatch(html, /aria-label="Current analysis"/);
});
test('switching current result to SQL retains earlier preset and record replies', () => {
  const reordered = [turns.at(-1), ...turns.slice(0,-1)];
  const html = workspace({turns:reordered, spec:null, page:'ask'});
  for (const key of [...records,'preset']) assert.match(html, new RegExp(`data-record="${key}"`));
  assert.equal((html.match(/data-record="research"/g)||[]).length, 1);
  assert.doesNotMatch(html, /aria-label="Current analysis"/);
});
