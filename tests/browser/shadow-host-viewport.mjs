#!/usr/bin/env node
// Real Chrome regression against production createMountPoint; no extension runtime.
// Run: pnpm exec node tests/browser/shadow-host-viewport.mjs
// Requires ChromeDriver/Chrome (override with CHROMEDRIVER / CHROME_BINARY).
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';

const source = await readFile(new URL('../../src/core/content-scripts/chunks/lazy-vue-app.js', import.meta.url), 'utf8');
const between = (start, end) => {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from);
  assert.ok(from >= 0 && to > from, `Source extraction markers missing: ${start}`);
  return source.slice(from, to).trim();
};
const helper = between('function needsTopLayerViewportHost(', '\nfunction isSuitableEnvironmentForVue');
const focus = between('function stopFocusInPropagation(', '\nfunction needsTopLayerViewportHost');
const mount = between('async function createMountPoint(', '\nexport function cleanupVueApp');
const implementation = (topLayer) => `
const UI_HOST_IDS = { MAIN:'translate-it-host-main', IFRAME:'translate-it-host-iframe', APP_CONTAINER:'translate-it-app-container' };
const contentAppStyles = '', allComponentStyles = '';
${focus}\n${helper}\n${topLayer ? mount : mount.replace("needsTopLayerViewportHost() && typeof hostElement.showPopover === 'function'", 'false')}
return createMountPoint;`;
const rootStyleCases = [
  ['transform', 'translateX(1px)', true], ['perspective', '1000px', true],
  ['rotate', '1deg', true], ['scale', '1.1', true], ['translate', '1px 0', true],
  ['will-change', 'transform', true], ['will-change', 'perspective', true],
  ['will-change', 'rotate', true], ['will-change', 'scale', true], ['will-change', 'translate', true],
  ['will-change', 'opacity, transform', true],
  ['filter', 'blur(1px)', false], ['content-visibility', 'hidden', false, false, false],
  ['content-visibility', 'auto', false, true, false], ['will-change', 'filter', false],
  ['will-change', 'opacity', false], ['will-change', 'opacity, filter', false],
];

const profile = await mkdtemp(join(tmpdir(), 'shadow-host-chrome-'));
const driver = spawn(process.env.CHROMEDRIVER || '/usr/bin/chromedriver', ['--port=0'], { stdio: ['ignore', 'pipe', 'pipe'] });
let output = '';
driver.stdout.on('data', (chunk) => output += chunk);
driver.stderr.on('data', (chunk) => output += chunk);
let base, session;
const response = async (res) => {
  const data = await res.json();
  if (!res.ok || data.value?.error) throw new Error(`WebDriver ${res.status}: ${JSON.stringify(data.value ?? data)}`);
  return data.value;
};
const request = (path, method = 'GET', body) => fetch(`${base}${path}`, {
  method, headers: body ? { 'content-type': 'application/json' } : undefined,
  body: body ? JSON.stringify(body) : undefined,
}).then(response);
const execute = (script) => request(`/session/${session}/execute/async`, 'POST', {
  script: `const done=arguments[arguments.length-1]; (async()=>{${script}\n})().then(done,e=>done({__error:String(e),stack:e.stack}));`, args: [],
}).then((value) => {
  if (value?.__error) throw new Error(value.stack || value.__error);
  return value;
});

async function waitForDriver() {
  const until = Date.now() + 10000;
  while (Date.now() < until) {
    const port = output.match(/ChromeDriver was started successfully on port (\d+)/i)?.[1];
    if (port) { base = `http://127.0.0.1:${port}`; try { await fetch(`${base}/status`); return; } catch { /* Driver is still binding. */ } }
    if (driver.exitCode !== null) break;
    await delay(50);
  }
  throw new Error(`ChromeDriver startup failed: ${output}`);
}
const click = async (points) => {
  const actions = [];
  for (const [x, y] of points) actions.push(
    { type: 'pointerMove', duration: 0, x: Math.round(x), y: Math.round(y) },
    { type: 'pointerDown', button: 0 }, { type: 'pointerUp', button: 0 },
  );
  await request(`/session/${session}/actions`, 'POST', { actions: [{ type: 'pointer', id: 'mouse', parameters: { pointerType: 'mouse' }, actions }] });
  await request(`/session/${session}/actions`, 'DELETE');
};

