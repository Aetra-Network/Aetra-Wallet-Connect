import { AetraConnectError } from "./errors.js";
import type { AppMetadata } from "./types.js";

/**
 * The app manifest — a small JSON file the dApp hosts (e.g. at
 * `https://myapp.com/aetra-connect-manifest.json`) that lets a wallet discover
 * and display who is asking to connect. Modelled on TON Connect's
 * `tonconnect-manifest.json`: same field names, same "host it CORS-open"
 * contract, so the mental model transfers.
 *
 * The dApp passes only a `manifestUrl`; both sides fetch it. The `url` field is
 * the canonical dApp origin and doubles as the domain the Aetra Proof binds to,
 * so the wallet verifies ownership against the app's own declared origin.
 */
export interface AetraConnectManifest {
  /** The dApp origin — its identity and the Aetra Proof domain. No trailing slash. */
  url: string;
  /** Display name shown in the wallet's approval screen. */
  name: string;
  /** Icon URL — PNG or ICO (not SVG), ~180×180 recommended, CORS-open. */
  iconUrl: string;
  /** Optional terms-of-use document URL. */
  termsOfUseUrl?: string;
  /** Optional privacy-policy URL. */
  privacyPolicyUrl?: string;
}

/** Maps a manifest to the internal `AppMetadata` (icon field rename, url normalised). */
export function manifestToApp(manifest: AetraConnectManifest): AppMetadata {
  return {
    name: manifest.name,
    url: normaliseOrigin(manifest.url),
    icon: manifest.iconUrl,
  };
}

/** Strips a trailing slash so a manifest `url` and a proof `domain` compare equal. */
export function normaliseOrigin(url: string): string {
  return url.replace(/\/+$/, "");
}

/**
 * Fetches and validates a manifest from `url`. Rejects with a typed
 * `AetraConnectError("MALFORMED", …)` on a network failure or a bad shape —
 * a wallet should refuse to pair with an app whose manifest isn't reachable.
 */
export async function loadManifest(url: string, fetchImpl: typeof fetch = globalThis.fetch): Promise<AetraConnectManifest> {
  if (typeof fetchImpl !== "function") {
    throw new AetraConnectError("INTERNAL", "loadManifest: no global fetch; pass a fetch implementation");
  }
  let res: Response;
  try {
    res = await fetchImpl(url, { cache: "no-store" });
  } catch (err) {
    throw new AetraConnectError("MALFORMED", `could not fetch manifest at ${url}`, err instanceof Error ? err.message : String(err));
  }
  if (!res.ok) {
    throw new AetraConnectError("MALFORMED", `manifest fetch failed with ${res.status} at ${url}`);
  }
  let json: unknown;
  try {
    json = await res.json();
  } catch {
    throw new AetraConnectError("MALFORMED", `manifest at ${url} is not valid JSON`);
  }
  return validateManifest(json);
}

/** Structural validation of a manifest object. Throws `MALFORMED` on anything off. */
export function validateManifest(value: unknown): AetraConnectManifest {
  const bad = (why: string): never => {
    throw new AetraConnectError("MALFORMED", `invalid manifest: ${why}`);
  };
  if (typeof value !== "object" || value === null) return bad("not an object");
  const m = value as Record<string, unknown>;
  if (typeof m.url !== "string" || !isHttpUrl(m.url)) bad("missing or non-http `url`");
  if (typeof m.name !== "string" || m.name.length === 0) bad("missing `name`");
  if (typeof m.iconUrl !== "string" || !isHttpUrl(m.iconUrl)) bad("missing or non-http `iconUrl`");
  if (m.termsOfUseUrl !== undefined && typeof m.termsOfUseUrl !== "string") bad("malformed `termsOfUseUrl`");
  if (m.privacyPolicyUrl !== undefined && typeof m.privacyPolicyUrl !== "string") bad("malformed `privacyPolicyUrl`");

  return {
    url: m.url as string,
    name: m.name as string,
    iconUrl: m.iconUrl as string,
    ...(typeof m.termsOfUseUrl === "string" ? { termsOfUseUrl: m.termsOfUseUrl } : {}),
    ...(typeof m.privacyPolicyUrl === "string" ? { privacyPolicyUrl: m.privacyPolicyUrl } : {}),
  };
}

function isHttpUrl(value: string): boolean {
  return /^https?:\/\/.+/i.test(value);
}
