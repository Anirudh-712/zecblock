'use strict';
const { compilePlan } = require('./ask-analytics-plan');
const { evidenceFor } = require('./ask-analytics');
const { catalogue } = require('./ask-query-plan');
const { coreCatalogue } = require('./ask-core-catalogue');
const { askError } = require('./ask-errors');

function createAnalyticsClient(env, fetchImpl = fetch) {
  if (env.ASK_ANALYTICS_ENABLED !== 'true' || !env.ASK_ANALYTICS_SERVICE_KEY || env.ASK_ANALYTICS_SERVICE_KEY.length < 32) return null;
  let url;
  try {
    url = new URL(env.ASK_ANALYTICS_SERVICE_URL);
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.pathname !== '/' || url.search || url.hash || url.username || url.password) return null;
  } catch { return null; }
  return {
    catalogue:env.ASK_ANALYTICS_STORE==='logical_public_core'?coreCatalogue:catalogue,
    close: async () => {},
    async execute(input, { signal } = {}) {
      const compiled = compilePlan(input,undefined,env.ASK_ANALYTICS_STORE);
      const response = await fetchImpl(new URL('/query', url), { method: 'POST', redirect: 'error',
        signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(12000)]),
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.ASK_ANALYTICS_SERVICE_KEY}` }, body: JSON.stringify(compiled.plan) });
      if (!response.ok) {
        await response.body?.cancel();
        if (response.status === 429) { const error = askError('quota'); error.quota = true; throw error; }
        throw askError('source');
      }
      const reader = response.body.getReader(); const chunks = []; let bytes = 0;
      try {
        while (true) { const { done, value } = await reader.read(); if (done) break;
          bytes += value.length; if (bytes > 65536) throw askError('source'); chunks.push(Buffer.from(value)); }
      } finally { await reader.cancel(); }
      const wire = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!Array.isArray(wire.rows) || typeof wire.retrievedAt !== 'string' || !Number.isFinite(Date.parse(wire.retrievedAt))) throw askError('source');
      if(env.ASK_ANALYTICS_STORE==='logical_public_core' && wire.consistency!=='verified-canonical-core')throw askError('source');
      // Recompute facts locally; never trust worker-supplied narrative or facts.
      return evidenceFor(compiled, wire.rows, { observed_days: wire.observedDays, indexed_through: wire.indexedThrough, consistency:env.ASK_ANALYTICS_STORE==='logical_public_core'?wire.consistency:null }, new Date(wire.retrievedAt).toISOString());
    },
  };
}
module.exports = { createAnalyticsClient };
