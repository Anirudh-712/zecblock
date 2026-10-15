const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { attachLocals } = require('../routes/crosslink/_helpers');

test('native byte-order keyed packet observations remain unknown when the node has no timestamp', async () => {
  const app = express();
  const now = Math.floor(Date.now() / 1000);
  const keys = ['01', '02', '03'].map(prefix => prefix + '00'.repeat(31));
  const reverse = key => Buffer.from(key, 'hex').reverse().toString('hex');
  const status = last => ({ last_direct_connection_utc: last, highest_round_vote: 0, no_yes_votes_in_my_height: [[0, 0], [0, 0]] });
  const rpc = {
    getblockcount: 53000,
    get_tfl_final_block_height_and_hash: { height: 52992 },
    getpeerinfo: [],
    get_tfl_roster_zats: keys.map((pub_key, index) => ({ pub_key, voting_power: 300000000 - index * 100000000 })),
    get_tfl_recency_status: { now_utc: now, my_height: 20, my_round: 0,
      finalizer_statuses: [
        [reverse(keys[2]), status(null)],
        [reverse(keys[0]), status(now - 10)],
        [reverse(keys[1]), status(now - 20)],
      ] },
  };
  app.locals.callZebraRPC = async method => rpc[method];
  app.use(attachLocals, require('../routes/crosslink/stats'));
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/crosslink`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.liveness.available, true);
    assert.equal(body.liveness.connectedCount, 2);
    assert.equal(body.roster[0].last_connected_utc, now - 10);
    assert.equal(body.roster[0].connected, true);
    assert.equal(body.roster[1].connected, true);
    assert.equal(body.roster[2].connected, null);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
