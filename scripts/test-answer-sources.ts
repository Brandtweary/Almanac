import assert from 'node:assert/strict';
import {createServer} from 'vite';
import {chromium} from 'playwright';
const g='a'.repeat(64),r='b'.repeat(64),x='c'.repeat(64);
const evidence=(document_id:string,title:string,offset='d',revision=r)=>({passage_id:`p:${g}:${offset.repeat(64)}`,document_id,source_revision:revision,extraction_revision:x,title,edition:'v1',section:[],page:{index:0,label:'1',coordinates:null,anchor:null},excerpt:'Use the stated source instructions.',complete:true,previous:null,next:null,flags:[],source:{url:`/v1/corpus/source/${encodeURIComponent(`p:${g}:${offset.repeat(64)}`)}`,sha256:revision,media_type:'text/html',origin:'fixture'}});
const user=(text='Question')=>({role:'user',content:text,timestamp:1});
const answer=(text='The answer.',timestamp=4)=>({role:'assistant',content:[{type:'text',text}],timestamp,stopReason:'stop',api:'openai-completions',provider:'fixture',model:'fixture'});
const call=(id:string,name='corpus_read')=>({role:'assistant',content:[{type:'toolCall',id,name,arguments:{}}],timestamp:2,stopReason:'toolUse',api:'openai-completions',provider:'fixture',model:'fixture'});
const result=(id:string,rows:any[],name='corpus_read',isError=false)=>({role:'toolResult',toolCallId:id,toolName:name,content:[{type:'text',text:'source evidence'}],details:name==='corpus_read'?{passages:rows}:{hits:rows},timestamp:3,isError});
const first=answer(),second=answer('Another answer.',6);const doc=evidence('manual','<img src=x onerror="window.injected=true"> Manual');
const history=[user(),call('search','corpus_search'),result('search',[evidence('unread','Unrelated search match','e')],'corpus_search'),call('read'),result('read',[doc,evidence('manual','Same document','f')]),first,user('Unrelated question'),second];
const fixture=Buffer.from(JSON.stringify({history,first,second})).toString('base64');
const html=`<!doctype html><html><body><script type="module">
import '/src/pi-web-ui/components/Messages.ts';import '/src/pi-web-ui/components/MessageList.ts';
const f=JSON.parse(atob('${fixture}'));const list=document.createElement('message-list');document.body.append(list);window.list=list;window.fixture=f;list.messages=f.history;list.sourceMessages=structuredClone(f.history);await list.updateComplete;window.ready=true;
</script></body></html>`;
const server=await createServer({server:{host:'127.0.0.1',port:0},plugins:[{name:'sources-fixture',configureServer(server){server.middlewares.use(async(req,res,next)=>{if(req.url==='/__sources'){res.setHeader('Content-Type','text/html');res.end(await server.transformIndexHtml(req.url,html));}else next();})}}]});
let browser;
try{
 const {collectAnswerSources,answerIdentity}=await server.ssrLoadModule('/src/answer-sources.ts');
 const found=collectAnswerSources(history);const a=found.get(answerIdentity(first));assert.equal(a.kind,'read');assert.equal(a.sources.length,1);assert.equal(a.sources[0].document_id,'manual');assert.equal(found.get(answerIdentity(second)).sources.length,0);
 const searched=collectAnswerSources([user(),call('q','corpus_search'),result('q',[doc],'corpus_search'),first]).get(answerIdentity(first));assert.equal(searched.kind,'search');assert.equal(searched.sources.length,1);
 for(const rows of [[user(),result('missing',[doc]),first],[user(),call('q'),result('q',[doc],'corpus_read',true),first],[user(),call('q'),result('q',[{...doc,source:{...doc.source,url:'javascript:alert(1)'}}]),first],[user(),call('q'),user('next'),result('q',[doc]),first]])assert.equal(collectAnswerSources(rows).get(answerIdentity(first)).sources.length,0);
 const versioned=collectAnswerSources([user(),call('q'),result('q',[doc,evidence('manual','Second version','e','f'.repeat(64))]),first]);assert.equal(versioned.get(answerIdentity(first)).sources.length,2);
 assert.deepEqual([...collectAnswerSources(JSON.parse(JSON.stringify(history)))],[...found]);
 await server.listen();browser=await chromium.launch({executablePath:process.env.BROWSER_EXECUTABLE||'/run/current-system/sw/bin/brave',headless:true});const page=await browser.newPage();const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));await page.goto(server.resolvedUrls!.local[0]+'__sources');await page.waitForFunction(()=>!!(window as any).ready);
 const footer=page.getByRole('region',{name:'Sources'});assert.equal(await footer.count(),1);assert.match(await footer.innerText(),/Read from the library/);assert.equal(await footer.locator('a').count(),1);assert.equal(await footer.locator('img').count(),0);const link=footer.locator('a');assert.match(await link.getAttribute('href')||'',/\/corpus\/source\/p%3A/);assert.equal(await link.getAttribute('target'),'_blank');assert(!(await footer.innerText()).includes('Unrelated search match'));
 await page.evaluate(async()=>{const w=window as any;w.list.messages=[{role:'compactionSummary',summary:'Prior conversation condensed'},w.fixture.first];w.list.sourceMessages=JSON.parse(JSON.stringify(w.fixture.history));await w.list.updateComplete;});assert.equal(await footer.count(),1,'raw archive retains attribution after compaction');
 await page.evaluate(async()=>{const w=window as any;w.list.messages=[w.fixture.second];w.list.sourceMessages=[];await w.list.updateComplete;});assert.equal(await footer.count(),0,'changing conversation removes prior sources');assert.deepEqual(errors,[]);
 console.log('Answer sources: scoped evidence, validation, deduplication, search fallback, reload/compaction and escaped browser links passed');
}finally{await browser?.close();await server.close();}
