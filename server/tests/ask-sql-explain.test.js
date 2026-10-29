'use strict';
// Opt-in "Explain results" for SQL runs: offered only for a finished queued SQL
// job while AI is available, sends that job's ticket once, and never appears
// for guided mode or synchronous runs without a ticket.
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),Module=require('node:module'),ts=require('typescript');
const React=require('react'),{renderToStaticMarkup}=require('react-dom/server');
function load(file,imports={}) {
  const filename=path.resolve(__dirname,'../../'+file),m=new Module(filename,module);m.filename=filename;m.paths=Module._nodeModulePaths(path.dirname(filename));const base=m.require.bind(m);
  m.require=name=>Object.hasOwn(imports,name)?imports[name]:name.endsWith('.module.css')?{default:new Proxy({},{get:(_,key)=>String(key)})}:base(name);
  m._compile(ts.transpileModule(fs.readFileSync(filename,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.CommonJS}}).outputText,filename);return m.exports;
}
const ticket={id:'00000000-0000-4000-8000-000000000009',token:'a'.repeat(64)};
const result={query:{version:3,sql:'SELECT height FROM blocks LIMIT 1',limit:100},columns:[{key:'c0',label:'height',type:'number'}],rows:[['3534601']],truncated:false,datasets:['blocks'],fingerprint:'b'.repeat(64),retrievedAt:'2026-10-29T00:00:00.000Z',indexedThrough:'2026-10-29T00:00:00.000Z',coverage:'verified canonical records',units:'Exact decimal strings.'};

async function fixture(t,{mode='ai',jobsEnabled=true}={}) {
  const states=[],effects=[],elements=[],calls={submit:[],explain:[],annotate:[],run:[]};let cursor=0,pending=[];
  const original={window:global.window,document:global.document,fetch:global.fetch,setInterval:global.setInterval,clearInterval:global.clearInterval,requestAnimationFrame:global.requestAnimationFrame};
  global.window={location:{hash:''},addEventListener(){},removeEventListener(){}};global.document={visibilityState:'visible'};
  global.fetch=async()=>new Response('{}');global.setInterval=()=>1;global.clearInterval=()=>{};global.requestAnimationFrame=fn=>fn();
  const react={
    useState(initial){const index=cursor++;if(!(index in states))states[index]=typeof initial==='function'?initial():initial;return[states[index],next=>{states[index]=typeof next==='function'?next(states[index]):next;}];},
    useRef(initial){const index=cursor++;return states[index]||(states[index]={current:initial});},
    useEffect(run,deps){const index=cursor++,previous=effects[index];if(!previous||deps.some((value,i)=>!Object.is(value,previous.deps[i])))pending.push(()=>{previous?.cleanup?.();effects[index]={deps,cleanup:run()};});},
  };
  const feedback={failure:null,failureBlocked:false,requestBlocked:false,blocked:false,blockedFor:()=>false,clear(){},report(){}};
  const runtime=require('react/jsx-runtime');const capture=fn=>(type,props,...rest)=>{elements.push({type,props});return fn(type,props,...rest);};
  const tools={library:{documents:[]},importing:false,title:'Analysis',accept(){},annotate:narrative=>{calls.annotate.push(narrative);return true;}};
  const imports={
    react,'react/jsx-runtime':{...runtime,jsx:capture(runtime.jsx),jsxs:capture(runtime.jsxs)},
    'next/link':{default:({children,...props})=>React.createElement('a',props,children)},
    '@/lib/ask/contract':require('../../lib/ask/contract'),
    '@/lib/ask/api-base':{getAskApiUrl:()=>'/v1/ask',isAuthenticatedAskStaging:()=>true},
    '@/lib/api-client':{readApiResponse:async()=>({data:{mode,provider:mode==='ai'?'OpenAI':null,researchEnabled:true,jobsEnabled,authenticatedStaging:true},meta:{network:'mainnet'}})},
    './ResearchWorkbench':{useResearchTools:()=>tools,ResearchLibrary:()=>null,ResearchDashboard:()=>null,ResearchPanel:()=>null,ResearchData:()=>null,SharedResearchDraft:()=>null},
    '@/lib/ask/research-job-contract':{jobTicketSchema:{parse:value=>value}},'@/lib/ask/research-contract':{researchResultSchema:{parse:value=>value}},
    '@/lib/ask/research-client':{
      submitResearch:async query=>{calls.submit.push(query);return ticket;},
      waitResearch:async()=>result,
      runResearch:async query=>{calls.run.push(query);return result;},
      explainResearch:async(sent,question)=>{calls.explain.push({sent,question});return{answer:'The latest returned height is 3,534,601.',locale:'en',mode:'ai',sources:[],spec:null,research:result};},
    },
    '@/components/ask/AskChallenge':{AskChallenge:()=>null},'@/components/ask/AskTransactions':{AskTransactions:()=>null},'@/components/ask/AskBlocks':{AskBlocks:()=>null},'@/components/ask/AskTransfers':{AskTransfers:()=>null},'@/components/ask/AskAnalytics':{AskAnalytics:()=>null},'@/components/ask/AskSources':{AskSources:()=>null},
    '@/lib/ask/client':{peekAskHandoff:()=>null,clearAskHandoff(){},askChat:async()=>{throw Error('unexpected chat');}},
    '@/lib/ask/composer':require('../../lib/ask/composer'),
    '@/components/ask/AskFeedback':{AskFeedback:()=>null,AskFailureFeedback:()=>null,useAskFeedback:()=>feedback},
    '@/lib/ask/data':require('../../lib/ask/data'),'@/lib/ask/research-share':require('../../lib/ask/research-share'),'@/lib/ask/follow-ups':require('../../lib/ask/follow-ups'),...require('./ask-sql-test-imports'),
    './AskAnalysis':{AskAnalysis:()=>null},
  };
  const {AskWorkspace}=load('app/ask/AskWorkspace.tsx',imports);
  let html='';
  function render(){cursor=0;pending=[];elements.length=0;html=renderToStaticMarkup(React.createElement(AskWorkspace));for(const effect of pending)effect();return html;}
  const settle=async()=>{for(let i=0;i<4;i++){await new Promise(resolve=>setImmediate(resolve));render();}};
  t.after(()=>{for(const effect of effects)effect?.cleanup?.();for(const[key,value]of Object.entries(original)){if(value===undefined)delete global[key];else global[key]=value;}});
  render();await settle();
  const button=label=>elements.find(item=>item.type==='button'&&item.props.children===label);
  async function runSQL(){
    button('SQL').props.onClick();render();
    elements.find(item=>item.props?.datasets&&typeof item.props.onRun==='function').props.onChange(result.query.sql);render();
    elements.find(item=>item.type==='form').props.onSubmit({preventDefault(){}});await settle();
  }
  return{calls,render,settle,button,runSQL,get html(){return html;}};
}

