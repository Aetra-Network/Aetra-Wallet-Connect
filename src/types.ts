import type { AetraConnectErrorCode } from "./errors.js";

/**
 * The wire model — every JSON shape that crosses between a dApp and a wallet.
 * Two channels carry them:
 *
 *   1. The **connect request** travels out-of-band inside the QR / deep-link
 *      URI (see `uri/`). It is public by construction, so it holds only a
 *      challenge and the dApp's identity — never anything secret.
 *   2. Everything after pairing travels over the **bridge** inside an encrypted
 *      `BridgeEnvelope`, whose ciphertext decrypts to an `RpcMessage`.
 */

// --- Identity / metadata ----------------------------------------------------

/** How a dApp presents itself to the wallet's approval screen. */
export interface AppMetadata {
  /** Human name shown in the wallet ("Aetra Swap"). */
  name: string;
  /** The dApp's canonical origin — also the `domain` the Aetra Proof is bound to. */
  url: string;
  /** Optional icon URL (https or data:). */
  icon?: string;
  /** Optional one-line description. */
  description?: string;
}

/** How a wallet presents itself back to the dApp. */
export interface WalletMetadata {
  name: string;
  url?: string;
  icon?: string;
}

// --- Connect request (carried in the URI) -----------------------------------

/** What the dApp asks the wallet to return at connect time. */
export type RequestedItem =
  | { name: "aetra_address" }
  /** Asks for an Aetra Proof of ownership signed over `payload` (a dApp-chosen nonce). */
  | { name: "aetra_proof"; payload: string };

/**
 * The payload a dApp broadcasts in its connect URI. `clientId` is the dApp's
 * ephemeral X25519 public key (hex) — the wallet derives the shared secret
 * against it. Nothing here is secret.
 */
export interface ConnectRequest {
  /** Protocol version. Wallet rejects a mismatched major with UNSUPPORTED_VERSION. */
  v: number;
  /** dApp session public key (hex) — the pairing handle and shared-secret input. */
  clientId: string;
  /** Base URL of the relay bridge both sides talk to. */
  bridge: string;
  /**
   * URL of the dApp's hosted manifest (TON-Connect style). When present, the
   * wallet fetches it to display and to derive the proof domain, rather than
   * trusting inline metadata. `app` is still carried as a fallback/display hint.
   */
  manifestUrl?: string;
  app: AppMetadata;
  /** Requested return items (address, optional proof). */
  items: RequestedItem[];
  /** Unix ms after which the wallet should refuse to pair (stale QR). */
  validUntil?: number;
}

// --- Aetra Proof ------------------------------------------------------------

/**
 * A wallet's signature proving control of `addressRaw`, bound to the dApp origin,
 * the dApp's challenge, and both session keys (so it can't be lifted onto a
 * different encrypted channel). See `proof/proof.ts` for the exact byte layout.
 */
export interface AetraProofData {
  /** dApp origin the wallet signed for (echoes `AppMetadata.url`). */
  domain: string;
  /** The challenge nonce the dApp put in its `aetra_proof` request item. */
  payload: string;
  /** Unix seconds when the wallet signed. Verifiers enforce a max age. */
  timestamp: number;
  /** The proven account in bech32 `ae1…` raw form. */
  addressRaw: string;
  /** dApp session public key (hex) the proof is bound to. */
  dappClientId: string;
  /** Wallet session public key (hex) the proof is bound to. */
  walletClientId: string;
  /** Compressed secp256k1 public key (hex) that produced `signatureHex`. */
  pubkeyHex: string;
  /** 64-byte compact secp256k1 signature (hex), low-S, over sha256(message). */
  signatureHex: string;
}

// --- The connected account --------------------------------------------------

/** The account the wallet exposes to the dApp once connected. */
export interface ConnectedAccount {
  /** `AE…` user-friendly form — the primary display + receive identity. */
  address: string;
  /** `ae1…` bech32 raw form. */
  addressRaw: string;
  /** Compressed secp256k1 public key (hex). */
  pubkeyHex: string;
  /** The network id the wallet is connected to, if it reported one. */
  chainId?: string;
  /** Present iff the dApp requested `aetra_proof` and the wallet honoured it. */
  proof?: AetraProofData;
}

