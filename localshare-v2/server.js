const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const os = require('os');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 7070;

// Track connected clients
const clients = new Map(); // id -> { ws, name, avatar }
let clientIdCounter = 1;

function getLocalIPs() {
  const interfaces = os.networkInterfaces();
  const ips = [];
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        ips.push({ name, ip: iface.address });
      }
    }
  }
  return ips;
}

function getDeviceName() {
  return os.hostname();
}

function broadcast(data, excludeId = null) {
  const msg = JSON.stringify(data);
  clients.forEach((client, id) => {
    if (id !== excludeId && client.ws.readyState === WebSocket.OPEN) {
      client.ws.send(msg);
    }
  });
}

function broadcastPeerList() {
  const peers = Array.from(clients.entries()).map(([id, c]) => ({
    id, name: c.name, avatar: c.avatar, deviceType: c.deviceType
  }));
  clients.forEach((client) => {
    if (client.ws.readyState === WebSocket.OPEN) {
      client.ws.send(JSON.stringify({ type: 'peers', peers }));
    }
  });
}

wss.on('connection', (ws) => {
  const clientId = String(clientIdCounter++);
  let clientInfo = { ws, name: 'Unknown', avatar: '💻', deviceType: 'desktop' };
  clients.set(clientId, clientInfo);

  ws.on('message', (rawData, isBinary) => {
    // Binary = file chunk
    if (isBinary) {
      // Parse header (first 512 bytes as JSON length + JSON + file data)
      try {
        const buf = Buffer.from(rawData);
        const headerLen = buf.readUInt32BE(0);
        const header = JSON.parse(buf.slice(4, 4 + headerLen).toString('utf8'));
        const fileData = buf.slice(4 + headerLen);

        // Forward to target
        const target = clients.get(header.targetId);
        if (target && target.ws.readyState === WebSocket.OPEN) {
          const forwardHeader = { ...header, senderId: clientId, senderName: clientInfo.name };
          const forwardHeaderBuf = Buffer.from(JSON.stringify(forwardHeader), 'utf8');
          const lenBuf = Buffer.allocUnsafe(4);
          lenBuf.writeUInt32BE(forwardHeaderBuf.length, 0);
          const outBuf = Buffer.concat([lenBuf, forwardHeaderBuf, fileData]);
          target.ws.send(outBuf, { binary: true });
        }
      } catch (e) {
        console.error('Binary parse error', e);
      }
      return;
    }

    // JSON messages
    let msg;
    try { msg = JSON.parse(rawData); } catch { return; }

    switch (msg.type) {
      case 'register':
        clientInfo.name = msg.name || getDeviceName();
        clientInfo.avatar = msg.avatar || '💻';
        clientInfo.deviceType = msg.deviceType || 'desktop';
        clients.set(clientId, clientInfo);
        ws.send(JSON.stringify({ type: 'welcome', id: clientId, serverName: getDeviceName() }));
        broadcastPeerList();
        break;

      case 'transfer-request':
        // Forward request to target
        const tgt = clients.get(msg.targetId);
        if (tgt && tgt.ws.readyState === WebSocket.OPEN) {
          tgt.ws.send(JSON.stringify({
            type: 'transfer-request',
            senderId: clientId,
            senderName: clientInfo.name,
            fileName: msg.fileName,
            fileSize: msg.fileSize,
            fileType: msg.fileType,
            transferId: msg.transferId
          }));
        }
        break;

      case 'transfer-accept':
      case 'transfer-reject':
        const sender = clients.get(msg.targetId);
        if (sender && sender.ws.readyState === WebSocket.OPEN) {
          sender.ws.send(JSON.stringify({ ...msg, fromId: clientId }));
        }
        break;

      case 'transfer-complete':
        const orig = clients.get(msg.targetId);
        if (orig && orig.ws.readyState === WebSocket.OPEN) {
          orig.ws.send(JSON.stringify({ type: 'transfer-complete', transferId: msg.transferId }));
        }
        break;

      case 'ping':
        ws.send(JSON.stringify({ type: 'pong' }));
        break;
    }
  });

  ws.on('close', () => {
    clients.delete(clientId);
    broadcastPeerList();
  });

  ws.on('error', console.error);
});

app.use(express.static(path.join(__dirname, 'public')));
app.get('/api/info', (req, res) => {
  res.json({ hostname: getDeviceName(), ips: getLocalIPs(), port: PORT });
});

server.listen(PORT, '0.0.0.0', () => {
  const ips = getLocalIPs();
  console.log('\n╔════════════════════════════════════╗');
  console.log('║       LocalShare is running!       ║');
  console.log('╚════════════════════════════════════╝\n');
  console.log('📡 Open on this device:');
  console.log(`   http://localhost:${PORT}\n`);
  if (ips.length) {
    console.log('📱 Open on other devices (same Wi-Fi):');
    ips.forEach(({ ip }) => console.log(`   http://${ip}:${PORT}`));
  }
  console.log('\n');
});
