/**
 * `Emitter` — a minimal, dependency-free typed event emitter. `EventMap` maps
 * each event name to its listener's single argument type. Kept tiny on purpose:
 * the connect/wallet connectors need `on`/`off`/`once`/`emit` and nothing more,
 * and a real EventEmitter dependency would drag Node's `events` into browser
 * bundles.
 */
export class Emitter<EventMap extends Record<string, unknown>> {
  private readonly listeners = new Map<keyof EventMap, Set<(payload: never) => void>>();

  /** Subscribes `fn` to `event`. Returns an unsubscribe function. */
  on<K extends keyof EventMap>(event: K, fn: (payload: EventMap[K]) => void): () => void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(fn as (payload: never) => void);
    return () => this.off(event, fn);
  }

  /** Subscribes `fn` for a single emission. */
  once<K extends keyof EventMap>(event: K, fn: (payload: EventMap[K]) => void): () => void {
    const off = this.on(event, (payload) => {
      off();
      fn(payload);
    });
    return off;
  }

  off<K extends keyof EventMap>(event: K, fn: (payload: EventMap[K]) => void): void {
    this.listeners.get(event)?.delete(fn as (payload: never) => void);
  }

  emit<K extends keyof EventMap>(event: K, payload: EventMap[K]): void {
    const set = this.listeners.get(event);
    if (!set) return;
    // Copy first so a listener that unsubscribes mid-emit doesn't skip a sibling.
    for (const fn of [...set]) {
      (fn as (p: EventMap[K]) => void)(payload);
    }
  }

  /** Drops all listeners (used on teardown). */
  removeAll(): void {
    this.listeners.clear();
  }
}
