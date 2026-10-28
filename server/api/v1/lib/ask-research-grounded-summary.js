'use strict';
// Bounded meanings for observed daily fields, separate from SQL admission and
// unit inference. Unknown expressions remain valid SQL, without a metric claim.
const {parse}=require('pgsql-parser');
const {renderExplanation}=require('./ask-explanation');
const {compare}=require('./ask-research-comparison');
const {researchCatalogue}=require('../../../../lib/ask/research-catalogue');
const fields={
 daily:{orchard:{title:'Orchard balance',unit:'zatoshi'},ironwood:{title:'Ironwood balance',unit:'zatoshi'},sapling:{title:'Sapling balance',unit:'zatoshi'},sprout:{title:'Sprout balance',unit:'zatoshi'}},
 activity_daily:{blocks:{title:'block count',unit:'count',suffix:'blocks'},transactions:{title:'non-coinbase transaction count',unit:'count',suffix:'transactions'},shielded_transactions:{title:'shielded transaction count',unit:'count',suffix:'transactions'},transparent_transactions:{title:'transparent transaction count',unit:'count',suffix:'transactions'},unclassified_transactions:{title:'unclassified transaction count',unit:'count',suffix:'transactions'},bytes:{title:'non-coinbase transaction bytes',unit:'bytes'},fees:{title:'non-coinbase transaction fees',unit:'zatoshi'},missing_fees:{title:'missing-fee observation count',unit:'count',suffix:'observations'},missing_bytes:{title:'missing-byte observation count',unit:'count',suffix:'observations'}},
};
const pools=Object.keys(fields.daily),names=n=>n?.map(part=>part.String?.sval),ref=n=>names(n?.ColumnRef?.fields),unknown=name=>({name,unit:'unknown'});
function plainType(n){const t=n?.TypeCast?.typeName,p=names(t?.names);return t&&!t.typmods?.length&&!t.arrayBounds?.length&&(p?.length===1||p?.length===2&&p[0]==='pg_catalog')?p.at(-1):null;}
function numericCast(n){return ['numeric','decimal'].includes(plainType(n));}
function constant(n,kind){
 if(numericCast(n))return constant(n.TypeCast.arg,kind);
 const c=n?.A_Const;if(!c)return false;
 if(kind==='scale')return c.ival?.ival===100000000||typeof c.fval?.fval==='string'&&/^(?:100000000(?:\.0+)?|1(?:\.0+)?e\+?8)$/i.test(c.fval.fval);
 return typeof c.fval?.fval==='string'&&/^(?:0?\.0{7}10*|1(?:\.0+)?e-0?8)$/i.test(c.fval.fval);
}
function sourceName(r){
 if(!r?.schemaname&&Object.hasOwn(fields,r?.relname))return r.relname;
 return r?.schemaname==='analytics_public'?({daily_query:'daily',activity_daily_query:'activity_daily'})[r.relname]:null;
}
async function researchObservedColumns(sql){
 try{
  const tree=await parse(sql);if(tree.stmts?.length!==1)return null;
  const rename=(columns,aliases)=>!aliases?.length?columns:aliases.length<=columns.length?columns.map((column,i)=>({...column,name:aliases[i]?.String?.sval||column.name})):[];
  function select(s,inherited=new Map(),depth=0){
   if(!s||depth>16||s.op&&s.op!=='SETOP_NONE'||s.withClause?.recursive||s.groupClause?.length||s.havingClause||s.distinctClause?.length||s.fromClause?.length!==1)return [];
   const scope=new Map(inherited);
   for(const item of s.withClause?.ctes||[]){const c=item.CommonTableExpr;if(!c)return [];scope.set(c.ctename,rename(select(c.ctequery?.SelectStmt,scope,depth+1),c.aliascolnames));}
   const from=s.fromClause[0];let columns,alias;
   if(from.RangeVar){
    const r=from.RangeVar;alias=r.alias?.aliasname||r.relname;
    if(!r.schemaname&&scope.has(r.relname))columns=scope.get(r.relname);
    else {const source=sourceName(r);if(!source)return [];columns=researchCatalogue.find(dataset=>dataset.id===source).columns.split(', ').map(field=>field==='date'?{name:field,source,field,kind:'observation-date',unit:'date'}:fields[source][field]?{name:field,source,field,kind:'measure',...fields[source][field]}:unknown(field));}
    columns=rename(columns,r.alias?.colnames);
   }else if(from.RangeSubselect){if(from.RangeSubselect.lateral)return [];alias=from.RangeSubselect.alias?.aliasname;columns=rename(select(from.RangeSubselect.subquery?.SelectStmt,scope,depth+1),from.RangeSubselect.alias?.colnames);}
   else return [];
   function expression(n){
    if(n?.ColumnRef){const parts=ref(n);if(!parts?.length||parts.length>2||parts.length===2&&parts[0]!==alias)return unknown();const matches=columns.filter(column=>column.name===parts.at(-1));return matches.length===1?{...matches[0]}:unknown();}
    if(n?.TypeCast){
     const inner=expression(n.TypeCast.arg),type=plainType(n);
     if(numericCast(n)&&inner.kind==='measure')return {...inner,numeric:true};
     if(['observation-date','month-bucket'].includes(inner.kind)&&['date','timestamp','timestamptz'].includes(type))return {...inner,dateCast:type};
     return unknown();
    }
    const e=n?.A_Expr;
    if(e?.kind==='AEXPR_OP'){
     const op=names(e.name)?.join('.');
     if(op==='/'&&constant(e.rexpr,'scale')){const inner=expression(e.lexpr),divisorNumeric=!!e.rexpr?.A_Const?.fval||numericCast(e.rexpr);if(inner.kind==='measure'&&inner.unit==='zatoshi'&&(inner.numeric||divisorNumeric))return {...inner,unit:'zec',numeric:true};}
     if(op==='*'){const inner=constant(e.lexpr,'inverse')?expression(e.rexpr):constant(e.rexpr,'inverse')?expression(e.lexpr):unknown();if(inner.kind==='measure'&&inner.unit==='zatoshi')return {...inner,unit:'zec',numeric:true};}
     return unknown();
    }
    // A proven bucket can support the existing bucket-specific shortcut, but
    // can never supply an actual observation date for the natural fallback.
    const f=n?.FuncCall,fn=names(f?.funcname);
    if(fn?.at(-1)==='date_trunc'&&(fn.length===1||fn.length===2&&fn[0]==='pg_catalog')&&f.args?.length===2&&f.args[0].A_Const?.sval?.sval==='month'){
     const date=expression(f.args[1]);if(date.kind==='observation-date'&&date.dateCast!=='timestamptz')return {...date,kind:'month-bucket'};
    }
    return unknown();
   }
   return (s.targetList||[]).flatMap(item=>{
    const t=item.ResTarget,p=ref(t?.val);
    if(t?.val?.ColumnRef?.fields?.at(-1)?.A_Star)return p?.length===1||p?.length===2&&p[0]===alias?columns:[];
    const info=expression(t?.val),name=t?.name||p?.at(-1)||(t?.val?.TypeCast?info.name:null)||names(t?.val?.FuncCall?.funcname)?.at(-1);
    return [{...info,name}];
   });
  }
  return select(tree.stmts[0].stmt?.SelectStmt);
 }catch{return null;}
}
function boundColumns(result,columns){
 return Array.isArray(columns)&&columns.length===result.columns?.length&&columns.length>0&&columns.every((info,i)=>typeof info.name==='string'&&info.name===result.columns[i].label&&result.columns[i].key===`c${i}`)&&new Set(columns.map(info=>info.name)).size===columns.length;
}
function poolProvenanceMatches(result,columns){
 if(!boundColumns(result,columns)||result.datasets?.length!==1||result.datasets[0]!=='daily')return false;
 const date=result.columns.findIndex(column=>column.label==='date'),month=result.columns.findIndex(column=>column.label==='month'),axis=date>=0?date:month;
 if(axis<0||columns[axis].source!=='daily'||columns[axis].field!=='date'||columns[axis].kind!==(date>=0?'observation-date':'month-bucket')||result.columns[axis].type!=='text'||date>=0&&columns[axis].dateCast&&columns[axis].dateCast!=='date')return false;
 const matched=new Set();
 for(const [i,column]of result.columns.entries()){
  const match=/^(orchard|ironwood)(?:_(zec|zatoshis))?$/.exec(column.label);if(!match)continue;
  const expected=match[2]==='zec'?'zec':'zatoshi',info=columns[i];
  if(column.type!=='number'||info.source!=='daily'||info.field!==match[1]||info.kind!=='measure'||info.unit!==expected)return false;
  matched.add(match[1]);
 }
 return matched.size===2;
}
function validDate(value){return typeof value==='string'&&/^20\d{2}-\d{2}-\d{2}$/.test(value)&&Number.isFinite(Date.parse(value))&&new Date(value+'T00:00:00Z').toISOString().slice(0,10)===value;}
function validValue(value,unit){return value===null||typeof value==='string'&&value.length<=1000&&/^\+?\d+(?:\.\d+)?$/.test(value)&&(unit!=='count'||/^\+?\d+$/.test(value));}
function safeAlias(info){
 const tokens=info.name.replace(/([a-z0-9])([A-Z])/g,'$1_$2').toLowerCase().split(/[^a-z0-9]+/),unit=tokens.filter(part=>/^(?:zec|usd|zatoshis?|zats?)$/.test(part));
 return !tokens.some(token=>pools.includes(token)&&token!==info.field)&&!unit.some(token=>(token==='zec'?'zec':token==='usd'?'usd':'zatoshi')!==info.unit);
}
function allowsObservedSummary(question){
 return typeof question==='string'&&!!question.trim()&&!/\b(?:chang(?:e|es|ed|ing)|delta|difference|lowest|minimum|smallest|median|growth|grow(?:s|ing)?|grew|increase[ds]?|decrease[ds]?|rose|fell|shares?|percent(?:age)?|ratios?|rates?|rolling|averages?|means?|sums?|cumulative|forecast\w*|predict\w*|projection\w*|future|next|will|why)\b|%|\bper\s+(?:block|transaction)\b|\bwhich\s+pool\b/i.test(question);
}
function selectMeasures(columns,question){
 if(!allowsObservedSummary(question))return [];
 const available=columns.filter(info=>info.kind==='measure'&&safeAlias(info)),namedPools=pools.filter(pool=>new RegExp('\\b'+pool+'\\b','i').test(question));let requested=[];
 if(namedPools.length){
  const focused=namedPools.filter(pool=>new RegExp('\\b(?:larger|higher|highest|largest|maximum)\\s+(?:(?:observed|closing)\\s+)?'+pool+"(?:['’]s)?\\s+(?:(?:observed|closing)\\s+)?balance\\b|\\b"+pool+"['’]s\\s+(?:larger|higher|highest|largest|maximum)\\s+(?:(?:observed|closing)\\s+)?balance\\b",'i').test(question));
  requested=focused.length===1?[focused[0],...namedPools.filter(pool=>pool!==focused[0])]:namedPools;
 }
 else if(/\b(?:pools?|balances?)\b/i.test(question))requested=available.filter(info=>info.source==='daily').map(info=>info.field);
 else{
  for(const [word,field]of [['shielded','shielded_transactions'],['transparent','transparent_transactions'],['unclassified','unclassified_transactions'],['bytes?','bytes'],['blocks?','blocks'],['fees?','fees']])if(new RegExp('\\b'+word+'\\b','i').test(question))requested.push(field);
  if(/\bmissing\b/i.test(question))requested=requested.map(field=>field==='fees'?'missing_fees':field==='bytes'?'missing_bytes':field);
  if(!requested.length&&/\btransactions?\b/i.test(question))requested=['transactions'];
 }
 if(!requested.length&&/\b(?:compare|explain|summari[sz]e|describe)\b/i.test(question))requested=available.map(info=>info.field);
 requested=[...new Set(requested)];if(!requested.length||requested.length>3)return [];
 const selected=requested.map(field=>available.filter(info=>info.field===field));
 return selected.every(matches=>matches.length===1)?selected.map(matches=>matches[0]):[];
}
function format(value){const [whole,fraction]=value.replace(/^\+/,'').split('.'),tail=fraction?.replace(/0+$/,'');return whole.replace(/\B(?=(\d{3})+(?!\d))/g,',')+(tail?'.'+tail:'');}
function researchGroundedSummary(result,columns,question,locale){
 try{
  if(!/^en(?:-|$)/.test(locale)||!boundColumns(result,columns)||result.truncated||!Array.isArray(result.rows)||result.rows.length<2||result.rows.length>40||result.columns.length>24||Buffer.byteLength(JSON.stringify(result.rows))>8192||result.rows.some(row=>row.length!==columns.length)||result.datasets?.length!==1)return null;
  const dates=columns.flatMap((info,i)=>info.kind==='observation-date'&&(!info.dateCast||info.dateCast==='date')&&result.columns[i].type==='text'?[i]:[]);if(dates.length!==1)return null;
  const axis=dates[0],source=columns[axis].source;
  if(result.datasets[0]!==source||result.rows.some(row=>!validDate(row[axis]))||new Set(result.rows.map(row=>row[axis])).size!==result.rows.length)return null;
  const selected=selectMeasures(columns,question);if(!selected.length||selected.some(info=>info.source!==source||result.columns[columns.indexOf(info)]?.type!=='number'))return null;
  // Require the source's missing-observation companion before treating fee
  // or byte totals as fully known, even if a future source changes null policy.
  for(const info of selected.filter(info=>info.source==='activity_daily'&&['fees','bytes'].includes(info.field))){
   const companions=columns.flatMap((column,i)=>column.source==='activity_daily'&&column.field==='missing_'+info.field&&column.kind==='measure'&&result.columns[i].type==='number'?[i]:[]);
   if(companions.length!==1||result.rows.some(row=>typeof row[companions[0]]!=='string'||!/^\+?0+$/.test(row[companions[0]])))return null;
  }
  const facts={},sentences=[],rows=[...result.rows].sort((a,b)=>a[axis].localeCompare(b[axis]));let serial=0;
  const fact=(value,date=false)=>{const id='observed_'+String.fromCharCode(97+serial++);facts[id]=date?new Date(value+'T00:00:00Z').toLocaleDateString(locale,{timeZone:'UTC',day:'numeric',month:'short',year:'numeric'}):format(value);return '{{'+id+'}}';};
  for(const info of selected){
   const column=columns.indexOf(info),unit=info.unit==='zec'?'ZEC':info.unit==='zatoshi'?'zatoshis':info.suffix||info.unit;
   if(rows.some(row=>!validValue(row[column],info.unit)))return null;
   const known=rows.filter(row=>row[column]!==null),title=info.title,qualified=known.length<rows.length?' with known values':'';
   if(!known.length){sentences.push(`The ${title} was unavailable in all returned observations.`);continue;}
   if(known.length===1){const row=known[0];sentences.push(`The ${title} was ${fact(row[column])} ${unit} on ${fact(row[axis],true)}; the other returned observations had no known value.`);continue;}
   let leaders=[known[0]];
   for(const row of known.slice(1)){const order=compare(row[column],leaders[0][column]);if(order==='left')leaders=[row];else if(order==='equal')leaders.push(row);}
   if(rows.length===2){
    const lead=leaders[0],other=known.find(row=>row!==lead),relation=leaders.length===2?'joint highest':'larger';
    sentences.push(`Among the returned observations, the ${title} was ${relation} on ${fact(lead[axis],true)}, at ${fact(lead[column])} ${unit}, compared with ${fact(other[column])} ${unit} on ${fact(other[axis],true)}.`);
   }else{
    const lead=leaders[0];let sentence=`Among the returned observations${qualified}, the highest ${title} was ${fact(lead[column])} ${unit} on ${fact(lead[axis],true)}.`;
    if(leaders.length>1)sentence+=` Other returned observations tied this value.`;
    sentences.push(sentence);
   }
  }
  const summary=sentences.join(' ');if(Buffer.byteLength(summary)>700)return null;
  const answer=renderExplanation({summary,observations:[],limitation:''},facts).summary;
  return Buffer.byteLength(answer)<=1000?answer:null;
 }catch{return null;}
}
module.exports={researchObservedColumns,poolProvenanceMatches,researchGroundedSummary,allowsObservedSummary};
