import {spawn, type ChildProcessWithoutNullStreams} from 'node:child_process';
import {createInterface} from 'node:readline';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {Type} from 'typebox';
import type {AgentTool} from '@earendil-works/pi-agent-core';

export interface ShellCase {
 id:string; split:'development'|'heldout'; track:'shell'; family:'shell-sanity'; description:string;
 steps:{action:'send';text:string}[]; assertions:{id:string;kind:string;critical:boolean}[]; rubric:string[];
 files:Record<string,string>; expected:string; task:'size'|'quote'|'numeric'|'count';
}
export interface ShellResult {stdout:string;stderr:string;exitCode:number;timedOut:boolean;outputTruncated:boolean;}
export const shellCases:ShellCase[] = (['development','heldout'] as const).flatMap((split,index)=>{
 const prefix=index?'cedar':'birch';
 const fixtures:{task:ShellCase['task'];files:Record<string,string>;expected:string;text:string}[]=[
 {task:'size',files:{[`${prefix}/large.txt`]:'L'.repeat(index?113:91),[`${prefix}/small.txt`]:'s'.repeat(index?7:3),[`${prefix}/middle.txt`]:'m'.repeat(index?29:19)},expected:'large.txt\nmiddle.txt\nsmall.txt',text:`Use ls with valid flags to create a long listing of files in ${prefix}, sorted largest size first. Save the listing to /work/result.txt.`},
 {task:'quote',files:{[`${prefix} records/-draft note.txt`]:index?'amber\nindigo\n':'cobalt\npearl\n'},expected:index?'amber\nindigo\n':'cobalt\npearl\n',text:`Copy the file /work/${prefix} records/-draft note.txt to /work/result.txt, preserving its exact contents. The directory has a space and the filename begins with a dash.`},
 {task:'numeric',files:{'values.txt':index?'31\n-4\n8\n102\n2\n':'19\n3\n-7\n40\n12\n'},expected:index?'-4\n2\n8\n31\n102\n':'-7\n3\n12\n19\n40\n',text:'Sort values.txt in ascending numeric order into /work/result.txt, one number per line.'},
 {task:'count',files:{'events.txt':index?'ready\nnot ready\nready\nREADY\nready now\nready\n':'ready\nready now\nnot ready\nready\nREADY\n'},expected:index?'3':'2',text:'Count only lines exactly equal to ready (case sensitive) in events.txt. Write only the count to /work/result.txt.'},
 ];
 return fixtures.map(f=>({id:`shell.${split}.${f.task}`,split,track:'shell' as const,family:'shell-sanity' as const,description:f.text,steps:[{action:'send' as const,text:f.text}],assertions:[{id:'actual_execution',kind:'execution',critical:true},{id:'exact_result',kind:'fixture_bytes',critical:true},{id:'fixture_preserved',kind:'fixture_bytes',critical:true}],rubric:[],...f}));
});

export class ShellSession {
 private process:ChildProcessWithoutNullStreams;
 private pending:{resolve:(value:any)=>void;reject:(error:Error)=>void}[]=[];
 private failure?:Error;
 readonly executions:({command:string}&ShellResult)[]=[];
 readonly ready:Promise<any>;
 constructor(helperDirectory?:string){
  this.process=spawn('python3',[helperDirectory?join(helperDirectory,'driver.py'):fileURLToPath(new URL('./driver.py',import.meta.url))],{stdio:['pipe','pipe','pipe'],env:{PATH:process.env.PATH??''}});
  this.ready=new Promise((resolve,reject)=>{const timer=setTimeout(()=>{this.dispose();reject(new Error('Shell sandbox initialization timed out'));},30000);this.pending.push({resolve:value=>{clearTimeout(timer);resolve(value);},reject:error=>{clearTimeout(timer);reject(error);}});});
  const fail=(error:Error)=>{this.failure=error;for(const p of this.pending.splice(0))p.reject(error);};
  createInterface({input:this.process.stdout}).on('line',line=>{try{const value=JSON.parse(line);if(value.error)fail(new Error(value.error));else this.pending.shift()?.resolve(value);}catch(error){fail(new Error(String(error)));}});
  let stderr='';this.process.stderr.on('data',chunk=>{stderr=(stderr+chunk).slice(-2000);});
  this.process.stdin.on('error',fail);this.process.on('error',fail);this.process.on('exit',code=>fail(new Error(`Shell driver exited ${code}: ${stderr}`)));
 }
 private request(value:unknown):Promise<any>{
  if(this.failure)return Promise.reject(this.failure);
  return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{this.dispose();reject(new Error('Shell sandbox request timed out'));},15000);this.pending.push({resolve:result=>{clearTimeout(timer);resolve(result);},reject:error=>{clearTimeout(timer);reject(error);}});this.process.stdin.write(JSON.stringify(value)+'\n');});
 }
 async initialize(files:Record<string,string>){await this.ready;await this.request({action:'init',files});}
 async execute(command:string,signal?:AbortSignal):Promise<ShellResult>{
  if(signal?.aborted)throw new Error('Shell execution cancelled');
  const abort=()=>this.dispose();signal?.addEventListener('abort',abort,{once:true});
  try{const result=await this.request({action:'execute',command});this.executions.push({command,...result});return result;}finally{signal?.removeEventListener('abort',abort);}
 }
 async inspect():Promise<Record<string,string>>{return (await this.request({action:'inspect'})).files;}
 async grade(test:ShellCase){
  const files=await this.inspect();const output=files['result.txt']??'';
  let matches=false;
  if(test.task==='size'){
   const lines=output.trim().split('\n').filter(line=>!line.startsWith('total '));
   const expected=test.expected.split('\n');
   matches=lines.length===expected.length&&lines.every((line,i)=>{const fields=line.trim().split(/\s+/);return fields.length>=9&&fields[0].startsWith('-')&&fields.at(-1)===expected[i]&&Number(fields[4])===test.files[`${test.split==='heldout'?'cedar':'birch'}/${expected[i]}`].length;});
  }else matches=test.task==='count'?output.trim()===test.expected:output===test.expected;
  const execution=this.executions.some(r=>r.exitCode===0&&!r.timedOut&&!r.outputTruncated&&(test.task!=='size'||/(?:^|[\s;|])ls(?:\s|$)/.test(r.command)));
  return [{id:'actual_execution',passed:execution,critical:true,evidence:`${this.executions.length} executed commands`},{id:'exact_result',passed:matches,critical:true,evidence:output},{id:'fixture_preserved',passed:Object.entries(test.files).every(([name,value])=>files[name]===value),critical:true,evidence:'Original fixture bytes compared'}];
 }
 dispose(){this.process.kill('SIGTERM');}
}
export async function prepareShellCase(test:ShellCase,helperDirectory?:string){const session=new ShellSession(helperDirectory);try{await session.initialize(test.files);return session;}catch(error){session.dispose();throw error;}}
export function createShellTool(session:ShellSession):AgentTool {
 return {name:'bash',label:'Bash',description:'Run Bash in the isolated synthetic /work fixture. Available: bash, ls, sort, wc, cat, cut, head, tail, tr, uniq, cp, mv, mkdir, rm, printf, seq, sleep, env, grep, awk, stat. No network. Files persist across calls; each command starts in /work. Commands have a five-second and 32 KiB-per-stream limit.',parameters:Type.Object({command:Type.String()}),execute:async(_id,params,signal)=>{const result=await session.execute((params as {command:string}).command,signal);return {content:[{type:'text' as const,text:JSON.stringify(result)}],details:result};}};
}
