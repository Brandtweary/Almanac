import assert from "node:assert/strict";
import { test } from "node:test";
import { admitPayload } from "../src/oracle-runtime.ts";
import { loadReleaseProfile, validateProfile } from "../src/local-model.ts";
const profile={id:"sampling-fixture",model:{id:"fixture",name:"Fixture",contextWindow:8192,maxTokens:256,reasoning:true,input:["text"],sampling:{temperature:1,top_p:.95,top_k:64}},roles:Object.fromEntries(["chat","audit","memory","summary","compaction"].map(role=>[role,{maxInputTokens:7936,maxOutputTokens:256,maxStageOutputTokens:1024}])),limits:{queueTimeoutMs:1000,executionTimeoutMs:1000}};
test("candidate sampling and output normalization precede exact measurement for every role",async()=>{
 const original=globalThis.fetch;const counts:any[]=[];
 globalThis.fetch=async(input,init)=>{
  if(String(input).endsWith("/profile"))return Response.json({ready:true,profile});
  assert(String(input).endsWith("/tokenize"));counts.push(JSON.parse(String(init?.body)));return Response.json({tokens:12});
 };
 try {
  await loadReleaseProfile();
  for(const role of ["chat","audit","memory","summary","compaction"] as const){
   const admitted=await admitPayload({model:"ignored",messages:[{role:"user",content:"Synthetic input"}],temperature:0,top_p:1,top_k:-1,max_completion_tokens:128},role) as any;
   assert.equal(admitted.temperature,1);assert.equal(admitted.top_p,.95);assert.equal(admitted.top_k,64);assert.equal(admitted.model,"fixture");assert.equal(admitted.max_tokens,128);assert.equal(admitted.max_completion_tokens,undefined);
   const {role:measuredRole,...measured}=counts.at(-1);assert.equal(measuredRole,role);assert.deepEqual(measured,admitted);
  }
 } finally {globalThis.fetch=original;}
});
test("malformed candidate sampling never becomes a live profile",()=>{
 for(const sampling of [null,{temperature:-1,top_p:.95,top_k:64},{temperature:1,top_p:0,top_k:64},{temperature:1,top_p:.95,top_k:0},{temperature:1,top_p:.95,top_k:1.5}])assert.throws(()=>validateProfile({...profile,model:{...profile.model,sampling}}),/sampling/);
 assert.equal(validateProfile(profile).model.sampling?.temperature,1);
});
