import { describe, it, expect, vi } from "vitest";
import { Wallet } from "@aetra/sdk/wallet";
import { loadManifest, validateManifest, manifestToApp, isSecureUrl, type AetraConnectManifest } from "../src/manifest.js";
import { AetraConnect } from "../src/dapp/index.js";
import { AetraWalletConnect } from "../src/wallet/index.js";
import { MemoryBridge } from "../src/bridge/index.js";
import { MemorySessionStore } from "../src/session/index.js";
import { AetraConnectError } from "../src/errors.js";
import { PROTOCOL_VERSION } from "../src/version.js";
import type { ConnectRequest } from "../src/types.js";

const MANIFEST: AetraConnectManifest = {
  url: "https://swap.aetra.example",
  name: "Aetra Swap",
  iconUrl: "https://swap.aetra.example/icon.png",
};

/** A fetch stub that serves `manifest` at `url` and 404s elsewhere. */
function manifestFetch(url: string, manifest: AetraConnectManifest): typeof fetch {
  return vi.fn(async (input: RequestInfo | URL) => {
    if (String(input) === url) {
      return new Response(JSON.stringify(manifest), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
}

describe("manifest", () => {
  it("validates and maps to app metadata", () => {
    const app = manifestToApp(validateManifest({ ...MANIFEST, url: "https://swap.aetra.example/" }));
    expect(app).toEqual({ name: "Aetra Swap", url: "https://swap.aetra.example", icon: MANIFEST.iconUrl });
  });

  it("rejects a malformed manifest", () => {
    expect(() => validateManifest({ name: "x" })).toThrow(/url/);
    expect(() => validateManifest({ url: "ftp://x", name: "n", iconUrl: "https://x/i.png" })).toThrow(/url/);
    expect(() => validateManifest({ url: "https://x", name: "n", iconUrl: "notaurl" })).toThrow(/iconUrl/);
  });

  it("fetches a manifest over (stubbed) http", async () => {
    const url = "https://swap.aetra.example/aetra-connect-manifest.json";
    const loaded = await loadManifest(url, manifestFetch(url, MANIFEST));
    expect(loaded).toEqual(MANIFEST);
  });

  it("surfaces a fetch failure as MALFORMED", async () => {
    const fetchImpl = vi.fn(async () => new Response("nope", { status: 500 })) as unknown as typeof fetch;
    await expect(loadManifest("https://x/m.json", fetchImpl)).rejects.toMatchObject({ code: "MALFORMED" });
  });

  it("pairs end-to-end using a manifestUrl on both sides", async () => {
    const bridge = new MemoryBridge();
    const manifestUrl = "https://swap.aetra.example/aetra-connect-manifest.json";
    const fetchImpl = manifestFetch(manifestUrl, MANIFEST);

    const signer = Wallet.random();
    const wallet = new AetraWalletConnect({
      bridge,
      signer,
      fetch: fetchImpl,
      chainId: "aetra-localnet-1",
      onTransaction: async () => ({ hash: "0xMANIFEST", accepted: true }),
    });

    const dapp = new AetraConnect({ manifestUrl, bridge, fetch: fetchImpl, storage: new MemorySessionStore() });
    await dapp.ready();
    expect(dapp.appMetadata?.url).toBe("https://swap.aetra.example");

    const hs = dapp.connect({ proof: true });
    expect(hs.request.manifestUrl).toBe(manifestUrl);

    const request = wallet.readRequest(hs.deepLink);
    const shownApp = await wallet.resolveApp(request); // wallet displays verified identity
    expect(shownApp.name).toBe("Aetra Swap");

    await wallet.approve(request);
    const account = await hs.approval();
    // Proof domain was bound to the manifest's origin — verified by the dApp.
    expect(account.proof?.domain).toBe("https://swap.aetra.example");
    expect(account.address).toBe(signer.address.toUserFriendly());

    const res = await dapp.sendTransaction({ messages: [{ kind: "activate" }] });
    expect(res.hash).toBe("0xMANIFEST");
  });

  it("ready() rejects when the manifest can't be loaded", async () => {
    const dapp = new AetraConnect({
      manifestUrl: "https://swap.aetra.example/missing.json",
      bridge: new MemoryBridge(),
      fetch: vi.fn(async () => new Response("no", { status: 404 })) as unknown as typeof fetch,
    });
    await expect(dapp.ready()).rejects.toBeInstanceOf(AetraConnectError);
  });

  it("still supports inline app metadata (no manifest)", async () => {
    const dapp = new AetraConnect({ app: { name: "Inline", url: "https://inline.example" }, bridge: new MemoryBridge() });
    await dapp.ready();
    const hs = dapp.connect({ proof: false });
    expect(hs.request.manifestUrl).toBeUndefined();
    expect(hs.request.app.name).toBe("Inline");
  });

  it("rejects a manifest whose own url/iconUrl are plain http (non-loopback)", () => {
    expect(() => validateManifest({ url: "http://evil.example", name: "n", iconUrl: "https://x/i.png" })).toThrow(/url/);
    expect(() => validateManifest({ url: "https://x", name: "n", iconUrl: "http://evil.example/i.png" })).toThrow(/iconUrl/);
  });
});

describe("isSecureUrl", () => {
  it("accepts https", () => {
    expect(isSecureUrl("https://example.com")).toBe(true);
  });

  it("rejects plain http to a public host", () => {
    expect(isSecureUrl("http://example.com")).toBe(false);
    expect(isSecureUrl("http://169.254.169.254/latest/meta-data")).toBe(false);
  });

  it("accepts plain http to localhost/127.0.0.1/::1 (local dev, e.g. examples/relay.mjs)", () => {
    expect(isSecureUrl("http://localhost:8788")).toBe(true);
    expect(isSecureUrl("http://127.0.0.1:8788")).toBe(true);
    expect(isSecureUrl("http://[::1]:8788")).toBe(true);
  });

  it("accepts plain http anywhere when allowInsecureConnections is set", () => {
    expect(isSecureUrl("http://internal-relay.example", { allowInsecureConnections: true })).toBe(true);
  });

  it("rejects an unparseable value", () => {
    expect(isSecureUrl("not a url")).toBe(false);
  });
});

describe("manifest fetch security (SSRF / HTTPS pinning)", () => {
  it("loadManifest refuses a plain-http, non-loopback manifest URL without ever fetching it", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(MANIFEST), { status: 200 })) as unknown as typeof fetch;
    await expect(loadManifest("http://evil.example/manifest.json", fetchImpl)).rejects.toMatchObject({ code: "MALFORMED" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("loadManifest allows a plain-http localhost manifest URL (local dev)", async () => {
    const url = "http://localhost:8788/aetra-connect-manifest.json";
    const loaded = await loadManifest(url, manifestFetch(url, MANIFEST));
    expect(loaded).toEqual(MANIFEST);
  });

  it("loadManifest allows plain-http when allowInsecureConnections is explicitly set", async () => {
    const url = "http://internal-relay.example/manifest.json";
    const loaded = await loadManifest(url, manifestFetch(url, MANIFEST), { allowInsecureConnections: true });
    expect(loaded).toEqual(MANIFEST);
  });

  it("loadManifest fetches with redirect: \"error\" so a manifest host can't bounce to another origin", async () => {
    const url = "https://swap.aetra.example/aetra-connect-manifest.json";
    const fetchImpl = manifestFetch(url, MANIFEST);
    await loadManifest(url, fetchImpl);
    expect(fetchImpl).toHaveBeenCalledWith(url, expect.objectContaining({ redirect: "error" }));
  });

  it("wallet.approve() refuses a pairing request whose bridge points at an insecure, non-loopback host", async () => {
    const signer = Wallet.random();
    const wc = new AetraWalletConnect({
      bridge: new MemoryBridge(),
      signer,
      onTransaction: async () => ({ hash: "0x", accepted: true }),
    });
    // A malicious QR/deep-link can carry any `bridge` it wants — simulate the
    // decoded request directly, as the wallet would hand it to approve().
    const malicious: ConnectRequest = {
      v: PROTOCOL_VERSION,
      clientId: "ab".repeat(32),
      bridge: "http://169.254.169.254/evil",
      app: { name: "Evil", url: "https://evil.example" },
      items: [{ name: "aetra_address" }],
    };
    await expect(wc.approve(malicious)).rejects.toMatchObject({ code: "MALFORMED" });
    expect(wc.activeSessions).toHaveLength(0);
  });
});
