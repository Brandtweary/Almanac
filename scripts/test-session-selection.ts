import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
const source=ts.createSourceFile('main.ts',readFileSync(new URL('../src/main.ts',import.meta.url),'utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.TS);
let loadExpression='',promptExpression='';
function visit(node:ts.Node){
 if(ts.isVariableDeclaration(node)&&node.name.getText(source)==='loadSession')loadExpression=node.initializer!.getText(source);
 if(ts.isBinaryExpression(node)&&node.operatorToken.kind===ts.SyntaxKind.EqualsToken&&node.left.getText(source).endsWith('.prompt')&&ts.isArrowFunction(node.right))promptExpression=node.right.getText(source);
 ts.forEachChild(node,visit);
}
visit(source);assert.ok(loadExpression);assert.ok(promptExpression);
function install(expression:string,context:Record<string,any>){
 if (context.alerts) context.alert = (message:string) => context.alerts.push(message);
 vm.runInNewContext(ts.transpileModule(`globalThis.operation = ${expression}`,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None}}).outputText,context);return context.operation;
}
function deferred<T>(){let resolve!:(value:T)=>void;let reject!:(error:Error)=>void;const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no;});return{resolve,reject,promise};}
function state(){return {sessionSelection:0,sessionLoadPending:false,sessionLoadDisabled:new WeakMap(),chatPanel:{agentInterface:{sendDisabled:false}},storage:{sessions:{get:async(_id:string):Promise<any>=>undefined,getMetadata:async(_id:string):Promise<any>=>undefined}},memoryConsent:"declined",alerts:[] as string[],alert(message:string){this.alerts.push(message)},dbgError:()=>{},dbgWarn:()=>{},dbg:()=>{},summarizeMessages:()=>'',MYRIAPOD_MODEL:{},MYRIAPOD_THINKING_LEVEL:'off',currentSessionId:'original',currentView:'chat',currentTitle:'original',createAgent:async()=>{},updateUrl:()=>{},updateBodyVisibility:()=>{},renderHeader:()=>{}};}
for(const stage of ['get','metadata','error']){
 const context=state();const gate=deferred<any>();
 context.storage.sessions.get=stage==='metadata'?async()=>({messages:[]}):()=>gate.promise;
 if(stage==='metadata')context.storage.sessions.getMetadata=()=>gate.promise;
 const load=install(loadExpression,context);const pending=load('next');
 assert.equal(context.chatPanel.agentInterface.sendDisabled,true,'lock precedes first storage read');
 assert.equal(context.sessionLoadPending,true);
 if(stage==='error'){gate.reject(new Error('storage failed'));assert.equal(await pending,false);assert.match(context.alerts[0],/retained/);assert.equal(context.currentSessionId,'original');assert.equal(context.memoryConsent,'declined');}
 else {gate.resolve(undefined);await pending;}
 assert.equal(context.chatPanel.agentInterface.sendDisabled,false,'failed/no-op selection releases its own lock');
 assert.equal(context.sessionLoadPending,false);
}
{
 const context=state();const first=deferred<any>();const second=deferred<any>();
 context.storage.sessions.get=id=>id==='first'?first.promise:second.promise;
 const load=install(loadExpression,context);const one=load('first');const two=load('second');
 first.resolve(undefined);await one;
 assert.equal(context.chatPanel.agentInterface.sendDisabled,true,'stale selection cannot unlock a newer lookup');
 second.resolve(undefined);await two;
 assert.equal(context.chatPanel.agentInterface.sendDisabled,false,'overlapping failed selections restore the original unlocked state');
}
for(const pendingLoad of [true,false]){
 const gate=deferred<void>();
 const context:any={sessionSelection:1,sessionLoadPending:pendingLoad,isCurrent:()=>true,runInFlight:false,dbgWarn:()=>{},releaseProfile:()=>{},ensureMemoryConsent:()=>gate.promise};
 const prompt=install(promptExpression,context);const sending=prompt('draft');
 const rejected=assert.rejects(sending,/Conversation/);
 if(!pendingLoad){assert.equal(context.runInFlight,true);context.sessionSelection++;gate.resolve();}
 await rejected;
 assert.equal(context.runInFlight,false,'stale admission cannot leave the old run locked');
}
console.log('6 storage-selection and prompt-admission race cases passed');
