'use strict';
// Explicit opt-in, disposable local database only. No production URLs accepted.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Pool } = require('pg');
const { compilePlan } = require('../../v1/lib/ask-analytics-plan');
const { GUARD, createAnalytics } = require('../../v1/lib/ask-analytics');

test('real PostgreSQL least-privilege reader, injection boundary, coverage, snapshots and primary refusal', { skip: process.env.ASK_TEST_POSTGRES !== '1' }, async t => {
  const name = `ask_analytics_test_${process.pid}`;
  const admin = new Pool({ host:'/tmp', database:'postgres', max:1 });
  if (Number((await admin.query("SELECT count(*) FROM pg_roles WHERE rolname IN ('ask_analytics_reader','ask_analytics_owner')")).rows[0].count)) {
    await admin.end(); throw new Error('Test roles already exist; refusing to reuse or alter them');
  }
  await admin.query(`CREATE DATABASE ${name}`);
  const owner = new Pool({ host:'/tmp', database:name, max:1 }); let reader;
  t.after(async () => {
    await reader?.end(); await owner.end();
    await admin.query(`DROP DATABASE ${name}`);
    await admin.query('DROP ROLE IF EXISTS ask_analytics_reader, ask_analytics_owner'); await admin.end();
  });
  // PG14's PUBLIC schema CREATE default is intentionally revoked only in this
  // disposable database. The production script never changes shared defaults.
  await owner.query(`REVOKE CREATE ON SCHEMA public FROM PUBLIC;
    CREATE TABLE privacy_trends_daily(date date PRIMARY KEY, shielded_count bigint, transparent_count bigint, orchard_pool_size bigint, ironwood_pool_size bigint, sapling_pool_size bigint, sprout_pool_size bigint);
    CREATE TABLE private_fixture(secret text); INSERT INTO private_fixture VALUES ('confidential-fixture');
    INSERT INTO privacy_trends_daily SELECT '2026-09-01'::date+i, (i+1)*100, 50, 900000000000-i, 400000000000001+i, 0, 0 FROM generate_series(0,29) i;
    DELETE FROM privacy_trends_daily WHERE date='2026-09-04';`);
  await owner.query(fs.readFileSync(path.resolve(__dirname,'../../../deploy/ask-analytics/provision.sql'),'utf8'));
  reader = new Pool({ host:'/tmp', database:name, user:'ask_analytics_reader', max:1 });
  const guard = (await reader.query(GUARD)).rows[0];
  assert.equal(guard.standby, false);
  for (const key of ['identity','restricted','disk_bounded','no_memberships','no_create','only_public_view','no_sequences','no_definers']) assert.equal(guard[key], true, key);
  // Turn off the user-changeable session default to prove grants are a second
  // boundary, not merely the READ ONLY flag.
  for (const attack of [
    'DELETE FROM public.privacy_trends_daily', 'DELETE FROM ask_public.daily_v1', 'TRUNCATE public.private_fixture',
    'DROP VIEW ask_public.daily_v1', 'CREATE TABLE ask_public.attack(n int)', 'SELECT secret FROM public.private_fixture',
    "SELECT pg_read_file('/etc/passwd')", "COPY (SELECT 1) TO PROGRAM 'id'", 'SET ROLE ask_analytics_owner',
    'ALTER ROLE ask_analytics_reader SUPERUSER',
  ]) {
    const connection = await reader.connect();
    try {
      await connection.query('SET default_transaction_read_only=off');
      await assert.rejects(connection.query(attack), /permission|must be|not permitted/i, attack);
    } finally { connection.release(true); }
  }
  const input = {version:1,metric:'transactions',start:'2026-09-01',end:'2026-09-30',bucket:'week',order:'highest',limit:5};
  const compiled = compilePlan(input, Date.UTC(2026,9,2));
  const counts = (await reader.query(compiled.text, compiled.values)).rows;
  assert.equal(counts[0].bucket,'2026-09-21'); assert.equal(counts[0].value,'17150');
  const snapshots = compilePlan({...input,metric:'ironwood_balance'},Date.UTC(2026,9,2));
  const balances = (await reader.query(snapshots.text,snapshots.values)).rows;
  assert.equal(balances[0].value,'400000000000030'); assert.equal(balances[0].observed_through,'2026-09-30'); assert.equal(balances[0].observed_days,3);
  assert.equal((await reader.query('SELECT count(*) FROM ask_public.daily_v1')).rows[0].count,'29');
  const service = createAnalytics({ASK_ANALYTICS_ENABLED:'true',ASK_ANALYTICS_DATABASE_URL:`postgres://ask_analytics_reader@localhost/${name}`,ASK_ANALYTICS_DAILY_QUERY_LIMIT:'100'},{pool:reader});
  await assert.rejects(service.execute(input,{redis:{isReady:true,eval:async()=>1,zRem:async()=>{}},now:Date.UTC(2026,9,2)}),error=>error.askKind==='source');
  // Effective PUBLIC and column-level leaks must be detected too.
  await owner.query('GRANT SELECT ON private_fixture TO PUBLIC');
  assert.equal((await reader.query(GUARD)).rows[0].only_public_view,false);
  await owner.query('REVOKE SELECT ON private_fixture FROM PUBLIC; GRANT UPDATE(secret) ON private_fixture TO ask_analytics_reader');
  assert.equal((await reader.query(GUARD)).rows[0].only_public_view,false);
  await owner.query('REVOKE UPDATE(secret) ON private_fixture FROM ask_analytics_reader');
  await owner.query("CREATE FUNCTION public.unsafe_fixture() RETURNS text LANGUAGE sql SECURITY DEFINER AS 'SELECT secret FROM public.private_fixture'");
  assert.equal((await reader.query(GUARD)).rows[0].no_definers,false);
});
