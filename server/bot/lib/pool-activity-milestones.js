'use strict';

const { addDays, day } = require('../../lib/transaction-activity');
const { candidate } = require('./editorial-policy');
const f = require('./editorial-format');

const VOLUME_LEVELS = [100000, 250000, 500000, 1000000, 2000000, 5000000, 10000000];
const SHARE_LEVELS = [10, 25, 50, 75];
const PARITY_LEVELS = [90, 95, 100];
const METHODOLOGY = 'Canonical mainnet non-coinbase transactions, once per pool per transaction. Pool counts overlap; migrations are included. Rolling windows use complete UTC days. Lifetime Ironwood counts include the activation day. Counts measure activity, not users or payments.';

function validate(activity, target) {
  day(target);
  const activation = activity?.activation;
  if (activation?.height !== 3428143 || activation.date !== '2026-07-28'
    || !Number.isSafeInteger(activation.timestamp)
    || new Date(activation.timestamp * 1000).toISOString().slice(0, 10) !== activation.date) {
    throw new Error('Verified Ironwood activation is required');
  }
  const start = addDays(activation.date, -365);
  const days = activity.days;
  const length = (Date.parse(target) - Date.parse(start)) / 86400000 + 1;
  if (target < activation.date || activity.historyStart !== start || !Array.isArray(days)
    || days.length !== length) throw new Error('Incomplete pool activity history');
  for (let i = 0; i < days.length; i++) {
    const row = days[i];
    if (row.date !== addDays(start, i) || row.complete !== true) throw new Error('Incomplete pool activity day');
    for (const key of ['totalTransactions', 'orchard', 'ironwood']) {
      if (!Number.isSafeInteger(row[key]) || row[key] < 0) throw new Error('Invalid pool activity count');
    }
    if (row.orchard > row.totalTransactions || row.ironwood > row.totalTransactions) throw new Error('Invalid pool activity denominator');
    if (row.date < activation.date && row.ironwood !== 0) throw new Error('Ironwood activity predates activation');
  }
  return days;
}

