import type { SessionRecord } from "./session.js";

/** A value that may be returned synchronously or as a promise. */
export type MaybePromise<T> = T | Promise<T>;

/**
 * `SessionStore` — persistence for session records, so a connection survives a
 * page reload. Keyed by session `topic`. All methods may be sync or async; the
 * connectors always `await`. Store records only within the same trust boundary
 * as the wallet's account keys — a record holds an X25519 secret key.
 */
export interface SessionStore {
  get(topic: string): MaybePromise<SessionRecord | null>;
  set(topic: string, record: SessionRecord): MaybePromise<void>;
  delete(topic: string): MaybePromise<void>;
  list(): MaybePromise<SessionRecord[]>;
}

/** In-memory store — the default. State is lost on reload; pair again after. */
export class MemorySessionStore implements SessionStore {
  private readonly records = new Map<string, SessionRecord>();

  get(topic: string): SessionRecord | null {
    return this.records.get(topic) ?? null;
  }
  set(topic: string, record: SessionRecord): void {
    this.records.set(topic, record);
  }
  delete(topic: string): void {
    this.records.delete(topic);
  }
  list(): SessionRecord[] {
    return [...this.records.values()];
  }
}

/**
 * `localStorage`-backed store for browser dApps and the web wallet. Each record
 * is one key (`<prefix>:<topic>`); a small index key tracks the topic set so
 * `list()` doesn't have to scan all of storage. Falls back to an in-memory map
 * when `localStorage` is unavailable (SSR, privacy mode), so construction never
 * throws.
 */
export class BrowserSessionStore implements SessionStore {
  private readonly prefix: string;
  private readonly indexKey: string;
  private readonly storage: StorageLike | null;
  private readonly fallback = new MemorySessionStore();

  constructor(prefix = "aetra-connect", storage?: StorageLike) {
    this.prefix = prefix;
    this.indexKey = `${prefix}:index`;
    this.storage = storage ?? safeLocalStorage();
  }

  get(topic: string): SessionRecord | null {
    if (!this.storage) return this.fallback.get(topic);
    const raw = this.storage.getItem(this.key(topic));
    if (!raw) return null;
    try {
      return JSON.parse(raw) as SessionRecord;
    } catch {
      return null;
    }
  }

  set(topic: string, record: SessionRecord): void {
    if (!this.storage) return this.fallback.set(topic, record);
    this.storage.setItem(this.key(topic), JSON.stringify(record));
    this.addToIndex(topic);
  }

  delete(topic: string): void {
    if (!this.storage) return this.fallback.delete(topic);
    this.storage.removeItem(this.key(topic));
    this.removeFromIndex(topic);
  }

  list(): SessionRecord[] {
    if (!this.storage) return this.fallback.list();
    return this.readIndex()
      .map((topic) => this.get(topic))
      .filter((r): r is SessionRecord => r !== null);
  }

  private key(topic: string): string {
    return `${this.prefix}:${topic}`;
  }

  private readIndex(): string[] {
    const raw = this.storage?.getItem(this.indexKey);
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw) as unknown;
      return Array.isArray(parsed) ? parsed.filter((t): t is string => typeof t === "string") : [];
    } catch {
      return [];
    }
  }

  private addToIndex(topic: string): void {
    const index = this.readIndex();
    if (!index.includes(topic)) {
      index.push(topic);
      this.storage?.setItem(this.indexKey, JSON.stringify(index));
    }
  }

  private removeFromIndex(topic: string): void {
    const index = this.readIndex().filter((t) => t !== topic);
    this.storage?.setItem(this.indexKey, JSON.stringify(index));
  }
}

/** The slice of the Web Storage API this store needs. */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function safeLocalStorage(): StorageLike | null {
  try {
    const ls = (globalThis as { localStorage?: StorageLike }).localStorage;
    if (!ls) return null;
    // Touch it — access can throw in sandboxed/blocked contexts.
    const probe = "aetra-connect:probe";
    ls.setItem(probe, "1");
    ls.removeItem(probe);
    return ls;
  } catch {
    return null;
  }
}
