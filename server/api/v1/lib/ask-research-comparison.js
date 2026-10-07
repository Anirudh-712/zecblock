'use strict';
// Deterministic comparisons of labeled returned pool balances. No new data,
// identity, causation or prediction; exact decimal arithmetic without floats.
function decimal(value){if(typeof value!=='string'||!/^[-+]?\d+(?:\.\d+)?$/.test(value))return null;const negative=value[0]==='-';const [whole,fraction='']=value.replace(/^[-+]/,'').split('.');return {coefficient:BigInt(whole+fraction)*(negative?-1n:1n),scale:fraction.length};}
function compare(left,right){const a=decimal(left),b=decimal(right);if(!a||!b)return null;const scale=Math.max(a.scale,b.scale),x=a.coefficient*10n**BigInt(scale-a.scale),y=b.coefficient*10n**BigInt(scale-b.scale);return x>y?'left':x<y?'right':'equal';}
function poolComparisons(result,rows){
 if(!result.datasets.includes('daily'))return null;
 const column=pool=>result.columns.findIndex(c=>c.type==='number'&&(c.label===pool||c.label===pool+'_zec'||c.label===pool+'_zatoshis'));
 const left=column('orchard'),right=column('ironwood'),date=result.columns.findIndex(c=>c.label==='date');
 if(left<0||right<0||date<0)return null;
 const unit=label=>label.endsWith('_zec')?'ZEC':'zatoshis';if(unit(result.columns[left].label)!==unit(result.columns[right].label))return null;
 const observations=rows.map(row=>({date:row[date],leader:compare(row[left],row[right])})).filter(row=>typeof row.date==='string'&&/^20\d{2}-\d{2}-\d{2}$/.test(row.date)&&Number.isFinite(Date.parse(row.date))&&new Date(row.date).toISOString().slice(0,10)===row.date);
 const firstRight=observations.filter(row=>row.leader==='right').sort((a,b)=>a.date.localeCompare(b.date))[0];
 return {left:result.columns[left].label,right:result.columns[right].label,scope:'Returned observations only. Dates are observations, not proof of the actual crossing time or a continuous lead.',observations,firstRightDate:firstRight?.date||null};
}
function poolComparisonAnswer(result,locale){
 // Narrow, server-authored English finding for complete paired snapshot tables.
 // General SQL and other locales still use fact-bound generation.
 if(!/^en(?:-|$)/.test(locale)||result.truncated||!result.rows.length||result.rows.length>40||result.datasets.length!==1||result.datasets[0]!=='daily'||result.columns.some(c=>!['date','month','orchard','ironwood','orchard_zec','ironwood_zec','orchard_zatoshis','ironwood_zatoshis'].includes(c.label)))return null;
 const monthly=!result.columns.some(c=>c.label==='date')&&result.columns.some(c=>c.label==='month');
 const month=result.columns.findIndex(c=>c.label==='month');
 if(monthly&&result.rows.some(row=>!/^20\d{2}-\d{2}-01$/.test(row[month]||'')))return null;
 const dated=monthly?{...result,columns:result.columns.map(c=>c.label==='month'?{...c,label:'date'}:c)}:result;
 const evidence=poolComparisons(dated,dated.rows);if(!evidence||evidence.observations.length!==result.rows.length||evidence.observations.some(o=>o.leader===null))return null;
 const date=monthly?month:result.columns.findIndex(c=>c.label==='date'),left=result.columns.findIndex(c=>c.label===evidence.left),right=result.columns.findIndex(c=>c.label===evidence.right);
 const rows=[...result.rows].sort((a,b)=>a[date].localeCompare(b[date]));if(new Set(rows.map(r=>r[date])).size!==rows.length)return null;
 const first=rows[0],last=rows.at(-1),formatDate=value=>new Date(value+'T00:00:00Z').toLocaleDateString(locale,{timeZone:'UTC',...(monthly?{}:{day:'numeric'}),month:'short',year:'numeric'});
 const amount=(value,label)=>{const d=decimal(value);if(!d||d.coefficient<0n)return null;const exponent=d.scale+(label.endsWith('_zec')?0:8)-2;const divisor=exponent>=0?10n**BigInt(exponent):1n;const hundredths=exponent>=0?(d.coefficient+divisor/2n)/divisor:d.coefficient*10n**BigInt(-exponent);return (hundredths/100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g,',')+'.'+(hundredths%100n).toString().padStart(2,'0');};
 const values=[amount(first[left],evidence.left),amount(last[left],evidence.left),amount(first[right],evidence.right),amount(last[right],evidence.right)];if(values.some(v=>v===null))return null;
 if(monthly){
  let answer=`Across the returned monthly rows, Orchard went from ${values[0]} ZEC in ${formatDate(first[date])} to ${values[1]} ZEC in ${formatDate(last[date])}, while Ironwood went from ${values[2]} to ${values[3]} ZEC over those same buckets.`;
  if(evidence.firstRightDate)answer+=' '+(compare(first[left],first[right])==='right'?'Ironwood was already ahead in the earliest returned month.':`The first returned month with Ironwood ahead was ${formatDate(evidence.firstRightDate)}.`);
  const ongoing=last[date].slice(0,7)===result.retrievedAt?.slice(0,7);
  answer+='\n\n'+(ongoing?'The latest row covers an ongoing month. ':'')+'Month labels identify buckets, not the actual snapshot dates. These values do not trace transfers between pools or predict future balances. Values above are rounded; the table preserves exact decimals.';
  return answer;
 }
 let answer=rows.length>1?`Across the returned snapshots (${formatDate(first[date])} to ${formatDate(last[date])}), Orchard went from ${values[0]} to ${values[1]} ZEC, while Ironwood went from ${values[2]} to ${values[3]} ZEC.`:`On ${formatDate(first[date])}, the returned snapshot held ${values[0]} ZEC in Orchard and ${values[2]} ZEC in Ironwood.`;
 if(evidence.firstRightDate){answer+=' '+(compare(first[left],first[right])==='right'?`Ironwood was already ahead at the earliest returned snapshot.`:`The first returned snapshot with Ironwood ahead was ${formatDate(evidence.firstRightDate)}.`);}
 const closing=/date_trunc\('month'/.test(result.query.sql.replace(/\s+/g,''));const latest=new Date(last[date]+'T00:00:00Z');const endOfMonth=new Date(Date.UTC(latest.getUTCFullYear(),latest.getUTCMonth()+1,0)).getUTCDate();
 answer+='\n\n'+(closing&&latest.getUTCDate()!==endOfMonth?`The ${formatDate(last[date])} row is a partial-month observation. `:'')+'These observations do not establish the exact crossing time, trace transfers between pools or predict future balances. Values above are rounded; the table preserves exact decimals.';
 return answer;
}
module.exports={compare,poolComparisons,poolComparisonAnswer};
