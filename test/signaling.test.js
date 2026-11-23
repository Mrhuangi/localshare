'use strict';

// Integration test: peer discovery, addressed forwarding (signal + text),
// and peer-list cleanup on disconnect. Spawns the real server.

const { spawn } = require('child_process');
const path = require('path');
const WebSocket = require('ws');
const assert = require('assert');

const PORT = 17070;
const URL = `ws://127.0.0.1:${PORT}`;

function waitFor(fn, timeout = 5000, step = 25) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    (function check() {
      let v;
      try { v = fn(); } catch { v = null; }
      if (v) return resolve(v);
      if (Date.now() - t0 > timeout) return reject(new Error('waitFor timeout'));
      setTimeout(check, step);
    })();
  });
}

function connectClient(name) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(URL);
    const client = { ws, name, id: null, messages: [] };
    ws.on('message', (data, isBinary) => {
      if (isBinary) return;
      const msg = JSON.parse(data.toString());
      client.messages.push(msg);
      if (msg.type === 'welcome') client.id = msg.id;
    });
    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'register', name, deviceType: 'desktop' }));
      resolve(client);
    });
    ws.on('error', reject);
  });
}

async function main() {
  const server = spawn('node', [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT: String(PORT) },
    stdio: 'pipe',
  });
  try {
    await waitFor(() => true, 1); // tick
    // wait until the port accepts connections
    await new Promise((resolve, reject) => {
      const t0 = Date.now();
      (function probe() {
        const probe = new WebSocket(URL);
        probe.on('open', () => { probe.close(); resolve(); });
        probe.on('error', () => {
          if (Date.now() - t0 > 5000) reject(new Error('server did not start'));
          else setTimeout(probe, 100);
        });
      })();
    });

    const a = await connectClient('Alice');
    const b = await connectClient('Bob');
    await waitFor(() => a.id && b.id);
    assert.notStrictEqual(a.id, b.id, 'ids must differ');

    // Both see each other in the peer list.
    const peersForA = await waitFor(() => {
      const m = [...a.messages].reverse().find((x) => x.type === 'peers');
      return m && m.peers.some((p) => p.id === b.id) ? m.peers : null;
    });
    assert(peersForA.some((p) => p.name === 'Bob'), 'A should see Bob by name');

    // Addressed signal forwarding, stamped with `from`.
    a.ws.send(JSON.stringify({ type: 'signal', to: b.id, data: { kind: 'offer', description: { type: 'offer', sdp: 'x' } } }));
    const sig = await waitFor(() => b.messages.find((x) => x.type === 'signal'));
    assert.strictEqual(sig.from, a.id);
    assert.strictEqual(sig.data.kind, 'offer');

    // Text forwarding.
    a.ws.send(JSON.stringify({ type: 'text', to: b.id, text: 'hello lan' }));
    const txt = await waitFor(() => b.messages.find((x) => x.type === 'text'));
    assert.strictEqual(txt.text, 'hello lan');
    assert.strictEqual(txt.from, a.id);

    // Disconnect cleanup: B leaves, A's peer list drops B.
    b.ws.close();
    await waitFor(() => {
      const m = [...a.messages].reverse().find((x) => x.type === 'peers');
      return m && !m.peers.some((p) => p.id === b.id) ? true : null;
    });

    a.ws.close();
    console.log('signaling.test.js: PASS');
  } finally {
    server.kill();
  }
}

main().catch((e) => { console.error('signaling.test.js: FAIL', e.message); process.exit(1); });
