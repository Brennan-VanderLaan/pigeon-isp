#!/usr/bin/env node
// autoroute.mjs — a headless Pigeon API consumer: MAC-learning software
// switch, no game, no physics. Proof that the loft API is consumer-agnostic,
// and the baseline the webapp gets benchmarked against.
//
//   node tools/autoroute.mjs [ws://127.0.0.1:9777/ws]
//
// Uses Node's built-in WebSocket (Node >= 22). Ctrl-C to stop routing —
// packet loss resumes immediately, as it should.

const url = process.argv[2] ?? 'ws://127.0.0.1:9777/ws';
const macTable = new Map(); // mac hex -> portId
const ports = new Map(); // portId -> info
let delivered = 0, flooded = 0, dropped = 0;
let ws;

const mac = (b, off) =>
  Array.from(b.slice(off, off + 6)).map((x) => x.toString(16).padStart(2, '0')).join('');

function connect() {
  ws = new WebSocket(url);
  ws.binaryType = 'arraybuffer';
  ws.onopen = () => console.log(`[autoroute] attached to ${url}`);
  ws.onclose = () => {
    console.log('[autoroute] loft unreachable, retrying in 2s…');
    ports.clear();
    setTimeout(connect, 2000);
  };
  ws.onerror = () => {};
  ws.onmessage = onMessage;
}
connect();

function onMessage(ev) {
  if (typeof ev.data === 'string') {
    const msg = JSON.parse(ev.data);
    if (msg.type === 'hello') {
      for (const p of msg.ports ?? []) ports.set(p.id, p);
      console.log(`[autoroute] hello: ${ports.size} port(s):`,
        [...ports.values()].map((p) => `${p.pod}=${p.ip}`).join(' '));
    } else if (msg.type === 'port-added') {
      ports.set(msg.port.id, msg.port);
      console.log(`[autoroute] port up: ${msg.port.pod} ${msg.port.ip}`);
    } else if (msg.type === 'port-removed') {
      ports.delete(msg.id);
    }
    return;
  }
  const b = new Uint8Array(ev.data);
  if (b.length < 11 || b[0] !== 0x01) return;
  const dv = new DataView(ev.data);
  const ingress = dv.getUint16(1);
  const frameId = dv.getUint32(3);
  const snap = b.slice(11);

  const send = (type, port) => {
    const reply = new ArrayBuffer(7);
    const out = new DataView(reply);
    out.setUint8(0, type);
    out.setUint16(1, port);
    out.setUint32(3, frameId);
    ws.send(reply);
  };

  if (snap.length >= 14) {
    macTable.set(mac(snap, 6), ingress);
    const dst = macTable.get(mac(snap, 0));
    if (dst !== undefined && dst !== ingress) {
      send(0x02, dst); delivered++;
      return;
    }
    // broadcast/unknown dst: real flood — copy-deliver (0x04) to every other
    // port, then free the original. A switch, doing switch things.
    let copies = 0;
    for (const id of ports.keys()) {
      if (id !== ingress) { send(0x04, id); copies++; }
    }
    send(0x03, 0);
    if (copies > 0) { flooded++; return; }
  } else {
    send(0x03, 0);
  }
  dropped++;
}

setInterval(() => {
  console.log(`[autoroute] delivered=${delivered} flooded=${flooded} dropped=${dropped} macs=${macTable.size}`);
}, 5000);
