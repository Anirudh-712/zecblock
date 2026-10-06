/* eslint-disable @typescript-eslint/no-require-imports */
const {researchDocumentSchema,researchLibrarySchema}=require('./research-contract');
const STORAGE_KEY='zecblock.research.v1';
const MAX_BYTES=2*1024*1024;
const emptyLibrary=()=>({format:'zecblock-library',version:1,documents:[],dashboards:[]});
function bounded(text){if(typeof text!=='string'||new TextEncoder().encode(text).length>MAX_BYTES)throw Error('Research files must be under 2 MB');return text;}
function readLibrary(storage){const raw=storage.getItem(STORAGE_KEY);return {raw,library:raw===null?emptyLibrary():researchLibrarySchema.parse(JSON.parse(bounded(raw)))};}
function writeLibrary(storage,library,previous){
 const text=bounded(JSON.stringify(researchLibrarySchema.parse(library)));
 if(storage.getItem(STORAGE_KEY)!==previous)throw Error('Your library changed in another tab. Reload before saving.');
 storage.setItem(STORAGE_KEY,text);return text;
}
function readPortable(text){const value=JSON.parse(bounded(text));return value?.format==='zecblock-research'?researchDocumentSchema.parse(value):researchLibrarySchema.parse(value);}
function mergePortable(current,incoming,uuid){
 researchLibrarySchema.parse(current);
 const library=incoming.format==='zecblock-research'?{...emptyLibrary(),documents:[researchDocumentSchema.parse(incoming)]}:researchLibrarySchema.parse(incoming);
 const ids=new Map(library.documents.map(d=>[d.id,uuid()]));
 const merged={...current,documents:[...current.documents,...library.documents.map(d=>({...d,id:ids.get(d.id)}))],dashboards:[...current.dashboards,...library.dashboards.map(d=>({...d,id:uuid(),items:d.items.map(id=>ids.get(id))}))]};
 bounded(JSON.stringify(merged));return researchLibrarySchema.parse(merged);
}
const plain=s=>String(s).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');
function markdownReport(input){
 const d=researchDocumentSchema.parse(input),r=d.result;
 const ticks=Math.max(3,...[...d.query.sql.matchAll(/`+/g)].map(m=>m[0].length+1));const fence='`'.repeat(ticks);
 const cell=s=>plain(s===null?'Unavailable':s).replaceAll('\\','\\\\').replaceAll('|','\\|').replace(/[\r\n]/g,' ');
 return `# ${plain(d.title)}\n\n${plain(d.notes)}\n\nSaved: ${d.savedAt}\n\n## Query\n\n${fence}sql\n${d.query.sql}\n${fence}\n\n${r?`## Results\n\nRetrieved: ${r.retrievedAt}\nIndexed through: ${r.indexedThrough}\nCoverage: ${plain(r.coverage)}\n${plain(r.units)}\n\n| ${r.columns.map(c=>cell(c.label)).join(' | ')} |\n| ${r.columns.map(()=>'---').join(' | ')} |\n${r.rows.map(row=>'| '+row.map(cell).join(' | ')+' |').join('\n')}\n\n${r.truncated?'Result truncated to the selected row limit.':'All returned rows included.'}`:'No result snapshot saved.'}\n\nSaved files are editable snapshots, not signed evidence. Rerun the query to verify current data.\n`;
}
module.exports={STORAGE_KEY,MAX_BYTES,emptyLibrary,readLibrary,writeLibrary,readPortable,mergePortable,markdownReport};
