#!/usr/bin/env node
'use strict';

const { loadEnv } = require('../lib/job-utils');
loadEnv(__dirname);
const { getPool } = require('../lib/db-pool');
const { callZebraRPC } = require('../lib/zebra-rpc');
const { maintainAllocations } = require('../lib/subsidy-allocation-maintenance');
const pool = getPool({ max: 1, statement_timeout: 5000, query_timeout: 6000 });
maintainAllocations(pool, callZebraRPC, {
  network: process.env.NETWORK,
  limit: process.env.SUBSIDY_ALLOCATION_BATCH === undefined ? 100 : Number(process.env.SUBSIDY_ALLOCATION_BATCH),
}).then(result => console.log(JSON.stringify(result)))
  .catch(error => { console.error(error.message); process.exitCode = 1; })
  .finally(() => pool.end());
