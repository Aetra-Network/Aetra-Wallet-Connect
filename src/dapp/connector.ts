import { Bytes } from "@aetra-network/sdk/bytes";
import { Emitter } from "../emitter.js";
import { AetraConnectError } from "../errors.js";
import { PROTOCOL_VERSION, DEFAULT_BRIDGE_URL } from "../version.js";
import { SessionKeyPair, SessionCipher, randomId, randomChallenge } from "../crypto/index.js";
import { AetraProof, verifySignedMessage } from "../proof/index.js";
import { ConnectUri, type ConnectUriForms } from "../uri/index.js";
import { Session, MemorySessionStore, type SessionStore } from "../session/index.js";
import { HttpBridge, type Bridge, type BridgeSubscription } from "../bridge/index.js";
import { loadManifest, manifestToApp, type AetraConnectManifest } from "../manifest.js";
import type {
  AppMetadata,
  BridgeEnvelope,
  ConnectRequest,
  ConnectedAccount,
  RpcMessage,
  RpcRequest,
  RpcResponse,
  SendTransactionParams,
  SendTransactionResult,
  SignMessageResult,
  ConnectEventPayload,
} from "../types.js";

const DEFAULT_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_AUTO_DISCONNECT_MS = 30 * 60 * 1000;
const DEFAULT_CONNECT_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_REQUEST_TIMEOUT_MS = 3 * 60 * 1000;
const DEFAULT_REQUEST_VALIDITY_MS = 5 * 60 * 1000;
const DEFAULT_PROOF_MAX_AGE_SECONDS = 300;
const LIFETIME_CHECK_INTERVAL_MS = 15_000;

export interface AetraConnectOptions {
  /**
   * URL of the dApp's hosted manifest (TON-Connect style) — the recommended way
   * to declare identity. Provide this OR `app`. The manifest's `url` is the
   * origin the Aetra Proof binds to. `await connect.ready()` (or the React
   * provider) resolves it before the first `connect()`.
   */
  manifestUrl?: string;
  /** Inline dApp metadata, as an alternative to `manifestUrl`. Provide this OR `manifestUrl`. */
  app?: AppMetadata;
  /** A relay base URL or a `Bridge` instance. Defaults to the network bridge (`DEFAULT_BRIDGE_URL`). */
  bridge?: Bridge | string;
  /** Explicit bridge URL to advertise in the pairing request (defaults to the HttpBridge base). */
  bridgeUrl?: string;
  /** `fetch` implementation used to load the manifest (defaults to the global). */
  fetch?: typeof fetch;
  /** Session persistence. Defaults to in-memory (lost on reload). */
  storage?: SessionStore;
  /** Base for the universal (https) link form of the pairing URI. */
  universalBase?: string;
  /** Max session lifetime this dApp will honour (ms). Default 7 days. */
  sessionTtlMs?: number;
  /** Drop the session after this much inactivity (ms). Default 30 min; 0 disables. */
  autoDisconnectMs?: number;
  /** Max accepted Aetra Proof age (seconds). Default 300. */
  proofMaxAgeSeconds?: number;
  /** If set, reject a wallet whose reported `chainId` differs — guards against wrong-network pairing. */
  requiredChainId?: string;
}

export interface ConnectHandshake {
  /** `aetra://…` deep link — opens an installed wallet. */
  deepLink: string;
  /** `https://…` universal link — render this into the modal's QR code. */
  universalLink: string;
  /** The exact request encoded into the URI (for display/debugging). */
  request: ConnectRequest;
  /** Resolves with the account when the wallet approves; rejects on timeout, cancel, or bad proof. */
  approval(opts?: { timeoutMs?: number }): Promise<ConnectedAccount>;
  /** Abandons this pairing attempt (closes the listener). */
  cancel(): void;
}

type DappEventMap = {
  connect: ConnectedAccount;
  disconnect: { reason?: string };
  session_update: ConnectedAccount;
};

interface PendingHandshake {
  keypair: SessionKeyPair;
  request: ConnectRequest;
  challenge: string | null;
  settled: boolean;
  resolve: (account: ConnectedAccount) => void;
  reject: (err: AetraConnectError) => void;
  /** This handshake's OWN bridge listener — promoted to the session's on success, closed on failure. */
  subscription: BridgeSubscription | null;
  timer: ReturnType<typeof setTimeout> | null;
}

