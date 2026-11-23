'use strict';

// LocalShare server: static files + WebSocket signaling.
// Files travel peer-to-peer over WebRTC data channels; this server only
// introduces peers, relays signaling/text, and (as a fallback) relays
// chunked file data when a direct connection cannot be established.

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { WebSocketServer } = require('ws');

const PORT = Number(process.env.PORT) || 7070;
const PUBLIC_DIR = path.join(__dirname, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

function getLocalIPs() {
  const ips = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const iface of list || []) {
      if (iface.family === 'IPv4' && !iface.internal) ips.push(iface.address);
    }
  }
  return ips;
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');

  if (url.pathname === '/api/info') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ hostname: os.hostname(), ips: getLocalIPs(), port: PORT }));
    return;
  }

  let filePath = path.join(PUBLIC_DIR, url.pathname === '/' ? 'index.html' : url.pathname);
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403); res.end(); return;
  }
  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    fs.createReadStream(filePath).pipe(res);
  });
});

const wss = new WebSocketServer({ server, maxPayload: 4 * 1024 * 1024 });

// id -> { ws, name, deviceType }
const clients = new Map();
let nextId = 1;

function send(ws, obj) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
}

function broadcastPeers() {
  const peers = [...clients.entries()].map(([id, c]) => ({
    id, name: c.name, deviceType: c.deviceType,
  }));
  for (const c of clients.values()) send(c.ws, { type: 'peers', peers });
}

function forward(toId, obj) {
  const target = clients.get(toId);
  if (target) send(target.ws, obj);
}

wss.on('connection', (ws) => {
  const id = String(nextId++);
  const client = { ws, name: '', deviceType: 'desktop' };
  clients.set(id, client);
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (data, isBinary) => {
    if (isBinary) {
      // Relay fallback frame: [4-byte BE header length][JSON header][payload]
      // Header: { to, transferId, kind: 'start'|'chunk'|'end', name?, size?, fileType? }
      try {
        const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
        if (buf.length < 4) return;
        const headerLen = buf.readUInt32BE(0);
        const header = JSON.parse(buf.subarray(4, 4 + headerLen).toString('utf8'));
        const target = clients.get(String(header.to));
        if (!target || target.ws.readyState !== ws.OPEN) return;
        const outHeader = Buffer.from(JSON.stringify({ ...header, from: id }), 'utf8');
        const lenBuf = Buffer.allocUnsafe(4);
        lenBuf.writeUInt32BE(outHeader.length, 0);
        target.ws.send(Buffer.concat([lenBuf, outHeader, buf.subarray(4 + headerLen)]), { binary: true });
      } catch { /* malformed frame: drop */ }
      return;
    }

    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }
    if (!msg || typeof msg !== 'object') return;

    if (msg.type === 'register') {
      client.name = String(msg.name || os.hostname()).slice(0, 40);
      client.deviceType = String(msg.deviceType || 'desktop').slice(0, 20);
      send(ws, { type: 'welcome', id });
      broadcastPeers();
      return;
    }
    if (msg.type === 'update-profile') {
      if (msg.name) client.name = String(msg.name).slice(0, 40);
      broadcastPeers();
      return;
    }
    if (msg.type === 'ping') { send(ws, { type: 'pong' }); return; }

    // Everything else is peer-to-peer control traffic addressed with `to`:
    // signal (SDP/ICE), send-request / send-accept / send-reject /
    // send-cancel, text, relay-note. Forward verbatim, stamped with `from`.
    if (typeof msg.to === 'string') {
      forward(msg.to, { ...msg, from: id });
    }
  });

  const cleanup = () => {
    if (clients.delete(id)) broadcastPeers();
  };
  ws.on('close', cleanup);
  ws.on('error', cleanup);
});

// Drop dead sockets so the peer list never shows ghosts.
const heartbeat = setInterval(() => {
  for (const { ws } of clients.values()) {
    if (ws.isAlive === false) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, 30000);
wss.on('close', () => clearInterval(heartbeat));

server.listen(PORT, '0.0.0.0', () => {
  console.log('LocalShare 已启动');
  console.log(`  本机打开        http://localhost:${PORT}`);
  for (const ip of getLocalIPs()) {
    console.log(`  其他设备（同一 Wi-Fi）  http://${ip}:${PORT}`);
  }
});
