// Entry for vendor/nostr-tools.mjs — subpath entry points only, so unused
// root modules (nostr-wasm, @scure/bip32, @scure/bip39) never ship.
export {
  finalizeEvent, generateSecretKey, getPublicKey, verifyEvent,
  getEventHash, serializeEvent, validateEvent, verifiedSymbol,
  compareEvents, sortEvents,
} from "nostr-tools/pure";
export * as nip19 from "nostr-tools/nip19";
export * as nip44 from "nostr-tools/nip44";
