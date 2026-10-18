// test.mjs — deterministic regression checks for lib.mjs trust helpers.
// Run: node test.mjs   (no deps, no DOM, no network)

import assert from "node:assert/strict";
import {
  KIND_CTXVM, KIND_SERVER_ANNOUNCEMENT, STALE_AFTER_S,
  isEventObject, announcementFresh, discoverySince, fromWorker, cleanBolt11,
  randomRequestId, correlatedEventId, jsonIdKey, InvocationRouter,
} from "./lib.mjs";

const now = 1_800_000_000;
const HEX64 = "a".repeat(64);
const HEX128 = "b".repeat(128);

const baseEvent = {
  kind: KIND_SERVER_ANNOUNCEMENT,
  pubkey: HEX64,
  id: HEX64,
  sig: HEX128,
  created_at: now,
  content: "{}",
  tags: [],
};

// --- isEventObject -----------------------------------------------------------

assert.equal(isEventObject(baseEvent), true, "valid event shape");
assert.equal(isEventObject({ ...baseEvent, tags: "nope" }), false, "tags must be array");
assert.equal(isEventObject({ ...baseEvent, id: "zz" }), false, "id must be 64 hex");
assert.equal(isEventObject({ ...baseEvent, sig: "sig" }), false, "sig must be 128 hex");
assert.equal(isEventObject({ ...baseEvent, sig: undefined }), false, "unsigned event rejected");
assert.equal(isEventObject(null), false, "null rejected");
assert.equal(isEventObject("event"), false, "non-object rejected");
assert.equal(isEventObject({ ...baseEvent, kind: 1.5 }), false, "non-integer kind rejected");

// --- announcementFresh --------------------------------------------------------

assert.equal(announcementFresh({ created_at: now }, now), true, "now is fresh");
assert.equal(announcementFresh({ created_at: now - STALE_AFTER_S + 1 }, now), true, "inside 12h window");
assert.equal(announcementFresh({ created_at: now - STALE_AFTER_S - 1 }, now), false, "older than 12h dropped");
assert.equal(announcementFresh({ created_at: now + 14 * 60 }, now), true, "small clock skew ok");
assert.equal(announcementFresh({ created_at: now + 3600 }, now), false, "future-dated pinning rejected");
assert.equal(announcementFresh({ created_at: "later" }, now), false, "non-numeric rejected");

// --- discoverySince -----------------------------------------------------------

assert.equal(discoverySince(now), now - STALE_AFTER_S, "since covers the whole 12h window");
assert.equal(STALE_AFTER_S, 12 * 60 * 60, "12h window");

// --- fromWorker ---------------------------------------------------------------

const inner = { ...baseEvent, kind: KIND_CTXVM };
assert.equal(fromWorker(inner, HEX64), true, "signed ctxvm event from worker");
assert.equal(fromWorker(inner, "c".repeat(64)), false, "impersonated pubkey rejected");
assert.equal(fromWorker({ ...inner, kind: KIND_SERVER_ANNOUNCEMENT }, HEX64), false, "wrong kind rejected");
assert.equal(fromWorker({ ...inner, sig: undefined }, HEX64), false, "unsigned inner rejected");
assert.equal(fromWorker(parseJsonUnsafe(JSON.stringify(inner)), HEX64), true, "parsed JSON passes");

function parseJsonUnsafe(t) { return JSON.parse(t); }

// --- cleanBolt11 --------------------------------------------------------------

assert.equal(cleanBolt11("lnbc210n1ptest"), "lnbc210n1ptest", "realistic invoice accepted");
assert.equal(cleanBolt11("  LNBC210N1PTEST  "), "LNBC210N1PTEST", "case + whitespace normalized");
assert.equal(cleanBolt11(""), "", "empty rejected");
assert.equal(cleanBolt11(undefined), "", "missing rejected");
assert.equal(cleanBolt11(42), "", "non-string rejected");
assert.equal(cleanBolt11("javascript:alert(1)"), "", "uri injection rejected");
assert.equal(cleanBolt11("lightning:lnbc1x"), "", "prefixed string rejected");
assert.equal(cleanBolt11("lnbc1x with spaces"), "", "spaces rejected");
assert.equal(cleanBolt11(`ln${"1".repeat(3000)}`), "", "oversized rejected");

// --- session correlation (HIGH-4: replay of prior-session signed events) ----

import { finalizeEvent, generateSecretKey, getPublicKey, verifyEvent } from "./vendor/nostr-tools.mjs";

assert.match(randomRequestId(), /^req-[0-9a-f]{32}$/, "request id is crypto-random hex");
const ids = new Set(Array.from({ length: 500 }, () => randomRequestId()));
assert.equal(ids.size, 500, "request ids are session-unique");

const workerEvent = (eTag, payload, extraTags = []) => ({
  ...baseEvent,
  kind: KIND_CTXVM,
  tags: [["p", "c".repeat(64)], ...(eTag ? [["e", eTag]] : []), ...extraTags],
  content: JSON.stringify(payload),
});
const requestEventId = "d".repeat(64); // this session's own request inner id
const priorSessionEventId = "e".repeat(64); // e-tag a replayed old job carries

assert.equal(correlatedEventId(workerEvent(requestEventId, {})), requestEventId, "e-tag extracted");
assert.equal(correlatedEventId(workerEvent(null, {})), null, "missing e-tag -> null");
assert.equal(
  correlatedEventId({ ...workerEvent(null, {}), tags: [["e", "first"], ["e", "second"]] }),
  "first",
  "first e-tag wins (mirrors rs-sdk get_tag_value)",
);
assert.equal(jsonIdKey(1), jsonIdKey("1"), "worker echoes numeric ids as strings");

