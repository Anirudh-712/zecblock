'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {gradeReply}=require('../../v1/lib/ask-research-eval');
const {cases}=require('../../v1/lib/ask-research-eval-cases');
const {formatChain}=require('../../../../lib/ask/data');
const when='2026-10-28T00:00:00Z';
const fieldType=role=>['date','month','text'].includes(role)?'text':role==='boolean'?'boolean':'number';
function result(rows,roles){return {query:{version:3,sql:'SELECT count(*) FROM blocks',limit:100},columns:roles.map((role,i)=>({key:'c'+i,label:'checked_'+i,type:fieldType(role)})),rows,truncated:false,datasets:['blocks'],fingerprint:'a'.repeat(64),retrievedAt:when,indexedThrough:when,coverage:'fixed operator fixture',units:'exact decimal strings'};}
function grade(item,rows,answer){const candidate=result(rows,item.roles),verification=result([...rows.map(row=>['reference',...row]),...rows.map(row=>['candidate',...row])],['text',...item.roles]);return gradeReply(item,{mode:'ai',answer,research:candidate},verification);}
const summer=cases.find(item=>item.id==='monthly_change_2026_summer');
const summerRows=[['2026-06-01',null,'42369',null,null],['2026-07-01','42369','43287','918','2.17'],['2026-08-01','43287','65548','22261','51.43']];
const summerAnswer='The shielded count rose by 22,261 from 43,287 in Jul 1, 2026 to 65,548 in Aug 1, 2026, a 51.43% increase. Chronologically: Jun 1, 2026 had no preceding in-range baseline and a current count of 42,369; Jul 1, 2026 had a preceding count of 42,369, current count of 43,287, signed change of 918 and percent change of 2.17%; Aug 1, 2026 had a preceding count of 43,287, current count of 65,548, signed change of 22,261 and percent change of 51.43%.';
const swaps=cases.find(item=>item.id==='swap_known_usd_rank');
const swapRows=[['eth','7640','67164165.404122879465','0'],['btc','1452','29377455.307957106106','0'],['sol','7139','21762193.338557663872','0']];
const swapAnswer='Ethereum leads the ranked chains in known reported USD subtotal, at 67,164,165.404122879465, across 7,640 tracked successful inflow swaps; none had missing valuations (0). This is the known-valued subtotal for tracked swaps, not all ZEC exchange volume. Covers indexed successful swaps from supported integrations; broader exchange activity and independent historical completeness are not established.';
const blocks=cases.find(item=>item.id==='bounded_block_transaction_join');
const blockRows=[['3500000','12','11'],['3500001','21','20'],['3500002','2','1'],['3500003','14','13'],['3500004','4','3'],['3500005','1','0'],['3500006','1','0'],['3500007','20','19'],['3500008','2','1'],['3500009','13','12'],['3500010','10','9'],['3500011','9','8'],['3500012','2','1'],['3500013','13','12'],['3500014','1','0'],['3500015','1','0'],['3500016','14','13'],['3500017','7','6'],['3500018','10','9'],['3500019','16','15']];
const blockAnswer='The largest matching observed non-coinbase transaction count is 20, at height 3,500,001; that block’s count including coinbase is 21. The requested twenty rows are shown in the result table in ascending height order, with both counts compared for each block.';

test('correct dated baseline endpoints are associated using the declared baseline row',()=>{
 const good=grade(summer,summerRows,summerAnswer);assert.equal(good.passed,true);assert.deepEqual(good.dimensions,{result:'passed',narrative:'passed',expectedOutcome:'not-applicable'});
 for(const answer of [summerAnswer.split('. Chronologically:')[0]+'.','Shielded transactions increased from 43,287 transactions on July 1, 2026 to 65,548 transactions on August 1, 2026, a change of 22,261 transactions or 51.43%.'])assert.equal(grade(summer,summerRows,answer).passed,true,answer);
 const unspecified={...summer,answerCheck:{...summer.answerCheck,baseRow:undefined}};
 assert.equal(grade(unspecified,summerRows,summerAnswer).passed,false,'baseline dates require an explicit reviewed association');
 assert.equal(grade({...summer,answerCheck:{...summer.answerCheck,baseRow:0}},summerRows,summerAnswer).passed,false);
});

test('dated endpoint support keeps direction, value, unit, key and denominator checks',()=>{
 const leading=summerAnswer.split('. Chronologically:')[0]+'.';
 for(const answer of [leading.replace('rose','fell'),leading.replace('22,261','22,260'),leading.replace('43,287','43,288'),leading.replace('65,548','65,549'),leading.replace('51.43%','51.42%'),leading.replace('Jul 1, 2026','Jun 1, 2026'),leading.replace('Aug 1, 2026','Jul 1, 2026'),leading.replace('Jul 1, 2026','Aug 1, 2026').replace('to 65,548 in Aug','to 65,548 in Jul'),leading.replace('43,287 in','43,287 USD in'),leading.replace('65,548 in','65,548 ZEC in'),leading.replace('51.43% increase','51.43% of all transactions'),leading.replace('a 51.43% increase','a 51.43% increase in June 2026')]){
  const outcome=grade(summer,summerRows,answer);assert.equal(outcome.passed,false,answer);assert.equal(outcome.dimensions.result,'passed',answer);assert.equal(outcome.dimensions.narrative,'failed',answer);
 }
});

