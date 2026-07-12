/**
 * `AetraConnectError` — the single error type every layer throws, tagged with a
 * stable `code` so callers branch on the code rather than string-matching a
 * message. The codes double as the on-the-wire RPC error codes: when the wallet
 * rejects or fails a request, the dApp's promise rejects with the same code, so
 * `err.code === "USER_REJECTED"` works identically on both sides.
 */
export type AetraConnectErrorCode =
  /** The user declined the connection or the transaction in their wallet. */
  | "USER_REJECTED"
  /** A connect request / transaction request passed its `validUntil` deadline. */
  | "EXPIRED"
  /** The Aetra Proof failed verification (bad signature, wrong address, replay, stale). */
  | "BAD_PROOF"
  /** A connect URI, envelope, or RPC message was malformed or unparseable. */
  | "MALFORMED"
  /** The peer speaks a protocol major version this build doesn't. */
  | "UNSUPPORTED_VERSION"
  /** No live session for the operation (never connected, or already disconnected). */
  | "NO_SESSION"
  /** The transport (bridge) failed to deliver or receive. */
  | "BRIDGE_ERROR"
  /** Waited past the caller's timeout for a wallet response. */
  | "TIMEOUT"
  /** Authenticated decryption failed — a tampered or misrouted envelope. */
  | "DECRYPT_FAILED"
  /** The wallet couldn't build/sign/broadcast the requested transaction. */
  | "TX_FAILED"
  /** A request asked for something the wallet doesn't implement. */
  | "UNSUPPORTED_METHOD"
  /** The wallet's account isn't the one the request expected (session/account mismatch). */
  | "ACCOUNT_MISMATCH"
  /** The wallet is on a different network than the dApp requires. */
  | "CHAIN_MISMATCH"
  /** Any other internal failure. */
  | "INTERNAL";

export class AetraConnectError extends Error {
  readonly code: AetraConnectErrorCode;
  /** Optional machine-readable detail (e.g. the underlying bridge error, tx log). */
  readonly detail?: string;

  constructor(code: AetraConnectErrorCode, message: string, detail?: string) {
    super(message);
    this.name = "AetraConnectError";
    this.code = code;
    this.detail = detail;
    // Restore the prototype chain when compiled down to ES5-ish targets.
    Object.setPrototypeOf(this, AetraConnectError.prototype);
  }

  /** Serialises to the RPC error shape carried back over the bridge. */
  toWire(): { code: AetraConnectErrorCode; message: string; detail?: string } {
    return { code: this.code, message: this.message, ...(this.detail ? { detail: this.detail } : {}) };
  }

  /** Rebuilds an error from a wire RPC error (or a best-effort guess if the code is unknown). */
  static fromWire(wire: { code?: string; message?: string; detail?: string }): AetraConnectError {
    const code = KNOWN_CODES.has(wire.code as AetraConnectErrorCode)
      ? (wire.code as AetraConnectErrorCode)
      : "INTERNAL";
    return new AetraConnectError(code, wire.message ?? "remote error", wire.detail);
  }

  /** True for `err` being an `AetraConnectError` with the given code. */
  static is(err: unknown, code: AetraConnectErrorCode): boolean {
    return err instanceof AetraConnectError && err.code === code;
  }
}

const KNOWN_CODES = new Set<AetraConnectErrorCode>([
  "USER_REJECTED",
  "EXPIRED",
  "BAD_PROOF",
  "MALFORMED",
  "UNSUPPORTED_VERSION",
  "NO_SESSION",
  "BRIDGE_ERROR",
  "TIMEOUT",
  "DECRYPT_FAILED",
  "TX_FAILED",
  "UNSUPPORTED_METHOD",
  "ACCOUNT_MISMATCH",
  "CHAIN_MISMATCH",
  "INTERNAL",
]);

/** Convenience: a rejection the wallet sends when the user declines. */
export function userRejected(what: "connection" | "transaction" | "request" = "request"): AetraConnectError {
  return new AetraConnectError("USER_REJECTED", `user rejected the ${what}`);
}