interface PendingRequest {
  resolve: (result: unknown) => void;
  reject: (err: AetraConnectError) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * `AetraConnect` — the dApp-side client. A website constructs one, calls
 * `connect()` to get a pairing URI (render it as a QR / deep-link button),
 * awaits `approval()`, then drives the wallet with `sendTransaction()` /
 * `signMessage()`. It owns exactly one live `Session` at a time and cleans it up
 * on disconnect, expiry, or inactivity.
 *
 * ```ts
 * const connect = new AetraConnect({ app, bridge: "https://bridge.aetra.network" });
 * await connect.restore();                       // resume a prior session, if any
 * const hs = connect.connect();
 * renderQr(hs.universalLink);
 * const account = await hs.approval();
 * const { hash } = await connect.sendTransaction({
 *   messages: [{ kind: "send", to: "AE…", amountNaet: "1000000000" }],
 * });
 * ```
 */
export class AetraConnect {
  private app?: AppMetadata;
  private manifest?: AetraConnectManifest;
  private readonly manifestUrl?: string;
  private readonly manifestFetch?: typeof fetch;
  private manifestReady?: Promise<void>;
  private readonly bridge: Bridge;
  private readonly bridgeUrl: string;
  private readonly storage: SessionStore;
  private readonly universalBase?: string;
  private readonly sessionTtlMs: number;
  private readonly autoDisconnectMs: number;
  private readonly proofMaxAgeSeconds: number;
  private readonly requiredChainId?: string;

  private readonly emitter = new Emitter<DappEventMap>();
  private readonly pendingRequests = new Map<string, PendingRequest>();

  private session: Session | null = null;
  /** The live session's bridge listener (distinct from any in-flight handshake's). */
  private sessionSub: BridgeSubscription | null = null;
  private handshake: PendingHandshake | null = null;
  private lifetimeTimer: ReturnType<typeof setInterval> | null = null;

  constructor(options: AetraConnectOptions) {
    this.manifestUrl = options.manifestUrl;
    this.manifestFetch = options.fetch;
    if (options.app) {
      this.app = options.app;
    } else if (!options.manifestUrl) {
      throw new AetraConnectError("MALFORMED", "AetraConnect requires either `manifestUrl` or `app`");
    }
    // The manifest is fetched lazily by ready() — the constructor stays free of
    // side effects, so building an instance on a server (SSR) is safe.

    const resolved = resolveBridge(options.bridge ?? DEFAULT_BRIDGE_URL, options.bridgeUrl);
    this.bridge = resolved.bridge;
    this.bridgeUrl = resolved.url;
    this.storage = options.storage ?? new MemorySessionStore();
    this.universalBase = options.universalBase;
    this.sessionTtlMs = options.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS;
    this.autoDisconnectMs = options.autoDisconnectMs ?? DEFAULT_AUTO_DISCONNECT_MS;
    this.proofMaxAgeSeconds = options.proofMaxAgeSeconds ?? DEFAULT_PROOF_MAX_AGE_SECONDS;
    this.requiredChainId = options.requiredChainId;
  }

  // --- Public state ----------------------------------------------------

  /**
   * Loads the manifest (once, memoised) and resolves when the app metadata is
   * available — immediately if `app` was inline. Call before the first
   * `connect()`; the React provider awaits it for you. Rejects with `MALFORMED`
   * if the manifest can't be fetched or is invalid.
   */
  async ready(): Promise<void> {
    if (this.app || !this.manifestUrl) return;
    if (!this.manifestReady) {
      this.manifestReady = loadManifest(this.manifestUrl, this.manifestFetch).then((m) => {
        this.manifest = m;
        this.app = manifestToApp(m);
      });
      // Keep the rejection observable via ready() without an unhandled-rejection warning.
      void this.manifestReady.catch(() => {});
    }
    await this.manifestReady;
  }

  /** The resolved app metadata (name/url/icon), or null until `ready()`. */
  get appMetadata(): AppMetadata | null {
    return this.app ?? null;
  }

