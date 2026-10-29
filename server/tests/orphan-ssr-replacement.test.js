const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');

function load(file, dependencies = {}) {
  const exports = {};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  }).outputText, { exports, URL, require: name => dependencies[name] ?? require(name) });
  return exports;
}
const { BlockPageSkeleton } = load('app/block/[height]/components/BlockPageSkeleton.tsx', {
  'next/link': { default: ({ children, prefetch, ...props }) => React.createElement('a', { ...props, 'data-prefetch': String(prefetch) }, children) },
  '@/components/ui/EmptyState': { SkeletonTable: () => null },
  '@/components/ui/Skeleton': { Skeleton: () => null },
  '@/components/ui/Card': Object.fromEntries(['Card', 'CardHeader', 'CardBody'].map(name => [name, ({ children }) => React.createElement('div', null, children)])),
  '@/components/ui/Badge': { Badge: ({ children }) => React.createElement('span', null, children) },
  '@/lib/utils': { formatRelativeTime: () => '2 minutes ago' },
  '@/lib/format-numbers': { formatBytesCompact: value => `${value} B` },
});

async function render(block) {
  const page = load('app/block/[height]/page.tsx', {
    '@/lib/api-client': {}, 'next/navigation': {},
    '@/lib/seo': { getBlockResolution: async () => ({ state: 'found', block }), getBaseUrl: () => 'https://zecblock.com',
      normalizeBlockIdentifier: value => value, BLOCK_HASH_PATTERN: /^[a-fA-F0-9]{64}$/ },
    '@/lib/server-fetch': {}, '@/lib/isr-fallback': {}, '@/lib/network-upgrades-server': {}, '@/lib/network-upgrades': {}, './FutureBlockView': {},
    './BlockPageClient': { default: props => React.createElement(BlockPageSkeleton, props) },
  });
  return renderToStaticMarkup(await page.default({ params: Promise.resolve({ height: block.hash }) }));
}
const orphan = { height: 100, hash: 'b'.repeat(64), isOrphaned: true, timestamp: 1792140000, transaction_count: 2, size: 1024 };

test('orphan server HTML includes the verified canonical replacement link and retains the orphan identifier', async () => {
  const html = await render({ ...orphan, canonicalBlock: { hash: 'a'.repeat(64) } });
  assert.equal((html.match(/<h1(?:\s|>)/g) || []).length, 1);
  assert.match(html, /Orphaned Zcash Block/);
  assert.ok(html.includes(orphan.hash));
  assert.match(html, /Canonical replacement at this height/);
  assert.match(html, /href="\/block\/100"[^>]*data-prefetch="false"/);
  assert.match(html, /Zcash block #100/);
});

test('server HTML never invents replacement discovery from an absent, malformed or identical hash', async () => {
  for (const canonicalBlock of [null, {}, { hash: null }, { hash: '' }, { hash: 'bad' }, { hash: orphan.hash }, { hash: orphan.hash.toUpperCase() }]) {
    const html = await render({ ...orphan, canonicalBlock });
    assert.doesNotMatch(html, /Canonical replacement at this height|href="\/block\/100"/);
  }
  const canonical = await render({ ...orphan, isOrphaned: false, canonicalBlock: { hash: 'a'.repeat(64) } });
  assert.doesNotMatch(canonical, /Canonical replacement at this height|href="\/block\/100"/);
});
