'use strict';
const {compileResearchSQL}=require('./ask-research-sql');
const {researchResultSchema}=require('../../../../lib/ask/research-contract');
const receipt=/^Your query returned \d+ records?\. The results are available in the table below\.$/;
function decimal(value,places){
 if(value===null)return null;
 const match=/^([+-]?)(\d+)(?:\.(\d+))?$/.exec(value);if(!match)return undefined;
 let digits=match[2]+(match[3]||''),scale=(match[3]||'').length;
 let integer=BigInt(digits)*(match[1]==='-'?-1n:1n);
 if(places!==undefined&&scale>places){const divisor=10n**BigInt(scale-places),negative=integer<0n;let magnitude=negative?-integer:integer;magnitude=(magnitude+divisor/2n)/divisor;integer=negative?-magnitude:magnitude;scale=places;}
 while(scale&&integer%10n===0n){integer/=10n;scale--;}
 return `${integer}:${scale}`;
}
function dateKey(value){
 if(typeof value!=='string')return null;
 const match=/^(20\d{2}-\d{2}-\d{2})(?:[ T]00:00:00(?:\.0+)?(?:Z|\+00(?::00)?)?)?$/.exec(value);
 const parsed=match?new Date(match[1]+'T00:00:00Z'):null;
 return parsed&&Number.isFinite(parsed.valueOf())&&parsed.toISOString().slice(0,10)===match[1]?match[1]:null;
}
function normalized(value,role){return role==='month'?dateKey(/^20\d{2}-\d{2}$/.test(value)?value+'-01':value):role==='date'?dateKey(value):decimal(value,role==='percent'||role==='average'?2:role==='zec'?8:undefined);}
function equivalent(left,right,role){const a=normalized(left,role),b=normalized(right,role);return a!==undefined&&b!==undefined&&a===b&&(!['date','month'].includes(role)||a!==null);}
async function comparisonQuery(item,candidate){
 if(item.kind!=='research')throw Error('Research case required');
 const draft=researchResultSchema.parse(candidate),width=Math.max(draft.columns.length,item.roles.length);
 if(width>23||draft.truncated)throw Error('Evaluation result too wide or truncated');
 // Positional derived-table aliases avoid relying on model-authored labels.
 // Text casts preserve exact decimals; the private compiler still checks both
 // nested SELECTs. No compiler policy or SQL limits are changed for an eval.
 const side=(sql,name,count)=>`SELECT '${name}' AS evaluation_side,${Array.from({length:width},(_,i)=>i<count?`${name}_cell_${i}::text AS evaluation_cell_${i}`:`NULL::text AS evaluation_cell_${i}`).join(',')} FROM (${sql}) AS ${name}_rows(${Array.from({length:count},(_,i)=>`${name}_cell_${i}`).join(',')})`;
 const query={version:3,sql:side(item.referenceSQL,'reference',item.roles.length)+' UNION ALL '+side(draft.query.sql,'candidate',draft.columns.length),limit:200};
 return (await compileResearchSQL(query,{extended:true})).request;
}
function verificationFailure(stage,counts={}){return Object.assign(Error('Evaluation verification failed'),{verificationDiagnostic:{stage,...counts}});}
function splitComparison(item,candidate,raw){
 const parsed=researchResultSchema.safeParse(raw);if(!parsed.success)throw verificationFailure('verification-shape');
 const verification=parsed.data,counts={initialRows:candidate.rows.length,initialColumns:candidate.columns.length,verificationRows:verification.rows.length,verificationColumns:verification.columns.length};
 if(candidate.truncated||verification.truncated)throw verificationFailure('truncated',counts);
 if(verification.columns.length!==1+Math.max(item.roles.length,candidate.columns.length))throw verificationFailure('verification-width',counts);
 const reference=[],observed=[];
 for(const row of verification.rows){if(row[0]==='reference')reference.push(row.slice(1,1+item.roles.length));else if(row[0]==='candidate')observed.push(row.slice(1,1+candidate.columns.length));else throw verificationFailure('verification-tag',counts);}
 counts.referenceRows=reference.length;counts.candidateRows=observed.length;
 if(reference.length<item.minRows||reference.length>item.maxRows)throw verificationFailure('reference-coverage',counts);
 if(observed.length!==reference.length)throw verificationFailure('candidate-coverage',counts);
 // PG boolean wire output is t/f, while its SQL ::text cast is true/false.
 // Normalize only columns the worker identified as BOOLEAN. TEXT t/f and all
 // other cells remain exact; false, true and null are always distinct.
 const cell=(value,i)=>candidate.columns[i].type==='boolean'?(value==='t'?'true':value==='f'?'false':value):value;
 const signature=rows=>JSON.stringify(rows.map(row=>JSON.stringify(row.map(cell))).sort());
 if(signature(observed)!==signature(candidate.rows)){
  const differingColumns=candidate.columns.flatMap((_,i)=>JSON.stringify(observed.map(row=>cell(row[i],i)).sort())===JSON.stringify(candidate.rows.map(row=>cell(row[i],i)).sort())?[]:[i]);
  throw verificationFailure('snapshot-mismatch',{...counts,differingColumns});
 }
 return {reference,observed};
}
function matchRoles(item,reference,observed){
 const options=item.roles.map((role,roleIndex)=>{
  const matches=[];
  for(let column=0;column<observed[0].length;column++){
   // Match date-keyed vectors; result row and column order may differ.
   if(roleIndex===0){if(observed.map(row=>normalized(row[column],role)).sort().join(',')===reference.map(row=>normalized(row[0],role)).sort().join(',')&&observed.every(row=>normalized(row[column],role)))matches.push(column);continue;}
   matches.push(column);
  }
  return matches;
 });
 for(const dateColumn of options[0]){
  const byDate=new Map(observed.map(row=>[normalized(row[dateColumn],item.roles[0]),row]));
  if(byDate.size!==reference.length||new Set(reference.map(row=>normalized(row[0],item.roles[0]))).size!==reference.length)continue;
  const candidates=options.map((columns,i)=>i===0?[dateColumn]:columns.filter(column=>reference.every(row=>equivalent(row[i],byDate.get(normalized(row[0],item.roles[0]))?.[column],item.roles[i]))));
  const mapping=[];function assign(i){if(i===candidates.length)return true;for(const column of candidates[i])if(!mapping.includes(column)){mapping[i]=column;if(assign(i+1))return true;mapping.length=i;}return false;}
  if(assign(0))return mapping;
 }
 return null;
}
function mentionsValue(answer,value){
 if(value===null)return /\b(?:unavailable|missing|unknown)\b/i.test(answer);
 const expected=decimal(value);if(expected===undefined)return false;
 return [...answer.matchAll(/(?<![\w.,])[-+]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?(?![\w,]|\.\d)/g)].some(match=>decimal(match[0].replaceAll(',',''))===expected);
}
function mentionsDate(answer,value){
 const day=dateKey(value);if(!day)return false;if(answer.includes(day))return true;
 const [year,month,date]=day.split('-'),name=['January','February','March','April','May','June','July','August','September','October','November','December'][Number(month)-1],monthWord=`(?:${name}|${name.slice(0,3)})`;
 return new RegExp(`\\b(?:${Number(date)}\\s+${monthWord}\\s*,?\\s*${year}|${monthWord}\\s+${Number(date)}\\s*,?\\s*${year})\\b`,'i').test(answer);
}
function mentionsMonth(answer,value){
 const day=dateKey(value);if(!day)return false;
 const [year,month]=day.split('-'),name=['January','February','March','April','May','June','July','August','September','October','November','December'][Number(month)-1];
 return answer.includes(day.slice(0,7))||new RegExp(`\\b(?:${name}|${name.slice(0,3)})\\s*,?\\s*${year}\\b`,'i').test(answer)||mentionsDate(answer,value);
}
function compareDecimal(left,right){const [a,sa]=decimal(left).split(':'),[b,sb]=decimal(right).split(':'),scale=Math.max(Number(sa),Number(sb)),delta=BigInt(a)*10n**BigInt(scale-Number(sa))-BigInt(b)*10n**BigInt(scale-Number(sb));return delta<0n?-1:delta>0n?1:0;}
function usefulFinding(item,answer,reference){
 if(receipt.test(answer.trim())||answer.length<20||answer.includes('{{'))return false;
 if(item.finding==='fee')return /\bfees?\b/i.test(answer)&&mentionsValue(answer,reference[0][3])&&(reference[0][3]===null||/\bZEC\b/.test(answer));
 if(item.finding==='baseline'){const leader=[...reference].sort((a,b)=>compareDecimal(b[3],a[3])||a[0].localeCompare(b[0]))[0];return mentionsDate(answer,leader[0])&&/\b(?:above|baseline|preceding|average)\b/i.test(answer)&&mentionsValue(answer,leader[3])&&/%|percent/i.test(answer);}
 if(item.finding==='annual_change'){
  const sorted=[...reference].sort((a,b)=>a[0].localeCompare(b[0]));let largest=0n,leaders=[];
  for(let i=1;i<sorted.length;i++){if(!/^\d+$/.test(sorted[i][1])||!/^\d+$/.test(sorted[i-1][1]))return false;const delta=BigInt(sorted[i][1])-BigInt(sorted[i-1][1]),size=delta<0n?-delta:delta;if(size>largest){largest=size;leaders=[];}if(size===largest)leaders.push({prior:sorted[i-1],next:sorted[i],delta});}
  return leaders.some(({prior,next,delta})=>mentionsMonth(answer,next[0])&&/shielded/i.test(answer)&&(delta<0n?/\b(?:fell|fall|drop|decreas|declin|down)\w*/i:/\b(?:rose|rise|increas|grew|growth|up)\w*/i).test(answer)&&(mentionsValue(answer,String(largest))||mentionsValue(answer,prior[1])&&mentionsValue(answer,next[1])));
 }
 return false;
}
function gradeReply(item,reply,verification=null){
 const answer=typeof reply?.answer==='string'?reply.answer:'',checks=[];
 if(reply?.mode!=='ai')checks.push('ai-path-required');
 if(item.kind!=='research'){
  if(reply?.job||reply?.research||reply?.analytics||reply?.transfers||reply?.blocks||reply?.transactions||reply?.spec)checks.push('unexpected-data-query');
  if(item.kind==='clarify'&&(!/\?|\b(?:which|choose|tell me)\b/i.test(answer)||!/\b(?:measure|metric|transaction|fee|volume)\w*\b/i.test(answer)||!/\b(?:baseline|compar|window)\w*\b/i.test(answer)))checks.push('clarification-not-useful');
  if(item.kind==='unavailable'&&(!/\b(?:cannot|can't|unavailable|unknown|not available|not reveal|not identify|do not identify)\b/i.test(answer)||/\b(?:belongs? to|owned by)\b/i.test(answer)))checks.push('private-facts-not-refused');
  return {passed:!checks.length,checks};
 }
 let reference,diagnostics,candidate;
 const parsed=researchResultSchema.safeParse(reply?.research);
 if(!parsed.success){checks.push('result-not-verified');diagnostics={stage:'candidate-shape'};}
 else{
  candidate=parsed.data;
  try{const pair=splitComparison(item,candidate,verification);reference=pair.reference;if(!matchRoles(item,pair.reference,pair.observed))checks.push('measures-or-window-mismatch');}
  catch(error){checks.push('result-not-verified');diagnostics=error.verificationDiagnostic||{stage:'verification-shape'};}
 }
 if(receipt.test(answer.trim()))checks.push('receipt-fallback');
 if(reference&&!usefulFinding(item,answer,reference))checks.push('requested-finding-missing');
 return {passed:!checks.length,checks,...(diagnostics?{diagnostics}:{})};
}
module.exports={decimal,dateKey,comparisonQuery,splitComparison,matchRoles,usefulFinding,gradeReply};
