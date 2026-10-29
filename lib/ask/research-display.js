'use strict';
// Display preferences never change query order, aggregate rows, or convert units.
function defaultResearchChart(result) {
  if (!result) return {view:'table',x:0,y:0};
  // Prefer an amount/share column (zec, usd, fees, pct…) over a count of records.
  const measures=result.columns.map((c,i)=>({c,i})).filter(({c})=>c.type==='number' && !/^(?:.*_)?(?:height|timestamp|id)$/.test(c.label.toLowerCase()));
  const amount=measures.find(({c})=>/(?:zec|usd|amount|fees?|value|share|pct|percent|balance)/i.test(c.label));
  const measure=(amount||measures[0])?.i ?? -1;
  const numeric=result.columns.findIndex(c=>c.type==='number');
  return {view:'table',x:0,y:Math.max(0,measure < 0 ? numeric : measure)};
}
function shortLabel(value) {
  const text=String(value ?? 'Unavailable');
  return text.length>22 ? text.slice(0,10)+'…'+text.slice(-6) : text;
}
function supportsLine(result,x) {
  const column=result.columns[x];
  if(!column || result.rows.length<2)return false;
  const values=result.rows.map(row=>row[x]===null ? NaN : column.type==='number' ? Number(row[x]) : /^\d{4}-\d{2}-\d{2}(?:$|[T ])/.test(row[x]) ? Date.parse(row[x]) : NaN);
  if(values.some(v=>!Number.isFinite(v)))return false;
  const direction=Math.sign(values[1]-values[0]);
  return direction!==0 && values.every((value,i)=>i===0 || Math.sign(value-values[i-1])===direction);
}
function cellLink(key,value) {
  if(!value)return null;
  if((key==='txid'||key==='transaction_hash') && /^[0-9a-f]{64}$/i.test(value))return '/tx/'+value;
  if((key==='height'||key==='block_height') && /^[1-9]\d{0,8}$/.test(value))return '/block/'+value;
  if((key==='miner'||key==='address') && /^t[13][1-9A-HJ-NP-Za-km-z]{33}$/.test(value))return '/address/'+value;
  return null;
}
// Bar labels keep every text column ("deshield · ironwood"), led by the chosen label column.
// A column already shown by bar colour is left out of the label.
function chartLabel(result,row,x,colourColumn=-1) {
  const parts=[x,...result.columns.map((c,i)=>({c,i})).filter(({c,i})=>c.type!=='number'&&i!==x).map(({i})=>i)].filter(i=>i!==colourColumn).map(i=>row[i]).filter(v=>v!==null&&v!=='');
  return parts.length?parts.join(' · '):String(row[x]??'Unavailable');
}
// Shield/deshield and inflow/outflow use the site's semantic flow colours;
// other small categories use a fixed palette. Only 2–6 distinct values colour.
const SEMANTIC={shield:'var(--color-shielding)',deshield:'var(--color-deshielding)',inflow:'var(--color-shielding)',outflow:'var(--color-deshielding)'};
const PALETTE=['var(--color-gold)','var(--color-purple)','var(--color-green)','var(--color-orange)','var(--color-text-secondary)','var(--color-yellow)'];
function chartSeries(result,x) {
  const order=[x,...result.columns.map((_,i)=>i).filter(i=>i!==x)];
  for (const i of order) {
    if (result.columns[i].type==='number') continue;
    const values=[...new Set(result.rows.map(row=>row[i]??'Unavailable'))];
    if (values.length<2||values.length>6) continue;
    const colors=new Map(values.map((v,k)=>[v,SEMANTIC[String(v).toLowerCase()]||PALETTE[k%PALETTE.length]]));
    return {column:i,legend:values.map(value=>({value,color:colors.get(value)})),colorFor:value=>colors.get(value??'Unavailable')};
  }
  return null;
}
module.exports={defaultResearchChart,shortLabel,supportsLine,cellLink,chartLabel,chartSeries};
