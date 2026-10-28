'use strict';
// Exact cell comparisons for the bounded narrative preview. These describe
// returned values only, never metric meaning, unreturned changes or causation.
function magnitude(value){
 if(typeof value!=='string'||value.length>1000)return null;
 const match=/^([+-]?)(\d+)(?:\.(\d+))?$/.exec(value);if(!match)return null;
 const whole=match[2].replace(/^0+(?=\d)/,''),fraction=(match[3]||'').replace(/0+$/,'');
 return {negative:match[1]==='-'&&(whole!=='0'||fraction!==''),whole,fraction};
}
function compare(left,right,absolute=false){
 if(!absolute&&left.negative!==right.negative)return left.negative?-1:1;
 const scale=Math.max(left.fraction.length,right.fraction.length);
 const a=left.whole+left.fraction.padEnd(scale,'0'),b=right.whole+right.fraction.padEnd(scale,'0');
 const value=a.length!==b.length?Math.sign(a.length-b.length):a===b?0:a>b?1:-1;
 return !absolute&&left.negative?-value:value;
}
function researchExtrema(columns,rows){
 if(!Array.isArray(columns)||!Array.isArray(rows)||columns.length>24||rows.length>40)return [];
 return columns.flatMap((column,j)=>{
  if(column.type!=='number')return [];
  const available=[];
  for(const [i,row] of rows.entries()){
   if(row[j]===null)continue;
   const value=magnitude(row[j]);if(!value)return [];
   available.push({value,fact:`row_${i<26?String.fromCharCode(97+i):'a'+String.fromCharCode(97+i-26)}_${String.fromCharCode(97+j)}`});
  }
  const extremum=(direction,absolute=false)=>{
   if(!available.length)return null;
   let leader=available[0],ties=[];
   for(const entry of available){const relation=compare(entry.value,leader.value,absolute)*direction;if(relation>0){leader=entry;ties=[entry.fact];}else if(relation===0)ties.push(entry.fact);}
   return {facts:ties.slice(0,2),additionalTies:ties.length>2};
  };
  return [{column:column.key,minimum:extremum(-1),maximum:extremum(1),largestMagnitude:extremum(1,true)}];
 });
}
module.exports={researchExtrema};
