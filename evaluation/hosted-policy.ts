/** Developer-only hosted routing and serialized exposure policy. */
export function hostedPayload(payload:object,profile:{temperature?:number;topP?:number;providerRouting?:{only?:string[];order?:string[]};prices?:{input:number;output:number;cacheRead:number;cacheWrite:number}}){
 const temperature=profile.temperature??0;
 if(!Number.isFinite(temperature)||temperature<0||temperature>2||profile.topP!==undefined&&(!Number.isFinite(profile.topP)||profile.topP<=0||profile.topP>1))throw new Error("Invalid hosted sampling settings");
 const prices=profile.prices;
 if(prices&&Object.values(prices).some(n=>!Number.isFinite(n)||n<0))throw new Error("Invalid provider price ceiling");
 const controlled={...payload,temperature,...(profile.topP===undefined?{}:{top_p:profile.topP}),provider:{...profile.providerRouting,require_parameters:true,allow_fallbacks:false,zdr:true,data_collection:"deny",...(prices?{max_price:{prompt:Math.max(prices.input,prices.cacheRead,prices.cacheWrite),completion:prices.output,request:0}}:{})}};
 if(Buffer.byteLength(JSON.stringify(controlled))>65536)throw new Error("screening_input_exposure_limit");
 return controlled;
}
