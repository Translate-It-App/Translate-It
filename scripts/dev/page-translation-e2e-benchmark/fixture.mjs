import { createServer } from 'node:http';

export const targetTexts = Array.from({ length: 12 }, (_, index) => `Benchmark sentence ${index + 1} has stable fixture content.`);
export const startupVoicesEndpoint = Object.freeze({ hostname: 'speech.platform.bing.com', pathname: '/consumer/speech/synthesize/readaloud/voices/list', method: 'GET' });
export const startupVoicesResponse = Object.freeze([]);

const largeScenarios = new Set(['early-visible', 'in-window-visible', 'late-visible']);
const largeTargetCount = 1000;
const visibleTargetIndexes = [500, 501, 502, 503];

export function createFixture(scenario = 'small') {
  if (scenario !== 'small' && !largeScenarios.has(scenario)) throw new TypeError(`Unknown benchmark fixture scenario: ${scenario}`);

  const texts = scenario === 'small'
    ? targetTexts
    : Array.from({ length: largeTargetCount }, (_, index) => `Benchmark target ${String(index + 1).padStart(4, '0')} has stable fixture content.`);
  const count = texts.length;
  const visibleIndexes = scenario === 'small' ? texts.map((_, index) => index) : visibleTargetIndexes;
  let indexes = texts.map((_, index) => index);
  if (scenario === 'early-visible') indexes = [...visibleIndexes, ...indexes.filter(index => !visibleIndexes.includes(index))];
  if (scenario === 'in-window-visible') indexes = [0, 1, ...visibleIndexes, ...indexes.filter(index => index > 1 && !visibleIndexes.includes(index))];

  const targets = indexes.map(index => ({
    id: `target-${index}`,
    source: texts[index],
    visible: visibleIndexes.includes(index),
  }));
  const htmlTargets = targets.map(target => {
    const targetIndex = Number(target.id.slice(7));
    const position = scenario === 'small'
      ? ''
      : `position:absolute;left:20px;top:${target.visible ? 20 + visibleIndexes.indexOf(targetIndex) * 30 : 2000 + targetIndex * 30}px;width:900px;height:24px;`;
    return `<p data-bench-id="${target.id}"${position ? ` style="${position}"` : ''}>${target.source}</p>`;
  }).join('');
  const html = `<!doctype html><meta charset="utf-8"><title>Page translation benchmark</title><main${scenario === 'small' ? '' : ' style="position:relative;min-height:12000px"'}>${htmlTargets}</main>`;
  const orderedTexts = targets.map(target => target.source);
  const visibleIds = targets.filter(target => target.visible).map(target => target.id);
  return {
    scenario,
    targetCount: count,
    targetTexts: orderedTexts,
    targets,
    visibleIds,
    html,
    viewport: { width: 1280, height: 900 },
    scroll: { x: 0, y: 0 },
    responseDelayMs: 50,
  };
}

export async function startFixture(fixture = createFixture()) {
  const server = createServer((request, response) => {
    if (request.url !== '/') { response.writeHead(404).end(); return; }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(fixture.html);
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return { server, url: `http://127.0.0.1:${server.address().port}/` };
}
