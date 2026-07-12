import { AetraConnectError } from "../errors.js";
import type { BridgeEnvelope } from "../types.js";
import type { Bridge, BridgeHandlers, BridgeSubscription } from "./bridge.js";

/**
 * `HttpBridge` — the real relay transport. Envelopes are POSTed to `send` and
 * received over a Server-Sent-Events stream at `events?client=<id>`. The relay
 * is a dumb forwarder: it queues by recipient id and streams to whoever is
 * listening. It never holds keys and never sees plaintext, so it can be a
 * shared public service.
 *
 * `EventSource` and `fetch` are browser globals; in Node (or an exotic runtime)
 * pass your own via `eventSource` / `fetch`. A minimal reference relay lives in
 * `examples/relay.mjs`.
 */
export interface HttpBridgeOptions {
  /** Relay base URL, e.g. `https://bridge.aetra.network`. */
  baseUrl: string;
  fetch?: typeof fetch;
  /** `EventSource` constructor (defaults to the global). */
  eventSource?: typeof EventSource;
}

export class HttpBridge implements Bridge {
  readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly eventSourceOption?: typeof EventSource;

  constructor(options: HttpBridgeOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    const f = options.fetch ?? globalThis.fetch;
    if (typeof f !== "function") {
      throw new AetraConnectError("BRIDGE_ERROR", "HttpBridge: no global fetch; pass options.fetch");
    }
    this.fetchImpl = f.bind(globalThis);
    // `EventSource` is only needed at subscribe() time (client-side). Resolving
    // it lazily keeps constructing an HttpBridge safe under SSR / in Node.
    this.eventSourceOption = options.eventSource;
  }

  async send(envelope: BridgeEnvelope): Promise<void> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}/send`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(envelope),
        cache: "no-store",
      });
    } catch (err) {
      throw new AetraConnectError("BRIDGE_ERROR", "bridge send failed", err instanceof Error ? err.message : String(err));
    }
    if (!res.ok) {
      throw new AetraConnectError("BRIDGE_ERROR", `bridge send rejected with ${res.status}`);
    }
  }

  subscribe(clientId: string, handlers: BridgeHandlers): BridgeSubscription {
    const EventSourceImpl = this.eventSourceOption ?? (globalThis as { EventSource?: typeof EventSource }).EventSource;
    if (typeof EventSourceImpl !== "function") {
      throw new AetraConnectError("BRIDGE_ERROR", "HttpBridge: no global EventSource; pass options.eventSource");
    }
    const url = `${this.baseUrl}/events?client=${encodeURIComponent(clientId)}`;
    const source = new EventSourceImpl(url);

    source.onopen = () => handlers.onOpen?.();
    source.onmessage = (event: MessageEvent) => {
      let envelope: BridgeEnvelope;
      try {
        envelope = JSON.parse(String(event.data)) as BridgeEnvelope;
      } catch {
        handlers.onError?.(new AetraConnectError("BRIDGE_ERROR", "bridge sent a non-JSON event"));
        return;
      }
      handlers.onMessage(envelope);
    };
    source.onerror = () => {
      // EventSource auto-reconnects; surface it as a non-fatal transport blip.
      handlers.onError?.(new AetraConnectError("BRIDGE_ERROR", "bridge stream error"));
    };

    let closed = false;
    return {
      clientId,
      close: () => {
        if (closed) return;
        closed = true;
        source.close();
      },
    };
  }
}
