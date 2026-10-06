'use strict';
// Standalone read-only worker. Intentionally no dotenv, primary pool, RPC,
// provider, legacy routes, file/shell tools or process execution imports.
const express = require('express');
const { timingSafeEqual } = require('node:crypto');
const { createClient } = require('redis');
const { createAnalytics } = require('./v1/lib/ask-analytics');
const { compilePlan } = require('./v1/lib/ask-analytics-plan');
const {compileResearchSQL}=require('./v1/lib/ask-research-sql');

function createWorker(env, { analytics, redis } = {}) {
  if (!env.ASK_ANALYTICS_SERVICE_KEY || env.ASK_ANALYTICS_SERVICE_KEY.length < 32 || !analytics || !redis) throw new Error('Analytics worker not configured');
  const app = express(); app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.set('Cache-Control', 'private, no-store');
    const supplied = Buffer.from(req.headers.authorization || '');
    const expected = Buffer.from(`Bearer ${env.ASK_ANALYTICS_SERVICE_KEY}`);
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return res.status(401).json({ error:'unauthorized' });
    next();
  });
  app.post('/query', express.json({ limit:'12kb' }), async (req, res) => {
    try { if(req.body?.version===3){if(env.ASK_RESEARCH_ENABLED!=='true'||env.ASK_ANALYTICS_STORE!=='logical_public_core')throw Error('Research is disabled');await compileResearchSQL(req.body,{extended:env.ASK_RESEARCH_EXTENDED==='true'});}else compilePlan(req.body,undefined,env.ASK_ANALYTICS_STORE); } catch { return res.status(400).json({error:'invalid-plan'}); }
    const controller = new AbortController();
    const abort = () => { if (!res.writableEnded) controller.abort(); };
    res.once('close', abort);
    try {
      const evidence = await analytics.execute(req.body, {redis, signal:controller.signal});
      if (!controller.signal.aborted && req.body.version===3)return res.json({research:evidence.result});
      if (!controller.signal.aborted) res.json({ rows: evidence.result.plan.version === 2 ? evidence.result.rows.map(row => Object.fromEntries(Object.entries(row).flatMap(([key,cell]) => [[key,cell.value], ...(/^m[0-3]$/.test(key) ? [['u'+key.slice(1),String(cell.missing)]] : [])]))) : evidence.result.rows.map(row => ({bucket:row.date,value:row.value,observed_days:row.observedDays,observed_through:row.observedThrough})), consistency:env.ASK_ANALYTICS_STORE==='logical_public_core'?'verified-canonical-core':null, observedDays:evidence.result.coverage.observedDays, indexedThrough:evidence.result.coverage.indexedThrough, retrievedAt:evidence.result.retrievedAt });
    } catch (error) {
      if (!controller.signal.aborted) res.status(error?.quota?429:error?.code==='57014'?504:['42601','42703','42883','42804','22012','22003','42P01'].includes(error?.code)?400:503).json({error:error?.quota?'allowance':error?.code==='57014'?'timeout':['42601','42703','42883','42804','22012','22003','42P01'].includes(error?.code)?'invalid-query':'unavailable'});
    } finally { res.off('close', abort); }
  });
  app.use((req,res) => res.status(404).json({error:'not-found'}));
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((error,req,res,next) => res.status(error.type === 'entity.too.large' ? 413 : 400).json({error:'invalid-request'}));
  return app;
}
async function main() {
  const env = process.env;
  if (process.getuid?.() === 0) throw new Error('Analytics worker must run as a non-root account');
  const analytics = createAnalytics(env);
  if (!analytics || !env.ASK_ANALYTICS_REDIS_URL) throw new Error('Analytics worker not configured');
  const redis = createClient({ url:env.ASK_ANALYTICS_REDIS_URL }); redis.on('error', () => {});
  await redis.connect();
  const app = createWorker(env,{analytics,redis});
  const port = Number(env.ASK_ANALYTICS_PORT || 3015);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid analytics port');
  const server = app.listen(port,'127.0.0.1');
  server.requestTimeout = 15000; server.headersTimeout = 10000; server.maxConnections = 8;
  for (const signal of ['SIGINT','SIGTERM']) process.once(signal, () => {
    server.close(async () => { await Promise.allSettled([analytics.close(),redis.quit()]); });
    server.closeAllConnections();
  });
}
if (require.main === module) main().catch(() => { console.error('Analytics worker failed'); process.exitCode=1; });
module.exports = {createWorker};