function firstCrossingStories(activity, target) {
  const days = validate(activity, target);
  const prefixes = [{ ironwood: 0, orchard: 0, totalTransactions: 0 }];
  for (const row of days) {
    const sums = {};
    for (const key of ['ironwood', 'orchard', 'totalTransactions']) {
      sums[key] = prefixes.at(-1)[key] + row[key];
      if (!Number.isSafeInteger(sums[key])) throw new Error('Pool activity sum exceeds safe integer range');
    }
    prefixes.push(sums);
  }
  const sum = (endIndex, count) => Object.fromEntries(['ironwood', 'orchard', 'totalTransactions']
    .map(key => [key, prefixes[endIndex + 1][key] - prefixes[endIndex + 1 - count][key]]));
  const atLeast = (value, denominator, level) => denominator > 0
    && BigInt(value) * 100n >= BigInt(denominator) * BigInt(level);
  const seen = new Set();
  const achievements = [];
  const launchIndex = 365;
  for (let i = launchIndex; i < days.length; i++) {
    const date = days[i].date;
    const period = count => ({ start: addDays(date, 1 - count), endExclusive: addDays(date, 1) });
    const consider = (id, facts) => {
      if (!seen.has(id) && date === target) achievements.push({ id, ...facts });
      seen.add(id);
    };
    for (const periodDays of [7, 30]) {
      // The activation day is partial. Rate windows start on the next UTC day.
      if (i - launchIndex < periodDays) continue;
      const totals = sum(i, periodDays);
      if (totals.ironwood > totals.orchard) consider(`leadership:${periodDays}`, {
        kind: 'leadership', periodDays, ...totals, period: period(periodDays),
      });
      if (periodDays === 7) for (const level of SHARE_LEVELS) {
        if (atLeast(totals.ironwood, totals.totalTransactions, level)) consider(`share:7:${level}`, {
          kind: 'share', periodDays: 7, level, ...totals, period: period(7),
        });
      }
    }
    const annual = sum(i, 365);
    for (const level of PARITY_LEVELS) {
      if (atLeast(annual.ironwood, annual.orchard, level)) consider(`parity:365:${level}`, {
        kind: 'parity', periodDays: 365, level, ...annual, period: period(365),
      });
    }
    const lifetime = sum(i, i - launchIndex + 1);
    for (const level of VOLUME_LEVELS) {
      if (lifetime.ironwood >= level) consider(`volume:${level}`, {
        kind: 'volume', periodDays: i - launchIndex + 1, level, ...lifetime,
        period: { start: activity.activation.date, endExclusive: addDays(date, 1) },
      });
    }
  }
  if (!achievements.length) return [];

  // Preserve every simultaneous first crossing in evidence, but send one story.
  const rank = a => a.kind === 'parity' && a.level === 100 ? 100
    : a.kind === 'leadership' ? 60 + a.periodDays
    : a.kind === 'volume' ? 50 : a.kind === 'share' ? 40 : 20;
  achievements.sort((a, b) => rank(b) - rank(a) || (b.level || 0) - (a.level || 0));
  const lead = achievements[0];
  const range = lead.period.start.slice(0, 4) === target.slice(0, 4)
    ? f.rangeText(lead.period.start, target) : `${f.dayYear(lead.period.start)} – ${f.dayYear(target)}`;
  const window = `${range} UTC`;
  const ageDays = Math.floor((Date.parse(`${addDays(target, 1)}T00:00:00Z`) / 1000 - activity.activation.timestamp) / 86400);
  let headline, detail, hero, line, qualifier;
  if (lead.kind === 'leadership') {
    headline = `Ironwood led Orchard over ${lead.periodDays} complete days for the first time.`;
    detail = `${f.number(lead.ironwood)} vs ${f.number(lead.orchard)} transactions involving each pool.`;
    hero = f.number(lead.ironwood); line = `transactions in ${lead.periodDays} complete days.`;
    qualifier = `Orchard: ${f.number(lead.orchard)} transactions.`;
  } else if (lead.kind === 'parity') {
    headline = lead.level === 100 ? "Ironwood reached Orchard's trailing-year transaction count."
      : `Ironwood reached ${lead.level}% of Orchard's trailing-year transaction count.`;
    detail = `${f.number(lead.ironwood)} vs ${f.number(lead.orchard)} over 365 complete days.`;
    hero = `≥${lead.level}%`; line = "of Orchard's trailing-year tx count.";
    qualifier = `${f.number(lead.ironwood)} vs ${f.number(lead.orchard)} transactions.`;
  } else if (lead.kind === 'volume') {
    headline = `Ironwood crossed ${f.number(lead.level)} transactions since activation.`;
    detail = `${f.number(lead.ironwood)} transactions involving Ironwood; ${ageDays} days after activation.`;
    hero = f.levelText(lead.level); line = 'transactions since activation.';
    qualifier = `${ageDays} days after activation.`;
  } else {
    headline = `Ironwood appeared in at least ${lead.level}% of Zcash transactions over 7 complete days.`;
    detail = `${f.number(lead.ironwood)} of ${f.number(lead.totalTransactions)} non-coinbase transactions.`;
    hero = `≥${lead.level}%`; line = 'of transactions involved Ironwood.';
    qualifier = '7 complete UTC days; coinbase excluded.';
  }
  // Dates, counts and the denominator take precedence over optional age context.
  const compose = extra => `🟨 ${headline}\n\n${detail}${extra}\n\n${window}. Coinbase excluded.\nhttps://zecblock.com/pools`;
  const withAge = compose(lead.kind === 'volume' ? '' : ` ${ageDays} days after activation.`);
  const content = withAge.length <= 280 ? withAge : compose('');
  const chartRows = days.slice(-30);
  const cumulative = lead.kind === 'volume';
  const values = chartRows.map((row, offset) => cumulative
    ? prefixes[days.length - chartRows.length + offset + 1].ironwood : row.ironwood);
  const card = { kicker: 'Milestone · Ironwood activity', hero, tone: 'ironwood', line, qualifier,
    source: 'zecblock.com/pools', date: range,
    visual: { kind: 'series', values, label: cumulative ? 'Ironwood transactions since activation' : 'Ironwood transactions per UTC day',
      start: chartRows[0].date, end: target } };
  return [candidate('milestone', `milestone:pool_activity:${lead.id}`, content, {
    target, achievements, lead: lead.id, activation: activity.activation, ageDays,
    historyStart: activity.historyStart, capturedAt: activity.capturedAt, tip: activity.tip,
    methodology: METHODOLOGY, card,
  }, 10 + rank(lead))];
}

// A bounded recovery window covers source failures and the shared daily cap.
// Preserve the original reporting date; never turn an old crossing into a new one.
function poolMilestoneStories(activity, target, { activatedAt, excludedKeys = [] } = {}) {
  validate(activity, target);
  let start = target;
  if (activatedAt) {
    const time = Date.parse(activatedAt);
    if (!Number.isFinite(time)) throw new Error('Invalid pool activity activation watermark');
    const activationDate = new Date(time).toISOString().slice(0, 10);
    const firstTarget = Date.parse(`${activationDate}T06:00:00Z`) >= time
      ? addDays(activationDate, -1) : activationDate;
    start = [addDays(target, -6), firstTarget, activity.activation.date].sort().at(-1);
  }
  const excluded = new Set(excludedKeys);
  const stories = [];
  for (let date = start; date <= target; date = addDays(date, 1)) {
    const length = (Date.parse(date) - Date.parse(activity.historyStart)) / 86400000 + 1;
    const events = firstCrossingStories({ ...activity, days: activity.days.slice(0, length) }, date);
    stories.push(...events.filter(story => !excluded.has(story.key)));
  }
  return stories;
}

module.exports = { VOLUME_LEVELS, SHARE_LEVELS, PARITY_LEVELS, poolMilestoneStories };
