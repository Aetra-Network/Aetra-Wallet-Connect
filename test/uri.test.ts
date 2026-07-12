import { describe, it, expect } from "vitest";
import { Bytes } from "@aetra/sdk/bytes";
import { ConnectUri } from "../src/uri/index.js";
import { AetraConnectError } from "../src/errors.js";
import { PROTOCOL_VERSION } from "../src/version.js";
import type { ConnectRequest } from "../src/types.js";

const request: ConnectRequest = {
  v: PROTOCOL_VERSION,
  clientId: "ab".repeat(32),
  bridge: "https://bridge.aetra.network",
  app: { name: "Aetra Swap", url: "https://swap.aetra.example", icon: "https://swap.aetra.example/icon.png" },
  items: [{ name: "aetra_address" }, { name: "aetra_proof", payload: "nonce-xyz" }],
  validUntil: 1_800_000_000_000,
};

describe("ConnectUri", () => {
  it("round-trips through the deep link form", () => {
    const { deepLink } = ConnectUri.encode(request);
    expect(deepLink.startsWith("aetra://connect?r=")).toBe(true);
    expect(ConnectUri.decode(deepLink)).toEqual(request);
  });

  it("round-trips through the universal link form", () => {
    const { universalLink } = ConnectUri.encode(request, { universalBase: "https://wallet.aetra.example/connect" });
    expect(universalLink.startsWith("https://wallet.aetra.example/connect?r=")).toBe(true);
    expect(ConnectUri.decode(universalLink)).toEqual(request);
  });

  it("decodes a bare encoded payload", () => {
    const { deepLink } = ConnectUri.encode(request);
    const bare = new URL(deepLink.replace("aetra://", "https://")).searchParams.get("r")!;
    expect(ConnectUri.decode(bare)).toEqual(request);
  });

  it("carries a version hint in the query", () => {
    const { universalLink } = ConnectUri.encode(request);
    expect(universalLink).toContain(`v=${PROTOCOL_VERSION}`);
  });

  it("rejects a malformed payload", () => {
    expect(() => ConnectUri.decode("aetra://connect?r=%%%notbase64%%%")).toThrowError(AetraConnectError);
  });

  it("rejects a URI missing the r parameter", () => {
    expect(() => ConnectUri.decode("aetra://connect?foo=bar")).toThrow(/missing/);
  });

  it("rejects a request missing required fields", () => {
    const encoded = Bytes.toBase64Url(Bytes.utf8Encode(JSON.stringify({ v: 1, clientId: "x" })));
    expect(() => ConnectUri.decode(`aetra://connect?r=${encoded}`)).toThrow(/invalid connect request/);
  });

  const encodeReq = (patch: Record<string, unknown>) =>
    `aetra://connect?r=${Bytes.toBase64Url(Bytes.utf8Encode(JSON.stringify({ ...request, ...patch })))}`;

  it("rejects a clientId that is not 64 lowercase hex", () => {
    expect(() => ConnectUri.decode(encodeReq({ clientId: "XYZ" }))).toThrow(/clientId/);
    expect(() => ConnectUri.decode(encodeReq({ clientId: "AB".repeat(32) }))).toThrow(/clientId/); // uppercase
    expect(() => ConnectUri.decode(encodeReq({ clientId: "ab".repeat(31) }))).toThrow(/clientId/); // too short
  });

  it("rejects an over-large payload", () => {
    const huge = "a".repeat(9000);
    expect(() => ConnectUri.decode(`aetra://connect?r=${huge}`)).toThrow(/too large/);
  });

  it("rejects too many requested items", () => {
    const items = Array.from({ length: 9 }, () => ({ name: "aetra_address" }));
    expect(() => ConnectUri.decode(encodeReq({ items }))).toThrow(/items/);
  });

  it("rejects an empty or over-long proof challenge", () => {
    expect(() => ConnectUri.decode(encodeReq({ items: [{ name: "aetra_proof", payload: "" }] }))).toThrow(/items/);
    expect(() => ConnectUri.decode(encodeReq({ items: [{ name: "aetra_proof", payload: "x".repeat(600) }] }))).toThrow(/items/);
  });
});