  /** The loaded manifest, if one was configured and has resolved. */
  get manifestData(): AetraConnectManifest | null {
    return this.manifest ?? null;
  }

  /** The connected account, or null. */
  get account(): ConnectedAccount | null {
    return this.session?.account ?? null;
  }

  /** True while a live session exists. */
  get connected(): boolean {
    return this.session !== null;
  }

  on<K extends keyof DappEventMap>(event: K, fn: (payload: DappEventMap[K]) => void): () => void {
    return this.emitter.on(event, fn);
  }
  once<K extends keyof DappEventMap>(event: K, fn: (payload: DappEventMap[K]) => void): () => void {
    return this.emitter.once(event, fn);
  }
  off<K extends keyof DappEventMap>(event: K, fn: (payload: DappEventMap[K]) => void): void {
    this.emitter.off(event, fn);
  }

  // --- Connect ---------------------------------------------------------

  /**
   * Begins a pairing. Returns the URI forms immediately (render the QR now) and
   * an `approval()` promise that settles when the wallet responds. `proof`
   * defaults to true — the wallet must return a verifiable Aetra Proof or the
   * approval rejects with `BAD_PROOF`. Starting a new pairing while one is
   * already in flight supersedes it; completing one while already connected
   * replaces the current session (the old one is torn down cleanly).
   */
  connect(opts: { proof?: boolean; requestValidityMs?: number } = {}): ConnectHandshake {
    if (!this.app) {
      throw new AetraConnectError("MALFORMED", "manifest not loaded yet — await connect.ready() before connect()");
    }
    this.cancelHandshake();

    const keypair = SessionKeyPair.generate();
    const wantProof = opts.proof !== false;
    const challenge = wantProof ? randomChallenge() : null;
    const validUntil = Date.now() + (opts.requestValidityMs ?? DEFAULT_REQUEST_VALIDITY_MS);

    const request: ConnectRequest = {
      v: PROTOCOL_VERSION,
      clientId: keypair.clientId,
      bridge: this.bridgeUrl,
      ...(this.manifestUrl ? { manifestUrl: this.manifestUrl } : {}),
      app: this.app,
      items: wantProof ? [{ name: "aetra_address" }, { name: "aetra_proof", payload: challenge! }] : [{ name: "aetra_address" }],
      validUntil,
    };

    const forms: ConnectUriForms = ConnectUri.encode(request, { universalBase: this.universalBase });

    let resolveApproval!: (account: ConnectedAccount) => void;
    let rejectApproval!: (err: AetraConnectError) => void;
    const approvalPromise = new Promise<ConnectedAccount>((resolve, reject) => {
      resolveApproval = resolve;
      rejectApproval = reject;
    });
    // The promise may settle before anyone awaits it; swallow the "unhandled
    // rejection" noise for the un-awaited case (cancel/timeout with no approval()).
    approvalPromise.catch(() => {});

    const pending: PendingHandshake = {
      keypair,
      request,
      challenge,
      settled: false,
      resolve: resolveApproval,
      reject: rejectApproval,
      subscription: null,
      timer: null,
    };
    this.handshake = pending;

    // Each handshake listens on its own client id, with its own subscription.
    pending.subscription = this.bridge.subscribe(keypair.clientId, {
      onMessage: (env) => this.onInbound(env),
      onError: () => {
        /* transient bridge blips are non-fatal; SSE auto-reconnects */
      },
    });
    // Arm a default timeout even if approval() is never called, so an abandoned
    // handshake still cleans up its subscription.
    this.armHandshakeTimeout(pending, DEFAULT_CONNECT_TIMEOUT_MS);

    return {
      deepLink: forms.deepLink,
      universalLink: forms.universalLink,
      request,
      approval: (a = {}) => {
        if (a.timeoutMs !== undefined) this.armHandshakeTimeout(pending, a.timeoutMs);
        return approvalPromise;
      },
      cancel: () => this.failHandshake(pending, new AetraConnectError("USER_REJECTED", "pairing cancelled")),
    };
  }

  // --- Requests --------------------------------------------------------

