/**
 * Protocol identity. `PROTOCOL_VERSION` is the wire-compat number carried in
 * every connect request and session record; a wallet rejects a request whose
 * major version it doesn't speak. Bump it only on a breaking wire change.
 */
export const PROTOCOL_NAME = "aetra-connect";
export const PROTOCOL_VERSION = 1;

/** Custom-scheme prefix a wallet registers as a deep-link handler. */
export const CONNECT_URI_SCHEME = "aetra";

/** The library's own release version (independent of the wire version). */
export const SDK_VERSION = "0.1.0";

/**
 * The network's default relay bridge. A dApp normally configures only a
 * `manifestUrl` and lets the bridge default to this (override per-app if you run
 * your own relay). Mirrors how a TON dApp configures a manifest, not a bridge.
 */
export const DEFAULT_BRIDGE_URL = "https://bridge.aetra.network";
