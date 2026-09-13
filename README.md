# Hench web client

Static browser dashboard for dispatching tasks to **Hench** phone workers over
ContextVM (MCP over Nostr) with CEP-8 Lightning payments.

Serve locally (no build step):

```bash
python3 -m http.server 8931
# open http://localhost:8931
```

What it does:

- discovers Hench workers from kind 11316/11317 announcements (names, tools,
  input schemas, sats prices from `cap` tags)
- renders a schema-driven form for the selected tool (JSON override available)
- runs the MCP handshake (initialize/initialized) and `tools/call`, gift-wrapped
  (NIP-44 single-layer, kind 21059) exactly like the Rust SDK client
- on `notifications/payment_required`: shows a QR + `lightning:` link for the
  bolt11 invoice — pay with any wallet; the task runs after settlement
- streams worker progress and renders the final result

The browser key lives in `localStorage` — the same key keeps your canonical
invocation identity, so replays of a completed call return the cached result
without a second invoice.

Dependencies load from esm.sh at runtime (nostr-tools, @noble/hashes, qrcode).
