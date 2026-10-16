const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');

const root = path.resolve(__dirname, '../..');

function load(relativePath, dependencies) {
  const exports = {};
  const source = fs.readFileSync(path.join(root, relativePath), 'utf8');
  vm.runInNewContext(ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      jsx: ts.JsxEmit.ReactJSX,
      esModuleInterop: true,
    },
  }).outputText, {
    exports,
    require(name) {
      if (name in dependencies) return dependencies[name];
      if (['react/jsx-runtime', 'next/link'].includes(name)) return require(name);
      throw new Error(`Unexpected dependency ${name}`);
    },
  });
  return exports;
}

function filesUnder(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? filesUnder(file) : file.endsWith('.tsx') ? [file] : [];
  });
}

test('detail links retain normal navigation without speculative viewport requests', () => {
  let checked = 0;
  const violations = [];
  for (const file of ['app', 'components'].flatMap(directory => filesUnder(path.join(root, directory)))) {
    const source = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    function visit(node) {
      if ((ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) && node.tagName.getText(source) === 'Link') {
        const attributes = node.attributes.properties;
        const href = attributes.find(attribute => ts.isJsxAttribute(attribute) && attribute.name.getText(source) === 'href');
        // Cover literal URLs, templates and conditional canonical/orphan targets.
        if (href && /[`"']\/(block|tx|address)\//.test(href.getText(source))) {
          checked++;
          const prefetch = attributes.find(attribute => ts.isJsxAttribute(attribute) && attribute.name.getText(source) === 'prefetch');
          const disabled = prefetch?.initializer && ts.isJsxExpression(prefetch.initializer)
            && prefetch.initializer.expression?.kind === ts.SyntaxKind.FalseKeyword;
          if (!disabled) {
            const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
            violations.push(`${path.relative(root, file)}:${line}`);
          }
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
  assert.ok(checked > 50, 'the audit must cover actual explorer detail links');
  assert.deepEqual(violations, [], 'detail pages should be requested on navigation, not just because a list is visible');
});

test('shared hash links server-render crawlable hrefs and full identifiers', () => {
  const { HashLink } = load('components/ui/HashLink.tsx', {
    '@/components/CopyButton': { CopyButton: () => null },
  });
  for (const [prefix, identifier] of [['tx', 'a'.repeat(64)], ['block', '3500000'], ['address', 't1full-public-address']]) {
    const href = `/${prefix}/${identifier}`;
    const element = HashLink({ value: identifier, href, copy: false });
    const link = element.props.children[0];
    assert.equal(link.props.prefetch, false, 'shared tables and CopyableHash use navigation-only data links');
    const html = renderToStaticMarkup(element);
    assert.ok(html.includes(`href="${href}"`), html);
    assert.ok(html.includes(`title="${identifier}"`), 'the complete identifier remains in server HTML');
    assert.ok(!html.includes('nofollow'), 'crawler discovery remains available');
  }
  const plain = renderToStaticMarkup(React.createElement(HashLink, { value: 'b'.repeat(64), copy: false }));
  assert.ok(plain.includes('<code'));
  assert.ok(!plain.includes('<a'), 'unlinked identifiers remain plain text');
});

test('labeled address components retain crawlable addresses and link intent', () => {
  const { AddressWithLabel, AddressDisplay } = load('components/AddressWithLabel.tsx', {
    '@/lib/address-labels': { useAddressLabel: () => ({ label: 'Public miner', description: 'Public attribution', isOfficial: true }) },
  });
  const address = 't1full-public-miner-address';
  for (const Component of [AddressWithLabel, AddressDisplay]) {
    const element = Component({ address });
    assert.equal(element.props.href, `/address/${address}`);
    assert.equal(element.props.prefetch, false);
    const html = renderToStaticMarkup(element);
    assert.ok(html.includes(`href="/address/${address}"`));
    assert.ok(html.includes('Public miner'));
  }
  const plain = renderToStaticMarkup(React.createElement(AddressWithLabel, { address, linkable: false }));
  assert.ok(!plain.includes('<a'), 'non-linkable addresses stay non-interactive');
});
