'use strict';

// Integration test: chunked file relay fallback. Two clients register,
// A streams a 3 MB random file to B through the server in 64 KB frames
// (start / chunk / end), B reassembles it and the SHA-256 must match.

const { spawn } = require('child_process');
const path = require('path');
const crypto = require('crypto');
const WebSocket = require('ws');
const assert = require('assert');

const PORT = 17071;
const URL = `ws://127.0.0.1:${PORT}`;
const CHUNK = 64 * 1024;

function waitFor(fn, timeout = 8000, step = 25) {
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

function frame(header, payload) {
  const headerBuf = Buffer.from(JSON.stringify(header), 'utf8');
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(headerBuf.length, 0);
  return Buffer.concat([lenBuf, headerBuf, payload || Buffer.alloc(0)]);
}

function connectClient(name, onBinary) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(URL);
    const client = { ws, name, id: null };
    ws.on('message', (data, isBinary) => {
      if (isBinary) { onBinary && onBinary(Buffer.from(data)); return; }
      const msg = JSON.parse(data.toString());
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
    await new Promise((resolve, reject) => {
      const t0 = Date.now();
      (function probe() {
        const p = new WebSocket(URL);
        p.on('open', () => { p.close(); resolve(); });
        p.on('error', () => {
          if (Date.now() - t0 > 5000) reject(new Error('server did not start'));
          else setTimeout(probe, 100);
        });
      })();
    });

    const received = { parts: [], meta: null, done: false };
    const b = await connectClient('Receiver', (buf) => {
      const headerLen = buf.readUInt32BE(0);
      const header = JSON.parse(buf.subarray(4, 4 + headerLen).toString('utf8'));
      const payload = buf.subarray(4 + headerLen);
      if (header.kind === 'start') received.meta = header;
      else if (header.kind === 'chunk') received.parts.push(Buffer.from(payload));
      else if (header.kind === 'end') received.done = true;
    });
    const a = await connectClient('Sender');
    await waitFor(() => a.id && b.id);

    const original = crypto.randomBytes(3 * 1024 * 1024 + 12345);
    const expectHash = crypto.createHash('sha256').update(original).digest('hex');
    const transferId = 'test-transfer';

    a.ws.send(frame({ to: b.id, transferId, fileIndex: 0, kind: 'start', name: 'blob.bin', size: original.length, fileType: 'application/octet-stream' }));
    for (let off = 0; off < original.length; off += CHUNK) {
      a.ws.send(frame({ to: b.id, transferId, fileIndex: 0, kind: 'chunk' }, original.subarray(off, off + CHUNK)));
    }
    a.ws.send(frame({ to: b.id, transferId, fileIndex: 0, kind: 'end' }));

    await waitFor(() => received.done, 15000);
    assert(received.meta, 'receiver got start frame');
    assert.strictEqual(received.meta.from, a.id, 'server stamps sender id');
    const assembled = Buffer.concat(received.parts);
    assert.strictEqual(assembled.length, original.length, 'byte length must match');
    const gotHash = crypto.createHash('sha256').update(assembled).digest('hex');
    assert.strictEqual(gotHash, expectHash, 'sha256 must match');

    a.ws.close(); b.ws.close();
    console.log('relay.test.js: PASS');
  } finally {
    server.kill();
  }
}

main().catch((e) => { console.error('relay.test.js: FAIL', e.message); process.exit(1); });
