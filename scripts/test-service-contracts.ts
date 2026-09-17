import assert from "node:assert/strict";
import { voiceLeaseResponse } from "../src/service-contracts.js";
for (const bad of [null, [], "text", 0, false]) assert.throws(() => voiceLeaseResponse(bad));
const lease = { leaseId: "opaque-lease", ttsUrl: "wss://example.org/tts", heartbeatSec: 30 };
assert.deepEqual(voiceLeaseResponse(lease), lease);
assert.equal(voiceLeaseResponse({ leaseId: "id", ttsUrl: "ws://localhost:8080" }).heartbeatSec, 60);
for (const field of ["leaseId", "ttsUrl"]) {
 for (const bad of [null, 3, false, [], "", " "]) assert.throws(() => voiceLeaseResponse({ ...lease, [field]: bad }));
}
for (const bad of [0, -1, null, "30", Infinity, NaN]) assert.throws(() => voiceLeaseResponse({ ...lease, heartbeatSec: bad }));
assert.throws(() => voiceLeaseResponse({ ...lease, ttsUrl: "not-a-url" }));
assert.throws(() => voiceLeaseResponse({ ...lease, ttsUrl: "https://example.org" }));
assert.equal(voiceLeaseResponse({ leaseId: "id", ttsUrl: "/api/tts_streaming" }).ttsUrl, "ws://localhost/api/tts_streaming");
console.log("Speech lease response contracts passed");
