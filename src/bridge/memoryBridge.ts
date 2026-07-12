import type { BridgeEnvelope } from "../types.js";
import type { Bridge, BridgeHandlers, BridgeSubscription } from "./bridge.js";

/**
 * `MemoryBridge` — an in-process relay. Both sides share one instance and
 * exchange envelopes without any network. It powers the test handshake and the
 * "wallet lives in the same page as the dApp" case; it is not a substitute for
 * a real relay across devices.
 *
 * Delivery is asynchronous (a microtask) to mirror the real bridge's ordering,
 * and envelopes addressed to a client that hasn't subscribed yet are buffered
 * and flushed the moment it does — so a wallet may reply before the dApp has
 * finished wiring up its listener without a lost message.
 */
export class MemoryBridge implements Bridge {
  /** Sentinel origin advertised in pairing requests (there is no network URL). */
  readonly baseUrl = "memory:local";
  private readonly subscribers = new Map<string, BridgeHandlers>();
  private readonly pending = new Map<string, BridgeEnvelope[]>();

  send(envelope: BridgeEnvelope): Promise<void> {
    queueMicrotask(() => this.deliver(envelope));
    return Promise.resolve();
  }

  subscribe(clientId: string, handlers: BridgeHandlers): BridgeSubscription {
    this.subscribers.set(clientId, handlers);
    handlers.onOpen?.();
    // Flush anything that arrived before this subscription existed.
    const queued = this.pending.get(clientId);
    if (queued) {
      this.pending.delete(clientId);
      for (const env of queued) queueMicrotask(() => this.deliver(env));
    }
    return {
      clientId,
      close: () => {
        if (this.subscribers.get(clientId) === handlers) this.subscribers.delete(clientId);
      },
    };
  }

  private deliver(envelope: BridgeEnvelope): void {
    const handlers = this.subscribers.get(envelope.to);
    if (handlers) {
      handlers.onMessage(envelope);
      return;
    }
    const queue = this.pending.get(envelope.to);
    if (queue) queue.push(envelope);
    else this.pending.set(envelope.to, [envelope]);
  }
}
