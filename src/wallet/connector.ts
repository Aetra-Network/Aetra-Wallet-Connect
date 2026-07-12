import { Address } from "@aetra/sdk/address";
import { Bytes } from "@aetra/sdk/bytes";
import { Emitter } from "../emitter.js";
import { AetraConnectError, userRejected } from "../errors.js";
import { PROTOCOL_VERSION } from "../version.js";
import { SessionKeyPair, SessionCipher } from "../crypto/index.js";
import { AetraProof, signMessage as builtinSignMessage, type ProofSigner } from "../proof/index.js";
import { ConnectUri } from "../uri/index.js";
import { Session, MemorySessionStore, type SessionStore } from "../session/index.js";
import { HttpBridge, type Bridge } from "../bridge/index.js";
import type {
  BridgeEnvelope,
  ConnectRequest,
  ConnectedAccount,
  RpcMessage,
  RpcResponse,
  SendTransactionParams,
  SendTransactionResult,
  SignMessageResult,
  WalletMetadata,
  AetraProofData,
} from "../types.js";

const DEFAULT_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_AUTO_DISCONNECT_MS = 30 * 60 * 1000;
const LIFETIME_CHECK_INTERVAL_MS = 15_000;

/** The wallet's account signer — a subset of the SDK `Signer` (an `@aetra/sdk` `Wallet` satisfies it). */
export type WalletSigner = ProofSigner;

/** Handles a decrypted transaction request: show UI, build/sign/broadcast, return the hash. */
export type TransactionHandler = (
  params: SendTransactionParams,
  context: TransactionContext,
) => Promise<SendTransactionResult>;

/** Handles an off-chain message-sign request. Omit to fall back to signing with the session signer. */
export type SignMessageHandler = (message: string, context: TransactionContext) => Promise<SignMessageResult>;

export interface TransactionContext {
  session: Session;
  account: ConnectedAccount;
}

export interface AetraWalletConnectOptions {
  /** A relay base URL or a `Bridge` instance (must be reachable from where the URI's `bridge` points). */
  bridge: Bridge | string;
  /** The unlocked account signer. */
  signer: WalletSigner;
  /** How the wallet presents itself back to the dApp. */
  wallet?: WalletMetadata;
  /** Network id reported to the dApp in the connected account. */
  chainId?: string;
  /** Session persistence. Defaults to in-memory. */
  storage?: SessionStore;
  /** REQUIRED: builds/signs/broadcasts an approved transaction. Throw `userRejected()` to decline. */
  onTransaction: TransactionHandler;
  /** Optional: gate off-chain message signing behind wallet UI. Without it, requests auto-sign. */
  onSignMessage?: SignMessageHandler;
  sessionTtlMs?: number;
  autoDisconnectMs?: number;
  /** Protocol major versions this wallet accepts. Defaults to the current one. */
  acceptedVersions?: number[];
}

type WalletEventMap = {
  connect: Session;
  disconnect: { topic: string; reason?: string };
  request: { topic: string; method: string };
};

/**
 * `AetraWalletConnect` — the wallet-side counterpart to `AetraConnect`. The
 * wallet reads a pairing URI, shows its own approval UI, then calls `approve()`
 * (or `reject()`). Once paired it serves the dApp's transaction / signing
 * requests through the injected `onTransaction` / `onSignMessage` handlers,
 * which is where the wallet renders its confirm dialog and reuses its existing
 * build-sign-broadcast pipeline.
 *
 * It manages many sessions at once (one wallet, many dApps), each with its own
 * ephemeral key and bridge subscription.
 */
export class AetraWalletConnect {
  private readonly bridge: Bridge;
  private readonly signer: WalletSigner;
  private readonly walletMeta?: WalletMetadata;
  private readonly chainId?: string;
  private readonly storage: SessionStore;
  private readonly onTransaction: TransactionHandler;
  private readonly onSignMessage?: SignMessageHandler;
  private readonly sessionTtlMs: number;
  private readonly autoDisconnectMs: number;
  private readonly acceptedVersions: number[];

  private readonly emitter = new Emitter<WalletEventMap>();
  private readonly sessions = new Map<string, Session>();
  private readonly subscriptions = new Map<string, { close(): void }>();
  private lifetimeTimer: ReturnType<typeof setInterval> | null = null;

  constructor(options: AetraWalletConnectOptions) {
    this.bridge = typeof options.bridge === "string" ? new HttpBridge({ baseUrl: options.bridge }) : options.bridge;
    this.signer = options.signer;
    this.walletMeta = options.wallet;
    this.chainId = options.chainId;
    this.storage = options.storage ?? new MemorySessionStore();
    this.onTransaction = options.onTransaction;
    this.onSignMessage = options.onSignMessage;
    this.sessionTtlMs = options.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS;
    this.autoDisconnectMs = options.autoDisconnectMs ?? DEFAULT_AUTO_DISCONNECT_MS;
    this.acceptedVersions = options.acceptedVersions ?? [PROTOCOL_VERSION];
  }

