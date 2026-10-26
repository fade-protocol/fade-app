// A local stand-in for the keeper's push (GET /v1/live) and its HTTP routes, for the app's
// tests: a plain node:http server that answers the WebSocket upgrade itself (RFC 6455 text,
// close and ping frames), answers the text "ping" with "pong" as the Workers runtime does for
// the keeper, and serves the other requests with `http`.
import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

export type StubConn = {
  /** Text messages the app sent, "ping" included. */
  received: string[];
  closed: boolean;
  send(text: string): void;
  /** A clean close, as the keeper sends one. */
  close(code?: number): void;
  /** The connection cut without a close: what a lost network looks like. */
  drop(): void;
};

export type StubOptions = {
  onConnection?: (conn: StubConn) => void;
  /** An HTTP status to refuse the upgrade with (429, 503); null to accept it. */
  refuse?: () => number | null;
  /** false: "ping" goes unanswered (a connection gone silent). */
  answerPings?: () => boolean;
  http?: (req: IncomingMessage, res: ServerResponse) => void;
};

function frame(opcode: number, payload: Buffer): Buffer {
  const n = payload.length;
  const head =
    n < 126
      ? Buffer.from([0x80 | opcode, n])
      : n < 65_536
        ? Buffer.from([0x80 | opcode, 126, n >> 8, n & 255])
        : Buffer.concat([Buffer.from([0x80 | opcode, 127]), bigLength(n)]);
  return Buffer.concat([head, payload]);
}

function bigLength(n: number): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64BE(BigInt(n));
  return b;
}

/** The complete frames at the start of `buf` (the client's are masked), and what is left. */
function frames(buf: Buffer): { out: { opcode: number; payload: Buffer }[]; rest: Buffer } {
  const out: { opcode: number; payload: Buffer }[] = [];
  let at = 0;
  for (;;) {
    if (buf.length - at < 2) break;
    const opcode = buf[at]! & 0x0f;
    let len = buf[at + 1]! & 0x7f;
    const masked = (buf[at + 1]! & 0x80) !== 0;
    let p = at + 2;
    if (len === 126) {
      if (buf.length < p + 2) break;
      len = buf.readUInt16BE(p);
      p += 2;
    } else if (len === 127) {
      if (buf.length < p + 8) break;
      len = Number(buf.readBigUInt64BE(p));
      p += 8;
    }
    const maskAt = p;
    if (masked) p += 4;
    if (buf.length < p + len) break;
    const payload = Buffer.from(buf.subarray(p, p + len));
    if (masked) for (let i = 0; i < len; i++) payload[i]! ^= buf[maskAt + (i % 4)]!;
    out.push({ opcode, payload });
    at = p + len;
  }
  return { out, rest: buf.subarray(at) };
}

export async function startStub(opts: StubOptions = {}) {
  const conns: StubConn[] = [];
  let upgrades = 0;
  const server: Server = createServer((req, res) => {
    if (opts.http) opts.http(req, res);
    else res.writeHead(404).end();
  });
  server.on("upgrade", (req: IncomingMessage, socket: Duplex) => {
    upgrades++;
    const refused = opts.refuse?.() ?? null;
    if (refused !== null || req.url !== "/v1/live") {
      socket.end(
        `HTTP/1.1 ${refused ?? 404} Refused\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`,
      );
      return;
    }
    const key = String(req.headers["sec-websocket-key"]);
    const accept = createHash("sha1")
      .update(key + GUID)
      .digest("base64");
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    const conn: StubConn = {
      received: [],
      closed: false,
      send: (text) => {
        if (!conn.closed) socket.write(frame(1, Buffer.from(text)));
      },
      close: (code = 1000) => {
        if (conn.closed) return;
        conn.closed = true;
        const b = Buffer.alloc(2);
        b.writeUInt16BE(code);
        socket.end(frame(8, b));
      },
      drop: () => {
        conn.closed = true;
        socket.destroy();
      },
    };
    let buf = Buffer.alloc(0);
    socket.on("data", (chunk: Buffer) => {
      const { out, rest } = frames(Buffer.concat([buf, chunk]));
      buf = Buffer.from(rest);
      for (const f of out) {
        if (f.opcode === 1) {
          const text = f.payload.toString();
          conn.received.push(text);
          if (text === "ping" && (opts.answerPings?.() ?? true)) conn.send("pong");
        } else if (f.opcode === 8) {
          if (!conn.closed) {
            conn.closed = true;
            socket.end(frame(8, f.payload.subarray(0, 2)));
          }
        } else if (f.opcode === 9) socket.write(frame(10, f.payload));
      }
    });
    socket.on("close", () => {
      conn.closed = true;
    });
    socket.on("error", () => {});
    conns.push(conn);
    opts.onConnection?.(conn);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    conns,
    upgrades: () => upgrades,
    stop: () =>
      new Promise<void>((r) => {
        for (const c of conns) if (!c.closed) c.drop();
        server.close(() => r());
      }),
  };
}

/** Resolves once `cond` holds, polling every 5 ms; rejects after `ms`. */
export async function until(cond: () => boolean, ms = 3_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}
