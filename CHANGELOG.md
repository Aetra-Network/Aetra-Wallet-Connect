# Changelog

All notable changes to `@aetra/connect` are documented here.

## 0.1.0

Initial foundation release.

### Added
- **Pairing** over QR / deep-link URIs (`aetra://` scheme + universal https link).
- **End-to-end-encrypted transport**: ephemeral X25519 session keys →
  HKDF-SHA256 → XChaCha20-Poly1305, over an untrusted relay bridge.
  `HttpBridge` (SSE + POST) and `MemoryBridge` (in-process), plus a reference
  relay (`examples/relay.mjs`).
- **Aetra Proof** of account ownership (secp256k1), bound to the dApp origin,
  a per-connection challenge, and both session keys; domain-separated from
  Cosmos `SignDoc`s. Off-chain `signMessage` / `verifySignedMessage`.
- **`AetraConnect`** (dApp) and **`AetraWalletConnect`** (wallet): connect,
  `sendTransaction` intents, `signMessage`, disconnect.
- **Sessions** with persistence (`MemorySessionStore` / `BrowserSessionStore`),
  a hard TTL, and idle auto-disconnect.
- Typed `AetraConnectError` codes shared across the wire.

### Hardening
- Each pairing handshake owns its own bridge subscription; reconnecting or
  restoring no longer leaks or clobbers a live session's listener.
- The wallet closes a superseded same-topic subscription on re-approve.
- Pairing URIs are size/shape-validated (64-hex client id, item and payload
  caps) before decryption.
- `requiredChainId` (dApp) rejects wrong-network pairing; the wallet rejects a
  request whose `from` isn't the session account.
- Transaction/signature replies from the wallet are shape-validated on the dApp.
