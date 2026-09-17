import {test,expect} from "bun:test";
import {vllmTokenizePayload} from "./tokenize";
import {resolveSpeechEndpoint} from "../src/app-paths";
test("vLLM full chat tokenization retains tools, template reasoning and continuation",()=>{
 const messages=[{role:"assistant",tool_calls:[{id:"call1",function:{name:"corpus_read",arguments:'{}'}}]},{role:"tool",tool_call_id:"call1",content:"source"}];
 const tools=[{type:"function",function:{name:"corpus_read",parameters:{type:"object"}}}];
 const p=vllmTokenizePayload({model:"candidate",messages,tools,reasoning_effort:"high",chat_template_kwargs:{custom:1},tool_choice:"auto"});
 expect(p.messages).toEqual(messages); expect(p.tools).toEqual(tools); expect(p.add_special_tokens).toBe(false); expect(p.add_generation_prompt).toBe(true); expect(p.chat_template_kwargs).toMatchObject({reasoning_effort:"high",enable_thinking:true,custom:1});
 expect(vllmTokenizePayload({tools,tool_choice:"none"},true).tools).toBeUndefined();
 expect(vllmTokenizePayload({tools,tool_choice:"none"},false).tools).toEqual(tools);
 expect(()=>vllmTokenizePayload({tool_choice:{type:"function",function:{name:"x"}}})).toThrow("tokenizer_tool_choice_unsupported");
});
test("voice broker endpoint resolves at root and portfolio mount",()=>{
 expect(resolveSpeechEndpoint("/api/tts_streaming","/","https://site.invalid/")).toBe("wss://site.invalid/api/tts_streaming");
 expect(resolveSpeechEndpoint("/api/tts_streaming","/almanac/","https://site.invalid/almanac/")).toBe("wss://site.invalid/almanac/api/tts_streaming");
 expect(resolveSpeechEndpoint("wss://speech.invalid/tts","/almanac/","https://site.invalid/almanac/")).toBe("wss://speech.invalid/tts");
});

test("vLLM counting matches chat normalization of retained assistant reasoning",()=>{
 const body={messages:[{role:"assistant",content:null,reasoning_content:"Preserved thought",tool_calls:[]},{role:"assistant",reasoning:"Canonical thought",reasoning_content:"Ignored legacy thought"},{role:"assistant",reasoning:null,reasoning_content:"Legacy fallback"}]};
 const payload=vllmTokenizePayload(body);
 expect(payload.messages).toEqual([{role:"assistant",content:null,reasoning:"Preserved thought",tool_calls:[]},{role:"assistant",reasoning:"Canonical thought"},{role:"assistant",reasoning:"Legacy fallback"}]);
 expect(body.messages[0].reasoning_content).toBe("Preserved thought");
});
