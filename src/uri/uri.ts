import { Bytes } from "@aetra/sdk/bytes";
import { AetraConnectError } from "../errors.js";
import { CONNECT_URI_SCHEME } from "../version.js";
import type { AppMetadata, ConnectRequest, RequestedItem } from "../types.js";

/**
 * The pairing URI — the one payload that crosses out-of-band (a QR code the
 * wallet scans, or a deep link the browser follows). It carries the public
 * `ConnectRequest` as a single base64url `r` parameter, in two interchangeable
 * forms:
 *
 *   - a **deep link** (`aetra://connect?r=…`) a mobile/desktop wallet registers
 *     as a scheme handler, and
 *   - a **universal link** (`https://…/connect?r=…`) that opens the web wallet
 *     directly and is the natural thing to render into a QR code.
 *
 * Both decode to the same request.
 */

/** Where a universal link points when the dApp doesn't override it. */
export const DEFAULT_UNIVERSAL_BASE = "https://wallet.aetra.network/connect";

const QUERY_KEY = "r";
/** Hard cap on the encoded payload — a QR realistically holds a few KB; anything larger is junk/attack. */
const MAX_ENCODED_LENGTH = 8192;
/** X25519 public keys are 32 bytes → 64 lowercase hex chars. */
const CLIENT_ID_HEX_LENGTH = 64;
const MAX_ITEMS = 8;
const MAX_CHALLENGE_LENGTH = 512;

export interface ConnectUriForms {
  /** `aetra://connect?r=…` — opens an installed wallet via its scheme handler. */
  deepLink: string;
  /** `https://…/connect?r=…` — web-wallet + QR-friendly fallback. */
  universalLink: string;
}

export class ConnectUri {
  /** Encodes a request into both URI forms. */
  static encode(request: ConnectRequest, opts: { universalBase?: string } = {}): ConnectUriForms {
    const encoded = Bytes.toBase64Url(Bytes.utf8Encode(JSON.stringify(request)));
    const query = `${QUERY_KEY}=${encoded}&v=${request.v}`;
    const base = (opts.universalBase ?? DEFAULT_UNIVERSAL_BASE).replace(/[?#].*$/, "");
    return {
      deepLink: `${CONNECT_URI_SCHEME}://connect?${query}`,
      universalLink: `${base}?${query}`,
    };
  }

  /** Decodes either URI form (or a bare `r` value) back into a validated `ConnectRequest`. */
  static decode(uri: string): ConnectRequest {
    const encoded = extractR(uri);
    if (encoded.length > MAX_ENCODED_LENGTH) {
      throw new AetraConnectError("MALFORMED", "connect URI payload is too large");
    }
    let json: unknown;
    try {
      json = JSON.parse(Bytes.utf8Decode(Bytes.fromBase64Url(encoded)));
    } catch {
      throw new AetraConnectError("MALFORMED", "connect URI payload is not valid base64url JSON");
    }
    return validateConnectRequest(json);
  }
}

/** Pulls the `r` value out of a deep link, universal link, or a bare encoded string. */
function extractR(uri: string): string {
  const trimmed = uri.trim();
  const q = trimmed.indexOf("?");
  if (q === -1) {
    // No query — assume the whole thing is the encoded payload.
    if (/[:/?#&=]/.test(trimmed)) {
      throw new AetraConnectError("MALFORMED", "connect URI has no query parameters");
    }
    return trimmed;
  }
  const params = new URLSearchParams(trimmed.slice(q + 1));
  const r = params.get(QUERY_KEY);
  if (!r) throw new AetraConnectError("MALFORMED", `connect URI is missing the "${QUERY_KEY}" parameter`);
  return r;
}

/**
 * Structural validation of a decoded request. Rejects anything missing the
 * fields the handshake relies on; does NOT enforce protocol version (the wallet
 * connector decides which versions it accepts, so it can report a precise
 * UNSUPPORTED_VERSION instead of a generic MALFORMED).
 */
export function validateConnectRequest(value: unknown): ConnectRequest {
  const bad = (why: string): never => {
    throw new AetraConnectError("MALFORMED", `invalid connect request: ${why}`);
  };
  if (typeof value !== "object" || value === null) return bad("not an object");
  const r = value as Record<string, unknown>;

  if (typeof r.v !== "number" || !Number.isInteger(r.v)) bad("missing version");
  if (typeof r.clientId !== "string" || !isClientId(r.clientId)) bad("missing or malformed clientId");
  // `bridge` may be empty for an in-process / embedded transport where both
  // sides already share the bridge; the transport layer enforces reachability.
  if (typeof r.bridge !== "string") bad("missing bridge");
  if (!isAppMetadata(r.app)) bad("missing or malformed app metadata");
  if (!Array.isArray(r.items) || r.items.length > MAX_ITEMS || !r.items.every(isRequestedItem)) bad("malformed items");

  return {
    v: r.v as number,
    clientId: r.clientId as string,
    bridge: r.bridge as string,
    app: r.app as AppMetadata,
    items: r.items as RequestedItem[],
    ...(typeof r.validUntil === "number" ? { validUntil: r.validUntil } : {}),
  };
}

function isAppMetadata(value: unknown): value is AppMetadata {
  if (typeof value !== "object" || value === null) return false;
  const a = value as Record<string, unknown>;
  return typeof a.name === "string" && typeof a.url === "string";
}

function isRequestedItem(value: unknown): value is RequestedItem {
  if (typeof value !== "object" || value === null) return false;
  const i = value as Record<string, unknown>;
  if (i.name === "aetra_address") return true;
  if (i.name === "aetra_proof") return typeof i.payload === "string" && i.payload.length > 0 && i.payload.length <= MAX_CHALLENGE_LENGTH;
  return false;
}

/** A well-formed session client id: exactly 64 lowercase hex chars (a 32-byte X25519 key). */
function isClientId(value: string): boolean {
  return value.length === CLIENT_ID_HEX_LENGTH && /^[0-9a-f]+$/.test(value);
}
