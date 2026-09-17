import assert from "node:assert/strict";
import {hostedPayload} from "./hosted-policy.ts";
const p=hostedPayload({model:"fixture",provider:{zdr:false},temperature:0},{temperature:1,topP:.95,providerRouting:{only:["test/fp8"]},prices:{input:.3,output:1,cacheRead:.1,cacheWrite:.4}});
assert.equal(p.temperature,1);assert.equal(p.top_p,.95);assert.deepEqual(p.provider,{only:["test/fp8"],require_parameters:true,allow_fallbacks:false,zdr:true,data_collection:"deny",max_price:{prompt:.4,completion:1,request:0}});
assert.throws(()=>hostedPayload({messages:["x".repeat(65536)]},{}),/exposure/);
assert.throws(()=>hostedPayload({}, {topP:0}),/sampling/);
console.log("Hosted request retains explicit sampling, privacy, provider and price ceilings; oversized exposure fails closed.");
