import { Bytes } from "@aetra/sdk/bytes";
import { SessionKeyPair, SessionCipher } from "../crypto/index.js";
import { AetraConnectError } from "../errors.js";
import type { BridgeEnvelope, ConnectedAccount, AppMetadata, RpcMessage } from "../types.js";

/** Which end of the pairing a `Session` represents. */
export type SessionRole = "dapp" | "wallet";

/**
 * A JSON-serialisable snapshot of a session, as written to a `SessionStore`.
 * The channel key is NOT stored — it is re-derived from `selfSecretHex` and the
 * peer's public key (`peerClientId`) on load, so a leaked store yields no
 * standing decryptor without the secret key alongside it.
 */
export interface SessionRecord {
  topic: string;
  role: SessionRole;
  selfSecretHex: string;
  peerClientId: string;
  account: ConnectedAccount;
  app: AppMetadata;
  bridge: string;
  createdAt: number;
  expiresAt: number;
  lastActivityAt: number;
}

/**
 * `Session` — one live pairing between a dApp and a wallet. It owns the crypto
 * (this side's keypair + the derived `SessionCipher`) and the metadata (peer,
 * account, lifetimes), and turns `RpcMessage`s into sealed `BridgeEnvelope`s and
 * back. Lifetime checks (`isExpired`, `isIdle`) drive the connectors'
 * auto-disconnect.
 */
export class Session {
  readonly topic: string;
  readonly role: SessionRole;
  private readonly self: SessionKeyPair;
  readonly peerClientId: string;
  private readonly cipher: SessionCipher;

  account: ConnectedAccount;
  readonly app: AppMetadata;
  readonly bridge: string;
  readonly createdAt: number;
  expiresAt: number;
  lastActivityAt: number;

  constructor(params: {
    topic: string;
    role: SessionRole;
    self: SessionKeyPair;
    peerClientId: string;
    account: ConnectedAccount;
    app: AppMetadata;
    bridge: string;
    createdAt: number;
    expiresAt: number;
    lastActivityAt?: number;
  }) {
    this.topic = params.topic;
    this.role = params.role;
    this.self = params.self;
    this.peerClientId = params.peerClientId;
    this.account = params.account;
    this.app = params.app;
    this.bridge = params.bridge;
    this.createdAt = params.createdAt;
    this.expiresAt = params.expiresAt;
    this.lastActivityAt = params.lastActivityAt ?? params.createdAt;

    const peerPublicKey = Bytes.fromHex(params.peerClientId);
    this.cipher = new SessionCipher(
      this.self.sharedSecret(peerPublicKey),
      SessionCipher.contextFor(this.self.clientId, params.peerClientId),
    );
  }

  /** This side's client id (its session public key, hex). */
  get selfClientId(): string {
    return this.self.clientId;
  }

  /** Seals an RPC message into an envelope addressed to the peer. */
  seal(message: RpcMessage): BridgeEnvelope {
    return {
      from: this.self.clientId,
      to: this.peerClientId,
      payload: this.cipher.sealJson(message),
    };
  }

  /** Opens an inbound envelope, rejecting one that isn't from this session's peer. */
  open(envelope: BridgeEnvelope): RpcMessage {
    if (envelope.from !== this.peerClientId) {
      throw new AetraConnectError("DECRYPT_FAILED", "envelope is not from this session's peer");
    }
    return this.cipher.openJson<RpcMessage>(envelope.payload);
  }

  /** Marks activity now (or at `at`), resetting the idle clock. */
  touch(at?: number): void {
    this.lastActivityAt = at ?? Date.now();
  }

  /** True once past the hard session TTL. */
  isExpired(now = Date.now()): boolean {
    return now >= this.expiresAt;
  }

  /** True once idle for at least `idleMs` (0 disables the idle check). */
  isIdle(idleMs: number, now = Date.now()): boolean {
    return idleMs > 0 && now - this.lastActivityAt >= idleMs;
  }

  toRecord(): SessionRecord {
    return {
      topic: this.topic,
      role: this.role,
      selfSecretHex: this.self.secretHex,
      peerClientId: this.peerClientId,
      account: this.account,
      app: this.app,
      bridge: this.bridge,
      createdAt: this.createdAt,
      expiresAt: this.expiresAt,
      lastActivityAt: this.lastActivityAt,
    };
  }

  static fromRecord(record: SessionRecord): Session {
    return new Session({
      topic: record.topic,
      role: record.role,
      self: SessionKeyPair.fromSecretHex(record.selfSecretHex),
      peerClientId: record.peerClientId,
      account: record.account,
      app: record.app,
      bridge: record.bridge,
      createdAt: record.createdAt,
      expiresAt: record.expiresAt,
      lastActivityAt: record.lastActivityAt,
    });
  }
}
