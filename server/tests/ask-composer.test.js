'use strict';
const test=require('node:test'), assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),Module=require('node:module'),ts=require('typescript'),React=require('react');
const {renderToStaticMarkup}=require('react-dom/server');
const {sqlDraft}=require('../../lib/ask/composer');
function load(file,imports={}){const filename=path.resolve(__dirname,'../../'+file),m=new Module(filename,module);m.filename=filename;m.paths=Module._nodeModulePaths(path.dirname(filename));const base=m.require.bind(m);m.require=name=>Object.hasOwn(imports,name)?imports[name]:name.endsWith('.module.css')?new Proxy({},{get:(_,key)=>key}):base(name);m._compile(ts.transpileModule(fs.readFileSync(filename,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.CommonJS}}).outputText,filename);return m.exports;}
const {ApiError}=load('lib/api-client.ts');
const client=load('lib/ask/client.ts',{'@/lib/api-client':{ApiError},'@/lib/api-config':{getApiUrl:()=>''}});
const {AskFeedback,AskFailureFeedback}=load('components/ask/AskFeedback.tsx',{'@/lib/ask/client':client});
test('SQL detection preserves full query and routes SQL fences/comments/CTEs away from AI; ordinary questions remain questions',()=>{
 const sql='-- notes\nWITH bounded AS (SELECT height FROM blocks LIMIT 100) SELECT * FROM bounded';
 assert.equal(sqlDraft(sql),sql);assert.equal(sqlDraft('WITH RECURSIVE x AS (SELECT 1) SELECT * FROM x'),'WITH RECURSIVE x AS (SELECT 1) SELECT * FROM x');assert.equal(sqlDraft('```sql\nSELECT 1\n```'),'SELECT 1');
 assert.equal(sqlDraft('/* read */ SELECT height FROM blocks'), '/* read */ SELECT height FROM blocks');
 const long='SELECT height FROM blocks -- '+ 'x'.repeat(1200);assert.equal(sqlDraft(long),long);
 for(const text of ['Compare pool balances','Select the busiest week for Zcash','With more details please','Explain this SQL: SELECT * FROM blocks'])assert.equal(sqlDraft(text),null);
 for(const text of ['DELETE FROM blocks','DROP TABLE blocks',"SELECT pg_read_file('/etc/passwd') FROM blocks"])assert.equal(sqlDraft(text),text);
});
test('only bounded admission limits produce a reset time; unknown budgets never promise an automatic reset',()=>{
 const now=Date.parse('2026-10-06T23:50:00Z');
 const daily=client.askFailure(new ApiError('untrusted secret',429,undefined,undefined,'600','ask-quota-day'),now);
 assert.equal(daily.retryAt,Date.parse('2026-10-07T00:00:00Z'));assert.match(daily.detail,/20 requests/);assert.doesNotMatch(daily.detail,/secret/);
 for(const [code,header] of [['ask-quota','60'],['ask-quota-day','Infinity'],['ask-quota-minute','999999'],['ask-quota-day','-1']])assert.equal(client.askFailure(new ApiError('raw',429,undefined,undefined,header,code),now).retryAt,undefined);
 assert.match(client.askErrorMessage(new ApiError('raw',400)),/syntax/);
});
test('progress, inline errors, quota resets and retries have accessible, safe markup',()=>{
 const working=renderToStaticMarkup(React.createElement(AskFeedback,{title:'Running your query…',detail:'Reading public data.',working:true,extra:'7s elapsed'}));
 assert.match(working,/role="status"/);assert.match(working,/aria-live="polite"/);assert.match(working,/aria-hidden="true">7s/);
 const failure={title:'Request limit reached',detail:'The daily allowance is used.',retryAt:Date.parse('2026-10-07T00:00:00Z'),retryable:false};
 const blocked=renderToStaticMarkup(React.createElement(AskFailureFeedback,{failure,blocked:true,onRetry:()=>{}}));assert.match(blocked,/Resets at/);assert.doesNotMatch(blocked,/<button/);
 const ready=renderToStaticMarkup(React.createElement(AskFailureFeedback,{failure,blocked:false,onRetry:()=>{}}));assert.match(ready,/You can try again/);assert.match(ready,/<button/);
 const unsafe=renderToStaticMarkup(React.createElement(AskFeedback,{title:'<script>bad()</script>',error:true}));assert.match(unsafe,/role="alert"/);assert.doesNotMatch(unsafe,/<script>/);
});
