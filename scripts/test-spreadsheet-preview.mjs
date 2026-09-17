import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {chromium} from 'playwright';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import * as XLSX from 'xlsx';
import JSZip from 'jszip';
const root=fileURLToPath(new URL('../',import.meta.url));
const executablePath=process.env.BROWSER_EXECUTABLE||execFileSync('which',['brave'],{encoding:'utf8'}).trim();
const maliciousName='"><img src=x onerror=alert(1)>';
const literalCell='<img src="/unexpected-cell" onerror="window.__xss=1">';
const sheet=XLSX.utils.aoa_to_sheet([
 ['Heading','Amount'],[literalCell,1234.5],['RICH_GOOD','RICH_BAD'],['Safe link','Unsafe link'],['Mail link','Data link'],['Merged heading',null],['Last',7],['STYLE_BAD','Style neighbor'],['FTP link','Relative link'],
]);
sheet.B2.z='"$"#,##0.00';
sheet.A4.l={Target:'https://example.invalid/reference?q=one&two=2'};
sheet.B4.l={Target:'javascript:globalThis.__xss=1'};
sheet.A5.l={Target:'mailto:reader@example.invalid'};
sheet.B5.l={Target:'data:text/html,<script>globalThis.__xss=1</script>'};
sheet.A9.l={Target:'ftp://example.invalid/reference'};
sheet.B9.l={Target:'/unexpected-navigation'};
sheet['!merges']=[XLSX.utils.decode_range('A6:B6')];
const workbook=XLSX.utils.book_new();XLSX.utils.book_append_sheet(workbook,sheet,maliciousName);XLSX.utils.book_append_sheet(workbook,XLSX.utils.aoa_to_sheet([['Total'],[7]]),'Totals');
const zip=await JSZip.loadAsync(XLSX.write(workbook,{bookType:'xlsx',bookSST:true,type:'base64'}),{base64:true});
let strings=await zip.file('xl/sharedStrings.xml').async('string');
assert.ok(strings.includes('<si><t>RICH_GOOD</t></si>'));
strings=strings.replace('<si><t>RICH_GOOD</t></si>','<si><r><rPr><b/><i/><u/><sz val="14"/></rPr><t>Bold rich value</t></r></si>');
strings=strings.replace('<si><t>RICH_BAD</t></si>','<si><r><t>&lt;img src=&quot;/unexpected-rich&quot; onerror=&quot;window.__xss=1&quot;&gt;rich remainder</t></r></si>');
strings=strings.replace('<si><t>STYLE_BAD</t></si>','<si><r><rPr><sz val="12pt; background-image:url(/unexpected-style); padding:0"/></rPr><t>Styled text</t></r></si>');
zip.file('xl/sharedStrings.xml',strings);const content=await zip.generateAsync({type:'base64'});
const parsed=XLSX.read(content,{type:'base64'}).Sheets[maliciousName];
assert.match(parsed.B3.h,/<img/,'fixture reaches the real rich-text raw-HTML path');
assert.match(parsed.A8.h,/background-image/,'fixture reaches the raw CSS style path');
assert.match(parsed.B4.l.Target,/^javascript:/,'fixture preserves unsafe hyperlink input');
const bundle=await build({stdin:{contents:`
import {AttachmentOverlay} from './src/pi-web-ui/dialogs/AttachmentOverlay.ts';
window.preview=async(content)=>{AttachmentOverlay.open({id:'synthetic',type:'document',fileName:'fixture.xlsx',mimeType:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',size:1,content,extractedText:'Extracted fixture text'});await document.querySelector('attachment-overlay').updateComplete;};
`,resolveDir:root},bundle:true,format:'iife',platform:'browser',define:{'import.meta.env':'{}','import.meta.url':'"https://fixture.invalid/"'},write:false,logLevel:'silent'});
const browser=await chromium.launch({executablePath,headless:true});
try{
 for(const policy of ['',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'"]){
  const page=await browser.newPage();page.setDefaultTimeout(5000);const dialogs=[];const errors=[];const requests=[];
  page.on('dialog',async dialog=>{dialogs.push(dialog.message());await dialog.dismiss();});
  page.on('pageerror',error=>errors.push(error.message));page.on('request',request=>requests.push(new URL(request.url()).pathname));
  await page.route('**/*',route=>{
   const pathname=new URL(route.request().url()).pathname;
   if(pathname==='/fixture.js')return route.fulfill({contentType:'application/javascript',body:bundle.outputFiles[0].text});
   if(pathname==='/')return route.fulfill({contentType:'text/html',headers:policy?{'Content-Security-Policy':policy}:{},body:'<!doctype html><html><body><script src="/fixture.js"></script></body></html>'});
   return route.fulfill({status:404,body:'unexpected request'});
  });
  await page.goto('https://fixture.invalid/');await page.evaluate(content=>window.preview(content),content);
  const preview=page.locator('#excel-container');await preview.locator('table').first().waitFor();
  assert.equal(await preview.locator('table').count(),2,'all workbook sheets retain previews');
  assert.equal(await preview.getByRole('button',{name:maliciousName,exact:true}).count(),1,'sheet name stays literal tab text');
  assert.equal(await preview.locator('img,script,iframe,svg,object,embed,form,input').count(),0,'no active payload nodes reach the preview');
  const first=preview.locator('table').first();
  assert.match(await first.textContent(),new RegExp(literalCell.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')));
  assert.match(await first.textContent(),/\$1,234\.50/,'formatted numeric content survives');
  assert.equal(await first.locator('td[colspan="2"]').textContent(),'Merged heading');
  assert.equal(await first.locator('b i').textContent(),'Bold rich value','legitimate rich text survives');
  assert.ok(await first.locator('span[style]').evaluateAll(spans=>spans.some(span=>span.style.fontSize==='14pt'&&span.style.textDecorationLine==='underline')));
  assert.equal(await first.locator('[style]').evaluateAll(nodes=>nodes.some(node=>/url\(/i.test(node.getAttribute('style')||''))),false,'untrusted CSS cannot request a resource');
  assert.equal(await first.locator('a[href]').count(),2,'only approved hyperlink schemes remain');
  assert.equal(await first.locator('a[href^="https:"]').getAttribute('href'),'https://example.invalid/reference?q=one&two=2');
  assert.equal(await first.locator('a[href^="mailto:"]').getAttribute('href'),'mailto:reader@example.invalid');
  assert.equal(await preview.evaluate(node=>[...node.querySelectorAll('*')].some(element=>[...element.attributes].some(attribute=>/^on/i.test(attribute.name)))),false,'event attributes are absent');
  await preview.getByRole('button',{name:'Totals',exact:true}).click();assert.equal(await preview.locator('table').nth(1).isVisible(),true);
  await preview.getByRole('button',{name:maliciousName,exact:true}).click();assert.equal(await first.isVisible(),true);
  assert.equal(await page.evaluate(()=>window.__xss),undefined);assert.deepEqual(dialogs,[]);assert.deepEqual(errors,[]);
  assert.deepEqual(requests.filter(path=>path!=='/'&&path!=='/fixture.js'),[],'payloads cannot trigger resource requests even in detached parsing');
  await page.close();
 }
 console.log('Spreadsheet preview preserves tabs, merges, formatting and safe links; malicious names/rich cells/links remain inert with and without CSP');
}finally{await browser.close();}