  /** Asks the wallet to build, sign, and broadcast a transaction from `messages`. */
  async sendTransaction(params: {
    messages: SendTransactionParams["messages"];
    memo?: string;
    validUntil?: number;
    network?: string;
    timeoutMs?: number;
  }): Promise<SendTransactionResult> {
    const session = this.requireSession();
    if (!Array.isArray(params.messages) || params.messages.length === 0) {
      throw new AetraConnectError("MALFORMED", "sendTransaction requires at least one message");
    }
    const request: RpcRequest = {
      type: "request",
      id: randomId(),
      method: "aetra_sendTransaction",
      params: {
        from: session.account.address,
        messages: params.messages,
        ...(params.memo !== undefined ? { memo: params.memo } : {}),
        validUntil: params.validUntil ?? Date.now() + DEFAULT_REQUEST_VALIDITY_MS,
        ...(params.network !== undefined ? { network: params.network } : {}),
      },
    };
    const result = await this.sendRpc<unknown>(session, request, params.timeoutMs);
    return assertSendResult(result);
  }

  /**
   * Asks the wallet to sign an arbitrary UTF-8 message (off-chain proof of
   * ownership). The returned signature is verified locally against the session
   * account before resolving, so a resolved result is always genuine.
   */
  async signMessage(message: string, opts: { timeoutMs?: number } = {}): Promise<SignMessageResult> {
    const session = this.requireSession();
    const request: RpcRequest = {
      type: "request",
      id: randomId(),
      method: "aetra_signMessage",
      params: { message },
    };
    const result = assertSignResult(await this.sendRpc<unknown>(session, request, opts.timeoutMs));
    const proven = verifySignedMessage(result, message);
    if (proven.toUserFriendly() !== session.account.address) {
      throw new AetraConnectError("BAD_PROOF", "signed message came back from a different account");
    }
    return result;
  }

  // --- Disconnect / restore -------------------------------------------

  /** Ends the session, telling the wallet (best-effort) and clearing local state. */
  async disconnect(reason = "dapp disconnected"): Promise<void> {
    const session = this.session;
    if (session) {
      try {
        await this.bridge.send(session.seal({ type: "request", id: randomId(), method: "aetra_disconnect", params: { reason } }));
      } catch {
        /* best-effort notice */
      }
    }
    await this.teardown(reason);
  }

  /**
   * Reattaches to the most recent stored session (if any, unexpired), resubscribes,
   * and returns its account. Emits `connect` so a reactive UI updates. Returns null
   * when there's nothing to restore. A no-op if already connected.
   */
  async restore(): Promise<ConnectedAccount | null> {
    if (this.session) return this.session.account;
    this.cancelHandshake(); // don't leave an in-flight pairing dangling
    const records = (await this.storage.list()).filter((r) => r.role === "dapp" && r.expiresAt > Date.now());
    if (records.length === 0) return null;
    const latest = records.sort((a, b) => b.createdAt - a.createdAt)[0]!;

    const session = Session.fromRecord(latest);
    this.session = session;
    this.sessionSub = this.bridge.subscribe(session.selfClientId, {
      onMessage: (env) => this.onInbound(env),
      onError: () => {},
    });
    this.startLifetimeTimer();
    this.emitter.emit("connect", session.account);
    return session.account;
  }

  // --- Internals -------------------------------------------------------

  private requireSession(): Session {
    if (!this.session) throw new AetraConnectError("NO_SESSION", "not connected — call connect() first");
    return this.session;
  }

