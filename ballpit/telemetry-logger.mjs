// Tiny telemetry sink so the (GPU) browser can stream what it sees to a file
// the agent can read — closing the "I can't see the screen" loop.
//   node telemetry-logger.mjs      → listens on :7788
// The ballpit GPU demo POSTs JSON each ~0.5s; we keep the latest in
// telemetry-latest.json and append everything to telemetry.log.
import http from 'node:http';
import { appendFileSync, writeFileSync } from 'node:fs';

const PORT = 7788;
http.createServer((req, res) => {
  // permissive headers so a cross-origin, COEP-isolated page can post here
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'content-type');
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
  if (req.method !== 'POST') { res.writeHead(200); res.end('telemetry logger'); return; }
  let body = '';
  req.on('data', (c) => { body += c; if (body.length > 1e6) req.destroy(); });
  req.on('end', () => {
    const line = new Date().toISOString() + ' ' + body;
    try { appendFileSync('telemetry.log', line + '\n'); writeFileSync('telemetry-latest.json', body); } catch { /* */ }
    process.stdout.write(line + '\n');
    res.writeHead(200); res.end('ok');
  });
}).listen(PORT, () => console.log('telemetry logger on http://localhost:' + PORT));
