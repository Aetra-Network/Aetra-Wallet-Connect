/**
 * Session state + persistence. `Session` is one live pairing; `SessionStore`
 * (memory or browser) makes it survive a reload.
 */
export { Session } from "./session.js";
export type { SessionRecord, SessionRole } from "./session.js";
export { MemorySessionStore, BrowserSessionStore } from "./storage.js";
export type { SessionStore, StorageLike, MaybePromise } from "./storage.js";