  // --- Public state ----------------------------------------------------

  /** All live sessions. */
  get activeSessions(): Session[] {
    return [...this.sessions.values()];
  }

  on<K extends keyof WalletEventMap>(event: K, fn: (payload: WalletEventMap[K]) => void): () => void {
    return this.emitter.on(event, fn);
  }
  off<K extends keyof WalletEventMap>(event: K, fn: (payload: WalletEventMap[K]) => void): void {
    this.emitter.off(event, fn);
  }

  // --- Pairing ---------------------------------------------------------

  /**
   * Parses and validates a pairing URI (scanned QR or opened deep link). Throws
   * `MALFORMED` / `UNSUPPORTED_VERSION` / `EXPIRED`. Show `request.app` in the
   * approval screen, then call `approve` or `reject`.
   */
  readRequest(uri: string): ConnectRequest {
    const request = ConnectUri.decode(uri);
    if (!this.acceptedVersions.includes(request.v)) {
      throw new AetraConnectError("UNSUPPORTED_VERSION", `unsupported protocol version ${request.v}`);
    }
    if (request.validUntil !== undefined && Date.now() > request.validUntil) {
      throw new AetraConnectError("EXPIRED", "pairing request has expired — ask the dApp for a fresh QR");
    }
    return request;
  }

  /** The account this wallet exposes (derived from the signer's public key). */
  currentAccount(proof?: AetraProofData): ConnectedAccount {
    const address = Address.fromPubkey(Bytes.fromHex(this.signer.pubkeyHex));
    return {
      address: address.toUserFriendly(),
      addressRaw: address.toRaw(),
      pubkeyHex: this.signer.pubkeyHex,
      ...(this.chainId ? { chainId: this.chainId } : {}),
      ...(proof ? { proof } : {}),
    };
  }

  /**
   * Approves a pairing: mints a session key, signs an Aetra Proof if requested,
   * sends the connect event to the dApp, and starts serving requests. Returns
   * the live `Session`.
   */
  async approve(request: ConnectRequest): Promise<Session> {
    const keypair = SessionKeyPair.generate();

    const proofItem = request.items.find((i) => i.name === "aetra_proof");
    let proof: AetraProofData | undefined;
    if (proofItem && proofItem.name === "aetra_proof") {
      proof = AetraProof.create({
        signer: this.signer,
        domain: request.app.url,
        payload: proofItem.payload,
        dappClientId: request.clientId,
        walletClientId: keypair.clientId,
      });
    }
    const account = this.currentAccount(proof);

    const now = Date.now();
    const expiresAt = now + this.sessionTtlMs;
    const session = new Session({
      topic: request.clientId,
      role: "wallet",
      self: keypair,
      peerClientId: request.clientId,
      account,
      app: request.app,
      bridge: request.bridge,
      createdAt: now,
      expiresAt,
      lastActivityAt: now,
    });

    this.attach(session);
    await this.storage.set(session.topic, session.toRecord());

    // First bridge message: the connect event the dApp is waiting for.
    await this.bridge.send(session.seal({ type: "event", event: "connect", payload: { account, wallet: this.walletMeta, expiresAt } }));

    this.startLifetimeTimer();
    this.emitter.emit("connect", session);
    return session;
  }

  /**
   * Declines a pairing and tells the dApp so its `approval()` fails fast with
   * `USER_REJECTED` instead of timing out. No session is formed.
   */
  async reject(request: ConnectRequest, reason = "user rejected the connection"): Promise<void> {
    const keypair = SessionKeyPair.generate();
    const cipher = new SessionCipher(
      keypair.sharedSecret(Bytes.fromHex(request.clientId)),
      SessionCipher.contextFor(keypair.clientId, request.clientId),
    );
    const envelope: BridgeEnvelope = {
      from: keypair.clientId,
      to: request.clientId,
      payload: cipher.sealJson({ type: "event", event: "disconnect", payload: { reason } } satisfies RpcMessage),
    };
    try {
      await this.bridge.send(envelope);
    } catch {
      /* best-effort */
    }
  }

  // --- Session serving -------------------------------------------------

  /**
   * Reattaches bridge subscriptions for all stored, unexpired wallet sessions —
   * call after the wallet unlocks so it keeps serving dApps paired before a reload.
   */
  async resume(): Promise<Session[]> {
    const records = (await this.storage.list()).filter((r) => r.role === "wallet" && r.expiresAt > Date.now());
    const resumed: Session[] = [];
    for (const record of records) {
      if (this.sessions.has(record.topic)) continue;
      const session = Session.fromRecord(record);
      this.attach(session);
      resumed.push(session);
    }
    if (resumed.length > 0) this.startLifetimeTimer();
    return resumed;
  }

