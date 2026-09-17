import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,copyFileSync,symlinkSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
const root=fileURLToPath(new URL('../',import.meta.url));const temp=mkdtempSync(join(tmpdir(),'raw-dictionary-'));
try{
 for(const dir of ['evaluation','src'])mkdirSync(join(temp,dir));
 for(const file of ['evaluation/raw-wordlist.ts','src/stt-lexicon.ts','src/regex-utils.ts'])copyFileSync(join(root,file),join(temp,file));
 symlinkSync(join(root,'node_modules'),join(temp,'node_modules'),'dir');writeFileSync(join(temp,'package.json'),'{"type":"module"}');
 writeFileSync(join(temp,'check.ts'),`import './evaluation/raw-wordlist.ts';import {englishWords,validateAutoReplace} from './src/stt-lexicon.ts';import assert from 'node:assert/strict';assert((await englishWords()).has('snacking'));await validateAutoReplace('snocking','snacking');await assert.rejects(validateAutoReplace('storm','different'),/real English word/);`);
 const run=spawnSync(join(root,'node_modules/.bin/tsx'),[join(temp,'check.ts')],{encoding:'utf8',timeout:15000});assert.equal(run.status,0,run.stderr);
 console.log('Relocated evaluation loads production dictionary through symlinked dependencies.');
}finally{rmSync(temp,{recursive:true,force:true});}