const router = new InvocationRouter();
let resolved;
const reqId = router.takeId();
router.register(requestEventId, reqId, reqId, (v) => { resolved = v; });

// Notifications: correlated payment_required routes, replayed one is dropped.
const invoice = { jsonrpc: "2.0", method: "notifications/payment_required", params: { pay_req: "lnbc210n1p", amount: 21, pmi: "bitcoin-lightning-bolt11" } };
assert.equal(router.route(workerEvent(requestEventId, invoice)).type, "notification", "live payment_required routes");
assert.equal(router.pending.size, 1, "notification must not consume the pending entry");
assert.equal(router.route(workerEvent(priorSessionEventId, invoice)), null, "replayed prior-session invoice dropped");
assert.equal(router.route(workerEvent(null, invoice)), null, "uncorrelated notification dropped");
assert.equal(router.pending.size, 1, "drops never consume the entry");

// Progress must carry this invocation's progressToken.
const progress = (token) => ({ jsonrpc: "2.0", method: "notifications/progress", params: { progressToken: token, status: "PROCESSING" } });
assert.equal(router.route(workerEvent(requestEventId, progress(reqId))).type, "notification", "progress with own token routes");
assert.equal(router.route(workerEvent(requestEventId, progress("req-old"))), null, "foreign progressToken dropped");
assert.equal(router.route(workerEvent(requestEventId, { jsonrpc: "2.0", method: "notifications/progress", params: {} })), null, "token-less progress dropped");

// payment_accepted/payment_rejected correlate by e-tag only (no progressToken on the wire).
assert.equal(
  router.route(workerEvent(requestEventId, { jsonrpc: "2.0", method: "notifications/payment_accepted", params: {} })).type,
  "notification",
  "payment_accepted routes on e-tag",
);

// Responses: correct id consumes; wrong id or stale e-tag dropped, entry kept.
const result = (id) => ({ jsonrpc: "2.0", id, result: { content: [] } });
assert.equal(router.route(workerEvent(priorSessionEventId, result(reqId))), null, "replayed prior-session result dropped");
assert.equal(router.route(workerEvent(requestEventId, result("req-old"))), null, "mismatched response id dropped");
assert.equal(router.pending.size, 1, "mismatched response leaves the entry live");
const routed = router.route(workerEvent(requestEventId, result(reqId)));
assert.equal(routed.type, "response", "genuine response routes");
assert.equal(router.pending.size, 0, "response consumes the pending entry");
assert.equal(router.route(workerEvent(requestEventId, result(reqId))), null, "replayed same-session result dropped");

// Timing-out requests stop accepting anything.
const router2 = new InvocationRouter();
const lateId = "f".repeat(64);
router2.register(lateId, router2.takeId(), undefined, () => {});
router2.drop(lateId);
assert.equal(router2.route(workerEvent(lateId, result("x"))), null, "expired invocation rejects stragglers");

assert.equal(resolved, undefined, "nothing resolved before the real response");
routed.entry.resolve(routed.payload);
assert.equal(resolved.result.content.length, 0, "genuine response resolves its caller");

// Full signature path: replayed events are AUTHENTIC — the worker really
// signed them — so signature verification alone passes them; only the
// per-session e-tag correlation rejects them.
const workerSk = generateSecretKey();
const workerPub = getPublicKey(workerSk);
const sign = (eTag, payload) =>
  finalizeEvent(
    {
      kind: KIND_CTXVM,
      created_at: now,
      tags: [["p", "c".repeat(64)], ["e", eTag]],
      content: JSON.stringify(payload),
    },
    workerSk,
  );
const session2 = new InvocationRouter();
const callId = session2.takeId();
let resolved2;
const myRequestEvent = sign("", { jsonrpc: "2.0", id: callId, method: "tools/call", params: {} });
session2.register(myRequestEvent.id, callId, callId, (v) => { resolved2 = v; });

// Authentic replay: worker-signed payment_required for a DIFFERENT session's request.
const replayedInvoice = sign("9".repeat(64), invoice);
assert.equal(fromWorker(replayedInvoice, workerPub), true, "replayed event is genuinely worker-signed");
assert.equal(verifyEvent(replayedInvoice), true, "replayed event verifies — signature is not enough");
assert.equal(session2.route(replayedInvoice), null, "signed-but-unrelated invoice dropped");

// Impersonated inner event (attacker-signed, pubkey swapped to claim the
// worker's identity — caught by verifyEvent in handleFrame).
const attackerSk = generateSecretKey();
const attackerEvent = finalizeEvent(
  { kind: KIND_CTXVM, created_at: now, tags: [["e", myRequestEvent.id]], content: "{}" },
  attackerSk,
);
const claimedForgery = { // field-by-field: a spread would carry verifiedSymbol
  pubkey: workerPub, id: attackerEvent.id, sig: attackerEvent.sig,
  kind: KIND_CTXVM, created_at: now, tags: attackerEvent.tags, content: "{}",
};
assert.equal(verifyEvent(claimedForgery), false, "claimed-pubkey forgery fails verification");

// The worker's real e-tagged response to THIS session's request routes.
const genuine = sign(myRequestEvent.id, { jsonrpc: "2.0", id: callId, result: { content: [] } });
assert.equal(fromWorker(genuine, workerPub), true, "genuine reply is from the worker");
assert.equal(verifyEvent(genuine), true, "genuine reply verifies");
assert.equal(session2.route(genuine)?.type, "response", "genuine correlated response routes");

console.log("test.mjs: all checks passed");
