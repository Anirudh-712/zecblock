'use strict';
// Report returned columns, never infer an answer, a denominator or a time window.
// This is a bounded fallback for prose that failed validation, not a SQL verifier.
const suffixes={zec:'ZEC',zatoshi:'zatoshis',usd:'USD'};
const supported=new Set(['count','scalar',...Object.keys(suffixes)]);
function researchValueSummary(result,inferred,locale){
 if(!/^en(?:-|$)/.test(locale)||result.truncated||result.rows.length!==1||result.columns.length>6||!result.columns.length||inferred.length!==result.columns.length)return null;
 const labels=new Set(),lines=[];
 for(const [index,column] of result.columns.entries()){
  const info=inferred[index],value=result.rows[0][index];
  if(column.type!=='number'||!info||info.name!==column.label||!supported.has(info.unit)||!/^[a-zA-Z_][a-zA-Z_0-9]{0,62}$/.test(column.label)||labels.has(column.label.toLowerCase()))return null;
  labels.add(column.label.toLowerCase());
  // A query alias must not make unconverted zatoshis look like ZEC, or make a
  // count/USD valuation look like a ZEC-denominated amount.
  const hints=column.label.replace(/([a-z0-9])([A-Z])/g,'$1_$2').toLowerCase().split('_').filter(part=>/^(?:zec|usd|zatoshis?|zats?)$/.test(part));
  if(hints.some(hint=>(hint==='zec'?'zec':hint==='usd'?'usd':'zatoshi')!==info.unit))return null;
  if(value!==null&&(typeof value!=='string'||!/^[-+]?\d+(?:\.\d+)?$/.test(value)))return null;
  let formatted='Unavailable';
  if(value!==null){
   const [whole,fraction]=value.split('.');const tail=fraction?.replace(/0+$/,'');
   formatted=whole.replace(/\B(?=(\d{3})+(?!\d))/g,',')+(tail?'.'+tail:'')+(suffixes[info.unit]?' '+suffixes[info.unit]:'');
  }
  // Labels stay verbatim and are explicitly described as query columns. They
  // are not promoted to verified metric definitions or model instructions.
  lines.push(column.label+': '+formatted);
 }
 const answer='Returned query values:\n'+lines.join('\n')+'\n\nThe generated explanation could not be verified.';
 return Buffer.byteLength(answer,'utf8')<=700?answer:null;
}
module.exports={researchValueSummary};
