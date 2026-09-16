import assert from "node:assert/strict";
import { grantToken, hostedBalance, voiceLeaseResponse } from "../src/service-contracts.js";
for (const bad of [null, [], "text", 0, false]) {
 for (const parse of [grantToken, hostedBalance, voiceLeaseResponse]) assert.throws(() => parse(bad));
}
for (const token of [null, 1, false, [], {}, "", " "]) assert.throws(() => grantToken({ token }));
assert.equal(grantToken({ token: "opaque-token" }), "opaque-token");
const balance = { tier: "free", remaining: 0, grant: 10 };
assert.deepEqual(hostedBalance(balance), balance);
for (const field of ["remaining", "grant"]) {
 for (const bad of [null, "10", -1, NaN, Infinity, undefined]) assert.throws(() => hostedBalance({ ...balance, [field]: bad }));
}
for (const bad of [null, 1, false, {}, ""]) assert.throws(() => hostedBalance({ ...balance, tier: bad }));
const lease = { leaseId: "opaque-lease", ttsUrl: "wss://example.org/tts", heartbeatSec: 30 };
assert.deepEqual(voiceLeaseResponse(lease), lease);
assert.equal(voiceLeaseResponse({ leaseId: "id", ttsUrl: "ws://localhost:8080" }).heartbeatSec, 60);
for (const field of ["leaseId", "ttsUrl"]) {
 for (const bad of [null, 3, false, [], "", " "]) assert.throws(() => voiceLeaseResponse({ ...lease, [field]: bad }));
}
for (const bad of [0, -1, null, "30", Infinity, NaN]) assert.throws(() => voiceLeaseResponse({ ...lease, heartbeatSec: bad }));
assert.throws(() => voiceLeaseResponse({ ...lease, ttsUrl: "not-a-url" }));
assert.throws(() => voiceLeaseResponse({ ...lease, ttsUrl: "https://example.org" }));
console.log("Hosted grant, balance, and lease response contracts passed");
