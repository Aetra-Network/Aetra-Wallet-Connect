/**
 * @aetra/connect — the Aetra Wallet Connect protocol.
 *
 * An end-to-end-encrypted bridge between a dApp and an Aetra wallet: QR /
 * deep-link pairing, an Aetra Proof of address ownership at connect time, and
 * user-approved transaction + message-signing requests, with session
 * persistence and idle auto-disconnect. Runs in the browser and in Node.
 *
 * Two entry points do the work:
 *   - `@aetra/connect/dapp`   → `AetraConnect`      (the website's client)
 *   - `@aetra/connect/wallet` → `AetraWalletConnect` (the wallet's responder)
 *
 * The primitives underneath are exported here and on narrow subpaths
 * (`/proof`, `/crypto`, `/session`, `/bridge`) for advanced use and testing.
 */

// Versioning / errors / wire model
export { PROTOCOL_NAME, PROTOCOL_VERSION, CONNECT_URI_SCHEME, SDK_VERSION } from "./version.js";
export { AetraConnectError, userRejected } from "./errors.js";
export type { AetraConnectErrorCode } from "./errors.js";
export type * from "./types.js";

// dApp + wallet connectors
export { AetraConnect } from "./dapp/index.js";
export type { AetraConnectOptions, ConnectHandshake } from "./dapp/index.js";
export { AetraWalletConnect } from "./wallet/index.js";
export type {
  AetraWalletConnectOptions,
  WalletSigner,
  TransactionHandler,
  SignMessageHandler,
  TransactionContext,
} from "./wallet/index.js";

// Proofs
export { AetraProof, signMessage, verifySignedMessage, signedMessageBytes } from "./proof/index.js";
export type { ProofSigner, ProofClaim, ProofExpectation } from "./proof/index.js";

// Crypto transport
export { SessionKeyPair, SessionCipher, randomBytesOf, randomId, randomChallenge } from "./crypto/index.js";

// Sessions
export { Session, MemorySessionStore, BrowserSessionStore } from "./session/index.js";
export type { SessionRecord, SessionRole, SessionStore, StorageLike, MaybePromise } from "./session/index.js";

// Bridges
export { HttpBridge, MemoryBridge } from "./bridge/index.js";
export type { Bridge, BridgeHandlers, BridgeSubscription, HttpBridgeOptions } from "./bridge/index.js";

// URIs
export { ConnectUri, DEFAULT_UNIVERSAL_BASE, validateConnectRequest } from "./uri/index.js";
export type { ConnectUriForms } from "./uri/index.js";