try {
  await waitForDriver();
  const created = await request('/session', 'POST', { capabilities: { alwaysMatch: { browserName: 'chrome', 'goog:chromeOptions': {
    binary: process.env.CHROME_BINARY || '/usr/bin/google-chrome-stable',
    args: ['--headless=new', '--no-sandbox', '--disable-dev-shm-usage', `--user-data-dir=${profile}`, '--window-size=1000,800'],
  } } } });
  session = created.sessionId;
  await request(`/session/${session}/url`, 'POST', { url: 'data:text/html,<html><head></head><body></body></html>' });
  await request(`/session/${session}/timeouts`, 'POST', { script: 10000 });

  // Ordinary page: host remains viewport-fixed without containment/top-layer promotion.
  const normal = await execute(`
    const create = new Function(${JSON.stringify(implementation(true))})();
    document.body.style.cssText='height:2400px;margin:0';
    const c=await create(), host=c.getRootNode().host;
    const p=document.createElement('button'); p.style.cssText='position:fixed;left:100px;top:80px;width:100px;height:40px;pointer-events:auto'; p.onclick=()=>p.dataset.clicked='yes'; c.append(p);
    const a=p.getBoundingClientRect().toJSON(); scrollTo(100,400); await new Promise(requestAnimationFrame);
    return {a,b:p.getBoundingClientRect().toJSON(), host:host.id};
  `);
  assert.deepEqual([normal.b.left, normal.b.top], [normal.a.left, normal.a.top], 'Normal-page fixed probe moved on scroll');
  assert.equal(normal.host, 'translate-it-host-main');

  // Real source extraction matrix: fixed-containing-block triggers promote;
  // filter/opacity and content-visibility remain ordinary by design.
  const rootMatrix = await execute(`
    const cases=${JSON.stringify(rootStyleCases)}, results=[];
    document.getElementById('translate-it-host-main')?.remove();
    document.body.style.cssText='height:3000px;margin:0';
    for(const [property,value,expectedPopover,expectedVisible=true,expectedStable=true] of cases){
      document.documentElement.style.cssText='';
      document.documentElement.style.setProperty(property,value);
      scrollTo(0,0);
      const create=new Function(${JSON.stringify(implementation(true))})();
      const container=await create(),host=container.getRootNode().host;
      const probes=[];
      for(const [id,css] of [['top-left','left:24px;top:32px'],['bottom-right','right:24px;bottom:32px']]){
        const el=document.createElement('button');el.id=id;el.style.cssText='position:fixed;width:64px;height:44px;pointer-events:auto;'+css;container.append(el);probes.push(el);
      }
      const rects=()=>probes.map(el=>{const r=el.getBoundingClientRect();return[r.left,r.top,r.right,r.bottom]});
      const before=rects();scrollTo(317,643);await new Promise(requestAnimationFrame);const after=rects();
      const hits=probes.map(el=>{const r=el.getBoundingClientRect();return host.shadowRoot.elementFromPoint(r.left+r.width/2,r.top+r.height/2)===el});
      results.push({property,value,expectedPopover,expectedVisible,expectedStable,hasPopover:host.hasAttribute('popover'),open:host.matches(':popover-open'),computed:getComputedStyle(document.documentElement).getPropertyValue(property),before,after,hits,visible:probes.map(el=>el.checkVisibility())});
      host.remove();
    }
    return results;
  `);
  for (const item of rootMatrix) {
    assert.equal(item.open, item.expectedPopover, `Unexpected promotion for root ${item.property}: ${item.value}`);
    if(item.expectedStable) assert.deepEqual(item.after, item.before, `Root ${item.property}: ${item.value} moved fixed probes`);
    assert.ok(item.visible.every(value => value === item.expectedVisible), `Unexpected probe visibility for root ${item.property}: ${item.value}`);
    if(item.expectedVisible && item.expectedStable) assert.ok(item.hits.every(Boolean), `Root ${item.property}: ${item.value} failed shadow hit-testing`);
  }
  const transformClick = await execute(`
    document.documentElement.style.cssText='';document.documentElement.style.transform='translateX(1px)';scrollTo(0,0);
    const create=new Function(${JSON.stringify(implementation(true))})();const c=await create(),host=c.getRootNode().host;
    const button=document.createElement('button');button.id='transform-trigger-click';button.style.cssText='position:fixed;left:40px;top:50px;width:80px;height:50px;pointer-events:auto';button.onclick=()=>button.dataset.clicked='yes';c.append(button);
    const r=button.getBoundingClientRect();return {point:[r.left+r.width/2,r.top+r.height/2],promoted:host.matches(':popover-open')};
  `);
  assert.equal(transformClick.promoted, true, 'Transform-trigger host did not enter the top layer');
  await click([transformClick.point]);
  assert.equal(await execute(`return document.querySelector('#translate-it-host-main').shadowRoot.getElementById('transform-trigger-click').dataset.clicked`), 'yes', 'Promoted transform-trigger probe missed a real pointer click');

  // Root containment: real toolbar/tooltip/FAB/window-shaped fixed buttons in the production shadow host.
  const setup = await execute(`
    document.getElementById('translate-it-host-main')?.remove();
    scrollTo(0,0);
    document.body.style.cssText='height:3000px;margin:0';
    document.documentElement.style.cssText='contain:layout style'; document.documentElement.dir='ltr';
    const create=new Function(${JSON.stringify(implementation(true))})();
    const c=await create(), host=c.getRootNode().host, els={};
    for(const [id,css] of Object.entries({toolbar:'left:100px;top:40px;width:90px;height:32px',tooltip:'left:220px;top:90px;width:80px;height:24px',fab:'right:40px;bottom:40px;width:48px;height:48px',window:'left:360px;top:180px;width:180px;height:120px'})){
      const e=document.createElement('button'); e.id=id; e.style.cssText='position:fixed;'+css+';pointer-events:auto'; e.onclick=()=>e.dataset.clicked='yes';
      if(id==='window'){
        let down;
        e.onpointerdown=event=>{down=[event.clientX,event.clientY,parseFloat(e.style.left)||0,parseFloat(e.style.top)||0];e.setPointerCapture(event.pointerId)};
        e.onpointermove=event=>{if(down&&(event.buttons&1)){e.style.left=(down[2]+event.clientX-down[0])+'px';e.style.top=(down[3]+event.clientY-down[1])+'px'}};
        e.onpointerup=()=>down=null;
      }
      c.append(e); els[id]=e;
    }
    const geometry=()=>Object.fromEntries(Object.entries(els).map(([k,e])=>{const r=e.getBoundingClientRect();return[k,[r.left,r.top,r.right,r.bottom]]}));
    const before=geometry(), points=Object.values(els).map(e=>{const r=e.getBoundingClientRect();return[r.left+r.width/2,r.top+r.height/2]});
    const shadowHits=['toolbar','tooltip','fab','window'].map(id=>host.shadowRoot.elementFromPoint(...(()=>{const r=els[id].getBoundingClientRect();return[r.left+r.width/2,r.top+r.height/2]})())?.id);
    return {before,points,shadowHits,hostId:host.id};
  `);
  await click(setup.points);
  const interactive = await execute(`return ['toolbar','tooltip','fab','window'].map(id=>document.getElementById('translate-it-host-main').shadowRoot.getElementById(id).dataset.clicked)`);
  assert.ok(interactive.every((value) => value === 'yes'), 'A shadow probe did not receive a real pointer click');
  assert.deepEqual(setup.shadowHits, ['toolbar', 'tooltip', 'fab', 'window'], 'Shadow hit-testing missed a probe');
  const [dragX, dragY] = setup.points[3];
  await request(`/session/${session}/actions`, 'POST', { actions: [{ type: 'pointer', id: 'mouse', parameters: { pointerType: 'mouse' }, actions: [
    { type: 'pointerMove', duration: 0, x: dragX, y: dragY }, { type: 'pointerDown', button: 0 },
    { type: 'pointerMove', duration: 100, x: dragX + 30, y: dragY + 20 }, { type: 'pointerUp', button: 0 },
  ] }] });
  await request(`/session/${session}/actions`, 'DELETE');
  const dragged = await execute(`const r=document.getElementById('translate-it-host-main').shadowRoot.getElementById('window').getBoundingClientRect();return[r.left,r.top]`);
  assert.deepEqual(dragged, [390, 200], 'Representative fixed window probe did not track pointer drag');
  const contained = await execute(`
    const h=document.getElementById('translate-it-host-main'), els=['toolbar','tooltip','fab','window'].map(id=>h.shadowRoot.getElementById(id));
    const before=els.map(e=>{const r=e.getBoundingClientRect();return[r.left,r.top,r.right,r.bottom]});
    document.documentElement.dir='rtl'; const rtl=els[0].getBoundingClientRect().left;
    scrollTo(317,643); await new Promise(requestAnimationFrame);
    const after=els.map(e=>{const r=e.getBoundingClientRect();return[r.left,r.top,r.right,r.bottom]});
    const pageTarget=document.elementFromPoint(25,25)?.tagName;
    return {before,after,rtl,pageTarget};
  `);
  assert.deepEqual(contained.after, contained.before, 'Fixed probes moved under root containment after scroll');
  assert.equal(contained.rtl, contained.before[0][0], 'RTL changed local viewport position');
  assert.ok(['BODY','HTML'].includes(contained.pageTarget), `Host intercepted page hit test: ${contained.pageTarget}`);

  // The old host (top-layer condition disabled in memory only) must fail the same scroll check.
  const old = await execute(`
    document.getElementById('translate-it-host-main').remove();
    const create=new Function(${JSON.stringify(implementation(false))})(); const c=await create();
    const p=document.createElement('div'); p.style.cssText='position:fixed;left:50px;top:60px;width:10px;height:10px'; c.append(p);
    const before=p.getBoundingClientRect().top; scrollTo(400,800); await new Promise(requestAnimationFrame);
    return {before,after:p.getBoundingClientRect().top};
  `);
  assert.notEqual(old.after, old.before, 'Negative control: pre-fix source unexpectedly survived root containment');

  // Same-origin iframe: local viewport geometry and its production host ID.
  const frame = await execute(`
    const f=document.createElement('iframe'); f.style.cssText='position:fixed;left:10px;top:10px;width:400px;height:300px;border:0'; f.srcdoc='<html><body style="height:1800px;margin:0"></body></html>'; document.body.append(f);
    await new Promise(resolve=>f.addEventListener('load',resolve,{once:true})); const w=f.contentWindow;
    w.document.documentElement.style.contain='layout style'; const create=w.Function(${JSON.stringify(implementation(true))})();
    const c=await create(), p=w.document.createElement('button'); p.style.cssText='position:fixed;left:35px;top:45px;width:50px;height:30px;pointer-events:auto'; c.append(p);
    const before=p.getBoundingClientRect().toJSON(); w.scrollTo(120,210); await new Promise(resolve=>w.requestAnimationFrame(resolve));
    const after=p.getBoundingClientRect().toJSON(); const contained={before:[before.left,before.top],after:[after.left,after.top],host:c.getRootNode().host.id,promoted:c.getRootNode().host.matches(':popover-open')};
    c.getRootNode().host.remove();w.document.documentElement.style.contain='';w.document.documentElement.style.transform='translateX(1px)';w.scrollTo(0,0);
    const transformCreate=w.Function(${JSON.stringify(implementation(true))})();const transformContainer=await transformCreate(),transformHost=transformContainer.getRootNode().host;
    const transformProbe=w.document.createElement('button');transformProbe.style.cssText='position:fixed;left:35px;top:45px;width:50px;height:30px;pointer-events:auto';transformContainer.append(transformProbe);
    const transformBefore=transformProbe.getBoundingClientRect().toJSON();w.scrollTo(120,210);await new Promise(resolve=>w.requestAnimationFrame(resolve));
    const transformAfter=transformProbe.getBoundingClientRect().toJSON();return {contained,transformed:{before:[transformBefore.left,transformBefore.top],after:[transformAfter.left,transformAfter.top],host:transformHost.id,promoted:transformHost.matches(':popover-open')}};
  `);
  assert.deepEqual(frame.contained.after, frame.contained.before, 'Iframe containment probe moved on iframe scroll');
  assert.equal(frame.contained.host, 'translate-it-host-iframe');
  assert.equal(frame.contained.promoted, true);
  assert.deepEqual(frame.transformed.after, frame.transformed.before, 'Iframe transform probe moved on iframe scroll');
  assert.equal(frame.transformed.host, 'translate-it-host-iframe');
  assert.equal(frame.transformed.promoted, true);

  const remount = await execute(`
    const old=document.getElementById('translate-it-host-main'); old.remove();
    const create=new Function(${JSON.stringify(implementation(true))})(); const c=await create();
    return c.getRootNode().host!==old && c.id==='translate-it-app-container';
  `);
  assert.equal(remount, true, 'Host could not be recreated after removal');

  // Page-authored popover selectors are outside the shadow tree and can target
  // the promoted light-DOM host. Record normal vs important cascade effects.
  const interference = await execute(`
    scrollTo(0,0);
    const host=document.getElementById('translate-it-host-main'), root=host.shadowRoot;
    const probe=document.createElement('button'); probe.id='window';
    probe.style.cssText='position:fixed;left:360px;top:180px;width:180px;height:120px;pointer-events:auto'; probe.onclick=()=>probe.dataset.clicked='yes';
    const fab=document.createElement('button'); fab.id='fab';
    fab.style.cssText='position:fixed;right:20px;bottom:20px;width:64px;height:44px;pointer-events:auto'; fab.onclick=()=>fab.dataset.clicked='yes';
    root.getElementById('translate-it-app-container').append(probe,fab);
    const properties=['position','display','inset','transform','translate','scale','rotate','perspective','willChange','contentVisibility','zoom','opacity','visibility','contain','filter','clipPath','backgroundColor','pointerEvents'];
    const capture=()=>{
      const s=getComputedStyle(host), b=getComputedStyle(host,'::backdrop');
      return {style:Object.fromEntries(properties.map(k=>[k,s[k]])), children:[probe,fab].map(el=>{const r=el.getBoundingClientRect(),x=r.left+r.width/2,y=r.top+r.height/2;return{id:el.id,rect:[r.left,r.top,r.right,r.bottom],visible:el.checkVisibility(),documentHit:document.elementFromPoint(x,y)?.id||document.elementFromPoint(x,y)?.tagName,shadowHit:host.shadowRoot.elementFromPoint(x,y)?.id||host.shadowRoot.elementFromPoint(x,y)?.tagName}}), backdrop:{backgroundColor:b.backgroundColor,pointerEvents:b.pointerEvents}};
    };
    const baseline=capture(), selectors=['[popover]',':popover-open'], priorities=['',' !important'], observations=[];
    const declarations='transform:translate(70px,50px);translate:11px 12px;scale:1.2;rotate:15deg;perspective:1000px;will-change:transform;content-visibility:hidden;zoom:1.2;opacity:.25;visibility:hidden;display:none;contain:paint;filter:blur(3px);clip-path:inset(20%);background-color:rgb(255,0,0);pointer-events:auto';
    for(const selector of selectors) for(const priority of priorities){
      const style=document.createElement('style');
      style.textContent=selector+'{'+declarations.replaceAll(';',''+priority+';')+priority+'}';
      document.head.append(style); observations.push({selector,priority:priority?'important':'normal',...capture()}); style.remove();
    }
    const hostileStyle=document.createElement('style');
    hostileStyle.textContent=':popover-open{'+declarations.replaceAll(';',' !important;')+' !important}';
    document.head.append(hostileStyle);
    const backdropStyle=document.createElement('style');
    backdropStyle.textContent='#translate-it-host-main::backdrop{background:rgb(255,0,0) !important;pointer-events:auto !important}';
    document.head.append(backdropStyle);
    const page=document.createElement('button'); page.id='popover-page-target'; page.textContent='page';
    page.style.cssText='position:fixed;left:20px;top:20px;width:80px;height:35px;z-index:0'; page.onclick=()=>page.dataset.clicked='yes'; document.body.append(page);
    probe.style.cssText+=';pointer-events:auto'; probe.onclick=()=>probe.dataset.clicked='yes';
    const backdrop={...capture(), hit:document.elementFromPoint(25,25)?.id||document.elementFromPoint(25,25)?.tagName};
    const point=e=>{const r=e.getBoundingClientRect();return[r.left+r.width/2,r.top+r.height/2]};
    const probePoints=[point(page),point(probe),point(fab)];
    return {baseline,observations,backdrop,hostile:capture(),probePoints};
  `);
  console.log('Popover CSS interference evidence:', JSON.stringify(interference));
  await click(interference.probePoints);
  const clicks = await execute(`const root=document.getElementById('translate-it-host-main').shadowRoot;return {page:document.getElementById('popover-page-target').dataset.clicked,probes:['window','fab'].map(id=>root.getElementById(id).dataset.clicked)}`);
  console.log('Popover CSS pointer-click evidence:', JSON.stringify({ clicks, points:interference.probePoints }));
  for (const item of interference.observations) {
    assert.deepEqual(item.style, interference.baseline.style, `Page ${item.selector} ${item.priority} CSS changed promoted host computed styles`);
    assert.deepEqual(item.children, interference.baseline.children, `Page ${item.selector} ${item.priority} CSS changed fixed child visibility, geometry, or hit testing`);
  }
  assert.deepEqual(interference.backdrop.backdrop, interference.baseline.backdrop, 'Page CSS changed promoted host backdrop');
  assert.equal(clicks.page, 'yes', 'Host intercepted the page click');
  assert.ok(clicks.probes.every((value) => value === 'yes'), 'Page CSS prevented pointer interaction with a fixed shadow probe');
  console.log('PASS: Chrome production-host containment, normal page, RTL, iframe, hit-testing, pointer clicks/drag probe, remount, and old-code negative control.');
} finally {
  if (session && base) { try { await request(`/session/${session}`, 'DELETE'); } catch { /* ChromeDriver may have already closed the session. */ } }
  driver.kill('SIGTERM');
  await Promise.race([new Promise((resolve) => driver.once('exit', resolve)), delay(2000)]);
  if (driver.exitCode === null) driver.kill('SIGKILL');
  await rm(profile, { recursive: true, force: true });
}
