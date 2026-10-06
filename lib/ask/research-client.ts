import {getApiUrl} from '@/lib/api-config';
import {readApiResponse} from '@/lib/api-client';
import {researchResultSchema,sqlQuerySchema} from './research-contract';
import type {ResearchQuery,ResearchResult} from './research-contract';
async function request(path:string,body:unknown,signal:AbortSignal){
 const response=await fetch(`${getApiUrl()}/v1/ask/research/${path}`,{method:'POST',cache:'no-store',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal});
 const {data,meta}=await readApiResponse<{result?:ResearchResult;query?:ResearchQuery|null}>(response);
 if(meta.network!=='mainnet')throw Error('Wrong network');return data;
}
export async function planResearch(question:string,challenge:string,signal:AbortSignal,execute=false){
 const data=await request('plan',{question,challenge,execute},signal);
 return {query:data.query===null?null:sqlQuerySchema.parse(data.query),result:data.result?researchResultSchema.parse(data.result):null};
}
export async function runResearch(query:ResearchQuery,challenge:string,signal:AbortSignal){const data=await request('query',{...query,challenge},signal);return researchResultSchema.parse(data.result);}
