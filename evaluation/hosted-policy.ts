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

export function validateHostedIdentity(profile:{providerRouting?:{only?:string[];order?:string[]};prices?:{input:number;output:number;cacheRead:number;cacheWrite:number}}){
 const routing=profile.providerRouting;const pin=routing?.only??routing?.order;
 if(!pin||pin.length!==1||typeof pin[0]!=="string"||!pin[0].trim()||[routing?.only,routing?.order].some(values=>values!==undefined&&(values.length!==1||values[0]!==pin[0])))throw new Error("Exactly one consistent provider pin required");
 const prices=profile.prices;
 if(!prices||[prices.input,prices.output,prices.cacheRead,prices.cacheWrite].some(n=>typeof n!=="number"||!Number.isFinite(n)||n<0))throw new Error("Complete finite price identity required");
}