test('only the baseline endpoint mention is exempted from competing-date attribution',()=>{
 const stem='The shielded count rose by 22,261 from 43,287 in July 1, 2026 to 65,548 in August 1, 2026, a 51.43% increase';
 for(const ending of [' in July 2026.',' in June 2026.',' on July 1, 2026.',' on June 1, 2026.']){
  const outcome=grade(summer,summerRows,stem+ending);assert.equal(outcome.passed,false,ending);assert.equal(outcome.dimensions.result,'passed');assert.equal(outcome.dimensions.narrative,'failed');assert.equal(outcome.diagnostics.reason,'change-key-association-unresolved');
 }
 for(const ending of ['.',' in August 2026.',' on August 1, 2026.'])assert.equal(grade(summer,summerRows,stem+ending).passed,true,ending);
 const prefix='In July 2026, the shielded count rose by 22,261 from 43,287 in July 1, 2026 to 65,548 in August 1, 2026, a 51.43% increase.';
 assert.equal(grade(summer,summerRows,prefix).passed,false);
});

test('declared chain names and unit-bearing subtotal subjects accept unchanged valid prose',()=>{
 assert.equal(formatChain('eth'),'Ethereum');assert.ok(swaps.answerCheck.keyAliases[0].eth.includes(formatChain('eth')));
 const good=grade(swaps,swapRows,swapAnswer);assert.equal(good.passed,true);assert.equal(good.dimensions.result,'passed');assert.equal(good.dimensions.narrative,'passed');
 assert.equal(grade(swaps,swapRows,swapAnswer.replace('Ethereum','ETH')).passed,true);
 assert.equal(grade({...swaps,answerCheck:{...swaps.answerCheck,unitInSubject:false}},swapRows,swapAnswer).passed,false,'the currency-in-subject convention is explicitly opted in');
 assert.equal(grade({...swaps,answerCheck:{...swaps.answerCheck,keyAliases:undefined}},swapRows,swapAnswer).passed,false,'no model-created or guessed chain alias');
});

test('chain aliases never waive wrong leader, monetary units, exact amount or contradictory key claims',()=>{
 for(const answer of [swapAnswer.replace('Ethereum','Bitcoin'),swapAnswer.replace('Ethereum','Solana'),swapAnswer.replace('Ethereum','Ether'),swapAnswer.replace('Ethereum leads','Ethereum lost to Bitcoin, which leads'),swapAnswer.replace('67164165.404122879465','67164165.404122879466').replace('67,164,165.404122879465','67,164,165.404122879466'),swapAnswer.replace('at 67,164,165.404122879465,','at 67,164,165.404122879465 ZEC,'),swapAnswer.replace('at 67,164,165.404122879465,','at 67,164,165.404122879465 BTC,'),swapAnswer.replace('at 67,164,165.404122879465,','at 67,164,165.404122879465 EUR,'),swapAnswer.replace('known reported USD subtotal','known reported ZEC subtotal'),swapAnswer.replace('leads','has the lowest value'),swapAnswer.replace('67,164,165.404122879465','6,7164,165.404122879465')]){
  const outcome=grade(swaps,swapRows,answer);assert.equal(outcome.passed,false,answer);assert.equal(outcome.dimensions.result,'passed');
 }
});

test('punctuation commas and formatted heights preserve the non-coinbase count association',()=>{
 const good=grade(blocks,blockRows,blockAnswer);assert.equal(good.passed,true);assert.equal(good.dimensions.result,'passed');assert.equal(good.dimensions.narrative,'passed');
 assert.equal(grade(blocks,blockRows,blockAnswer.replace('3,500,001','3500001')).passed,true);
});

test('the coinbase-inclusive count, wrong block and wrong units remain failed findings',()=>{
 for(const answer of [blockAnswer.replace('count is 20,','count is 21,'),blockAnswer.replace('3,500,001','3,500,002'),blockAnswer.replace('count is 20,','count is 20 USD,'),blockAnswer.replace('count is 20,','count is 20 bytes,'),blockAnswer.replace('count is 20,','count is 20 records,'),blockAnswer.replace('count is 20,','count is 20%,'),blockAnswer.replace('largest','smallest'),blockAnswer.replace('20, at','20, or in fact 21, at')])assert.equal(grade(blocks,blockRows,answer).passed,false,answer);
});

test('ordinary punctuation after exact decimals is distinct from malformed digit grouping',()=>{
 const item={id:'fixed_unit_fixture',kind:'research',roles:['usd'],minRows:1,maxRows:1,resultCheck:{keyColumns:[],ordered:false},answerCheck:{type:'value',row:0,column:0,subject:'known USD subtotal',unit:'USD',unitInSubject:true}};
 for(const answer of ['The known USD subtotal is 12,345.67, with other observations reported separately.','The known USD subtotal was 12,345.67 USD, with other observations reported separately.'])assert.equal(grade(item,[['12345.67']],answer).passed,true,answer);
 for(const answer of ['The known USD subtotal is 12,345.6701, with other observations reported separately.','The known USD subtotal is 1,2345.67, with other observations reported separately.','The known USD subtotal is 12,345.67 ZEC, with other observations reported separately.'])assert.equal(grade(item,[['12345.67']],answer).passed,false,answer);
});

test('the independently observed annual model error remains a failed finding',()=>{
 const item=cases.find(value=>value.id==='annual_2025'),fixture=require('../fixtures/ask-monthly-change-2025.json'),rows=fixture.rows.map(row=>[row[0],row[1],row[2],row[4],row[5]]);
 const wrong='Shielded counts peaked in 2025-11-01 00:00:00 at 63,100 transactions, while transparent counts peaked that month at 410,477; the shielded share was 13.32%. The three-month rolling average of shielded transactions reached 52,099 in 2025-12-01 00:00:00. The largest absolute month-to-month change was a decrease of 23,078 shielded transactions in 2025-12-01 00:00:00 versus 63,100 the previous month.';
 const outcome=grade(item,rows,wrong);assert.equal(outcome.passed,false);assert.equal(outcome.dimensions.result,'passed');assert.equal(outcome.dimensions.narrative,'failed');
});
