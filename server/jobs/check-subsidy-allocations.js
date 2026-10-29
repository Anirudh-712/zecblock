#!/usr/bin/env node
'use strict';

const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const path = require('node:path');
const { loadEnv } = require('../lib/job-utils');
loadEnv(__dirname);
const { getPool } = require('../lib/db-pool');
const { callZebraRPC } = require('../lib/zebra-rpc');
const { DEFAULT_STATE_FILE, readAllocationState, writePrivateJson } = require('../lib/subsidy-allocation-state');
const { checkAllocationHealth } = require('../lib/subsidy-allocation-health');

const execute = promisify(execFile);
const pool = getPool({ max: 1, connectionTimeoutMillis: 5000, statement_timeout: 5000, query_timeout: 6000 });
const stateFile = process.env.SUBSIDY_ALLOCATION_STATE_FILE || DEFAULT_STATE_FILE;
const healthFile = process.env.SUBSIDY_ALLOCATION_HEALTH_FILE || path.join(path.dirname(stateFile), 'health.json');

async function systemdProperties(unit, properties) {
  const { stdout } = await execute('systemctl', ['show', unit, `--property=${properties.join(',')}`], { timeout: 3000, maxBuffer: 16384 });
  return Object.fromEntries(stdout.trim().split('\n').map(line => {
    const equals = line.indexOf('=');
    return [line.slice(0, equals), line.slice(equals + 1)];
  }));
}

async function main() {
  let health;
  try {
    const [state, timer, service] = await Promise.all([
      readAllocationState(stateFile, process.env.NETWORK),
      systemdProperties('cipherscan-subsidy-allocations.timer', ['ActiveState', 'UnitFileState']),
      systemdProperties('cipherscan-subsidy-allocations.service', ['Result']),
    ]);
    health = await checkAllocationHealth({ pool, rpc: callZebraRPC, network: process.env.NETWORK, state,
      systemd: { timerActive: timer.ActiveState, timerEnabled: timer.UnitFileState, serviceResult: service.Result } });
  } catch {
    health = { version: 1, network: process.env.NETWORK ?? null, checkedAt: new Date().toISOString(), status: 'unhealthy',
      reason: 'monitor_unavailable' };
  }
  await writePrivateJson(healthFile, health);
  console.log(JSON.stringify(health));
  process.exitCode = health.status === 'healthy' ? 0 : 1;
}

main().catch(() => { console.error('Allocation health status could not be persisted'); process.exitCode = 1; })
  .finally(() => pool.end());
