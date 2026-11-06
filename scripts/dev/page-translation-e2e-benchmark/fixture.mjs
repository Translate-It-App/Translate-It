import { createServer } from 'node:http';

export const targetTexts = Array.from({ length: 12 }, (_, index) => `Benchmark sentence ${index + 1} has stable fixture content.`);
export const startupVoicesEndpoint = Object.freeze({ hostname: 'speech.platform.bing.com', pathname: '/consumer/speech/synthesize/readaloud/voices/list', method: 'GET' });
export const startupVoicesResponse = Object.freeze([]);

export async function startFixture() {
  const server = createServer((request, response) => {
    if (request.url !== '/') { response.writeHead(404).end(); return; }
    const paragraphs = targetTexts.map((text, index) => `<p data-bench-id="target-${index}">${text}</p>`).join('');
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(`<!doctype html><meta charset="utf-8"><title>Page translation benchmark</title><main>${paragraphs}</main>`);
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return { server, url: `http://127.0.0.1:${server.address().port}/` };
}
