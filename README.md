# Hench web client

Static browser dashboard for dispatching tasks to **Hench** phone workers over
ContextVM (MCP over Nostr) with CEP-8 Lightning payments.
Part of https://autonomica.xyz — source at
https://github.com/autonomica-xyz/hench-web.

Serve locally (no build step):

```bash
python3 -m http.server 8931
# open http://localhost:8931
```

What it does:

- discovers Hench workers from kind 11316/11317 announcements published in the
  last 12h — every event must carry a valid schnorr signature (`verifyEvent`),
  so relays can't inject forged workers
- renders a schema-driven form; a JSON override replaces those fields rather
  than being blocked by their browser validation
- runs the MCP handshake (initialize/initialized) and `tools/call`, gift-wrapped
  (NIP-44 single-layer, kind 21059) exactly like the Rust SDK client
- unwraps responses and verifies the inner event's signature against the
  selected worker's pubkey — a forged `notifications/payment_required` can't
  redirect your sats to someone else's invoice
- on `notifications/payment_required`: shows a QR + `lightning:` link for the
  bolt11 invoice — pay with any wallet; the task runs after settlement
- streams worker progress and renders the final result; terminal success or
  failure hides the invoice controls

The browser key lives in `localStorage` — the same key keeps your canonical
invocation identity, so replays of a completed call return the cached result
without a second invoice. If storage is unavailable (private windows) an
ephemeral key is used instead.

Dependencies are vendored under `vendor/` — byte-pinned, self-contained ES
module bundles (no runtime CDN): nostr-tools 2.25.2, @noble/hashes 2.4.0,
qrcode 1.5.4, each with upstream license + sha256 in `vendor/README.md`.
Shared wire constants, trust checks, and the session invocation-correlation
router live in `lib.mjs`; `node test.mjs` runs deterministic regression checks
(announcement freshness/shape, inner-event identity, replay correlation,
invoice sanitization).

Session correlation: every request's signed inner event id is registered
before publishing; inbound responses, progress, and payment notifications are
only delivered when their `e` tag names a live request event id — a replayed
invoice/result from an earlier job cannot attach to a new one.

## License

MIT (see [LICENSE](LICENSE)); dependencies vendored under `vendor/` keep
their own licenses (recorded in `vendor/README.md`).
