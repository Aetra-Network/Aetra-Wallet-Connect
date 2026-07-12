import { describe, it, expect } from "vitest";
import { BrowserSessionStore, type StorageLike, type SessionRecord } from "../src/session/index.js";

function fakeStorage(): StorageLike {
  const map = new Map<string, string>();
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => void map.set(key, value),
    removeItem: (key) => void map.delete(key),
  };
}

const RECORD: SessionRecord = {
  topic: "t1",
  role: "dapp",
  selfSecretHex: "aa".repeat(32),
  peerClientId: "bb".repeat(32),
  account: { address: "AEexample", addressRaw: "ae1example", pubkeyHex: "02" + "00".repeat(32) },
  app: { name: "App", url: "https://app.example" },
  bridge: "https://bridge.aetra.network",
  createdAt: 1,
  expiresAt: 2,
  lastActivityAt: 1,
};

describe("BrowserSessionStore", () => {
  it("round-trips a well-formed record", () => {
    const storage = fakeStorage();
    const store = new BrowserSessionStore("aetra-connect", storage);
    store.set(RECORD.topic, RECORD);
    expect(store.get(RECORD.topic)).toEqual(RECORD);
    expect(store.list()).toEqual([RECORD]);
  });

  it("returns null and clears a corrupted (non-JSON) entry instead of throwing", () => {
    const storage = fakeStorage();
    const store = new BrowserSessionStore("aetra-connect", storage);
    storage.setItem("aetra-connect:topic1", "{not json");

    expect(store.get("topic1")).toBeNull();
    expect(storage.getItem("aetra-connect:topic1")).toBeNull();
  });

  it("returns null and clears an entry that parses but doesn't match the SessionRecord shape", () => {
    const storage = fakeStorage();
    const store = new BrowserSessionStore("aetra-connect", storage);
    // Add it via the real API first so it's indexed, then corrupt it in place —
    // simulates an old-schema record left over from a prior version.
    store.set("topic2", RECORD);
    storage.setItem("aetra-connect:topic2", JSON.stringify({ some: "old schema junk" }));

    expect(store.get("topic2")).toBeNull();
    expect(storage.getItem("aetra-connect:topic2")).toBeNull();
    // The index no longer references the cleared entry either.
    expect(store.list()).toEqual([]);
  });

  it("falls back to an in-memory store when localStorage is unavailable, without throwing", () => {
    const store = new BrowserSessionStore("aetra-connect", undefined);
    // No explicit storage and no global localStorage in this test env — must not throw.
    expect(() => store.set(RECORD.topic, RECORD)).not.toThrow();
    expect(store.get(RECORD.topic)).toEqual(RECORD);
  });
});
