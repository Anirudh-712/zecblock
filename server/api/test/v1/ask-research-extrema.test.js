'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {researchExtrema}=require('../../v1/lib/ask-research-extrema');
const columns=[{key:'c0',label:'month',type:'text'},{key:'c1',label:'change',type:'number'}];
test('minimum, maximum and largest magnitude keep signed exact cell references distinct',()=>{
 const rows=[['2025-01',null],['2025-02','50'],['2025-03','-200'],['2025-04','75']];
 assert.deepEqual(researchExtrema(columns,rows),[{column:'c1',minimum:{facts:['row_c_b'],additionalTies:false},maximum:{facts:['row_d_b'],additionalTies:false},largestMagnitude:{facts:['row_c_b'],additionalTies:false}}]);
 assert.equal(rows[2][1],'-200','the original signed value is unchanged');
});
test('comparison preserves exact large integers, decimal scale, negative zero and tied extrema',()=>{
 const large=researchExtrema(columns,[['a','9007199254740992.000'],['b','9007199254740993'],['c','-9007199254740993.0']])[0];
 assert.deepEqual(large.maximum.facts,['row_b_b']);assert.deepEqual(large.minimum.facts,['row_c_b']);assert.deepEqual(large.largestMagnitude.facts,['row_b_b','row_c_b']);
 const zeros=researchExtrema(columns,[['a','-0.000'],['b','0'],['c','+00.0']])[0];
 assert.deepEqual(zeros.minimum,{facts:['row_a_b','row_b_b'],additionalTies:true});assert.deepEqual(zeros.maximum,zeros.minimum);
 const decimals=researchExtrema(columns,[['a','0.000000001'],['b','0.000000002'],['c','-0.000000003']])[0];
 assert.deepEqual(decimals.maximum.facts,['row_b_b']);assert.deepEqual(decimals.largestMagnitude.facts,['row_c_b']);
});
test('unknown numeric encodings and absent observations cannot fabricate an extremum',()=>{
 assert.deepEqual(researchExtrema(columns,[['a','1e20'],['b','2']]),[]);
 assert.deepEqual(researchExtrema(columns,[['a','NaN']]),[]);
 assert.deepEqual(researchExtrema(columns,[['a',null]])[0],{column:'c1',minimum:null,maximum:null,largestMagnitude:null});
 assert.deepEqual(researchExtrema(columns,Array(41).fill(['a','1'])),[]);
});
test('preview metadata has bounded tie references and follows the existing fact alphabet beyond row twenty-six',()=>{
 const output=researchExtrema(columns,Array.from({length:40},(_,i)=>['label',String(i)]))[0];
 assert.deepEqual(output.maximum.facts,['row_an_b']);
 const ties=researchExtrema(columns,Array(40).fill(['label','1']))[0];assert.equal(ties.maximum.additionalTies,true);assert.equal(ties.maximum.facts.length,2);
});
