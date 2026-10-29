'use strict';
// Draft checks that compare AI-written SQL with the question it answers.
// Observed on staging: an Orchard question was answered from all shielded
// transactions, and a "last 7 days" window ended after today.
const POOLS = ['orchard', 'ironwood', 'sapling', 'sprout'];
const POOL_SOURCES = {
  orchard: 'count(*) FILTER (WHERE orchard) on transactions, daily.orchard for pool balances, or flows/flow_daily with pool = \'orchard\'',
  ironwood: 'count(*) FILTER (WHERE ironwood) on transactions, daily.ironwood for pool balances, or flows/flow_daily with pool = \'ironwood\'',
  sapling: 'count(*) FILTER (WHERE sapling) on transactions, daily.sapling for pool balances, or flows/flow_daily with pool = \'sapling\'',
  sprout: 'daily.sprout for pool balances',
};

function words(node, out = new Set()) {
  if (!node || typeof node !== 'object') return out;
  if (Array.isArray(node)) { for (const item of node) words(item, out); return out; }
  if (node.ColumnRef) for (const field of node.ColumnRef.fields || []) if (field.String) out.add(field.String.sval.toLowerCase());
  if (node.A_Const?.sval) out.add(String(node.A_Const.sval.sval).toLowerCase());
  for (const value of Object.values(node)) words(value, out);
  return out;
}
function literals(node, out = []) {
  if (!node || typeof node !== 'object') return out;
  if (Array.isArray(node)) { for (const item of node) literals(item, out); return out; }
  if (typeof node.A_Const?.sval?.sval === 'string') out.push(node.A_Const.sval.sval);
  for (const value of Object.values(node)) literals(value, out);
  return out;
}

// A question that names a pool must be answered from that pool's data.
function poolQuestionDiagnostics(tree, question) {
  const asked = POOLS.filter(pool => new RegExp(`\\b${pool}\\b`, 'i').test(question || ''));
  if (!asked.length) return [];
  const used = [...words(tree.stmts?.[0]?.stmt)];
  return asked.filter(pool => !used.some(word => word.includes(pool))).map(pool => `The question asks about ${pool[0].toUpperCase() + pool.slice(1)}, but the query never uses ${pool} data. activity_daily has no per-pool counts. Use ${POOL_SOURCES[pool]}, bounded by the requested dates; do not substitute all shielded activity.`);
}

// "Last N days" ends at today's UTC midnight; only questions about today or a
// current calendar period ("this month") may reach past it. Open-ended year or
// month bounds in other questions are harmless and left alone.
const RECENT = /\b(?:last|past|previous|prior)\s+(?:\d+|one|two|three|four|five|six|seven|ten|fourteen|thirty|ninety)?\s*(?:days?|weeks?)\b/i;
const CURRENT = /\b(?:today|tonight|so far|right now|currently|current (?:day|week|month|year)|this (?:day|week|month|quarter|year)|year[- ]to[- ]date|month[- ]to[- ]date|ytd)\b/i;
function futureWindowDiagnostics(tree, question, now = new Date()) {
  if (!RECENT.test(question || '') || CURRENT.test(question || '')) return [];
  const today = now.toISOString().slice(0, 10);
  const late = literals(tree.stmts?.[0]?.stmt).map(text => /^(\d{4}-\d{2}-\d{2})/.exec(text.trim())?.[1]).filter(date => date && date > today);
  return late.length ? [`The time window ends on ${late.sort().at(-1)}, after today (${today}). "Last N days" means the N most recent completed UTC days: timestamp >= today minus N days AND timestamp < today at 00:00 UTC. Do not include today's partial day unless the question asks about today.`] : [];
}

module.exports = { poolQuestionDiagnostics, futureWindowDiagnostics };
