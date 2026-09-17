/** Load the same Vite raw dictionary asset in the Node-only evaluation runner. */
import { registerHooks } from 'node:module';
import { readFileSync, realpathSync } from 'node:fs';
import {fileURLToPath,pathToFileURL} from 'node:url';
const asset=pathToFileURL(realpathSync(fileURLToPath(new URL('../node_modules/word-list/words.txt',import.meta.url))));
registerHooks({load(url,context,nextLoad){
 if(url!==asset.href+'?raw')return nextLoad(url,context);
 return {format:'module',source:`export default ${JSON.stringify(readFileSync(asset,'utf8'))}`,shortCircuit:true};
}});