test('a finished SQL job offers Explain results, sends its ticket once and shows the checked answer',async t=>{
  const f=await fixture(t);await f.runSQL();
  assert.equal(f.calls.submit.length,1);assert.equal(f.calls.explain.length,0);
  assert.match(f.html,/1 rows returned\. No AI was used\./);
  const explain=f.button('Explain results');assert.ok(explain,'Explain results is offered after a queued SQL run');
  assert.match(explain.props.title,/AI allowance/);
  explain.props.onClick();await f.settle();
  assert.equal(f.calls.explain.length,1);assert.deepEqual(f.calls.explain[0].sent,ticket);
  assert.match(f.calls.explain[0].question,/^Analysis: What are the main findings in these results\?/);
  assert.match(f.html,/The latest returned height is 3,534,601\./);
  assert.equal(f.calls.annotate.at(-1).inputMode,'sql');assert.equal(f.calls.annotate.at(-1).fingerprint,result.fingerprint);
  assert.equal(f.button('Explain results'),undefined,'the ticket is consumed; no second paid explanation is offered');
});

test('Explain results is not offered in guided mode',async t=>{
  const guided=await fixture(t,{mode:'guided'});await guided.runSQL();
  assert.equal(guided.calls.submit.length,1);assert.equal(guided.button('Explain results'),undefined);
});
test('Explain results is not offered for a synchronous run without a job ticket',async t=>{
  const synchronous=await fixture(t,{jobsEnabled:false});await synchronous.runSQL();
  assert.equal(synchronous.calls.run.length,1);assert.equal(synchronous.button('Explain results'),undefined);
});
