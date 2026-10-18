// lib.mjs — wire constants + dependency-free checks shared by the Hench web
// client, the nsite demo client (hench.js), and test.mjs. No imports, so the
// checks run under plain Node.

// ContextVM / MCP-over-Nostr wire format (must stay compatible with rs-sdk).
export const KIND_CTXVM = 25910;
export const KIND_WRAP = 21059;
export const KIND_WRAP_ALT = 1059;
export const KIND_SERVER_ANNOUNCEMENT = 11316;
export const KIND_TOOLS_LIST = 11317;
export const MCP_PROTOCOL_VERSION = "2025-06-18";
export const CLIENT_SECRET_KEY = "hench-client-secret-key";

export const DEFAULT_RELAYS = [
  "wss://relay.damus.io",
  "wss://nos.lol",
  "wss://relay.primal.net",
  "wss://relay.nostr.net",
];

// Live workers re-announce on every boot; announcements older than this are
// treated as stale (debug ghosts, offline phones).
export const STALE_AFTER_S = 12 * 60 * 60;
const FUTURE_GRACE_S = 15 * 60; // clock-skew slack; rejects far-future pinning

export function isEventObject(event) {
  return (
    !!event &&
    typeof event === "object" &&
    Number.isInteger(event.kind) &&
    typeof event.pubkey === "string" &&
    /^[0-9a-f]{64}$/i.test(event.id || "") &&
    /^[0-9a-f]{128}$/i.test(event.sig || "") &&
    typeof event.created_at === "number" &&
    typeof event.content === "string" &&
    Array.isArray(event.tags)
  );
}

// Acceptable created_at for a discovery announcement: not ancient, not forged
// far into the future (a future-dated event would pin a worker as "fresh").
export function announcementFresh(event, nowS = Date.now() / 1000) {
  const created = Number(event?.created_at);
  return Number.isFinite(created) && created >= nowS - STALE_AFTER_S && created <= nowS + FUTURE_GRACE_S;
}

// `since` filter for the discovery REQ — no point asking relays for ghosts.
export function discoverySince(nowS = Math.floor(Date.now() / 1000)) {
  return Math.max(0, nowS - STALE_AFTER_S);
}

// True when a decrypted inner event is a signed ContextVM message from the
// worker we dispatched to (checked against its discovered pubkey).
export function fromWorker(inner, serverPubkey) {
  return isEventObject(inner) && inner.pubkey === serverPubkey && inner.kind === KIND_CTXVM;
}

// Returns a plausibly-shaped bolt11 invoice or "" — keeps garbage out of the
// QR and the lightning: link.
export function cleanBolt11(raw) {
  const invoice = String(raw ?? "").trim();
  return /^ln[a-z0-9]{8,2048}$/i.test(invoice) ? invoice : "";
}

// ---------- session invocation correlation ----------

// Crypto-random JSON-RPC request id. Session-unique (no per-session counter
// restart) so a replayed event can never carry this session's id. String form
// matches what the Kotlin/Rust workers echo back (`jsonRpcId` is a String).
export function randomRequestId() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return `req-${[...bytes].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

// The worker's correlation tag: the first "e" tag on the signed inner event,
// naming the client's request inner-event id (rs-sdk `create_response_tags`).
export function correlatedEventId(inner) {
  for (const tag of inner?.tags || []) {
    if (Array.isArray(tag) && tag[0] === "e" && typeof tag[1] === "string" && tag[1]) {
      return tag[1];
    }
  }
  return null;
}

// JSON-RPC ids arrive re-serialized (Kotlin echoes them as strings) — compare
// by value, not identity.
export function jsonIdKey(id) {
  return typeof id === "object" ? JSON.stringify(id) : String(id);
}

// Per-session map of outstanding invocations keyed by the request's own
// signed inner-event id. Every inbound worker message — response, progress,
// or payment notification — must "e"-tag a live entry or it is dropped, which
// is what keeps a prior job's authentic signed invoice/result from attaching
// to a new job (its e-tag names an event this session never published).
export class InvocationRouter {
  constructor() {
    this.pending = new Map(); // request inner event id -> { id, progressToken, resolve }
    this.usedIds = new Set();
  }

  takeId() {
    let id;
    do { id = randomRequestId(); } while (this.usedIds.has(id));
    this.usedIds.add(id);
    return id;
  }

  register(innerEventId, requestId, progressToken, resolve) {
    this.pending.set(innerEventId, { id: requestId, progressToken, resolve });
  }

  // Drop a live entry (request timed out). Returns true if one was removed.
  drop(innerEventId) {
    return this.pending.delete(innerEventId);
  }

  // Route one decrypted, signature-verified worker event. Returns
  // { type: "notification"|"response", entry, payload } or null to drop.
  // A response consumes its entry; notifications leave it for the response
  // that follows (matches the rs-sdk correlation gate).
  route(inner) {
    const eTag = correlatedEventId(inner);
    if (!eTag) return null;
    const entry = this.pending.get(eTag);
    if (!entry) return null;
    let payload;
    try { payload = JSON.parse(inner.content); } catch { return null; }
    if (!payload || typeof payload !== "object") return null;
    if (typeof payload.method === "string") {
      // notifications/progress must also carry the request's own
      // progressToken (CEP-8/MCP: the token the invocation supplied).
      if (payload.method === "notifications/progress") {
        const params = payload.params && typeof payload.params === "object" ? payload.params : {};
        if (entry.progressToken === undefined ||
            jsonIdKey(params.progressToken) !== jsonIdKey(entry.progressToken)) {
          return null;
        }
      }
      return { type: "notification", entry, payload };
    }
    if (payload.id === undefined) return null;
    // Correlated by event id AND by the invocation's JSON-RPC id — a response
    // whose id doesn't match the pending request is dropped without consuming
    // the entry, so the genuine response can still land.
    if (jsonIdKey(payload.id) !== jsonIdKey(entry.id)) return null;
    this.pending.delete(eTag);
    return { type: "response", entry, payload };
  }
}
