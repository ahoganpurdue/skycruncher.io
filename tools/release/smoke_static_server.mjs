#!/usr/bin/env node
// smoke_static_server.mjs — minimal request-logging static file server for the
// updater self-update smoke. NOT a product; test-only. Serves <root> on 127.0.0.1:<port>.
// Usage: node tools/release/smoke_static_server.mjs <root> <port>
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(process.argv[2] || '.');
const port = Number(process.argv[3]) || 8788;

http.createServer((req, res) => {
  const urlPath = decodeURIComponent(req.url.split('?')[0]);
  const file = path.join(root, urlPath);
  const ts = new Date().toISOString().slice(11, 19);
  // Separator-boundary check: bare startsWith(root) lets a sibling dir whose
  // name extends `root` as a string (dist vs dist-secret) slip past traversal.
  if (file !== root && !file.startsWith(root + path.sep)) { console.log(`${ts} 403 ${urlPath}`); res.writeHead(403); return res.end('forbidden'); }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { console.log(`${ts} 404 ${urlPath}`); res.writeHead(404); return res.end('not found'); }
    const ct = file.endsWith('.json') ? 'application/json'
      : file.endsWith('.exe') ? 'application/octet-stream'
        : 'application/octet-stream';
    console.log(`${ts} 200 ${urlPath} (${st.size} B)`);
    res.writeHead(200, { 'content-type': ct, 'content-length': st.size, 'cache-control': 'no-cache' });
    fs.createReadStream(file).pipe(res);
  });
}).listen(port, '127.0.0.1', () => console.log(`[smoke-server] serving ${root} on http://127.0.0.1:${port}`));
