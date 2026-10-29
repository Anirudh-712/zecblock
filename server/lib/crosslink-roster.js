'use strict';

const network = require('../../lib/crosslink-network.json');

const HEX_KEY = /^[a-f0-9]{64}$/i;
const RECENCY_MAX_AGE_SECONDS = 60;
const CONNECTION_WINDOW_SECONDS = 300;

function nonnegativeInteger(value) {
  const number = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

/**
 * v14 RosterMember serializes its raw [u8;32] key directly as hex. Tenderlink
 * sorts Reverse((stake, raw key)) and only the first ACTIVE_ROSTER_MAX_N vote.
 * Preserve all candidates and their stake; membership is a separate field.
 */
function buildCrosslinkRoster(raw) {
  if (!Array.isArray(raw)) return null;
  const identities = new Set();
  const roster = [];
  let totalStakeZats = 0;
  for (const member of raw) {
    const identity = member?.pub_key ?? member?.identity ?? member?.public_key;
    const stake = nonnegativeInteger(member?.voting_power ?? member?.stake_zats ?? member?.stake);
    if (typeof identity !== 'string' || !HEX_KEY.test(identity) || stake === null) return null;
    const key = identity.toLowerCase();
    if (identities.has(key)) return null;
    identities.add(key);
    totalStakeZats += stake;
    if (!Number.isSafeInteger(totalStakeZats)) return null;
    roster.push({ identity: key, stake_zats: stake, stake_zec: stake / 1e8 });
  }
  roster.sort((a, b) => b.stake_zats - a.stake_zats || (a.identity < b.identity ? 1 : a.identity > b.identity ? -1 : 0));
  const active = roster.slice(0, network.activeRosterLimit);
  const activeStakeZats = active.reduce((sum, member) => sum + member.stake_zats, 0);
  roster.forEach((member, index) => {
    member.votingEligible = index < network.activeRosterLimit;
    member.voted = null;
    member.highest_round = null;
    member.last_connected_utc = null;
    member.connected = null;
  });
  return {
    roster,
    finalizerCount: active.length,
    candidateCount: roster.length,
    activeRosterLimit: network.activeRosterLimit,
    totalStakeZats,
    totalStakeZec: totalStakeZats / 1e8,
    activeStakeZats,
    activeStakeZec: activeStakeZats / 1e8,
    rosterSource: 'native-v14-next-bft-roster',
  };
}

function unavailable(reason) {
  return {
    available: false, unavailableReason: reason,
    observation: 'local-node-current-height-votes-and-recent-packets',
    bftHeight: null, bftRound: null, observedAt: null,
    onlineCount: null, offlineCount: null, onlineStakeZec: null, offlineStakeZec: null,
    onlinePercent: null, connectedCount: null, connectedStakeZec: null, connectedPercent: null,
  };
}

/**
 * PubKeyID serde reverses bytes, unlike RosterMember.pub_key. Recency is a
 * union across retained Tenderlink rounds, not a positionally aligned roster.
 * A changed roster, incomplete snapshot, or stale node observation cannot
 * establish current voting/connection totals. These observations are local
 * votes/packets, never a global online/offline determination.
 */
function crosslinkLiveness(rosterData, snapshot, { nowSeconds = Math.floor(Date.now() / 1000), active = true } = {}) {
  if (!active) return unavailable('crosslink-not-active');
  if (!snapshot || typeof snapshot !== 'object') return unavailable('recency-unavailable');
  const now = nonnegativeInteger(snapshot.now_utc);
  const height = nonnegativeInteger(snapshot.my_height);
  const round = nonnegativeInteger(snapshot.my_round);
  if (now === null || height === null || round === null || !Array.isArray(snapshot.finalizer_statuses)) {
    return unavailable('invalid-recency-snapshot');
  }
  if (nowSeconds - now > RECENCY_MAX_AGE_SECONDS || now - nowSeconds > 5) return unavailable('stale-recency-snapshot');
  const statuses = new Map();
  for (const entry of snapshot.finalizer_statuses) {
    if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string' || !HEX_KEY.test(entry[0])) {
      return unavailable('invalid-recency-snapshot');
    }
    const identity = Buffer.from(entry[0], 'hex').reverse().toString('hex');
    if (statuses.has(identity)) return unavailable('invalid-recency-snapshot');
    const status = entry[1];
    const votes = status?.no_yes_votes_in_my_height;
    if (!Array.isArray(votes) || votes.length !== 2 || votes.some(pair => !Array.isArray(pair) || pair.length !== 2 || pair.some(n => nonnegativeInteger(n) === null)) || nonnegativeInteger(status.highest_round_vote) === null) {
      return unavailable('invalid-recency-snapshot');
    }
    const rawLastConnected = status.last_direct_connection_utc;
    const lastConnected = rawLastConnected === null ? null : nonnegativeInteger(rawLastConnected);
    if (rawLastConnected !== null && (lastConnected === null || lastConnected > now + 5)) {
      return unavailable('invalid-recency-snapshot');
    }
    statuses.set(identity, {
      voted: votes.some(pair => pair.some(n => Number(n) > 0)),
      highest_round: Number(status.highest_round_vote),
      last_connected_utc: lastConnected,
      connected: lastConnected === null ? null : now - lastConnected < CONNECTION_WINDOW_SECONDS,
    });
  }
  const activeRoster = rosterData.roster.filter(member => member.votingEligible);
  if (!activeRoster.length || statuses.size !== activeRoster.length || activeRoster.some(member => !statuses.has(member.identity))) {
    return unavailable('roster-recency-mismatch');
  }
  let votedCount = 0, votedStake = 0, connectedCount = 0, connectedStake = 0;
  for (const member of activeRoster) {
    Object.assign(member, statuses.get(member.identity));
    if (member.voted) { votedCount++; votedStake += member.stake_zats; }
    if (member.connected) { connectedCount++; connectedStake += member.stake_zats; }
  }
  const total = rosterData.activeStakeZats;
  return {
    available: true, unavailableReason: null,
    observation: 'local-node-current-height-votes-and-recent-packets',
    bftHeight: height, bftRound: round, observedAt: new Date(now * 1000).toISOString(),
    connectionWindowSeconds: CONNECTION_WINDOW_SECONDS,
    // Compatibility aliases: "online" means an observed vote at this BFT
    // height; "offline" only means no observed vote. Neither is global status.
    onlineCount: votedCount, offlineCount: activeRoster.length - votedCount,
    onlineStakeZec: votedStake / 1e8, offlineStakeZec: (total - votedStake) / 1e8,
    onlinePercent: total > 0 ? Math.round(votedStake / total * 100) : null,
    connectedCount, connectedStakeZec: connectedStake / 1e8,
    connectedPercent: total > 0 ? Math.round(connectedStake / total * 100) : null,
  };
}

module.exports = { buildCrosslinkRoster, crosslinkLiveness };
