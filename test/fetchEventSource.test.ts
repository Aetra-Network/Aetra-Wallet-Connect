import { describe, it, expect, vi } from "vitest";
import { FetchEventSource } from "../src/bridge/fetchEventSource.js";

describe("FetchEventSource", () => {
  it("parses a normal SSE data frame", async () => {
    const encoder = new TextEncoder();
    const payload = JSON.stringify({ from: "a", to: "b", payload: "c" });
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(`data: ${payload}\n\n`));
        // Left open — real SSE streams stay open between messages.
      },
    });
    const fetchImpl = vi.fn(async () => new Response(stream, { status: 200 })) as unknown as typeof fetch;
    const es = new FetchEventSource("https://relay.example/events", fetchImpl);

    const message = await new Promise<{ data: string }>((resolve) => {
      es.onmessage = resolve;
    });
    expect(message.data).toBe(payload);
    es.close();
  });

  it("aborts and errors instead of buffering an unterminated stream forever", async () => {
    // A hostile/compromised relay that never sends the "\n\n" frame
    // terminator — each pull yields another chunk of garbage.
    let pulls = 0;
    const chunk = new Uint8Array(64 * 1024).fill(97); // 'a', never contains \n\n
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls++;
        controller.enqueue(chunk);
      },
    });
    const fetchImpl = vi.fn(async () => new Response(stream, { status: 200 })) as unknown as typeof fetch;

    const messages: unknown[] = [];
    const es = new FetchEventSource("https://relay.example/events", fetchImpl);
    es.onmessage = (m) => messages.push(m);

    const err = await new Promise<unknown>((resolve) => {
      es.onerror = resolve;
    });
    es.close();

    expect(String(err)).toMatch(/buffer exceeded the maximum size/i);
    expect(messages).toHaveLength(0);
    // Bounded: stopped well short of pulling indefinitely (512 KiB cap / 64 KiB chunks ~= 8-9 pulls).
    expect(pulls).toBeLessThan(50);
  });
});
