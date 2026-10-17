'use strict';
const fs = require('node:fs/promises');

// Public health never exposes local paths, raw errors, credentials or retry data.
async function readAllocationHealth(filename, network, { readFile = fs.readFile, now = Date.now } = {}) {
  try {
    const raw = await readFile(filename, 'utf8');
    if (raw.length > 16384) return { status: 'unavailable' };
    const report = JSON.parse(raw);
    const checked = typeof report.checkedAt === 'string' ? Date.parse(report.checkedAt) : NaN;
    const age = now() - checked;
    if (!Number.isFinite(age) || report.network !== network) return { status: 'unavailable' };
    if (age < -30000 || age > 300000) return { status: 'stale' };
    return { status: report.status === 'healthy' ? 'up' : 'unhealthy', age_seconds: Math.max(0, Math.floor(age / 1000)) };
  } catch {
    return { status: 'unavailable' };
  }
}

module.exports = { readAllocationHealth };
