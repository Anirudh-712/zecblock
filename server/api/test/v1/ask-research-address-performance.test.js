'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {parse}=require('pgsql-parser');
const {compileResearchSQL}=require('../../v1/lib/ask-research-sql');
const {addressDistinctDiagnostics}=require('../../v1/lib/ask-research-address-performance');
const sql="WITH bounded_activity AS(SELECT address,txid,timestamp FROM address_activity WHERE timestamp>=EXTRACT(EPOCH FROM TIMESTAMPTZ '2026-09-01 00:00:00+00')::bigint AND timestamp<EXTRACT(EPOCH FROM TIMESTAMPTZ '2026-10-01 00:00:00+00')::bigint),daily_counts AS(SELECT to_char(to_timestamp(timestamp),'YYYY-MM-DD') AS utc_date,count(DISTINCT address) AS distinct_active_transparent_addresses,count(*) AS address_transaction_incidences FROM bounded_activity GROUP BY 1) SELECT *,max(address_transaction_incidences) OVER() AS most_daily_incidences FROM daily_counts ORDER BY utc_date";
async function diagnose(statement){const compiled=await compileResearchSQL({version:3,sql:statement,limit:100},{extended:true});return {compiled,issues:addressDistinctDiagnostics(await parse(compiled.request.sql))};}
test('bounded month-wide DISTINCT daily address draft gets a per-day range-scan hint without changing SQL',async()=>{const {compiled,issues}=await diagnose(sql);assert.equal(issues.length,1);assert.match(issues[0],/correlated per-day COUNT\(DISTINCT a.address\) and COUNT\(\*\)/);assert.match(issues[0],/complete requested month/);assert.match(issues[0],/coinbase/);assert.match(issues[0],/Do not shorten/);assert.match(compiled.request.sql,/count\(DISTINCT address\)/i);});
test('source aliases and equivalent UTC numeric bounds preserve only the proven raw incidence shape',async()=>{
 const renamed="WITH raw(d,a) AS(SELECT timestamp,address FROM address_activity WHERE timestamp>=1788220800 AND timestamp<1790812800) SELECT date_trunc('day',to_timestamp(d)) AS day,count(DISTINCT a) AS distinct_addresses,count(*) AS incidences FROM raw GROUP BY 1";
 assert.equal((await diagnose(renamed)).issues.length,1);
 assert.equal((await diagnose(sql.replace("GROUP BY 1)","GROUP BY utc_date)"))).issues.length,1);
});
test('the efficient fixed per-day reference remains accepted without a repair diagnostic',async()=>{const {cases}=require('../../v1/lib/ask-research-eval-cases');const ref=cases.find(c=>c.id==='daily_address_incidences').referenceSQL;assert.deepEqual((await diagnose(ref)).issues,[]);});
test('one-day, custom-grain and unresolved source queries remain queryable without this hint',async()=>{
 const rejected=[sql.replace("2026-10-01 00:00:00+00","2026-09-02 00:00:00+00"),sql.replace("count(DISTINCT address)","count(address)"),sql.replace("count(*) AS address_transaction_incidences","count(txid) AS address_transaction_incidences"),sql.replace("SELECT address,txid,timestamp FROM address_activity", "SELECT address,txid,timestamp FROM address_activity WHERE is_input IS TRUE").replace("WHERE timestamp>=","AND timestamp>="),sql.replace("SELECT address,txid,timestamp FROM address_activity WHERE", "SELECT address,txid,timestamp FROM address_activity WHERE").replace("::bigint),daily_counts", "::bigint LIMIT 100),daily_counts"),sql.replace("count(DISTINCT address)","count(DISTINCT txid)"),sql.replace("'YYYY-MM-DD'","'YYYY-MM'")];
 for(const statement of rejected){const {compiled,issues}=await diagnose(statement);assert.deepEqual(issues,[],statement);assert.ok(compiled.request.sql);}
});
test('CTE shadowing, joined sources and preaggregated inputs cannot acquire raw address lineage',async()=>{
 const examples=["WITH address_activity AS(SELECT address,last_seen AS timestamp FROM addresses) SELECT to_char(to_timestamp(timestamp),'YYYY-MM-DD') AS day,count(DISTINCT address),count(*) FROM address_activity WHERE timestamp>=1788220800 AND timestamp<1790812800 GROUP BY 1", "SELECT to_char(to_timestamp(a.timestamp),'YYYY-MM-DD') AS day,count(DISTINCT a.address),count(*) FROM address_activity a JOIN transactions t ON t.txid=a.txid WHERE a.timestamp>=1788220800 AND a.timestamp<1790812800 GROUP BY 1", "WITH input AS(SELECT address,min(timestamp) AS timestamp FROM address_activity WHERE timestamp>=1788220800 AND timestamp<1790812800 GROUP BY address) SELECT to_char(to_timestamp(timestamp),'YYYY-MM-DD') AS day,count(DISTINCT address),count(*) FROM input GROUP BY 1"];
 // Reserved-name shadowing is already rejected by the compiler. The helper
 // itself must also fail to attribute a fabricated source to raw incidences.
 assert.deepEqual(addressDistinctDiagnostics(await parse(examples[0])),[]);
 for(const statement of examples.slice(1))assert.deepEqual((await diagnose(statement)).issues,[]);
});
