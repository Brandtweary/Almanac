/** Explicit loopback gateway for local stock fixtures; not a production content service. */
import { parseArgs } from "node:util";
import { readFileSync } from "node:fs";
import { createGateway } from "./server";
import { config, validateProfile } from "./config";
const {values}=parseArgs({options:{profile:{type:"string"},inference:{type:"string"},port:{type:"string"},log:{type:"string"}}});
if(!values.profile||!values.inference||!values.port||!values.log)throw new Error("Explicit candidate profile, loopback inference URL, unused gateway port and log path required");
const inference=new URL(values.inference);
if(inference.protocol!=="http:"||!["127.0.0.1","localhost","[::1]"].includes(inference.hostname)||inference.username||inference.password||inference.pathname!=="/"||inference.search||inference.hash)throw new Error("Inference must be a loopback HTTP origin");
const port=Number(values.port);if(!Number.isSafeInteger(port)||port<1024||port>65535)throw new Error("Invalid qualification port");
const profile=validateProfile(JSON.parse(readFileSync(values.profile,"utf8")),true);
if(profile.qualified!==false)throw new Error("Qualification gateway requires an explicitly unqualified candidate profile");
const fixtureBase="http://stock-fixture.invalid";
const app=createGateway({...config,host:"127.0.0.1",port,qualificationMode:true,qualificationBoundary:"",llmBase:inference.origin,contentBase:fixtureBase,sttBase:"",ttsBase:"",profilePath:"",logPath:values.log,allowedOrigins:[`http://127.0.0.1:${port}`]},(async(input: Parameters<typeof fetch>[0],init?: Parameters<typeof fetch>[1])=>{
 if(String(input)===`${fixtureBase}/capabilities`)return Response.json({ready:true,qualified:false,scope:"Stock synthetic sources are served by the evaluation fixture transport; no production corpus admission."});
 return fetch(input,init);
}) as typeof fetch,profile);
Bun.serve({hostname:"127.0.0.1",port,fetch:app.app.fetch,idleTimeout:0});
console.log(JSON.stringify({status:"qualification_only",gateway:`http://127.0.0.1:${port}/v1`,inference:inference.origin,profile:profile.id}));
