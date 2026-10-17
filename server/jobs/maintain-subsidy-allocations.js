#!/usr/bin/env node
'use strict';

const { loadEnv } = require('../lib/job-utils');
loadEnv(__dirname);
const { getPool } = require('../lib/db-pool');
const { callZebraRPC } = require('../lib/zebra-rpc');
const { maintainAllocations } = require('../lib/subsidy-allocation-maintenance');
const { DEFAULT_STATE_FILE, runMaintenanceWithState, sanitizeMessage } = require('../lib/subsidy-allocation-state');
const watchdog = setTimeout(() => {
  console.error('Allocation maintenance exceeded its wall-clock deadline');
  process.exit(1);
}, 60000);
watchdog.unref();
const pool = getPool({ max: 2, connectionTimeoutMillis: 5000, statement_timeout: 5000, query_timeout: 6000 });
runMaintenanceWithState({
  filePath: process.env.SUBSIDY_ALLOCATION_STATE_FILE || DEFAULT_STATE_FILE,
  network: process.env.NETWORK,
  ownershipPool: pool,
  onOwnershipLost: () => { console.error('Allocation state ownership was lost'); process.exit(1); },
  maintain: ({ excludeHashes }) => maintainAllocations(pool, callZebraRPC, {
    network: process.env.NETWORK, excludeHashes,
    limit: process.env.SUBSIDY_ALLOCATION_BATCH === undefined ? 100 : Number(process.env.SUBSIDY_ALLOCATION_BATCH),
  }),
}).then(({ result, exitCode }) => { console.log(JSON.stringify(result)); process.exitCode = exitCode; })
  .catch(error => { console.error(sanitizeMessage(error.message)); process.exitCode = 1; })
  .finally(async () => { await pool.end(); clearTimeout(watchdog); });
