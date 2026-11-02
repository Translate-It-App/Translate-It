import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const directory = dirname(fileURLToPath(import.meta.url));
const files = new Map([
  ['/', ['fixture.html', 'text/html; charset=utf-8']],
  ['/fixture.js', ['fixture.js', 'text/javascript; charset=utf-8']],
  ['/benchmark.js', ['benchmark.js', 'text/javascript; charset=utf-8']],
  ['/engine.js', ['engine.js', 'text/javascript; charset=utf-8']],
]);
const server = createServer(async (request, response) => {
  const entry = files.get(new URL(request.url, 'http://127.0.0.1').pathname);
  if (!entry || !['GET', 'HEAD'].includes(request.method)) {
    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('Not found');
    return;
  }
  try {
    const path = resolve(directory, entry[0]);
    if (!path.startsWith(`${directory}${sep}`)) throw new Error('Invalid path');
    const body = await readFile(path);
    response.writeHead(200, { 'content-type': entry[1], 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
    response.end(request.method === 'HEAD' ? undefined : body);
  } catch {
    response.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' }).end('Fixture assets unavailable');
  }
});
const port = Number(process.env.PORT || 4178);
server.listen(port, '127.0.0.1', () => console.log(`Fixture server listening at http://127.0.0.1:${server.address().port}/`));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => process.exit(0)));
