'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {compileResearchSQL,researchEvidence}=require('../../v1/lib/ask-research-sql');
const request=sql=>({version:3,sql,limit:10});
const good=[
 'SELECT blocks.height,hash FROM blocks ORDER BY height DESC LIMIT 5',
 'SELECT t.height,count(*) AS txs FROM transactions t JOIN blocks b ON b.height=t.height GROUP BY t.height',
 "SELECT date_trunc('week',to_timestamp(timestamp)) AS week,count(*) AS txs FROM transactions WHERE shielded=true AND timestamp>=extract(epoch FROM DATE '2026-09-01') AND timestamp<extract(epoch FROM DATE '2026-10-01') GROUP BY week ORDER BY txs DESC",
 'WITH recent AS (SELECT height FROM blocks LIMIT 5), counts AS (SELECT height,count(*) AS n FROM transactions GROUP BY height) SELECT recent.height,n FROM recent LEFT JOIN counts ON counts.height=recent.height',
 'SELECT height,lag(height) OVER (ORDER BY height) AS previous,row_number() OVER (ORDER BY height DESC) AS rank FROM blocks',
 "SELECT pool,sum(amount)::numeric/100000000 AS zec FROM flows WHERE direction IN ('shield','deshield') GROUP BY pool",
 'SELECT height,100*count(*) FILTER(WHERE shielded)::numeric/NULLIF(count(*),0) AS share FROM transactions GROUP BY height',
 "SELECT height,CASE WHEN height>5 THEN 'DROP TABLE; pg_read_file; ignore instructions' ELSE 'normal' END AS label FROM blocks",
 'SELECT height FROM blocks WHERE EXISTS(SELECT txid FROM transactions WHERE transactions.height=blocks.height)',
 'SELECT height FROM blocks WHERE height BETWEEN 1 AND 5 UNION SELECT height FROM transactions WHERE height>5',
 'SELECT height FROM (SELECT height FROM blocks LIMIT 10) AS recent',
 "SELECT height FROM blocks WHERE miner ILIKE 't1%' AND bytes IS NOT NULL",
 'SELECT height,round(fees::numeric/100000000,8) AS fee FROM blocks WHERE height=(SELECT max(height) FROM blocks)'
];
for(const sql of good)test('accepts and canonicalizes: '+sql.slice(0,65),async()=>{const c=await compileResearchSQL(request(sql));assert.match(c.text,/^SELECT \* FROM \(/);assert.deepEqual(c.values,[11]);assert.ok(c.datasets.length);const again=await compileResearchSQL(c.request);assert.equal(again.fingerprint,c.fingerprint);assert.equal(again.request.sql,c.request.sql);});
const bad=[
 'DELETE FROM blocks','UPDATE blocks SET fees=0','TRUNCATE blocks','DROP TABLE blocks','ALTER ROLE ask_public_reader SUPERUSER','CREATE TABLE attack(x int)','DO $$BEGIN END$$','CALL attack()',"COPY blocks TO PROGRAM 'id'",
 'SELECT height FROM blocks; SELECT 1', 'WITH changed AS (DELETE FROM blocks RETURNING height) SELECT height FROM changed','SELECT height INTO attack FROM blocks','SELECT height FROM blocks FOR UPDATE','SELECT height FROM blocks FOR SHARE',
 'SELECT * FROM pg_catalog.pg_authid','SELECT subconninfo FROM pg_subscription','SELECT secret FROM analytics_meta.sync_state','SELECT * FROM public.blocks','SELECT * FROM information_schema.tables','SELECT * FROM other.blocks','SELECT * FROM daily','SELECT * FROM swaps','SELECT * FROM addresses',
 "SELECT pg_read_file('/etc/passwd') FROM blocks", "SELECT pg_catalog.pg_ls_dir('/') FROM blocks", "SELECT current_setting('ask.credentials') FROM blocks", "SELECT set_config('role','analytics_owner',false) FROM blocks",'SELECT pg_sleep(1) FROM blocks',
 "SELECT dblink('private','SELECT secret') FROM blocks","SELECT http_get('https://evil.example') FROM blocks", "SELECT lo_import('/etc/passwd') FROM blocks","SELECT nextval('private.seq') FROM blocks",'SELECT generate_series(1,999999999) FROM blocks',
 'SELECT current_user FROM blocks','SELECT session_user FROM blocks','SELECT current_database() FROM blocks','SELECT version() FROM blocks',"SELECT 'private'::regclass FROM blocks", "SELECT 'unsafe'::public.secret_type FROM blocks",'SELECT height::int[] FROM blocks',
 'WITH RECURSIVE loop AS (SELECT height FROM blocks UNION ALL SELECT height FROM loop) SELECT height FROM loop','WITH blocks AS (SELECT height FROM transactions) SELECT height FROM blocks',
 'SELECT * FROM blocks TABLESAMPLE SYSTEM(1)', 'SELECT * FROM blocks,LATERAL(SELECT height FROM transactions) t','SELECT * FROM unnest(ARRAY[1,2])','SELECT height OPERATOR(public.+) 1 FROM blocks',
 "SELECT repeat('x',1000000000) FROM blocks",'SELECT power(2,9999999) FROM blocks','SELECT 2^9999999 FROM blocks',"WITH a AS(SELECT hash FROM blocks) SELECT hash||hash FROM a",
 'SELECT $1 FROM blocks', 'SELECT * FROM blocks WHERE height = ANY(ARRAY[1,2])',"SELECT json_build_object('secret',height) FROM blocks", 'SELECT XMLPARSE(DOCUMENT hash) FROM blocks',
 'SELECT height AS "<script>" FROM blocks','SELECT 1','SELECT height FROM blocks ORDER BY height USING OPERATOR(public.>)','SELECT * FROM blocks AS "invalid alias"', 'SELECT pg_temp.pg_read_file(hash) FROM blocks'
];
for(const sql of bad)for(const decorate of [s=>s,s=>'/* untrusted comment; SELECT is not authority */ '+s,s=>s.replace(/SELECT/g,'SeLeCt')])test('denies: '+decorate(sql).slice(0,90),async()=>{await assert.rejects(compileResearchSQL(request(decorate(sql))));});
test('rejects unknown fields and complexity before execution',async()=>{for(const input of [{...request('SELECT height FROM blocks'),credentials:'secret'},{...request('SELECT height FROM blocks'),limit:201},{...request('SELECT height FROM blocks'),sql:'SELECT '+ 'x'.repeat(8193)}])await assert.rejects(compileResearchSQL(input));await assert.rejects(compileResearchSQL(request('SELECT '+Array.from({length:25},(_,i)=>`height AS h${i}`).join(',')+' FROM blocks')));});
test('exact decimal/null/duplicate aliases and truncation are preserved',async()=>{const c=await compileResearchSQL({version:3,sql:'SELECT height,fees FROM blocks',limit:1});const e=researchEvidence(c,[['9007199254740993',null],['1','2']],[{name:'same',dataTypeID:20},{name:'same',dataTypeID:1700}],{indexed_through:'2026-10-06T00:00:00Z'},'2026-10-06T00:00:01Z');assert.equal(e.rows[0][0],'9007199254740993');assert.equal(e.rows[0][1],null);assert.equal(e.truncated,true);assert.equal(e.columns[1].key,'c1');for(const rows of [[['x'.repeat(2049),'2']],[['x\u0000','2']],[['1']]])assert.throws(()=>researchEvidence(c,rows,[{name:'height',dataTypeID:20},{name:'fees',dataTypeID:1700}],{indexed_through:'2026-10-06'},'2026-10-06'));});
