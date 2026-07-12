/**
 * Reference Aetra Connect relay — a minimal, in-memory bridge server.
 *
 * The relay is a dumb, stateless-ish forwarder: it routes opaque envelopes by
 * their `to` client id and never sees plaintext (payloads are AEAD-sealed). It
 * exposes exactly the two endpoints `HttpBridge` talks to:
 *
 *   GET  /events?client=<clientId>   Server-Sent-Events stream of envelopes for <clientId>
 *   POST /send   { from, to, payload }   enqueue/deliver one envelope toward `to`
 *
 * Run it:  node examples/relay.mjs           (listens on :8788)
 *          PORT=9000 node examples/relay.mjs
 *
 * This is a reference for local development. A production relay would add rate
 * limiting, a bounded queue TTL, and horizontal fan-out (Redis pub/sub, etc.) —
 * but nothing here needs the operator to be trusted with keys or plaintext.
 */
import http from "node:http";

const PORT = Number(process.env.PORT ?? 8788);
const QUEUE_TTL_MS = 5 * 60 * 1000; // drop undelivered envelopes after 5 minutes

/** clientId -> Set<ServerResponse> of live SSE listeners */
const listeners = new Map();
/** clientId -> [{ envelope, at }] buffered until a listener connects */
const pending = new Map();

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (req.method === "OPTIONS") {
    res.writeHead(204, cors);
    res.end();
    return;
  }

  if (req.method === "GET" && url.pathname === "/events") {
    const client = url.searchParams.get("client");
    if (!client) {
      res.writeHead(400, cors);
      res.end("missing client");
      return;
    }
    openStream(client, res);
    return;
  }

  if (req.method === "POST" && url.pathname === "/send") {
    readBody(req)
      .then((body) => {
        const envelope = JSON.parse(body);
        if (!envelope || typeof envelope.to !== "string") throw new Error("bad envelope");
        deliver(envelope);
        res.writeHead(200, { ...cors, "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      })
      .catch((err) => {
        res.writeHead(400, { ...cors, "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: String(err?.message ?? err) }));
      });
    return;
  }

  if (req.method === "GET" && url.pathname === "/health") {
    res.writeHead(200, { ...cors, "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, listeners: listeners.size, pending: pending.size }));
    return;
  }

  res.writeHead(404, cors);
  res.end("not found");
});

function openStream(client, res) {
  res.writeHead(200, {
    ...cors,
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.write(": connected\n\n");

  let set = listeners.get(client);
  if (!set) {
    set = new Set();
    listeners.set(client, set);
  }
  set.add(res);

  // Flush anything buffered before this listener showed up.
  const queued = pending.get(client);
  if (queued) {
    pending.delete(client);
    const now = Date.now();
    for (const { envelope, at } of queued) {
      if (now - at <= QUEUE_TTL_MS) writeEvent(res, envelope);
    }
  }

  const heartbeat = setInterval(() => res.write(": ping\n\n"), 20_000);
  req_on_close(res, () => {
    clearInterval(heartbeat);
    set.delete(res);
    if (set.size === 0) listeners.delete(client);
  });
}

function deliver(envelope) {
  const set = listeners.get(envelope.to);
  if (set && set.size > 0) {
    for (const res of set) writeEvent(res, envelope);
    return;
  }
  const queue = pending.get(envelope.to) ?? [];
  queue.push({ envelope, at: Date.now() });
  pending.set(envelope.to, queue);
}

function writeEvent(res, envelope) {
  res.write(`data: ${JSON.stringify(envelope)}\n\n`);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > 1_000_000) reject(new Error("payload too large"));
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

function req_on_close(res, fn) {
  res.on("close", fn);
}

server.listen(PORT, () => {
  console.log(`Aetra Connect relay listening on http://127.0.0.1:${PORT}`);
  console.log(`  SSE   GET  /events?client=<clientId>`);
  console.log(`  send  POST /send   { from, to, payload }`);
});
