'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');

function load(file, mocks = {}) {
  const exports = {};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText, { exports, Date, require(name) {
    if (name in mocks) return mocks[name];
    throw Error(`Unexpected import: ${name}`);
  } });
  return exports;
}
const { clusterNodeLocations } = load('lib/node-map-locations.ts');
const location = (countryCode, nodeCount, extra = {}) => ({ country: countryCode, countryCode,
  lat: 49, lon: 2, nodeCount, avgPingMs: 10, topClient: 'Zebra', topIsp: 'Provider A', ...extra });

function visit(tree, predicate, out = []) {
  if (!tree || typeof tree !== 'object') return out;
  if (predicate(tree)) out.push(tree);
  const children = tree.props?.children;
  for (const child of Array.isArray(children) ? children.flat(Infinity) : [children]) visit(child, predicate, out);
  return out;
}
function text(tree) {
  if (Array.isArray(tree)) return tree.map(text).join('');
  if (tree == null || typeof tree === 'boolean') return '';
  return typeof tree === 'object' ? text(tree.props?.children) : String(tree);
}
function mapHarness({ version = 3, fail = false } = {}) {
  const state = []; let cursor = 0;
  const jsx = (type, props, key) => ({ type, props, key });
  const locations = [location('GB', 10), location('FR', 9), location('FR', 8)];
  const stats = { censusVersion: version, chainQualifiedCrawlerNodes: 20, localPeerOnlyNodes: 12, activeNodes: 32, totalNodes: 100, countries: 2, cities: 2,
    avgPingMs: 10, torNodes: 4, lastUpdated: '2026-10-19T00:30:00.000Z' };
  const { NodeMap } = load('components/NodeMap.tsx', {
    'react/jsx-runtime': { jsx, jsxs: jsx },
    react: { useMemo: fn => fn(), useState: value => { const index = cursor++; if (!(index in state)) state[index] = value; return [state[index], next => { state[index] = next; }]; } },
    'next/link': { default: 'Link' },
    '@/components/ui/Skeleton': { LoadingRegion: 'LoadingRegion', Skeleton: 'Skeleton' },
    '@/components/ChartWatermark': { ChartWatermark: 'ChartWatermark' },
    '@/lib/network-colors': { clientLabel: value => value },
    '@/lib/node-map-locations': { clusterNodeLocations },
    '@/hooks/useApiQuery': { useApiQuery: path => ({ loading: false, error: fail ? 'offline' : null,
      data: path.endsWith('/stats') ? { stats, trends: { change24h: null, change7d: null, change30d: null },
        topCountries: [{ country: 'France', countryCode: 'FR', nodeCount: 17 }, { country: 'Britain', countryCode: 'GB', nodeCount: 10 }] } : { locations } }) },
    '@/lib/world-dot-map': { MAP_WIDTH: 1000, MAP_HEIGHT: 500, DOT_RADIUS: 1,
      project: (lat, lon) => ({ x: lon, y: lat }), useWorldLandDots: () => [{ x: 0, y: 0 }] },
  });
  return () => { cursor = 0; return NodeMap({}); };
}

test('border-adjacent countries retain their counts and filters independently', () => {
  const render = mapHarness(); let tree = render();
  const france = visit(tree, n => n.type === 'button').find(n => text(n).includes('France'));
  france.props.onClick(); tree = render();
  const bubbles = visit(tree, n => n.type === 'g' && String(n.key).startsWith('nc-'));
  assert.equal(bubbles.length, 2);
  const counts = bubbles.map(n => ({ count: Number(text(visit(n, x => x.type === 'text')[0])), opacity: n.props.style.opacity }));
  assert.ok(counts.some(n => n.count === 17 && n.opacity === 1));
  assert.ok(counts.some(n => n.count === 10 && n.opacity === 0.15));
  assert.equal(counts.reduce((sum, n) => sum + n.count, 0), 27);
});

test('combined cells never claim the last cell latency or an unsupported dominant client', () => {
  const input = [location('FR', 9), location('FR', 8, { avgPingMs: 1000, topClient: 'Zakura', topIsp: 'Provider B' })];
  const [combined] = clusterNodeLocations(input);
  assert.equal(combined.nodeCount, 17);
  assert.equal(combined.avgPingMs, null);
  assert.equal(combined.topClient, null);
  assert.equal(combined.topIsp, null);
  assert.equal(input[0].nodeCount, 9, 'source observations remain intact');
});

test('new census shows missing baselines without manufacturing percentages and labels candidate remainder', () => {
  const page = text(mapHarness()());
  for (const period of ['24h', '7d', '30d']) assert.ok(page.includes(`${period} unavailable`));
  assert.ok(page.includes('comparable observation'));
  assert.ok(page.includes('Other / unknown5'));
  assert.ok(page.includes('Tor classified'));
  assert.ok(page.includes('20 crawler-verified IPs'));
  assert.ok(page.includes('12 additional local-peer IPs'));
  assert.ok(!page.includes('332.2%'));
  assert.ok(!text(mapHarness({ version: 2 })()).includes('after chain verification'));
});

test('a failed refresh keeps observations visible with an explicit stale status', () => {
  const tree = mapHarness({ fail: true })();
  assert.ok(text(tree).includes('Observed IPs'));
  const status = visit(tree, n => n.props?.role === 'status');
  assert.equal(status.length, 1);
  assert.ok(text(status[0]).includes('may be stale'));
});
