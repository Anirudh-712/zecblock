'use strict';

// Fixed public categories only. Never forward an upstream message or body.
const failures = {
  resource:{code:'ask-resource',status:422,type:'validation-error',detail:'This query exceeded the research disk or result-size budget. Filter each joined table to the requested period and aggregate before joining; your date range has not been changed.'},
  job:{code:'ask-job',status:404,type:'not-found',detail:'This research job is unavailable or has expired.'},
  interrupted:{code:'ask-interrupted',status:503,type:'upstream-error',detail:'Research was interrupted by a worker restart. Run the query again; it was not retried automatically.'},
  query:{code:'ask-query',status:400,type:'validation-error',detail:'This SQL cannot run. Check the catalogue, column names and supported SELECT syntax.'},
  verification: { code: 'ask-verification', status: 403, type: 'access-denied', detail: 'Verification expired or failed. Retry verification, then send your question again.' },
  source: { code: 'ask-source', status: 503, type: 'upstream-error', detail: 'The source data could not be read. Your analysis is still available; try again shortly.' },
  provider: { code: 'ask-provider', status: 503, type: 'upstream-error', detail: 'The AI provider is temporarily unavailable. Starter charts remain available.' },
  answer: { code: 'ask-answer', status: 503, type: 'upstream-error', detail: 'Ask could not validate the answer. Try a more specific question or open the source chart.' },
  timeout: { code: 'ask-timeout', status: 504, type: 'upstream-timeout', detail: 'The request took too long. Review the query bounds and filters on each joined table, then run it again. The requested period has not been changed.' },
  quota: { code: 'ask-quota', status: 429, type: 'rate-limited', detail: 'Ask has reached its allowance. Please try later; starter charts remain available.' },
  unavailable: { code: 'ask-unavailable', status: 503, type: 'upstream-error', detail: 'Ask is temporarily unavailable. Starter charts remain available.' },
};
function askError(kind) { const error = new Error('Ask operation failed'); error.askKind = kind; return error; }
function classifyFailure(error) {
  const kind = error?.quota ? 'quota' : ['TimeoutError', 'AbortError'].includes(error?.name) ? 'timeout' : Object.hasOwn(failures, error?.askKind) ? error.askKind : 'unavailable';
  return failures[kind];
}
async function askStage(kind, operation) {
  try { return await operation(); } catch (error) {
    if (error?.quota || error?.askKind || ['TimeoutError', 'AbortError'].includes(error?.name)) throw error;
    throw askError(kind);
  }
}
module.exports = { askError, askStage, classifyFailure };