  /** Ends one session, notifying the dApp. */
  async disconnect(topic: string, reason = "wallet disconnected"): Promise<void> {
    const session = this.sessions.get(topic);
    if (session) {
      try {
        await this.bridge.send(session.seal({ type: "event", event: "disconnect", payload: { reason } }));
      } catch {
        /* best-effort */
      }
    }
    await this.teardown(topic, reason, /* notified */ true);
  }

  private attach(session: Session): void {
    // Replacing a session for the same topic (e.g. a re-approve): close the old
    // listener first so it isn't orphaned.
    this.subscriptions.get(session.topic)?.close();
    this.sessions.set(session.topic, session);
    const sub = this.bridge.subscribe(session.selfClientId, {
      onMessage: (env) => void this.onSessionMessage(session.topic, env),
      onError: () => {},
    });
    this.subscriptions.set(session.topic, sub);
  }

  private async onSessionMessage(topic: string, envelope: BridgeEnvelope): Promise<void> {
    const session = this.sessions.get(topic);
    if (!session) return;
    let message: RpcMessage;
    try {
      message = session.open(envelope);
    } catch {
      return;
    }
    session.touch();
    void Promise.resolve(this.storage.set(session.topic, session.toRecord())).catch(() => {});

    if (message.type === "request") {
      this.emitter.emit("request", { topic, method: message.method });
      await this.handleRequest(session, message);
      return;
    }
    if (message.type === "event" && message.event === "disconnect") {
      await this.teardown(topic, message.payload?.reason ?? "dapp disconnected", /* notified */ true);
    }
  }

  private async handleRequest(
    session: Session,
    request: Extract<RpcMessage, { type: "request" }>,
  ): Promise<void> {
    const context: TransactionContext = { session, account: session.account };
    const respond = (response: RpcResponse) => this.bridge.send(session.seal(response)).catch(() => {});

    try {
      if (request.method === "aetra_disconnect") {
        await this.teardown(session.topic, request.params?.reason ?? "dapp disconnected", /* notified */ true);
        return;
      }

      if (request.method === "aetra_sendTransaction") {
        assertNotExpired(request.params.validUntil);
        assertFromMatches(request.params.from, session.account);
        const result = await this.onTransaction(request.params, context);
        await respond({ type: "response", id: request.id, ok: true, result });
        return;
      }

      if (request.method === "aetra_signMessage") {
        const result = this.onSignMessage
          ? await this.onSignMessage(request.params.message, context)
          : builtinSignMessage(this.signer, request.params.message);
        await respond({ type: "response", id: request.id, ok: true, result });
        return;
      }

      throw new AetraConnectError("UNSUPPORTED_METHOD", `unknown method ${(request as { method: string }).method}`);
    } catch (err) {
      const wire = err instanceof AetraConnectError ? err : new AetraConnectError("TX_FAILED", messageOf(err));
      await respond({ type: "response", id: (request as { id: string }).id, ok: false, error: wire.toWire() });
    }
  }

  private startLifetimeTimer(): void {
    if (this.lifetimeTimer) return;
    this.lifetimeTimer = setInterval(() => {
      const now = Date.now();
      for (const session of [...this.sessions.values()]) {
        if (session.isExpired(now)) void this.teardown(session.topic, "session expired", false);
        else if (session.isIdle(this.autoDisconnectMs, now)) void this.teardown(session.topic, "session idle timeout", false);
      }
    }, LIFETIME_CHECK_INTERVAL_MS);
    (this.lifetimeTimer as { unref?: () => void }).unref?.();
  }

  private async teardown(topic: string, reason: string, notified: boolean): Promise<void> {
    const session = this.sessions.get(topic);
    this.subscriptions.get(topic)?.close();
    this.subscriptions.delete(topic);
    this.sessions.delete(topic);
    await Promise.resolve(this.storage.delete(topic)).catch(() => {});
    if (this.sessions.size === 0 && this.lifetimeTimer) {
      clearInterval(this.lifetimeTimer);
      this.lifetimeTimer = null;
    }
    if (session) this.emitter.emit("disconnect", { topic, reason });
    // `notified` is advisory — callers that already told the peer pass true.
    void notified;
  }
}

function assertNotExpired(validUntil?: number): void {
  if (validUntil !== undefined && Date.now() > validUntil) {
    throw new AetraConnectError("EXPIRED", "transaction request expired before approval");
  }
}

/** Rejects a request whose declared signer isn't this session's account (a confused/hostile dApp). */
function assertFromMatches(from: string | undefined, account: ConnectedAccount): void {
  if (from !== undefined && from !== account.address && from !== account.addressRaw) {
    throw new AetraConnectError("ACCOUNT_MISMATCH", `request signer ${from} is not this session's account`);
  }
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export { userRejected };
