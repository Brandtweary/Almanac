/** Evidence from fully framed SSE events; usage alone does not prove stream completion. */
export function inspectCompletionStream(body:string){
 const result:{protocolDone:boolean;malformedFrame:boolean;usage?:any;provider?:string;id?:string;error?:any;errorCode?:any}={protocolDone:false,malformedFrame:false};
 const frames=body.replace(/\r\n/g,"\n").split("\n\n");frames.pop();
 for(const frame of frames){
  const data=frame.split("\n").filter(line=>line.startsWith("data:")).map(line=>line.slice(5).replace(/^ /,"")).join("\n");
  if(!data)continue;
  if(data.trim()==="[DONE]"){result.protocolDone=true;break;}
  try{const event=JSON.parse(data);if(event.usage)result.usage=event.usage;if(event.provider)result.provider=event.provider;if(event.id)result.id=event.id;if(event.error){result.error=event.error;result.errorCode=event.error.code;}}
  catch{result.malformedFrame=true;}
 }
 return result;
}
