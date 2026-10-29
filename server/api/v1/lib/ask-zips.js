'use strict';
// Official ZIP index (numbers, titles, statuses) for Ask's reviewed sources.
// Data comes from scripts/update-ask-zips.mjs; nothing here summarizes a ZIP's
// contents, so answers can only cite a ZIP's title and index status.
const index = require('./ask-zips.json');

const byNumber = new Map(index.zips.map(zip => [zip.number, zip]));
const nu7 = new Set(index.nu7Planned);
const STOP = new Set('a an and are as at be by can does do for from has have how in into is it its of on or that the this to was what when where which who why will with zcash zip zips proposal proposals improvement explain tell me about'.split(' '));
const stem = word => word.replace(/'s$/, '').replace(/sses$/, 'ss').replace(/(?<=[a-z]{2})ies$/, 'y').replace(/(?<=[a-z]{2}[^s])s$/, '');
const words = text => [...new Set(text.toLowerCase().match(/[a-z][a-z0-9.]*/g) || [])].filter(word => !STOP.has(word)).map(stem);
const titleWords = new Map(index.zips.map(zip => [zip.number, new Set(words(zip.title))]));
// How many ZIP titles use a word: rare words identify a ZIP on their own.
const frequency = new Map();
for (const set of titleWords.values()) for (const word of set) frequency.set(word, (frequency.get(word) || 0) + 1);

const live = zip => /\b(?:Active|Final|Proposed)\b/.test(zip.status);
const dead = zip => !live(zip) && /\b(?:Withdrawn|Rejected|Obsolete|Reserved)\b/.test(zip.status);
// A word identifies a ZIP alone when it names an upgrade (nu7, nu6.3) or is a
// long word used by at most three titles; short common words ("time") never do.
const distinctive = word => /\d/.test(word) || word.length >= 5 && frequency.get(word) <= 3;

// Up to `limit` ZIPs for a question: explicit "ZIP 317" / "zip-0317" first,
// then title matches ranked by shared words, preferring live over withdrawn.
function matchZips(question, limit = 3) {
  if (typeof question !== 'string') return [];
  const explicit = [...question.matchAll(/\bzip[\s#-]*0*(\d{1,4})\b/gi)].map(match => byNumber.get(Number(match[1]))).filter(Boolean);
  const asked = words(question), upgrade = asked.find(word => /^nu\d/.test(word));
  const scored = index.zips.map(zip => {
    const shared = asked.filter(word => titleWords.get(zip.number).has(word));
    const strong = shared.length >= 2 || shared.some(distinctive) || shared.length === 1 && live(zip) && frequency.get(shared[0]) <= 6 && shared[0].length >= 3;
    const score = strong ? shared.length * 2 + (shared.some(distinctive) ? 1 : 0) + (live(zip) ? 1 : 0) - (dead(zip) ? 3 : 0) + (upgrade === 'nu7' && nu7.has(zip.number) ? 2 : 0) : 0;
    return { zip, score };
  }).filter(item => item.score > 0).sort((a, b) => b.score - a.score || a.zip.number - b.zip.number).map(item => item.zip);
  return [...new Set([...explicit, ...scored])].slice(0, limit);
}

const letters = 'abc';
function statusNote(zip) {
  return nu7.has(zip.number) ? 'It is listed in the official NU7 deployment plan.' : '';
}
const settled = index.settledUpgrade ? ` The most recent settled mainnet network upgrade in the index is ${index.settledUpgrade.name}.` : '';
const caveat = ' Index status alone does not establish mainnet activation; the ZIP text is the authority for its details.';

// Reviewed-source records for matched ZIPs. With placeholders (model input) the
// number/status are server facts the model must cite as {{zip_a}} etc., because
// prose numerals are rejected; without them (guided path) the text is final.
function zipRecords(zips, { placeholders = false } = {}) {
  const facts = {};
  const records = zips.slice(0, letters.length).map((zip, i) => {
    const key = `zip_${letters[i]}`;
    facts[key] = `ZIP ${zip.number}`; facts[`${key}_status`] = zip.status;
    const name = placeholders ? `{{${key}}}` : `ZIP ${zip.number}`;
    const status = placeholders ? `{{${key}_status}}` : zip.status;
    return Object.freeze({
      id: `zip_${zip.number}`, reviewed: index.retrieved, title: `ZIP ${zip.number}: ${zip.title}`, url: zip.url,
      text: `${name}, "${zip.title}", has status ${status} in the official ZIP index. ${statusNote(zip)}${placeholders ? ' Refer to this ZIP only as ' + name + ' and its status only as ' + status + '; never type its number.' : ''}${settled}${caveat}`.replace(/\s+/g, ' ').trim(),
    });
  });
  return { records, facts: placeholders ? facts : {} };
}

module.exports = { matchZips, zipRecords, zipIndex: index };
