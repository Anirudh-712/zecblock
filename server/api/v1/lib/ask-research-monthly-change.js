'use strict';
// Source-proven monthly count interpretation; SQL admission is unchanged.
const {parse}=require('pgsql-parser');
const {renderExplanation}=require('./ask-explanation');
const {researchCatalogue}=require('../../../../lib/ask/research-catalogue');
const subjects={blocks:'block count',transactions:'non-coinbase transaction count',shielded_transactions:'shielded transaction count',transparent_transactions:'transparent transaction count',unclassified_transactions:'unclassified transaction count'};
const names=node=>node?.map(part=>part.String?.sval),ref=node=>names(node?.ColumnRef?.fields),unknown=()=>({kind:'unknown'});
function type(node){const t=node?.TypeCast?.typeName,p=names(t?.names);return t&&!t.typmods?.length&&!t.arrayBounds?.length&&(p?.length===1||p?.length===2&&p[0]==='pg_catalog')?p.at(-1):null;}
function func(call){const p=names(call?.funcname);return p&&(p.length===1||p.length===2&&p[0]==='pg_catalog')?p.at(-1):null;}
function requestedField(question){
 if(typeof question!=='string'||question.length>8192)return null;
 const request=/\b(?:largest|greatest|biggest|maximum)\s+absolute\s+(?:month[- ]to[- ]month|month[- ]over[- ]month|monthly)\s+(?:change|difference|swing)\b/i.exec(question);
 if(!request||/\b(?:forecast\w*|predict\w*|future|next\s+month)\b/i.test(question))return null;
 const fields=text=>{const found=[];for(const [word,field] of [['unclassified','unclassified_transactions'],['shielded','shielded_transactions'],['transparent','transparent_transactions']])if(new RegExp('\\b'+word+'\\b','i').test(text))found.push(field);if(/\bblocks?\b/i.test(text))found.push('blocks');if(/\b(?:non[- ]coinbase|all|total)\s+transactions?\b/i.test(text))found.push('transactions');return found;};
 const tail=question.slice(request.index+request[0].length).split(/[.!?]/)[0];
 if(/\b(?:shares?|percent(?:age)?|ratios?|rates?|averages?|means?|medians?|rolling|fees?|balances?|USD|ZEC|zatoshis?)\b|%|\bper\s+(?:block|transaction)\b/i.test(tail)||/\b(?:why|caus(?:e|ed|es)|forecast\w*|predict\w*)\b/i.test(question)||/\b(?:not|instead|rather)\b[^.!?]{0,45}$/i.test(question.slice(0,request.index)))return null;
 const scoped=fields(tail),selected=scoped.length?scoped:fields(question),measureScope=scoped.length?tail:question;
 // A component name alone does not mean its transaction count: volume,
 // users and normalized rates require their own source/intent contract.
 if(!/\b(?:counts?|transactions?|blocks?)\b/i.test(measureScope)||/\b(?:volumes?|amounts?|values?|users?|addresses|wallets?|payments?|per|not|instead|rather)\b|\bonly\s+(?:increases?|decreases?|positive|negative|rises?|falls?|growth)\b/i.test(tail)||/\b(?:because|due\s+to|driven\s+by|attribut\w*)\b/i.test(question))return null;
 return selected.length===1?selected[0]:null;
}
async function monthlyCountColumns(sql){
 try{
  const tree=await parse(sql);if(tree.stmts?.length!==1)return null;let visited=0;
  const rename=(columns,aliases)=>!aliases?.length?columns:aliases.length<=columns.length?columns.map((info,i)=>({...info,name:aliases[i]?.String?.sval||info.name})):[];
  function select(s,inherited=new Map(),depth=0){
   if(!s||depth>20||++visited>8000||s.op&&s.op!=='SETOP_NONE'||s.withClause?.recursive||s.fromClause?.length!==1||s.distinctClause?.length||s.havingClause)return [];
   const scope=new Map(inherited);for(const item of s.withClause?.ctes||[]){const c=item.CommonTableExpr;if(!c)return [];scope.set(c.ctename,rename(select(c.ctequery?.SelectStmt,scope,depth+1),c.aliascolnames));}
   const from=s.fromClause[0];let columns,alias;
   if(from.RangeVar){const r=from.RangeVar;alias=r.alias?.aliasname||r.relname;if(!r.schemaname&&scope.has(r.relname))columns=scope.get(r.relname);else{if(!(r.relname==='activity_daily'&&!r.schemaname||r.relname==='activity_daily_query'&&r.schemaname==='analytics_public'))return [];columns=researchCatalogue.find(item=>item.id==='activity_daily').columns.split(', ').map(field=>({name:field,...(field==='date'?{kind:'date',origin:'activity_daily.date'}:Object.hasOwn(subjects,field)?{kind:'daily-count',field,origin:'activity_daily.date'}:unknown())}));}columns=rename(columns,r.alias?.colnames);}
   else if(from.RangeSubselect){const r=from.RangeSubselect;if(r.lateral)return [];alias=r.alias?.aliasname;columns=rename(select(r.subquery?.SelectStmt,scope,depth+1),r.alias?.colnames);}else return [];
   const resolve=node=>{const p=ref(node);if(!p?.length||p.length>2||p.length===2&&p[0]!==alias)return unknown();const matches=columns.filter(info=>info.name===p.at(-1));return matches.length===1?{...matches[0]}:unknown();};
   let grouping=null;
   function expression(node){
    if(!node||++visited>8000)return unknown();if(node.ColumnRef)return resolve(node);
    if(node.TypeCast){const inner=expression(node.TypeCast.arg),t=type(node);if(['numeric','decimal'].includes(t)&&['daily-count','monthly-count'].includes(inner.kind))return {...inner};if(['date','timestamp'].includes(t)&&['date','month'].includes(inner.kind))return {...inner};return unknown();}
    const f=node.FuncCall,name=func(f);
    if(name==='date_trunc'&&!f.over&&!f.agg_filter&&!f.agg_distinct&&f.args?.length===2&&f.args[0].A_Const?.sval?.sval==='month'){const date=expression(f.args[1]);return date.kind==='date'?{kind:'month',origin:date.origin}:unknown();}
    if(name==='sum'&&grouping&&!f.over&&!f.agg_filter&&!f.agg_distinct&&!f.agg_order?.length&&f.args?.length===1){const count=expression(f.args[0]);return count.kind==='daily-count'&&count.origin===grouping.origin?{kind:'monthly-count',field:count.field,origin:grouping.origin}:unknown();}return unknown();
   }
   // Source filtering must not silently turn daily totals into a monthly
   // subtotal. Accept only conjunctions of inclusive/exclusive whole-month
   // date bounds. Once aggregated, selecting fewer monthly rows is safe: the
   // wording explicitly limits its comparison to returned observations.
   function wholeMonthBounds(node){
    if(node?.BoolExpr)return node.BoolExpr.boolop==='AND_EXPR'&&node.BoolExpr.args?.length>0&&node.BoolExpr.args.every(wholeMonthBounds);
    const e=node?.A_Expr,op=names(e?.name),date=expression(e?.lexpr),literal=e?.rexpr?.TypeCast;
    return e?.kind==='AEXPR_OP'&&op?.length===1&&['>=','<'].includes(op[0])&&date.kind==='date'&&type(e.rexpr)==='date'&&/^20\d{2}-(?:0[1-9]|1[0-2])-01$/.test(literal?.arg?.A_Const?.sval?.sval||'');
   }
   const dailyInput=columns.some(info=>info.kind==='daily-count');
   if(dailyInput&&(s.whereClause&&!wholeMonthBounds(s.whereClause)||!s.groupClause?.length&&(s.limitCount||s.limitOffset)))return [];
   if(s.groupClause?.length){if(s.groupClause.length!==1)return [];let group=s.groupClause[0],ordinal=group?.A_Const?.ival?.ival;if(Number.isInteger(ordinal)&&ordinal>=1)group=s.targetList?.[ordinal-1]?.ResTarget?.val;else{const p=ref(group);if(p?.length===1&&!columns.some(info=>info.name===p[0])){const targets=s.targetList?.filter(item=>item.ResTarget?.name===p[0]);if(targets?.length===1)group=targets[0].ResTarget.val;}}const info=expression(group);if(info.kind!=='month')return [];grouping=info;}
   return (s.targetList||[]).flatMap(item=>{const t=item.ResTarget,p=ref(t?.val);if(t?.val?.ColumnRef?.fields?.at(-1)?.A_Star)return !grouping&&(p?.length===1||p?.length===2&&p[0]===alias)?columns:[];const info=expression(t?.val),name=t?.name||p?.at(-1)||(t?.val?.TypeCast?info.name:null)||func(t?.val?.FuncCall);return [{...info,name}];});
  }return select(tree.stmts[0].stmt?.SelectStmt);
 }catch{return null;}
}
function month(value){if(typeof value!=='string')return null;const m=/^(20\d{2})-(0[1-9]|1[0-2])-01(?:[ T]00:00:00(?:\.0+)?(?:Z|\+00(?::?00)?)?)?$/.exec(value);return m?{date:m[1]+'-'+m[2]+'-01',ordinal:Number(m[1])*12+Number(m[2])-1}:null;}
const display=value=>value.toString().replace(/\B(?=(\d{3})+(?!\d))/g,',');
async function researchMonthlyChangeSummary(result,question,locale='en'){
 try{
  const field=requestedField(question);if(!field||!/^en(?:-|$)/.test(locale)||result.truncated||result.datasets?.length!==1||result.datasets[0]!=='activity_daily'||result.rows?.length<2||result.rows.length>40||result.columns?.length>24||Buffer.byteLength(JSON.stringify(result.rows))>8192)return null;
  const columns=await monthlyCountColumns(result.query.sql);if(!columns?.length||columns.length!==result.columns.length||columns.some((info,i)=>typeof info.name!=='string'||info.name!==result.columns[i].label||result.columns[i].key!==`c${i}`)||new Set(columns.map(info=>info.name)).size!==columns.length)return null;
  const axes=columns.flatMap((info,i)=>info.kind==='month'&&result.columns[i].type==='text'?[i]:[]),measures=columns.flatMap((info,i)=>info.kind==='monthly-count'&&info.field===field&&result.columns[i].type==='number'?[i]:[]);if(axes.length!==1||measures.length!==1)return null;const axis=axes[0],measure=measures[0];if(columns[axis].origin!==columns[measure].origin)return null;
  const rows=result.rows.map(row=>{const date=month(row[axis]),value=row[measure];return row.length===columns.length&&date&&typeof value==='string'&&value.length<=1000&&/^\+?\d+$/.test(value)?{...date,value:BigInt(value)}:null;});if(rows.some(row=>!row))return null;rows.sort((a,b)=>a.ordinal-b.ordinal);if(rows.some((row,i)=>i>0&&row.ordinal!==rows[i-1].ordinal+1))return null;
  let leaders=[],largest=-1n;for(let i=1;i<rows.length;i++){const previous=rows[i-1],current=rows[i],delta=current.value-previous.value,magnitude=delta<0n?-delta:delta;if(magnitude>largest){leaders=[];largest=magnitude;}if(magnitude===largest)leaders.push({previous,current,delta});}
  const leading=leaders[0],facts={change_magnitude:display(largest),prior_count:display(leading.previous.value),current_count:display(leading.current.value),prior_month:new Date(leading.previous.date+'T00:00:00Z').toLocaleDateString(locale,{timeZone:'UTC',month:'long',year:'numeric'}),current_month:new Date(leading.current.date+'T00:00:00Z').toLocaleDateString(locale,{timeZone:'UTC',month:'long',year:'numeric'})},title=subjects[field],unit=field==='blocks'?'blocks':'transactions';
  const summary=largest===0n?`The ${title} was unchanged between every consecutive returned month; the absolute month-to-month change was {{change_magnitude}} ${unit}.`:`Among the returned monthly observations, ${leaders.length>1?'a joint':'the'} largest absolute month-to-month change in ${title} was ${leading.delta<0n?'a decrease':'an increase'} of {{change_magnitude}} ${unit}, from {{prior_count}} in {{prior_month}} to {{current_count}} in {{current_month}}.${leaders.length>1?' Other returned month-to-month changes tied this magnitude.':''}`;
  const answer=renderExplanation({summary,observations:[],limitation:''},facts).summary;return Buffer.byteLength(answer)<=1000?answer:null;
 }catch{return null;}
}
module.exports={monthlyCountColumns,researchMonthlyChangeSummary,requestedField};
