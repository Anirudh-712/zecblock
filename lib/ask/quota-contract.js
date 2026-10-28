/* eslint-disable @typescript-eslint/no-require-imports */
const { z } = require('zod');
// Only fixed SQL capacity categories cross the private worker boundary.
const sqlQuotaSchema = z.object({
  code: z.enum(['ask-sql-global-day', 'ask-sql-busy', 'ask-sql-queue']),
  retryAfter: z.number().int().min(1).max(86400),
}).strict();
module.exports = { sqlQuotaSchema };
