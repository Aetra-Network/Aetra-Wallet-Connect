import type { BridgeEnvelope } from "../types.js";

/**
 * `Bridge` — the transport seam. A bridge only routes opaque envelopes by their
 * `to` client id; it never sees plaintext (the payload is AEAD-sealed). Two
 * implementations ship: `HttpBridge` over a relay's SSE + POST endpoints (the
 * real cross-device path) and `MemoryBridge` for same-process pairing and tests.
 * A dApp or wallet can supply its own (BroadcastChannel, WebSocket, …) by
 * implementing this interface.
 */
export interface Bridge {
  /** Delivers `envelope` toward `envelope.to`. Rejects only on a transport failure. */
  send(envelope: BridgeEnvelope): Promise<void>;

  /**
   * Starts receiving envelopes addressed to `clientId`. `onMessage` fires per
   * delivered envelope; `onError` (if given) fires on a transport-level fault.
   * Returns a handle whose `close()` tears the subscription down.
   */
  subscribe(clientId: string, handlers: BridgeHandlers): BridgeSubscription;
}

export interface BridgeHandlers {
  onMessage: (envelope: BridgeEnvelope) => void;
  onError?: (error: Error) => void;
  /** Fires once the underlying channel is established (SSE open, etc.). */
  onOpen?: () => void;
}

export interface BridgeSubscription {
  /** The client id this subscription receives for. */
  readonly clientId: string;
  /** Tears down the channel. Idempotent. */
  close(): void;
}
