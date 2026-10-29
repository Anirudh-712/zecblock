const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { registerNetworkAnalyticsRoutes } = require('../api/routes/network-analytics');

const blocks = (length = 200) => Array.from({ length }, (_, i) => ({
  height: 1000 - i, timestamp: 1800000000 - i * 75,
  difficulty: 100, transaction_count: 5, total_fees: 100000,
}));

async function metrics(rows, query = {}) {
  const routes = new Map();
  registerNetworkAnalyticsRoutes({ get: (path, handler) => routes.set(path, handler) });
  let body, fetched;
  const req = { query, app: { locals: { pool: { async query(_sql, [limit]) {
    fetched = limit;
    return { rows: rows.slice(0, limit) };
  } } } } };
  const res = { json(value) { body = value; }, status() { assert.fail('Request must succeed'); } };
  await routes.get('/api/network/mining-metrics')(req, res);
  return { body, fetched };
}

test('all displayed mining points have complete averages using offscreen predecessors', async () => {
  for (const window of [5, 20, 100]) {
    const { body, fetched } = await metrics(blocks(700), { window, limit: 120 });
    assert.equal(fetched, 120 + window);
    assert.equal(body.points.length, 120);
    assert.equal(body.points[0].height, 881);
    assert.equal(body.points.at(-1).height, 1000);
    for (const p of body.points) {
      assert.equal(p.blockTime, 75);
      assert.ok(Math.abs(p.solrate - 100 * 8192 / 75) < 1e-8);
      assert.equal(p.difficulty, 100);
      assert.equal(p.txCount, 5);
      assert.ok(Math.abs(p.txFees - 0.001) < 1e-12);
    }
  }
});

test('missing heights preserve timing gaps and recover once the gap leaves the window', async () => {
  const rows = blocks().filter(b => b.height !== 950);
  const { body } = await metrics(rows);
  for (const p of body.points.filter(p => p.height >= 951 && p.height <= 970)) {
    assert.equal(p.solrate, null);
    assert.equal(p.blockTime, null);
  }
  assert.equal(body.points.find(p => p.height === 971).blockTime, 75);
});

test('equal or backwards individual timestamps retain positive complete-window solrate', async () => {
  for (const delta of [0, -5]) {
    const rows = blocks();
    rows[0].timestamp = rows[1].timestamp + delta;
    const { body } = await metrics(rows);
    assert.equal(body.solrateMethod, 'difficulty-work-over-elapsed-v1');
    assert.ok(Math.abs(body.latest.solrate - 20 * 100 * 8192 / (19 * 75 + delta)) < 1e-8);
    assert.equal(body.points.at(-1).solrate, body.latest.solrate);
    assert.equal(body.latest.blockTime, (19 * 75 + delta) / 20);
  }
});

test('solrate divides all contributing work by elapsed time rather than averaging instantaneous rates', async () => {
  const rows = blocks(6);
  const intervals = [5, 10, 20, 40, 80];
  const difficulties = [2, 3, 5, 7, 11];
  const chronological = rows.slice().reverse();
  chronological[0].difficulty = 1_000_000;
  for (let i = 1; i < chronological.length; i++) {
    chronological[i].timestamp = chronological[i - 1].timestamp + intervals[i - 1];
    chronological[i].difficulty = difficulties[i - 1];
  }
  const { body } = await metrics(rows, { window: 5 });
  assert.equal(body.latest.solrate, difficulties.reduce((a, b) => a + b, 0) * 8192 / 155);
  assert.equal(body.latest.blockTime, 31);
  assert.equal(body.latest.difficulty, 28 / 5, 'predecessor difficulty is outside the numerator');
});

test('nonpositive complete-window elapsed time remains unavailable for solrate', async () => {
  for (const elapsed of [0, -5]) {
    const rows = blocks(21);
    rows[0].timestamp = rows[20].timestamp + elapsed;
    const { body } = await metrics(rows);
    assert.equal(body.latest.solrate, null);
    assert.equal(body.latest.blockTime, elapsed / 20, 'signed block-time diagnostic is unchanged');
  }
});

test('unknown timestamps and invalid difficulty never become zero work or a complete timing window', async () => {
  for (const invalid of [null, undefined, '', ' ', 'bad', '100bad', NaN, Infinity, true]) {
    const rows = blocks(21);
    rows[10].timestamp = invalid;
    let { body } = await metrics(rows);
    assert.equal(body.latest.solrate, null);
    assert.equal(body.latest.blockTime, null);
    rows[10].timestamp = blocks(21)[10].timestamp;
    rows[10].difficulty = invalid;
    ({ body } = await metrics(rows));
    assert.equal(body.latest.solrate, null);
    assert.equal(body.latest.difficulty, null);
    assert.equal(body.latest.blockTime, 75);
  }
  for (const difficulty of [0, -1]) {
    const rows = blocks(21);
    rows[10].difficulty = difficulty;
    assert.equal((await metrics(rows)).body.latest.solrate, null);
  }
});

test('captured testnet equal-timestamp blocks have complete positive windows and no artificial solrate gap', async () => {
  const fixture = JSON.parse(fs.readFileSync('server/tests/fixtures/mining-metrics-testnet-header-window.json', 'utf8'));
  const { body } = await metrics(fixture.rows, { window: 20, limit: fixture.rows.length - 20 });
  const chronological = fixture.rows.slice().reverse();
  assert.equal(chronological.find(r => r.height === 4507966).timestamp, 1792146633);
  assert.equal(chronological.find(r => r.height === 4507967).timestamp, 1792146633);
  assert.equal(body.points.length, fixture.rows.length - 20);
  assert.ok(body.points.every(point => point.solrate > 0));
  for (const point of body.points) {
    const index = chronological.findIndex(r => r.height === point.height);
    const span = chronological[index].timestamp - chronological[index - 20].timestamp;
    const difficulty = chronological.slice(index - 19, index + 1).reduce((sum, row) => sum + Number(row.difficulty), 0);
    assert.ok(Math.abs(point.solrate - difficulty * 8192 / span) < 1e-7);
  }
  assert.ok(body.points.filter(p => p.height >= 4507967 && p.height <= 4507986).every(p => p.solrate > 0));
});

test('insufficient history and empty data do not invent full-window averages', async () => {
  for (const rows of [[], blocks(4)]) {
    const { body } = await metrics(rows);
    for (const value of Object.values(body.latest)) assert.equal(value, null);
    for (const p of body.points) assert.equal(p.difficulty, null);
  }
  const { body } = await metrics(blocks(21));
  assert.equal(body.latest.blockTime, 75);
  assert.equal(body.points[0].blockTime, null);
});
