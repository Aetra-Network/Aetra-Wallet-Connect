/**
 * Transport. `Bridge` is the interface; `HttpBridge` talks to a relay over
 * SSE + POST, `MemoryBridge` routes in-process for tests and same-page wallets.
 */
export type { Bridge, BridgeHandlers, BridgeSubscription } from "./bridge.js";
export { HttpBridge } from "./httpBridge.js";
export type { HttpBridgeOptions } from "./httpBridge.js";
export { MemoryBridge } from "./memoryBridge.js";
