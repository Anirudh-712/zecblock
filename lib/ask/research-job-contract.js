/* eslint-disable @typescript-eslint/no-require-imports */
const {z}=require('zod');
const {researchResultSchema}=require('./research-contract');
const jobTicketSchema=z.object({id:z.string().uuid(),token:z.string().regex(/^[a-f0-9]{64}$/)}).strict();
const jobStatusSchema=z.object({id:z.string().uuid(),state:z.enum(['queued','running','succeeded','failed','cancelled']),createdAt:z.string().datetime(),startedAt:z.string().datetime().nullable(),finishedAt:z.string().datetime().nullable(),queuePosition:z.number().int().min(0).max(6),maxRunSeconds:z.literal(30),error:z.enum(['timeout','resource','query','source','quota','unavailable','interrupted']).nullable(),result:researchResultSchema.nullable()}).strict().refine(j=>(j.state==='succeeded')===!!j.result);
module.exports={jobTicketSchema,jobStatusSchema};
