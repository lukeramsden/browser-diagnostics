// Minimal static server for the fixture app. No dependencies, no network egress.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname, normalize } from 'node:path';

const root = new URL('./app/', import.meta.url).pathname;
const port = Number(process.env.FIXTURE_PORT || 4173);
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css' };

createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  let p = normalize(url.pathname).replace(/^(\.\.[/\\])+/, '');
  if (p === '/' || p.startsWith('/c/')) p = '/index.html'; // SPA routes
  try {
    const body = await readFile(join(root, p));
    res.writeHead(200, { 'content-type': types[extname(p)] || 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(body);
  } catch {
    res.writeHead(404).end('not found');
  }
}).listen(port, '127.0.0.1', () => console.log(`fixture at http://127.0.0.1:${port}/`));
