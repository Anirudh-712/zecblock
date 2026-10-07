'use strict';
// Display preferences never change query order, aggregate rows, or convert units.
function defaultResearchChart(result) {
  if (!result) return {view:'table',x:0,y:0};
  const measure=result.columns.findIndex(c=>c.type==='number' && !/^(?:.*_)?(?:height|timestamp|id)$/.test(c.label.toLowerCase()));
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
module.exports={defaultResearchChart,shortLabel,supportsLine,cellLink};
