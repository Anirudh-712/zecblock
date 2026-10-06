import type {ZodType} from 'zod';
export interface ResearchQuery {version:3;sql:string;limit:number}
export interface ResearchResult {query:ResearchQuery;columns:{key:string;label:string;type:'number'|'boolean'|'text'}[];rows:(string|null)[][];truncated:boolean;datasets:string[];fingerprint:string;retrievedAt:string;indexedThrough:string;coverage:string;units:string}
export interface ResearchChart {view:'table'|'line'|'bar';x:number;y:number}
export interface ResearchDocument {format:'zecblock-research';version:1;id:string;title:string;notes:string;query:ResearchQuery;chart:ResearchChart;result:ResearchResult|null;savedAt:string}
export interface ResearchLibrary {format:'zecblock-library';version:1;documents:ResearchDocument[];dashboards:{id:string;title:string;items:string[]}[]}
export const sqlQuerySchema:ZodType<ResearchQuery>;
export const researchResultSchema:ZodType<ResearchResult>;
export const researchDocumentSchema:ZodType<ResearchDocument>;
export const researchLibrarySchema:ZodType<ResearchLibrary>;
export const chartSchema:ZodType<ResearchChart>;