// --- RPC messages (bridge ciphertext, after decryption) ---------------------

/** A wallet-initiated event pushed to the dApp (not a reply to a request). */
export type RpcEvent =
  | { type: "event"; event: "connect"; payload: ConnectEventPayload }
  | { type: "event"; event: "disconnect"; payload?: { reason?: string } }
  | { type: "event"; event: "session_update"; payload: { account: ConnectedAccount } };

/** The wallet's answer to a connect request — the first bridge message it sends. */
export interface ConnectEventPayload {
  account: ConnectedAccount;
  wallet?: WalletMetadata;
  /** Session lifetime the wallet grants (unix ms). The dApp clamps to its own max. */
  expiresAt: number;
}

/** A transaction intent — one entry the wallet resolves into a signed message. */
export type ConnectTxMessage =
  /** Plain AET transfer. `amountNaet` is the base-unit (naet) string. */
  | { kind: "send"; to: string; amountNaet: string; comment?: string }
  /** Record the wallet's public key (native-account activation). */
  | { kind: "activate" }
  /** Deposit into a nominator staking pool. */
  | { kind: "stake.deposit"; poolId: string; amountNaet: string }
  /** Request unbonding of `shares` (a share count, not naet) from a pool. */
  | { kind: "stake.unbond"; poolId: string; requestId: string; shares: string }
  /** Claim accrued pool rewards. */
  | { kind: "stake.claim"; poolId: string }
  /** Call a deployed contract's `@external` entrypoint. */
  | {
      kind: "contract.execute";
      contract: string;
      opcode?: number;
      /** Typed field entries, `[{ name, type, value }]` — the SDK `Field` wire form. */
      fields?: ContractFieldSpec[];
      fundsNaet?: string;
      gasLimit?: number;
    }
  /** Escape hatch: a pre-encoded Cosmos message the wallet passes straight through. */
  | { kind: "raw"; typeUrl: string; valueBase64: string };

/** One typed contract field, mirroring the SDK's flat `{name,type,value}` payload entries. */
export interface ContractFieldSpec {
  name: string;
  type: string;
  value: unknown;
}

/** Parameters of an `aetra_sendTransaction` request. */
export interface SendTransactionParams {
  /** The signer address the dApp expects (wallet rejects a mismatch with the session). */
  from?: string;
  messages: ConnectTxMessage[];
  /** Optional tx memo / text comment. */
  memo?: string;
  /** Unix ms deadline; the wallet refuses a request it receives after this. */
  validUntil?: number;
  /** Optional network hint. */
  network?: string;
}

/** Parameters of an `aetra_signMessage` request (off-chain proof of ownership). */
export interface SignMessageParams {
  /** UTF-8 text to sign. Domain-separated from tx SignDocs — see `proof/`. */
  message: string;
}

/** dApp → wallet request. `id` correlates the reply. */
export type RpcRequest =
  | { type: "request"; id: string; method: "aetra_sendTransaction"; params: SendTransactionParams }
  | { type: "request"; id: string; method: "aetra_signMessage"; params: SignMessageParams }
  | { type: "request"; id: string; method: "aetra_disconnect"; params?: { reason?: string } };

/** The successful result body per method. */
export interface SendTransactionResult {
  /** The broadcast tx hash. */
  hash: string;
  /** CheckTx verdict — true if the node accepted it into the mempool. */
  accepted: boolean;
}
export interface SignMessageResult {
  signatureHex: string;
  pubkeyHex: string;
  address: string;
}

/** wallet → dApp reply, correlated by `id`. */
export type RpcResponse =
  | { type: "response"; id: string; ok: true; result: unknown }
  | { type: "response"; id: string; ok: false; error: { code: AetraConnectErrorCode; message: string; detail?: string } };

/** Anything that can be encrypted into a bridge envelope. */
export type RpcMessage = RpcRequest | RpcResponse | RpcEvent;

// --- Bridge envelope (the only plaintext on the wire, besides the URI) -------

/**
 * The routing wrapper the relay sees. `from`/`to` are session public keys (hex);
 * the relay forwards by `to` and never sees `payload` in the clear — it is the
 * base64 of the AEAD-sealed `RpcMessage`.
 */
export interface BridgeEnvelope {
  from: string;
  to: string;
  payload: string;
}
