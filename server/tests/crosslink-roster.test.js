const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { once } = require('node:events');
const fixture = require('./fixtures/crosslink-v14-roster-recency.json');
const { buildCrosslinkRoster, crosslinkLiveness } = require('../lib/crosslink-roster');
const { attachLocals } = require('../api/routes/crosslink/_helpers');
const statsRouter = require('../api/routes/crosslink/stats');
const createV1Router = require('../api/v1');

const reverse = key => Buffer.from(key, 'hex').reverse().toString('hex');
const clone = value => structuredClone(value);
const observedNow = fixture.recency.now_utc;
const roster = () => buildCrosslinkRoster(fixture.roster);
const observe = (snapshot = fixture.recency, options = {}) => crosslinkLiveness(roster(), snapshot, { nowSeconds: observedNow, ...options });

test('captured v14 RPC shapes distinguish 25 candidates from the 12 voting slots and normalize PubKeyID byte order', () => {
  const data = roster();
  assert.equal(data.candidateCount, 25);
  assert.equal(data.finalizerCount, 12);
  assert.equal(data.totalStakeZats, 21581068957470, 'all-candidate delegated stake retains its existing meaning');
  assert.equal(data.activeStakeZats, 21164549995515);
  const active = data.roster.filter(member => member.votingEligible);
  assert.deepEqual(active.map(member => member.identity).sort(), fixture.recency.finalizer_statuses.map(([key]) => reverse(key)).sort());
  assert.equal(fixture.recency.finalizer_statuses.some(([key]) => data.roster.some(member => member.identity === key)), false);
  const result = crosslinkLiveness(data, fixture.recency, { nowSeconds: observedNow });
  assert.equal(result.available, true);
  assert.equal(result.connectedCount, 12);
  assert.equal(result.connectedPercent, 100);
  assert.equal(result.onlineCount, 0, 'no vote at the sampled BFT height is an observation, not an offline claim');
  assert.ok(data.roster.filter(member => !member.votingEligible).every(member => member.connected === null && member.voted === null));
});

test('eligibility tie-breaks equal stakes by descending raw public-key bytes exactly as Tenderlink does', () => {
  const data = buildCrosslinkRoster(Array.from({ length: 14 }, (_, i) => ({
    pub_key: (i + 1).toString(16).padStart(64, '0'), voting_power: 100,
  })).reverse());
  assert.deepEqual(data.roster.filter(member => member.votingEligible).map(member => Number.parseInt(member.identity, 16)), [14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3]);
});

test('vote/packet observations join normalized identities despite array reordering, and use active stake as denominator', () => {
  const snapshot = clone(fixture.recency);
  const key = roster().roster[0].identity;
  const entry = snapshot.finalizer_statuses.find(([identity]) => reverse(identity) === key);
  entry[1].no_yes_votes_in_my_height = [[1, 0], [0, 0]]; // nil prevote is still a vote
  for (const status of snapshot.finalizer_statuses) status[1].last_direct_connection_utc = null;
  entry[1].last_direct_connection_utc = snapshot.now_utc - 299;
  snapshot.finalizer_statuses.reverse();
  const data = roster();
  const result = crosslinkLiveness(data, snapshot, { nowSeconds: observedNow });
  assert.equal(result.available, true);
  assert.equal(result.onlineCount, 1);
  assert.equal(result.connectedCount, 1);
  const member = data.roster.find(member => member.identity === key);
  assert.equal(member.voted, true);
  assert.equal(result.onlinePercent, Math.round(member.stake_zats / data.activeStakeZats * 100));
  assert.equal(result.connectedPercent, result.onlinePercent);
  entry[1].last_direct_connection_utc = snapshot.now_utc - 300;
  assert.equal(observe(snapshot).connectedCount, 0, 'the five-minute packet window is half-open');
});

test('missing, stale, future, invalid and round-transition snapshots never fabricate liveness totals', () => {
  const cases = [
    [null, 'recency-unavailable'],
    [{ ...fixture.recency, now_utc: observedNow - 61 }, 'stale-recency-snapshot'],
    [{ ...fixture.recency, now_utc: observedNow + 6 }, 'stale-recency-snapshot'],
    [{ ...fixture.recency, my_height: null }, 'invalid-recency-snapshot'],
    [{ ...fixture.recency, finalizer_statuses: fixture.recency.finalizer_statuses.slice(1) }, 'roster-recency-mismatch'],
  ];
  const changed = clone(fixture.recency);
  changed.finalizer_statuses[0][0] = 'ff'.repeat(32);
  cases.push([changed, 'roster-recency-mismatch']);
  const union = clone(fixture.recency);
  union.finalizer_statuses.push(['ff'.repeat(32), clone(union.finalizer_statuses[0][1])]);
  cases.push([union, 'roster-recency-mismatch']);
  const duplicate = clone(fixture.recency);
  duplicate.finalizer_statuses[0] = clone(duplicate.finalizer_statuses[1]);
  cases.push([duplicate, 'invalid-recency-snapshot']);
  const malformed = clone(fixture.recency);
  malformed.finalizer_statuses[0][1].no_yes_votes_in_my_height = [[-1, 0], [0, 0]];
  cases.push([malformed, 'invalid-recency-snapshot']);
  for (const [snapshot, reason] of cases) {
    const data = roster();
    const result = crosslinkLiveness(data, snapshot, { nowSeconds: observedNow });
    assert.equal(result.available, false);
    assert.equal(result.unavailableReason, reason);
    for (const field of ['onlineCount', 'offlineCount', 'onlineStakeZec', 'offlineStakeZec', 'onlinePercent', 'connectedCount', 'connectedStakeZec', 'connectedPercent']) assert.equal(result[field], null);
    assert.ok(data.roster.every(member => member.voted === null && member.connected === null));
  }
  assert.equal(observe(fixture.recency, { active: false }).unavailableReason, 'crosslink-not-active');
});

