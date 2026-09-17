import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";
import { compactContext } from "../src/oracle-context.js";
import { formatTranscript } from "../src/pipeline.js";
import { userStatementText } from "../src/user-messages.js";

const attachment = { role:"user-with-attachments",content:"My own requirement",timestamp:1,attachments:[
  {id:"doc",type:"document",fileName:"notes.txt",mimeType:"text/plain",content:"U291cmNl",size:6,extractedText:"An uploaded source claim"},
  {id:"image",type:"image",fileName:"image.png",mimeType:"image/png",content:"aW1hZ2U=",size:5},
] } as AgentMessage;

test("pipeline retains attachment user text and distinguishes uploaded source text from testimony", () => {
  const text = formatTranscript([attachment]);
  assert.match(text, /\[USER\]\nMy own requirement/);
  assert.match(text, /USER-UPLOADED SOURCE; NOT USER TESTIMONY/);
  assert.match(text, /An uploaded source claim/); assert.match(text, /image.png/);
  assert.doesNotMatch(text, /aW1hZ2U=|U291cmNl/);
  assert.equal(userStatementText(attachment), "My own requirement");
});

test("attachment user messages form compaction boundaries and newest attachment turn stays intact", async () => {
  const older = {role:"user",content:"Earlier requirement",timestamp:0} as AgentMessage;
  const reply = {role:"assistant",content:[{type:"text",text:"Earlier reply"}]} as AgentMessage;
  const ledger = {role:"corpus-ledger",entries:[]} as any;
  let summarized = "";
  const result = await compactContext({messages:[older,reply,attachment],ledger,inputBudget:10,summaryInputBudget:1000,
    convert: messages => messages.filter(message => ["user","assistant"].includes(message.role)) as Message[],
    measure: async messages => messages.some(message => message.role === "compactionSummary") ? 5 : 20,
    measureSummary: async text => text.length,
    summarize: async text => { summarized = text; return "Earlier requirements and reply"; }, isCurrent: () => true});
  assert.match(summarized, /Earlier requirement/); assert.doesNotMatch(summarized, /My own requirement/);
  assert.equal(result.at(-1), attachment); assert.equal(result[0].role,"compactionSummary");
});
