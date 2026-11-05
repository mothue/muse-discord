// Fake Discord Gateway (Bun WebSocket server on localhost).
import type { ServerWebSocket } from "bun";

export interface Conn {
  ws: ServerWebSocket<{ path: string }>;
  path: string;
  received: any[];
  closeCode?: number;
}

export class FakeGateway {
  server: ReturnType<typeof Bun.serve<{ path: string }>>;
  conns: Conn[] = [];
  heartbeatInterval = 45000;
  /** Reply to heartbeats with op 11 */
  ackHeartbeats = true;
  seq = 0;
  /** Every payload a client sent, across connections */
  get received() {
    return this.conns.flatMap((c) => c.received);
  }

  constructor() {
    this.server = Bun.serve<{ path: string }>({
      port: 0,
      hostname: "127.0.0.1",
      fetch: (req, server) => {
        const u = new URL(req.url);
        if (server.upgrade(req, { data: { path: u.pathname + u.search } })) return undefined;
        return new Response("expected websocket", { status: 400 });
      },
      websocket: {
        open: (ws) => {
          this.conns.push({ ws, path: ws.data.path, received: [] });
          ws.send(JSON.stringify({ op: 10, d: { heartbeat_interval: this.heartbeatInterval } }));
        },
        message: (ws, raw) => {
          const conn = this.conns.find((c) => c.ws === ws)!;
          const p = JSON.parse(String(raw));
          conn.received.push(p);
          if (p.op === 1 && this.ackHeartbeats) ws.send(JSON.stringify({ op: 11 }));
        },
        close: (ws, code) => {
          const conn = this.conns.find((c) => c.ws === ws);
          if (conn) conn.closeCode = code;
        },
      },
    });
  }

  get url() {
    return `ws://127.0.0.1:${this.server.port}/gw`;
  }
  get resumeUrl() {
    return `ws://127.0.0.1:${this.server.port}/resume`;
  }
  get current(): Conn | undefined {
    return this.conns[this.conns.length - 1];
  }

  send(payload: unknown, conn = this.current) {
    conn!.ws.send(JSON.stringify(payload));
  }
  dispatch(t: string, d: unknown, conn = this.current) {
    this.seq += 1;
    this.send({ op: 0, t, s: this.seq, d }, conn);
    return this.seq;
  }
  /** Re-send a dispatch with an existing seq (Resume replay) */
  replay(t: string, d: unknown, s: number, conn = this.current) {
    this.send({ op: 0, t, s, d }, conn);
  }
  ready(user: { id: string; username: string }, sessionId = "sess-1") {
    return this.dispatch("READY", { v: 10, user, session_id: sessionId, resume_gateway_url: this.resumeUrl, guilds: [] });
  }
  stop() {
    this.server.stop(true);
  }
}