test('invalid/missing roster and unsafe amounts cannot become empty or zero-stake success data', () => {
  for (const data of [null, {}, [{ pub_key: 'bad', voting_power: 1 }], [{ ...fixture.roster[0], voting_power: null }], [{ ...fixture.roster[0], voting_power: Number.MAX_SAFE_INTEGER + 1 }], [fixture.roster[0], fixture.roster[0]]]) {
    assert.equal(buildCrosslinkRoster(data), null);
  }
  assert.equal(buildCrosslinkRoster([]).candidateCount, 0);
});

test('accepted integer timestamp strings normalize to numbers and zero stake never invents a percentage', () => {
  const snapshot = clone(fixture.recency);
  for (const [, status] of snapshot.finalizer_statuses) status.last_direct_connection_utc = String(observedNow);
  const data = buildCrosslinkRoster(fixture.roster.map(member => ({ ...member, voting_power: 0 })));
  // Equal-stake sorting changes the eligible set, so select recency keys for
  // that actual capped roster rather than reusing a different epoch's keys.
  snapshot.finalizer_statuses = data.roster.filter(member => member.votingEligible).map(member => [reverse(member.identity), clone(snapshot.finalizer_statuses[0][1])]);
  const result = crosslinkLiveness(data, snapshot, { nowSeconds: observedNow });
  assert.equal(result.available, true);
  assert.equal(result.onlinePercent, null);
  assert.equal(result.connectedPercent, null);
  assert.ok(data.roster.filter(member => member.votingEligible).every(member => member.last_connected_utc === observedNow));
});

test('legacy and actual v1 passthrough preserve corrected counts, null availability and missing-roster HTTP status', async t => {
  let snapshot = clone(fixture.recency);
  snapshot.now_utc = Math.floor(Date.now() / 1000);
  for (const [, status] of snapshot.finalizer_statuses) status.last_direct_connection_utc = snapshot.now_utc;
  let nativeRoster = fixture.roster;
  const source = express();
  source.locals.callZebraRPC = async method => ({
    getblockcount: 53000,
    get_tfl_final_block_height_and_hash: { height: 52992 },
    get_tfl_roster_zats: nativeRoster,
    getpeerinfo: [],
    get_tfl_recency_status: snapshot,
  })[method];
  source.use(attachLocals, statsRouter);
  const upstream = source.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  const router = createV1Router({ API_V1_ENABLED: 'true', API_V1_LAUNCHED: 'true', NEXT_PUBLIC_NETWORK: 'crosslink-testnet', V1_INTERNAL_SERVICE_KEY: '', V1_INTERNAL_API_BASE_URL: `http://127.0.0.1:${upstream.address().port}` });
  const app = express(); app.use('/v1', router);
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => {
    router.__stopRateLimiters?.();
    server.closeAllConnections(); upstream.closeAllConnections();
    await Promise.all([server, upstream].map(s => new Promise(resolve => s.close(resolve))));
  });
  const legacyUrl = `http://127.0.0.1:${upstream.address().port}/api/crosslink`;
  const v1Url = `http://127.0.0.1:${server.address().port}/v1/crosslink`;
  for (const url of [legacyUrl, v1Url]) {
    let response = await fetch(url);
    assert.equal(response.status, 200);
    let body = await response.json(); if (url === v1Url) body = body.data;
    assert.equal(body.finalizerCount, 12);
    assert.equal(body.candidateCount, 25);
    assert.equal(body.liveness.available, true);
    snapshot = null;
    response = await fetch(url); assert.equal(response.status, 200);
    body = await response.json(); if (url === v1Url) body = body.data;
    assert.equal(body.liveness.available, false);
    assert.equal(body.liveness.onlinePercent, null);
    snapshot = { ...clone(fixture.recency), now_utc: Math.floor(Date.now() / 1000) };
  }
  nativeRoster = null;
  for (const url of [legacyUrl, v1Url]) {
    const responses = await Promise.all([fetch(url), fetch(url)]);
    for (const response of responses) {
      assert.equal(response.status, 503);
      assert.equal((await response.json())._status, undefined);
    }
  }
});
