const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');

function pageHarness() {
  const states = [];
  const effects = [];
  let index = 0, refresh;
  const source = fs.readFileSync(path.join(__dirname, '../../app/validators/page.tsx'), 'utf8');
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const hookReact = {
    ...React,
    useState(initial) {
      const slot = index++;
      if (states.length <= slot) states[slot] = initial;
      return [states[slot], value => { states[slot] = typeof value === 'function' ? value(states[slot]) : value; }];
    },
    useEffect(effect) { effects.push(effect); },
    useCallback(callback) { refresh = callback; return callback; },
  };
  const empty = () => null;
  const imports = {
    react: hookReact,
    '@/lib/api-client': { readApiData: async response => (await response.json()).data },
    'next/link': { __esModule: true, default: ({ children }) => children },
    '@/components/StakingDayBanner': { StakingDayBanner: empty },
    '@/components/CopyButton': { CopyButton: empty },
    '@/components/ui/HashLink': { HashLink: empty },
    '@/components/ui/SectionHeader': { PageHeader: ({ title }) => React.createElement('h1', null, title) },
    '@/lib/config': { CURRENCY: 'cTAZ' },
    '@/lib/utils': { displayPubkey: key => key },
    '@/lib/finalizer-labels': { getFinalizerLabel: () => null, finalizerAvatarStyle: () => ({}) },
    '@/lib/api-config': { getApiUrl: () => 'http://test.invalid' },
  };
  const module = { exports: {} };
  new Function('require', 'module', 'exports', code)(name => imports[name] || require(name), module, module.exports);
  return {
    render() { index = 0; effects.length = 0; return renderToStaticMarkup(module.exports.default()); },
    refresh: () => refresh(),
    runObservationEffect: () => effects.at(-1)(),
  };
}

test('a successful native observation disappears after a failed refresh and old observations never render as live', async t => {
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });
  const page = pageHarness();
  page.render();
  let observedAt = new Date().toISOString();
  const roster = [{ identity: '01'.repeat(32), stake_zats: 10000000000, stake_zec: 100,
    votingEligible: true, connected: true, voted: true, last_connected_utc: Math.floor(Date.now() / 1000) }];
  global.fetch = async () => new Response(JSON.stringify({ data: {
    roster, finalizerCount: 12, candidateCount: 25, totalStakeZec: 100,
    finalizedHeight: 52992, tipHeight: 53000,
    liveness: { available: true, observedAt, bftHeight: 12324, bftRound: 0,
      onlineCount: 8, onlineStakeZec: 80, onlinePercent: 80,
      connectedCount: 12, connectedStakeZec: 100, connectedPercent: 100 },
  } }));
  await page.refresh();
  let html = page.render();
  assert.match(html, /Finalizer Observations/);
  assert.match(html, /Recent packets/);
  assert.match(html, /Packet observed/);
  assert.match(html, new RegExp(observedAt));

  global.fetch = async () => new Response('{}', { status: 503 });
  await page.refresh();
  html = page.render();
  assert.match(html, /Crosslink RPC unavailable/);
  assert.doesNotMatch(html, /Finalizer Observations|Recent packets|Votes this height/);

  observedAt = new Date(Date.now() - 91000).toISOString();
  global.fetch = async () => new Response(JSON.stringify({ data: {
    roster, finalizerCount: 12, candidateCount: 25, totalStakeZec: 100,
    finalizedHeight: 52992, tipHeight: 53000,
    liveness: { available: true, observedAt, bftHeight: 12324, bftRound: 0,
      onlineCount: 8, onlineStakeZec: 80, onlinePercent: 80 },
  } }));
  await page.refresh();
  html = page.render();
  assert.match(html, /Recent finalizer observations are unavailable/);
  assert.doesNotMatch(html, /Finalizer Observations|Votes this height/);
  assert.doesNotMatch(html, /title="Packet observed|title="Vote observed at this height/);
  assert.match(html, /Recent finalizer observations unavailable/);
});

test('observations and row dots expire while a foreground refresh remains pending', async t => {
  const originalFetch = global.fetch, originalTimeout = global.setTimeout, originalClear = global.clearTimeout;
  t.after(() => { global.fetch = originalFetch; global.setTimeout = originalTimeout; global.clearTimeout = originalClear; });
  const page = pageHarness(); page.render();
  const observedAt = new Date().toISOString();
  global.fetch = async url => new Response(JSON.stringify({ data: url.endsWith('/participation?window=500') ? {} : {
    roster: [{ identity: '02'.repeat(32), stake_zats: 10000000000, stake_zec: 100, votingEligible: true,
      connected: true, voted: true, last_connected_utc: Math.floor(Date.now() / 1000) }],
    finalizerCount: 12, candidateCount: 25, totalStakeZec: 100, finalizedHeight: 52992, tipHeight: 53000,
    liveness: { available: true, observedAt, bftHeight: 12324, bftRound: 0,
      onlineCount: 8, onlineStakeZec: 80, onlinePercent: 80,
      connectedCount: 12, connectedStakeZec: 100, connectedPercent: 100 },
  } }));
  await page.refresh();
  assert.match(page.render(), /Finalizer Observations/);
  let expire, delay;
  global.setTimeout = (callback, milliseconds) => { expire = callback; delay = milliseconds; return 1; };
  global.clearTimeout = () => {};
  page.runObservationEffect();
  assert.ok(delay > 0 && delay <= 90001);
  global.fetch = () => new Promise(() => {});
  void page.refresh();
  expire();
  const html = page.render();
  assert.match(html, /Recent finalizer observations are unavailable/);
  assert.match(html, /Recent finalizer observations unavailable/);
  assert.doesNotMatch(html, /Finalizer Observations|Recent packets|Votes this height|title="Packet observed|title="Vote observed at this height/);
});
