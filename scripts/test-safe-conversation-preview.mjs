import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';
import * as XLSX from 'xlsx';
const root=fileURLToPath(new URL('../',import.meta.url));
const zip=new JSZip();
zip.file('[Content_Types].xml','<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
zip.file('_rels/.rels','<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
zip.file('word/document.xml',`<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body><w:p><w:r><w:rPr><w:b/></w:rPr><w:t>Document preview</w:t></w:r></w:p>${['safe','javascript','data','relative'].map(id=>`<w:p><w:hyperlink r:id="${id}"><w:r><w:t>${id} link</w:t></w:r></w:hyperlink></w:p>`).join('')}<w:sectPr><w:pgSz w:w="12240" w:h="15840"/></w:sectPr></w:body></w:document>`);
zip.file('word/_rels/document.xml.rels',`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${Object.entries({safe:'https://example.invalid/reference',javascript:'javascript:globalThis.__xss=1',data:'data:text/html,bad',relative:'/unexpected-navigation'}).map(([id,url])=>`<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="${url}" TargetMode="External"/>`).join('')}</Relationships>`);
const docx=await zip.generateAsync({type:'base64'});
const legacyBook=XLSX.utils.book_new();XLSX.utils.book_append_sheet(legacyBook,XLSX.utils.aoa_to_sheet([['Legacy spreadsheet',42]]),'Sheet1');const legacyXls=XLSX.write(legacyBook,{bookType:'biff8',type:'base64'});
const bundle=await build({stdin:{contents:`
import './src/pi-web-ui/components/Messages.ts';
import {AttachmentOverlay} from './src/pi-web-ui/dialogs/AttachmentOverlay.ts';
import {loadAttachment} from './src/pi-web-ui/utils/attachment-utils.ts';
window.legacyPreview=async content=>{for(const overlay of document.querySelectorAll('attachment-overlay'))overlay.close();const bytes=Uint8Array.from(atob(content),char=>char.charCodeAt(0));const attachment=await loadAttachment(new File([bytes],'fixture.xls',{type:''}));AttachmentOverlay.open({...attachment,mimeType:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'});return attachment.mimeType;};
import {ConsoleRuntimeProvider} from './src/pi-web-ui/components/sandbox/ConsoleRuntimeProvider.ts';
import {registerMemoryToolRenderers} from './src/kg-tools.ts';
import {registerWebToolRenderer} from './src/web-tools.ts';
registerMemoryToolRenderers();registerWebToolRenderer();
window.preview=async content=>{AttachmentOverlay.open({id:'fixture',type:'document',fileName:'fixture.docx',mimeType:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',size:1,content});};
window.renderMessages=async content=>{
 for(const [tag,id]of [['user-message','user'],['assistant-message','assistant'],['thinking-block','thinking']]){
  let element=document.getElementById(id);if(!element){element=document.createElement(tag);element.id=id;document.body.append(element)}
  if(tag==='user-message')element.message={role:'user',content,timestamp:1};
  if(tag==='assistant-message'){element.isStreaming=true;element.message={role:'assistant',content:[{type:'text',text:content}],stopReason:'stop',timestamp:1,usage:{input:0,output:0,totalTokens:0,cost:{total:0}}};}
  if(tag==='thinking-block'){element.content=content;element.isExpanded=true;}
  await element.updateComplete;
 }
};
window.consoleTest=async()=>{const output=[];window.sendRuntimeMessage=async message=>output.push(message);new ConsoleRuntimeProvider().getRuntime()('fixture');console.log({toJSON:()=>undefined});return output[0].text;};
window.toolsTest=async()=>{for(const name of['memory_search','memory_dump','web_search'])for(const state of['pending','error','complete']){const element=document.createElement('tool-message');element.id=name+'-'+state;element.toolCall={id:name,name,arguments:{}};if(state!=='pending')element.result={role:'toolResult',toolCallId:name,toolName:name,isError:state==='error',content:[],details:{},timestamp:1};document.body.append(element);await element.updateComplete;}};
`,resolveDir:root},bundle:true,format:'iife',platform:'browser',define:{'import.meta.env':'{}','import.meta.url':'"https://fixture.invalid/"'},write:false,logLevel:'silent'});
const browser=await chromium.launch({executablePath:process.env.BROWSER_EXECUTABLE||execFileSync('which',['brave'],{encoding:'utf8'}).trim(),headless:true});
try{
 for(const policy of['',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; object-src 'none'"]){
  const page=await browser.newPage();page.setDefaultTimeout(5000);const requests=[];
  await page.route('**/*',route=>{const path=new URL(route.request().url()).pathname;requests.push(path);return route.fulfill({contentType:path==='/fixture.js'?'application/javascript':'text/html',headers:policy?{'Content-Security-Policy':policy}:{},body:path==='/fixture.js'?bundle.outputFiles[0].text:'<!doctype html><html><body><script src="/fixture.js"></script></body></html>'})});
  await page.goto('https://fixture.invalid/');
  const payload='<img src="/unexpected" onerror="globalThis.__xss=1"><svg onload="globalThis.__xss=1"></svg>\n\n[bad](javascript:alert%281%29) [data](data:text/html,bad) [safe](https://example.invalid/) [citation](corpus:abc)\n\n```html\n<img onerror=alert(1)>\n```\n\n$\\frac{1}{2}$';
  for(const value of[payload.slice(0,35),payload]){await page.evaluate(value=>window.renderMessages(value),value);await page.waitForFunction(()=>document.querySelectorAll('safe-markdown').length===3);await page.evaluate(()=>Promise.all([...document.querySelectorAll('safe-markdown')].map(e=>e.updateComplete)));}
  for(const id of['user','assistant','thinking']){
   const target=page.locator('#'+id);assert.equal(await target.locator('img,script,iframe,[onerror],[onload]').count(),0);
   assert.equal(await target.locator('a[href^="javascript:"],a[href^="data:"]').count(),0);
   assert.equal(await target.locator('a[href="https://example.invalid/"]').count(),1);
   assert.equal(await target.locator('a[href="corpus:abc"]').count(),1);
   assert.equal(await target.locator('math').count(),1);assert.equal(await target.locator('code-block').count(),1);
  }
  assert.equal(await page.evaluate(()=>window.__xss),undefined);assert(!requests.includes('/unexpected'));
  assert.equal(await page.evaluate(()=>window.consoleTest()),'(not provided)');
  await page.evaluate(()=>window.toolsTest());
  for(const name of['memory_search','memory_dump','web_search'])assert.match(await page.locator('#'+name+'-error').textContent(),/failed/);
  await page.evaluate(content=>window.preview(content),docx);await page.locator('#docx-container a').first().waitFor();
  const doc=page.locator('#docx-container');assert.match(await doc.textContent(),/Document preview/);assert.equal(await doc.locator('a[href]').count(),1);assert.equal(await doc.locator('a[href]').getAttribute('href'),'https://example.invalid/reference');
  assert.equal(await doc.locator('[onerror],[onload],iframe,svg').count(),0);
  assert.equal(await doc.locator('style').count(),1,'only application-owned preview CSS survives');
  assert.equal(await page.evaluate(content=>window.legacyPreview(content),legacyXls),'application/vnd.ms-excel');
  await page.locator('#excel-container table').waitFor();assert.match(await page.locator('#excel-container').textContent(),/Legacy spreadsheet/);
  await page.close();
 }
 console.log('Safe conversation, reasoning, DOCX, tool errors and console cases passed with and without CSP');
}finally{await browser.close()}
