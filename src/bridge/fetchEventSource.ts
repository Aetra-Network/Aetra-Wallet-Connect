/**
 * `FetchEventSource` — a minimal Server-Sent-Events client built on streaming
 * `fetch`, exposing the same surface `HttpBridge` uses from the browser's
 * `EventSource` (`onopen`/`onmessage`/`onerror`/`close`). It exists so the
 * bridge works out of the box in Node (>=18) and other runtimes that ship
 * `fetch` but not `EventSource` — a Telegram bot, a backend, a CLI.
 *
 * Behaviour mirrors the browser type where it matters:
 *   - auto-reconnects after a dropped stream (fixed small backoff),
 *   - only `data:` lines are surfaced; comments (`: ping`) keep the socket warm,
 *   - `close()` is final — no further events or reconnects.
 */

const RECONNECT_DELAY_MS = 3_000;
/**
 * Hard cap on the SSE frame-assembly buffer. One legitimate frame is one
 * `BridgeEnvelope` JSON — bounded by `SessionCipher`'s own ~256 KiB envelope
 * cap plus a little `from`/`to`/JSON overhead — so 512 KiB is roughly 2x that
 * and never rejects real traffic, while still bounding a hostile/compromised
 * relay that never sends the terminating blank line from growing this buffer
 * without limit.
 */
const MAX_BUFFER_LENGTH = 512 * 1024;

type MessageLike = { data: string };

export class FetchEventSource {
  onopen: (() => void) | null = null;
  onmessage: ((event: MessageLike) => void) | null = null;
  onerror: ((error?: unknown) => void) | null = null;

  private closed = false;
  private controller: AbortController | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly url: string,
    private readonly fetchImpl: typeof fetch = globalThis.fetch,
  ) {
    void this.run();
  }

  close(): void {
    this.closed = true;
    this.controller?.abort();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
  }

  private scheduleReconnect(): void {
    if (this.closed) return;
    this.reconnectTimer = setTimeout(() => void this.run(), RECONNECT_DELAY_MS);
    // Don't hold a Node process open just to keep retrying a dead relay.
    (this.reconnectTimer as { unref?: () => void }).unref?.();
  }

  private async run(): Promise<void> {
    if (this.closed) return;
    this.controller = new AbortController();
    try {
      const res = await this.fetchImpl(this.url, {
        headers: { Accept: "text/event-stream" },
        cache: "no-store",
        signal: this.controller.signal,
      });
      if (!res.ok || !res.body) {
        this.onerror?.(new Error(`SSE endpoint answered ${res.status}`));
        this.scheduleReconnect();
        return;
      }
      this.onopen?.();

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        if (buffer.length > MAX_BUFFER_LENGTH) {
          this.controller?.abort();
          this.onerror?.(new Error("SSE frame buffer exceeded the maximum size — dropping the connection"));
          this.scheduleReconnect();
          return;
        }
        // SSE frames are separated by a blank line.
        let frameEnd;
        while ((frameEnd = buffer.indexOf("\n\n")) !== -1) {
          const frame = buffer.slice(0, frameEnd);
          buffer = buffer.slice(frameEnd + 2);
          const data = frame
            .split("\n")
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).trim())
            .join("\n");
          if (data) this.onmessage?.({ data });
        }
      }
      // Stream ended (relay restarted, network flap) — treat like the browser does.
      this.onerror?.(new Error("SSE stream ended"));
      this.scheduleReconnect();
    } catch (err) {
      if (this.closed) return;
      this.onerror?.(err);
      this.scheduleReconnect();
    }
  }
}
