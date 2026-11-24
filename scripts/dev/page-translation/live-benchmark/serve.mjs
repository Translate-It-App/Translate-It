import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import process from "node:process";
import { fileURLToPath, URL as NodeURL } from "node:url";

const root = resolve(fileURLToPath(new NodeURL(".", import.meta.url)));
const files = new Set(["index.html", "benchmark.js"]);

export async function startServer(port = 0) {
  const server = createServer(async (request, response) => {
    try {
      const pathname = new URL(request.url, "http://127.0.0.1").pathname;
      const name = pathname === "/" ? "index.html" : pathname.slice(1);
      const file = resolve(root, name);
      if (!files.has(name) || !file.startsWith(`${root}${sep}`)) {
        response.writeHead(404).end("Not found");
        return;
      }
      const contentType =
        extname(file) === ".js"
          ? "text/javascript; charset=utf-8"
          : "text/html; charset=utf-8";
      response.writeHead(200, {
        "content-type": contentType,
        "cache-control": "no-store",
      });
      response.end(await readFile(file));
    } catch {
      response.writeHead(500).end("Unable to serve benchmark fixture");
    }
  });

  await new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  return {
    server,
    url: `http://127.0.0.1:${address.port}/`,
    close: () =>
      new Promise((resolveClose, reject) =>
        server.close((error) => (error ? reject(error) : resolveClose())),
      ),
  };
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const { server, url, close } = await startServer(
    Number(process.env.PORT) || 0,
  );
  process.stdout.write(`Page Translation live benchmark: ${url}\n`);
  const shutdown = async () => {
    await close();
    process.exitCode = 0;
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  server.on("error", (error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
