/** Routing amendments cannot replace a model trajectory that has already produced evidence. */
export function isZeroGenerationRoutingFailure(receipt:any):boolean {
 if(receipt?.status!=="transport_error"||!Array.isArray(receipt.requests)||!receipt.requests.length||!Array.isArray(receipt.providerReceipts)||receipt.providerReceipts.length!==receipt.requests.length)return false;
 if(receipt.metrics?.outputTokens>0||receipt.toolCalls?.length||receipt.actions?.length||receipt.auditFindings?.length)return false;
 if(receipt.turnOutcomes?.some((t:any)=>t.stopReason==="stop"||t.stopReason==="toolUse"))return false;
 const messages=[...(receipt.messages??[]),...(receipt.events??[]).filter((e:any)=>e.type==="message_end").map((e:any)=>e.message)];
 if(messages.some((m:any)=>m?.role==="assistant"&&(m.usage?.output>0||["stop","toolUse"].includes(m.stopReason)||m.content?.some((c:any)=>c.type==="toolCall"||String(c.text??c.thinking??"").trim()))))return false;
 if(receipt.events?.some((e:any)=>e.type==="tool_execution_start"||e.type==="tool_execution_end"))return false;
 return receipt.providerReceipts.every((r:any)=>r.httpStatus>=400&&r.httpStatus<500&&!r.provider&&!r.bodyInterrupted&&!(r.usage?.completion_tokens>0));
}
