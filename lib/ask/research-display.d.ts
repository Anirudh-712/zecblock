import type {ResearchResult,ResearchChart} from './research-contract';
export function defaultResearchChart(result?:ResearchResult):ResearchChart;
export function shortLabel(value:unknown):string;
export function supportsLine(result:ResearchResult,x:number):boolean;
export function cellLink(key:string,value:string|null):string|null;
