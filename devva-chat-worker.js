// Devva community chat Worker (Cloudflare Durable Objects)
// Deploy this as a separate Worker. It enforces unique active usernames on the server.
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/health") return new Response("Devva chat server is online.");
    if (url.headers.get("Upgrade") !== "websocket") {
      return new Response("Devva chat is online. Connect with a WebSocket.", {
        headers: { "Content-Type": "text/plain; charset=utf-8" }
      });
    }
    const room = env.CHAT_ROOM.get(env.CHAT_ROOM.idFromName("devva-global"));
    return room.fetch(request);
  }
};

export class ChatRoom {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
  }

  async fetch(request) {
    const url = new URL(request.url);
    const name = (url.searchParams.get("name") || "").trim().replace(/\s+/g, " ");
    if (!/^[A-Za-z0-9_ -]{3,20}$/.test(name)) {
      return new Response("Invalid username.", { status: 400 });
    }
    const normalized = name.toLowerCase();
    const sockets = this.ctx.getWebSockets();
    const duplicate = sockets.some(ws => {
      const attachment = ws.deserializeAttachment() || {};
      return (attachment.name || "").toLowerCase() === normalized && ws.readyState === WebSocket.OPEN;
    });

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.ctx.acceptWebSocket(server);
    if (duplicate) {
      server.send(JSON.stringify({ type: "error", message: "That username is already in use. Choose another one." }));
      server.close(1008, "Username already in use");
      return new Response(null, { status: 101, webSocket: client });
    }
    server.serializeAttachment({ name });
    server.send(JSON.stringify({ type: "joined", name }));
    this.broadcast({ type: "system", text: name + " joined the chat." }, server);
    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketMessage(ws, raw) {
    let data;
    try { data = JSON.parse(raw); } catch { return; }
    if (!data || data.type !== "message" || typeof data.text !== "string") return;
    const text = data.text.trim();
    if (!text || text.length > 500) return;
    const attachment = ws.deserializeAttachment() || {};
    if (!attachment.name) return;
    // Basic per-connection cooldown to reduce spam.
    const now = Date.now();
    if (attachment.lastMessageAt && now - attachment.lastMessageAt < 700) return;
    attachment.lastMessageAt = now;
    ws.serializeAttachment(attachment);
    this.broadcast({ type: "message", name: attachment.name, text, time: now });
  }

  webSocketClose(ws) {
    const attachment = ws.deserializeAttachment() || {};
    if (attachment.name) this.broadcast({ type: "system", text: attachment.name + " left the chat." }, ws);
  }

  webSocketError(ws) {
    const attachment = ws.deserializeAttachment() || {};
    if (attachment.name) this.broadcast({ type: "system", text: attachment.name + " disconnected." }, ws);
  }

  broadcast(data, except = null) {
    const payload = JSON.stringify(data);
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === except || ws.readyState !== WebSocket.OPEN) continue;
      try { ws.send(payload); } catch {}
    }
  }
}