  private sendRpc<T>(session: Session, request: RpcRequest, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS): Promise<T> {
    session.touch();
    return new Promise<T>((resolve, reject) => {
      const id = (request as { id: string }).id;
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new AetraConnectError("TIMEOUT", "wallet did not answer the request in time"));
      }, timeoutMs);
      (timer as { unref?: () => void }).unref?.();
      this.pendingRequests.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });

      let envelope: BridgeEnvelope;
      try {
        envelope = session.seal(request);
      } catch (err) {
        clearTimeout(timer);
        this.pendingRequests.delete(id);
        reject(err instanceof AetraConnectError ? err : new AetraConnectError("INTERNAL", "failed to encode request"));
        return;
      }
      this.bridge.send(envelope).catch((err) => {
        const p = this.pendingRequests.get(id);
        if (!p) return;
        clearTimeout(p.timer);
        this.pendingRequests.delete(id);
        reject(err instanceof AetraConnectError ? err : new AetraConnectError("BRIDGE_ERROR", "failed to send request"));
      });
    });
  }

  private onInbound(envelope: BridgeEnvelope): void {
    // A live session's peer takes precedence; otherwise this may be a pairing reply.
    if (this.session && envelope.from === this.session.peerClientId) {
      this.onSessionMessage(envelope);
      return;
    }
    if (this.handshake && !this.handshake.settled) {
      this.onHandshakeReply(this.handshake, envelope);
    }
  }

  private onHandshakeReply(pending: PendingHandshake, envelope: BridgeEnvelope): void {
    // Decrypt with an ad-hoc cipher — no Session exists until we trust the reply.
    let message: RpcMessage;
    try {
      const cipher = new SessionCipher(
        pending.keypair.sharedSecret(Bytes.fromHex(envelope.from)),
        SessionCipher.contextFor(pending.keypair.clientId, envelope.from),
      );
      message = cipher.openJson<RpcMessage>(envelope.payload);
    } catch {
      return; // not for us / not decryptable — ignore quietly
    }
    if (message.type !== "event") return;
    if (message.event === "disconnect") {
      // The wallet declined the pairing — fail fast instead of timing out.
      this.failHandshake(pending, new AetraConnectError("USER_REJECTED", message.payload?.reason ?? "wallet rejected the connection"));
      return;
    }
    if (message.event !== "connect") return;

    const payload = message.payload as ConnectEventPayload;
    try {
      this.acceptConnect(pending, envelope.from, payload);
    } catch (err) {
      this.failHandshake(pending, err instanceof AetraConnectError ? err : new AetraConnectError("INTERNAL", "connect failed"));
    }
  }

  private acceptConnect(pending: PendingHandshake, walletClientId: string, payload: ConnectEventPayload): void {
    const account = payload.account;
    const app = this.app;
    if (!app) throw new AetraConnectError("INTERNAL", "manifest not resolved");

    // Enforce the proof iff we asked for one.
    if (pending.challenge !== null) {
      if (!account.proof) throw new AetraConnectError("BAD_PROOF", "wallet did not return the requested proof");
      const proven = AetraProof.verify(account.proof, {
        domain: app.url,
        payload: pending.challenge,
        dappClientId: pending.keypair.clientId,
        walletClientId,
        maxAgeSeconds: this.proofMaxAgeSeconds,
      });
      if (proven.toRaw() !== account.addressRaw || proven.toUserFriendly() !== account.address) {
        throw new AetraConnectError("BAD_PROOF", "proof address does not match the reported account");
      }
    }

    if (this.requiredChainId && account.chainId !== this.requiredChainId) {
      throw new AetraConnectError(
        "CHAIN_MISMATCH",
        `wallet is on chain "${account.chainId ?? "unknown"}", this dApp requires "${this.requiredChainId}"`,
      );
    }

    // Replacing a live session: tear the old one down cleanly first.
    if (this.session) this.teardown("replaced by a new connection");

    const now = Date.now();
    const expiresAt = Math.min(payload.expiresAt || now + this.sessionTtlMs, now + this.sessionTtlMs);
    const session = new Session({
      topic: pending.keypair.clientId,
      role: "dapp",
      self: pending.keypair,
      peerClientId: walletClientId,
      account,
      app,
      bridge: this.bridgeUrl,
      createdAt: now,
      expiresAt,
      lastActivityAt: now,
    });

    this.session = session;
    pending.settled = true;
    if (pending.timer) clearTimeout(pending.timer);
    // Promote the handshake's listener to the session's; don't let failHandshake close it.
    this.sessionSub = pending.subscription;
    pending.subscription = null;
    this.handshake = null;

    void Promise.resolve(this.storage.set(session.topic, session.toRecord())).catch(() => {});
    this.startLifetimeTimer();

    pending.resolve(account);
    this.emitter.emit("connect", account);
  }

  private onSessionMessage(envelope: BridgeEnvelope): void {
    const session = this.session;
    if (!session) return;
    let message: RpcMessage;
    try {
      message = session.open(envelope);
    } catch {
      return;
    }
    session.touch();

    if (message.type === "response") {
      this.settleResponse(message);
      return;
    }
    if (message.type === "event") {
      if (message.event === "disconnect") {
        void this.teardown(message.payload?.reason ?? "wallet disconnected");
      } else if (message.event === "session_update") {
        session.account = message.payload.account;
        void Promise.resolve(this.storage.set(session.topic, session.toRecord())).catch(() => {});
        this.emitter.emit("session_update", session.account);
      }
    }
  }

  private settleResponse(response: RpcResponse): void {
    const pending = this.pendingRequests.get(response.id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pendingRequests.delete(response.id);
    if (response.ok) pending.resolve(response.result);
    else pending.reject(AetraConnectError.fromWire(response.error));
  }

  private armHandshakeTimeout(pending: PendingHandshake, ms: number): void {
    if (pending.settled) return;
    if (pending.timer) clearTimeout(pending.timer);
    pending.timer = setTimeout(() => {
      this.failHandshake(pending, new AetraConnectError("TIMEOUT", "wallet did not respond in time"));
    }, ms);
    (pending.timer as { unref?: () => void }).unref?.();
  }

  private failHandshake(pending: PendingHandshake, err: AetraConnectError): void {
    if (pending.settled) return;
    pending.settled = true;
    if (pending.timer) clearTimeout(pending.timer);
    // Close this handshake's OWN subscription (never a promoted session sub).
    pending.subscription?.close();
    pending.subscription = null;
    if (this.handshake === pending) this.handshake = null;
    pending.reject(err);
  }

  private cancelHandshake(): void {
    if (this.handshake && !this.handshake.settled) {
      this.failHandshake(this.handshake, new AetraConnectError("USER_REJECTED", "superseded by a new connect()"));
    }
  }

  private startLifetimeTimer(): void {
    if (this.lifetimeTimer) return;
    this.lifetimeTimer = setInterval(() => {
      const session = this.session;
      if (!session) return;
      if (session.isExpired()) void this.teardown("session expired");
      else if (session.isIdle(this.autoDisconnectMs)) void this.teardown("session idle timeout");
    }, LIFETIME_CHECK_INTERVAL_MS);
    // Don't keep a Node process alive just for the heartbeat.
    (this.lifetimeTimer as { unref?: () => void }).unref?.();
  }

  /** Tears down the live session (not any in-flight handshake) and its listener. */
  private async teardown(reason: string): Promise<void> {
    const session = this.session;
    this.session = null;
    this.sessionSub?.close();
    this.sessionSub = null;
    if (this.lifetimeTimer) {
      clearInterval(this.lifetimeTimer);
      this.lifetimeTimer = null;
    }
    for (const [, p] of this.pendingRequests) {
      clearTimeout(p.timer);
      p.reject(new AetraConnectError("NO_SESSION", "session ended before the request completed"));
    }
    this.pendingRequests.clear();
    if (session) {
      await Promise.resolve(this.storage.delete(session.topic)).catch(() => {});
      this.emitter.emit("disconnect", { reason });
    }
  }
}

function resolveBridge(bridge: Bridge | string, bridgeUrl?: string): { bridge: Bridge; url: string } {
  if (typeof bridge === "string") {
    return { bridge: new HttpBridge({ baseUrl: bridge }), url: bridge };
  }
  const url = bridgeUrl ?? (bridge as { baseUrl?: string }).baseUrl ?? "";
  return { bridge, url };
}

/** Defensively validates the wallet's transaction reply shape (a hostile/buggy wallet could send anything). */
function assertSendResult(value: unknown): SendTransactionResult {
  const v = value as Record<string, unknown> | null;
  if (!v || typeof v.hash !== "string" || typeof v.accepted !== "boolean") {
    throw new AetraConnectError("TX_FAILED", "wallet returned a malformed transaction result");
  }
  return { hash: v.hash, accepted: v.accepted };
}

function assertSignResult(value: unknown): SignMessageResult {
  const v = value as Record<string, unknown> | null;
  if (!v || typeof v.signatureHex !== "string" || typeof v.pubkeyHex !== "string" || typeof v.address !== "string") {
    throw new AetraConnectError("BAD_PROOF", "wallet returned a malformed signature result");
  }
  return { signatureHex: v.signatureHex, pubkeyHex: v.pubkeyHex, address: v.address };
}
