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
const runtimeModule = between('let vueApp = null;', '\nexport default').replace(/^export\s+(?=(?:async\s+)?function)/gm, '');
const runtimeImplementation = `
const UI_HOST_IDS = { MAIN:'translate-it-host-main', IFRAME:'translate-it-host-iframe', APP_CONTAINER:'translate-it-app-container' };
const contentAppStyles = '', allComponentStyles = '';
const logger = { error() {} };
${runtimeModule}
return { createMountPoint, cleanupVueApp, setMountedApp(app) { vueApp = app; } };`;
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
  await request(`/session/${session}/url`, 'POST', { url: 'data:text/html,<!DOCTYPE html><html><head></head><body></body></html>' });
  await request(`/session/${session}/timeouts`, 'POST', { script: 10000 });

  // Ordinary page: host remains viewport-fixed without containment/top-layer promotion.
  const normal = await execute(`
    const api = window.__shadowHostApi = new Function(${JSON.stringify(runtimeImplementation)})();
    document.body.style.cssText='height:2400px;margin:0';
    const c=await api.createMountPoint(), host=c.getRootNode().host;
    const p=document.createElement('button'); p.style.cssText='position:fixed;left:100px;top:80px;width:100px;height:40px;pointer-events:auto'; p.onclick=()=>p.dataset.clicked='yes'; c.append(p);
    const a=p.getBoundingClientRect().toJSON(); scrollTo(100,400); await new Promise(requestAnimationFrame); const b=p.getBoundingClientRect().toJSON();
    api.setMountedApp({unmount(){}}); api.cleanupVueApp();
    return {a,b, host:host.id};
  `);
  assert.deepEqual([normal.b.left, normal.b.top], [normal.a.left, normal.a.top], 'Normal-page fixed probe moved on scroll');
  assert.equal(normal.host, 'translate-it-host-main');

  // Real source extraction matrix: fixed-containing-block triggers promote;
  // filter/opacity and content-visibility remain ordinary by design.
  const rootMatrix = await execute(`
    const cases=${JSON.stringify(rootStyleCases)}, results=[];
    const api=window.__shadowHostApi;
    document.body.style.cssText='height:3000px;margin:0';
    for(const [property,value,expectedPopover,expectedVisible=true,expectedStable=true] of cases){
      document.documentElement.style.cssText='';
      document.documentElement.style.setProperty(property,value);
      scrollTo(0,0);
      const container=await api.createMountPoint(),host=container.getRootNode().host;
      const probes=[];
      for(const [id,css] of [['top-left','left:24px;top:32px'],['bottom-right','right:24px;bottom:32px']]){
        const el=document.createElement('button');el.id=id;el.style.cssText='position:fixed;width:64px;height:44px;pointer-events:auto;'+css;container.append(el);probes.push(el);
      }
      const rects=()=>probes.map(el=>{const r=el.getBoundingClientRect();return[r.left,r.top,r.right,r.bottom]});
      const before=rects();scrollTo(317,643);await new Promise(requestAnimationFrame);const after=rects();
      const hits=probes.map(el=>{const r=el.getBoundingClientRect();return host.shadowRoot.elementFromPoint(r.left+r.width/2,r.top+r.height/2)===el});
      results.push({property,value,expectedPopover,expectedVisible,expectedStable,hasPopover:host.hasAttribute('popover'),open:host.matches(':popover-open'),computed:getComputedStyle(document.documentElement).getPropertyValue(property),viewport:{width:document.documentElement.clientWidth,height:document.documentElement.clientHeight},before,after,hits,visible:probes.map(el=>el.checkVisibility())});
      api.setMountedApp({unmount(){}});api.cleanupVueApp();
    }
    return results;
  `);
  for (const item of rootMatrix) {
    assert.equal(item.open, item.expectedPopover, `Unexpected promotion for root ${item.property}: ${item.value}`);
    if(item.expectedStable) assert.deepEqual(item.after, item.before, `Root ${item.property}: ${item.value} moved fixed probes`);
    assert.ok(item.visible.every(value => value === item.expectedVisible), `Unexpected probe visibility for root ${item.property}: ${item.value}`);
    if(item.expectedVisible && item.expectedStable) {
      const [topLeft, bottomRight] = item.before;
      const [scrolledTopLeft, scrolledBottomRight] = item.after;
      const { width, height } = item.viewport;
      const tolerance = 0.5;
      const near = (actual, expected) => Math.abs(actual - expected) <= tolerance;
      assert.ok(near(topLeft[0], 24) && near(topLeft[1], 32), `Root ${item.property}: ${item.value} top-left probe is not viewport-anchored before scroll: ${JSON.stringify(topLeft)}`);
      assert.ok(near(bottomRight[2], width - 24) && near(bottomRight[3], height - 32), `Root ${item.property}: ${item.value} bottom-right probe is not viewport-anchored before scroll: ${JSON.stringify({rect:bottomRight,viewport:item.viewport})}`);
      assert.ok(near(scrolledTopLeft[0], 24) && near(scrolledTopLeft[1], 32), `Root ${item.property}: ${item.value} top-left probe is not viewport-anchored after scroll: ${JSON.stringify(scrolledTopLeft)}`);
      assert.ok(near(scrolledBottomRight[2], width - 24) && near(scrolledBottomRight[3], height - 32), `Root ${item.property}: ${item.value} bottom-right probe is not viewport-anchored after scroll: ${JSON.stringify({rect:scrolledBottomRight,viewport:item.viewport})}`);
      assert.ok(item.hits.every(Boolean), `Root ${item.property}: ${item.value} failed shadow hit-testing`);
    }
  }
  const transformClick = await execute(`
    document.documentElement.style.cssText='';document.documentElement.style.transform='translateX(1px)';scrollTo(0,0);
    const api=window.__shadowHostApi,c=await api.createMountPoint(),host=c.getRootNode().host;
    const button=document.createElement('button');button.id='transform-trigger-click';button.style.cssText='position:fixed;left:40px;top:50px;width:80px;height:50px;pointer-events:auto';button.onclick=()=>button.dataset.clicked='yes';c.append(button);
    const r=button.getBoundingClientRect();return {point:[r.left+r.width/2,r.top+r.height/2],promoted:host.matches(':popover-open')};
  `);
  assert.equal(transformClick.promoted, true, 'Transform-trigger host did not enter the top layer');
  await click([transformClick.point]);
  assert.equal(await execute(`return document.querySelector('#translate-it-host-main').shadowRoot.getElementById('transform-trigger-click').dataset.clicked`), 'yes', 'Promoted transform-trigger probe missed a real pointer click');
  await execute(`window.__shadowHostApi.setMountedApp({unmount(){}});window.__shadowHostApi.cleanupVueApp()`);

  // Root containment: real toolbar/tooltip/FAB/window-shaped fixed buttons in the production shadow host.
  const setup = await execute(`
    scrollTo(0,0);
    document.body.style.cssText='height:3000px;margin:0';
    document.documentElement.style.cssText='contain:layout style'; document.documentElement.dir='ltr';
    const api=window.__shadowHostApi,c=await api.createMountPoint(), host=c.getRootNode().host, els={};
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
  await execute(`window.__shadowHostApi.setMountedApp({unmount(){}});window.__shadowHostApi.cleanupVueApp()`);

  // Negative control: hide the native Popover API in memory, then confirm the
  // source host falls back to normal fixed positioning and exhibits the known drift.
  const old = await execute(`
    const descriptor=Object.getOwnPropertyDescriptor(HTMLElement.prototype,'showPopover');
    try {
      Object.defineProperty(HTMLElement.prototype,'showPopover',{configurable:true,value:undefined});
      const api=new Function(${JSON.stringify(runtimeImplementation)})(); const c=await api.createMountPoint();
      const p=document.createElement('div'); p.style.cssText='position:fixed;left:50px;top:60px;width:10px;height:10px'; c.append(p);
      const before=p.getBoundingClientRect().top; scrollTo(400,800); await new Promise(requestAnimationFrame);
      const after=p.getBoundingClientRect().top;
      api.setMountedApp({unmount(){}});api.cleanupVueApp();
      return {before,after};
    } finally {
      if(descriptor)Object.defineProperty(HTMLElement.prototype,'showPopover',descriptor);else delete HTMLElement.prototype.showPopover;
    }
  `);
  assert.notEqual(old.after, old.before, 'Negative control: pre-fix source unexpectedly survived root containment');

  // Same-origin iframe: local viewport geometry and its production host ID.
  const frame = await execute(`
    const f=document.createElement('iframe'); f.style.cssText='position:fixed;left:10px;top:10px;width:400px;height:300px;border:0'; f.srcdoc='<html><body style="height:1800px;margin:0"></body></html>'; document.body.append(f);
    await new Promise(resolve=>f.addEventListener('load',resolve,{once:true})); const w=f.contentWindow;
    w.document.documentElement.style.contain='layout style'; const api=w.__shadowHostApi=w.Function(${JSON.stringify(runtimeImplementation)})();
    const c=await api.createMountPoint(), p=w.document.createElement('button'); p.style.cssText='position:fixed;left:35px;top:45px;width:50px;height:30px;pointer-events:auto'; c.append(p);
    const before=p.getBoundingClientRect().toJSON(); w.scrollTo(120,210); await new Promise(resolve=>w.requestAnimationFrame(resolve));
    const after=p.getBoundingClientRect().toJSON(); const contained={before:[before.left,before.top],after:[after.left,after.top],host:c.getRootNode().host.id,promoted:c.getRootNode().host.matches(':popover-open')};
    api.setMountedApp({unmount(){}});api.cleanupVueApp();w.document.documentElement.style.contain='';w.document.documentElement.style.transform='translateX(1px)';w.scrollTo(0,0);
    const transformContainer=await api.createMountPoint(),transformHost=transformContainer.getRootNode().host;
    const transformProbe=w.document.createElement('button');transformProbe.style.cssText='position:fixed;left:35px;top:45px;width:50px;height:30px;pointer-events:auto';transformContainer.append(transformProbe);
    const transformBefore=transformProbe.getBoundingClientRect().toJSON();w.scrollTo(120,210);await new Promise(resolve=>w.requestAnimationFrame(resolve));
    const transformAfter=transformProbe.getBoundingClientRect().toJSON();const transformed={before:[transformBefore.left,transformBefore.top],after:[transformAfter.left,transformAfter.top],host:transformHost.id,promoted:transformHost.matches(':popover-open')};
    api.setMountedApp({unmount(){}});api.cleanupVueApp();return {contained,transformed};
  `);
  assert.deepEqual(frame.contained.after, frame.contained.before, 'Iframe containment probe moved on iframe scroll');
  assert.equal(frame.contained.host, 'translate-it-host-iframe');
  assert.equal(frame.contained.promoted, true);
  assert.deepEqual(frame.transformed.after, frame.transformed.before, 'Iframe transform probe moved on iframe scroll');
  assert.equal(frame.transformed.host, 'translate-it-host-iframe');
  assert.equal(frame.transformed.promoted, true);

  const remount = await execute(`
    const old=window.__shadowHostApi;
    const c=await old.createMountPoint();
    return c.getRootNode().host.id==='translate-it-host-main' && c.id==='translate-it-app-container';
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
    hostileStyle.id='hostile-host-style';
    hostileStyle.textContent=':popover-open{'+declarations.replaceAll(';',' !important;')+' !important}';
    document.head.append(hostileStyle);
    const backdropStyle=document.createElement('style');
    backdropStyle.id='hostile-host-backdrop-style';
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

  await execute(`
    document.getElementById('hostile-host-style')?.remove();
    document.getElementById('hostile-host-backdrop-style')?.remove();
    document.getElementById('popover-page-target')?.remove();
    window.__shadowHostApi.setMountedApp({unmount(){}});
    window.__shadowHostApi.cleanupVueApp();
    document.documentElement.style.cssText='';
    scrollTo(0,0);
  `);

  const originalWindowRect = await request(`/session/${session}/window/rect`);
  const setWindowRect = (width, height) => request(`/session/${session}/window/rect`, 'PUT', {
    x: originalWindowRect.x ?? 0, y: originalWindowRect.y ?? 0, width, height,
  });
  const assertViewportAnchored = (snapshot, label) => {
    const { width, height } = snapshot.viewport;
    const [topLeft, bottomRight] = snapshot.before;
    const [scrolledTopLeft, scrolledBottomRight] = snapshot.after;
    const near = (actual, expected) => Math.abs(actual - expected) <= 0.5;
    for (const [name, rect] of [['top-left', topLeft], ['scrolled top-left', scrolledTopLeft]]) {
      assert.ok(near(rect[0], 24) && near(rect[1], 32), `${label} ${name} probe is not viewport anchored: ${JSON.stringify(rect)}`);
    }
    for (const [name, rect] of [['bottom-right', bottomRight], ['scrolled bottom-right', scrolledBottomRight]]) {
      assert.ok(near(rect[2], width - 24) && near(rect[3], height - 32), `${label} ${name} probe is not viewport anchored: ${JSON.stringify({rect,viewport:snapshot.viewport})}`);
    }
  };
  await setWindowRect(1200, 900);
  const dynamicStart = await execute(`
    const api=window.__shadowHostApi,root=document.documentElement;
    const originalShowPopover=Object.getOwnPropertyDescriptor(HTMLElement.prototype,'showPopover');
    const nativeShowPopover=HTMLElement.prototype.showPopover;
    window.__dynamicShowDescriptor=originalShowPopover;
    window.__dynamicShowCalls=0;
    HTMLElement.prototype.showPopover=function(...args){if(this.id==='translate-it-host-main')window.__dynamicShowCalls++;return nativeShowPopover.apply(this,args)};
    window.__dynamicFlush=async(win=window)=>{await new Promise(resolve=>win.requestAnimationFrame(()=>win.requestAnimationFrame(resolve)));await new Promise(resolve=>setTimeout(resolve,60))};
    window.__dynamicProbes=(container,win=window)=>{
      const top=win.document.createElement('button'),fab=win.document.createElement('button');
      top.id='dynamic-top-left';fab.id='dynamic-bottom-right';
      top.style.cssText='position:fixed;left:24px;top:32px;width:64px;height:44px;pointer-events:auto';
      fab.style.cssText='position:fixed;right:24px;bottom:32px;width:64px;height:44px;pointer-events:auto';
      top.onclick=()=>top.dataset.clicked='yes';fab.onclick=()=>fab.dataset.clicked='yes';container.append(top,fab);return[top,fab];
    };
    window.__dynamicSnapshot=async(host,probes,win=window)=>{
      win.scrollTo(0,0);await new Promise(resolve=>win.requestAnimationFrame(resolve));
      const rects=els=>els.map(e=>{const r=e.getBoundingClientRect();return[r.left,r.top,r.right,r.bottom]});
      const before=rects(probes),viewport={width:win.document.documentElement.clientWidth,height:win.document.documentElement.clientHeight};
      win.scrollTo(321,643);await new Promise(resolve=>win.requestAnimationFrame(()=>win.requestAnimationFrame(resolve)));
      const after=rects(probes),hits=probes.map(e=>{const r=e.getBoundingClientRect(),x=r.left+r.width/2,y=r.top+r.height/2;return{visible:e.checkVisibility(),document:win.document.elementFromPoint(x,y)?.id||win.document.elementFromPoint(x,y)?.tagName,shadow:host.shadowRoot.elementFromPoint(x,y)?.id||host.shadowRoot.elementFromPoint(x,y)?.tagName}});
      win.scrollTo(0,0);
      return{open:host.matches(':popover-open'),hostSame:host===win.__dynamicHost,showCalls:win.__dynamicShowCalls,before,after,viewport,hits};
    };
    root.style.cssText='';root.className='';root.removeAttribute('data-head-trigger');root.removeAttribute('data-link-trigger');root.removeAttribute('data-resize-trigger');
    document.body.style.cssText='height:5000px;margin:0';
    const routes=document.createElement('style');routes.id='dynamic-route-styles';routes.textContent='.route-contain{contain:layout style}.route-transform{transform:translateX(2px)}';document.head.append(routes);
    const container=await api.createMountPoint(),host=container.getRootNode().host;window.__dynamicHost=host;
    const probes=window.__dynamicProbes(container);window.__dynamicProbeElements=probes;
    const before=await window.__dynamicSnapshot(host,probes);
    root.classList.add('route-contain');history.pushState({route:'contain'},'','#route-contain');await window.__dynamicFlush();
    const after=await window.__dynamicSnapshot(host,probes);
    const rect=probes[0].getBoundingClientRect();
    return{before,after,clickPoint:[rect.left+rect.width/2,rect.top+rect.height/2],rootContain:getComputedStyle(root).contain};
  `);
  assert.equal(dynamicStart.before.open, false, 'Ordinary root should leave the new host unpromoted');
  assert.equal(dynamicStart.after.open, true, 'SPA class/route containment change did not promote the existing host');
  assert.equal(dynamicStart.after.hostSame, true, 'Dynamic promotion replaced the existing host');
  assert.equal(dynamicStart.after.showCalls, 1, 'Dynamic promotion should call showPopover exactly once');
  assert.equal(dynamicStart.rootContain, 'layout style');
  assertViewportAnchored(dynamicStart.after, 'SPA class/route promotion');
  assert.ok(dynamicStart.after.hits.every((hit,index) => hit.visible && hit.document === 'translate-it-host-main' && hit.shadow === ['dynamic-top-left','dynamic-bottom-right'][index]));
  await click([dynamicStart.clickPoint]);
  assert.equal(await execute(`return window.__dynamicProbeElements[0].dataset.clicked`), 'yes', 'Dynamically promoted probe missed a native pointer click');

  const classAndStyleChanges = await execute(`
    const api=window.__shadowHostApi,root=document.documentElement,host=window.__dynamicHost,probes=window.__dynamicProbeElements;
    root.classList.remove('route-contain');history.pushState({route:'clear'},'','#route-clear');await window.__dynamicFlush();
    const cleared=await window.__dynamicSnapshot(host,probes);
    root.classList.add('route-transform');history.pushState({route:'transform'},'','#route-transform');await window.__dynamicFlush();
    const classTransform=await window.__dynamicSnapshot(host,probes);
    root.classList.remove('route-transform');root.style.transform='translateX(3px)';await window.__dynamicFlush();
    const inlineTransform=await window.__dynamicSnapshot(host,probes);
    root.style.transform='';await window.__dynamicFlush();
    const inlineRemoved=await window.__dynamicSnapshot(host,probes);
    api.setMountedApp({unmount(){}});api.cleanupVueApp();await window.__dynamicFlush();
    const countAfterCleanup=window.__dynamicShowCalls;
    root.classList.add('route-contain');await window.__dynamicFlush();
    const cleanupQuiet={hostExists:!!document.getElementById('translate-it-host-main'),showCalls:window.__dynamicShowCalls,countAfterCleanup};
    root.classList.remove('route-contain');document.getElementById('dynamic-route-styles')?.remove();
    return{cleared,classTransform,inlineTransform,inlineRemoved,cleanupQuiet};
  `);
  for (const [label, state] of Object.entries(classAndStyleChanges).filter(([key]) => key !== 'cleanupQuiet')) {
    assert.equal(state.open, true, `${label} wrongly demoted a promoted host`);
    assert.equal(state.hostSame, true, `${label} changed host identity`);
    assert.equal(state.showCalls, 1, `${label} called showPopover again`);
    assert.deepEqual(state.after, state.before, `${label} moved fixed descendants`);
    assert.ok(state.hits.every((hit, index) => hit.visible && hit.document === 'translate-it-host-main' && hit.shadow === ['dynamic-top-left','dynamic-bottom-right'][index]), `${label} lost probe visibility/hit testing`);
    assertViewportAnchored(state, label);
  }
  assert.deepEqual(classAndStyleChanges.cleanupQuiet, {hostExists:false,showCalls:1,countAfterCleanup:1}, 'Cleaned-up root observer reacted to later class changes');

  const stylesheetChanges = await execute(`
    const api=window.__shadowHostApi,root=document.documentElement;
    root.style.cssText='';root.className='';root.setAttribute('data-head-trigger','yes');
    const container=await api.createMountPoint(),host=container.getRootNode().host;window.__dynamicHost=host;
    const probes=window.__dynamicProbeElements=window.__dynamicProbes(container);
    const before=await window.__dynamicSnapshot(host,probes);
    const sheet=document.createElement('style');sheet.id='dynamic-head-sheet';sheet.textContent='html[data-head-trigger="yes"]{transform:translateX(2px)}';document.head.append(sheet);
    await window.__dynamicFlush();const inserted=await window.__dynamicSnapshot(host,probes);
    sheet.textContent='html[data-head-trigger="yes"]{perspective:900px}';await window.__dynamicFlush();
    const replaced={...(await window.__dynamicSnapshot(host,probes)),perspective:getComputedStyle(root).perspective};
    sheet.firstChild.data='html[data-head-trigger="yes"]{contain:layout style}';await window.__dynamicFlush();
    const textChanged={...(await window.__dynamicSnapshot(host,probes)),contain:getComputedStyle(root).contain};
    const override=document.createElement('style');override.id='dynamic-head-override';override.textContent='html[data-head-trigger="yes"]{contain:layout style !important}';document.head.append(override);
    await window.__dynamicFlush();const overridden=await window.__dynamicSnapshot(host,probes);
    sheet.remove();override.remove();root.removeAttribute('data-head-trigger');await window.__dynamicFlush();
    const removed=await window.__dynamicSnapshot(host,probes);
    const showCalls=window.__dynamicShowCalls;
    api.setMountedApp({unmount(){}});api.cleanupVueApp();await window.__dynamicFlush();
    return{before,inserted,replaced,textChanged,overridden,removed,showCalls};
  `);
  assert.equal(stylesheetChanges.before.open, false);
  for (const stage of ['inserted','replaced','textChanged','overridden','removed']) {
    assert.equal(stylesheetChanges[stage].open, true, `Stylesheet ${stage} demoted the host`);
    assert.equal(stylesheetChanges[stage].hostSame, true, `Stylesheet ${stage} replaced the host`);
    assert.equal(stylesheetChanges[stage].showCalls, 2, `Stylesheet ${stage} reopened the promoted host`);
    assert.deepEqual(stylesheetChanges[stage].after, stylesheetChanges[stage].before, `Stylesheet ${stage} moved a fixed probe`);
    assert.ok(stylesheetChanges[stage].hits.every((hit, index) => hit.visible && hit.document === 'translate-it-host-main' && hit.shadow === ['dynamic-top-left','dynamic-bottom-right'][index]), `Stylesheet ${stage} broke probe hit-testing`);
    assertViewportAnchored(stylesheetChanges[stage], `Stylesheet ${stage}`);
  }
  assert.equal(stylesheetChanges.replaced.perspective, '900px');
  assert.equal(stylesheetChanges.textChanged.contain, 'layout style');

  const linkChanges = await execute(`
    const api=window.__shadowHostApi,root=document.documentElement;
    root.style.cssText='';root.className='';root.removeAttribute('data-head-trigger');root.setAttribute('data-link-trigger','yes');
    const container=await api.createMountPoint(),host=container.getRootNode().host;window.__dynamicHost=host;
    const probes=window.__dynamicProbeElements=window.__dynamicProbes(container);
    const before=await window.__dynamicSnapshot(host,probes);
    const link=document.createElement('link');link.rel='stylesheet';link.media='all';link.id='dynamic-link-sheet';
    const dataCss=css=>'data:text/css;charset=utf-8,'+encodeURIComponent(css);
    const loadHref=(href)=>new Promise((resolve,reject)=>{link.onload=resolve;link.onerror=()=>reject(new Error('Dynamic link stylesheet failed to load'));link.href=href});
    const firstLoad=loadHref(dataCss('html[data-link-trigger="yes"]{transform:translateX(3px)}'));document.head.append(link);await firstLoad;await window.__dynamicFlush();
    const loaded={...(await window.__dynamicSnapshot(host,probes)),transform:getComputedStyle(root).transform};
    link.media='not all';await window.__dynamicFlush();const mediaOff=await window.__dynamicSnapshot(host,probes);
    link.media='all';await window.__dynamicFlush();const mediaOn=await window.__dynamicSnapshot(host,probes);
    const hrefLoad=loadHref(dataCss('html[data-link-trigger="yes"]{perspective:900px}'));await hrefLoad;await window.__dynamicFlush();
    const hrefChanged={...(await window.__dynamicSnapshot(host,probes)),perspective:getComputedStyle(root).perspective};
    link.remove();root.removeAttribute('data-link-trigger');await window.__dynamicFlush();const removed=await window.__dynamicSnapshot(host,probes);
    const showCalls=window.__dynamicShowCalls;api.setMountedApp({unmount(){}});api.cleanupVueApp();await window.__dynamicFlush();
    return{before,loaded,mediaOff,mediaOn,hrefChanged,removed,showCalls};
  `);
  assert.equal(linkChanges.before.open, false);
  for (const stage of ['loaded','mediaOff','mediaOn','hrefChanged','removed']) {
    assert.equal(linkChanges[stage].open, true, `Link stylesheet ${stage} demoted the host`);
    assert.equal(linkChanges[stage].hostSame, true, `Link stylesheet ${stage} replaced the host`);
    assert.equal(linkChanges[stage].showCalls, 3, `Link stylesheet ${stage} called showPopover again`);
    assert.deepEqual(linkChanges[stage].after, linkChanges[stage].before, `Link stylesheet ${stage} moved a fixed probe`);
    assert.ok(linkChanges[stage].hits.every(hit => hit.visible && hit.shadow), `Link stylesheet ${stage} broke probe hit-testing`);
    assertViewportAnchored(linkChanges[stage], `Link stylesheet ${stage}`);
  }
  assert.equal(linkChanges.loaded.transform, 'matrix(1, 0, 0, 1, 3, 0)');
  assert.equal(linkChanges.hrefChanged.perspective, '900px');

  // Each sheet/attribute case starts with a fresh ordinary host; only the named
  // mutation occurs after mount, proving that mutation itself triggered promotion.
  const freshMutationCases = await execute(`
    const api=window.__shadowHostApi,root=document.documentElement,initialCalls=window.__dynamicShowCalls,results=[];
    const resetRoot=()=>{root.style.cssText='';root.className='';for(const name of [...root.getAttributeNames()])if(name.startsWith('data-dynamic-'))root.removeAttribute(name);};
    const cleanup=async()=>{api.setMountedApp({unmount(){}});api.cleanupVueApp();await window.__dynamicFlush()};
    const freshHost=async()=>{scrollTo(0,0);const container=await api.createMountPoint(),host=container.getRootNode().host;window.__dynamicHost=host;const probes=window.__dynamicProbeElements=window.__dynamicProbes(container);return{host,probes,before:await window.__dynamicSnapshot(host,probes)}};
    const record=async(name,fixture,hostState,expected)=>{
      await window.__dynamicFlush();const after=await window.__dynamicSnapshot(hostState.host,hostState.probes);
      results.push({name,before:hostState.before,after,expected,computed:getComputedStyle(root).getPropertyValue(expected.property),calls:window.__dynamicShowCalls});
      await cleanup();fixture?.remove();resetRoot();
    };
    // Inline root style is the sole post-mount trigger.
    resetRoot();let state=await freshHost();root.style.contain='layout style';
    await record('inline-style',null,state,{property:'contain',value:'layout style'});

    // Existing non-triggering style changes textContent only after host creation.
    resetRoot();root.setAttribute('data-dynamic-style','yes');
    let style=document.createElement('style');style.textContent='html[data-dynamic-style="yes"]{opacity:.9}';document.head.append(style);
    state=await freshHost();style.textContent='html[data-dynamic-style="yes"]{transform:translateX(1px)}';
    await record('style-text-replacement',style,state,{property:'transform',value:'matrix(1, 0, 0, 1, 1, 0)'});

    // Existing sheet text node changes (characterData) after ordinary mount.
    resetRoot();root.setAttribute('data-dynamic-text','yes');
    style=document.createElement('style');style.textContent='html[data-dynamic-text="yes"]{filter:blur(1px)}';document.head.append(style);
    state=await freshHost();style.firstChild.data='html[data-dynamic-text="yes"]{perspective:900px}';
    await record('style-text-node',style,state,{property:'perspective',value:'900px'});

    // An important harmless override initially masks the dangerous CSS; removing only it triggers promotion.
    resetRoot();root.setAttribute('data-dynamic-override','yes');
    const base=document.createElement('style'),override=document.createElement('style');
    base.textContent='html[data-dynamic-override="yes"]{contain:layout style}';override.textContent='html[data-dynamic-override="yes"]{contain:none !important}';document.head.append(base,override);
    state=await freshHost();override.remove();await window.__dynamicFlush();
    const afterOverrideRemoval=await window.__dynamicSnapshot(state.host,state.probes);
    results.push({name:'remove-masking-override',before:state.before,after:afterOverrideRemoval,expected:{property:'contain',value:'layout style'},computed:getComputedStyle(root).contain,calls:window.__dynamicShowCalls});
    await cleanup();base.remove();resetRoot();

    // A loaded link is harmless while media is off; media activation is the trigger.
    resetRoot();root.setAttribute('data-dynamic-media','yes');
    const link=document.createElement('link');link.rel='stylesheet';link.media='not all';link.href='data:text/css;charset=utf-8,'+encodeURIComponent('html[data-dynamic-media="yes"]{contain:layout style}');
    await new Promise((resolve,reject)=>{link.onload=resolve;link.onerror=()=>reject(new Error('Media-case stylesheet failed to load'));document.head.append(link)});
    state=await freshHost();link.media='all';
    await record('link-media-activation',link,state,{property:'contain',value:'layout style'});

    // A loaded harmless link changes href to a trigger only after mount.
    resetRoot();root.setAttribute('data-dynamic-href','yes');
    const hrefLink=document.createElement('link');hrefLink.rel='stylesheet';hrefLink.href='data:text/css;charset=utf-8,'+encodeURIComponent('html[data-dynamic-href="yes"]{opacity:.9}');
    await new Promise((resolve,reject)=>{hrefLink.onload=resolve;hrefLink.onerror=()=>reject(new Error('Harmless href stylesheet failed to load'));document.head.append(hrefLink)});
    state=await freshHost();
    await new Promise((resolve,reject)=>{hrefLink.onload=resolve;hrefLink.onerror=()=>reject(new Error('Trigger href stylesheet failed to load'));hrefLink.href='data:text/css;charset=utf-8,'+encodeURIComponent('html[data-dynamic-href="yes"]{transform:translateX(2px)}')});
    await record('link-href-change',hrefLink,state,{property:'transform',value:'matrix(1, 0, 0, 1, 2, 0)'});
    return{initialCalls,results};
  `);
  for (const item of freshMutationCases.results) {
    assert.equal(item.before.open, false, `${item.name} fixture promoted before its target mutation`);
    assert.equal(item.after.open, true, `${item.name} target mutation did not promote`);
    assert.equal(item.after.hostSame, true, `${item.name} replaced the existing host`);
    assert.equal(item.after.showCalls, item.before.showCalls + 1, `${item.name} did not promote exactly once`);
    assert.equal(item.calls, item.after.showCalls);
    assert.equal(item.computed, item.expected.value, `${item.name} did not apply its intended computed root style`);
    assert.deepEqual(item.after.after, item.after.before, `${item.name} moved fixed probes after scroll`);
    assert.ok(item.after.hits.every((hit,index) => hit.visible && hit.document === 'translate-it-host-main' && hit.shadow === ['dynamic-top-left','dynamic-bottom-right'][index]), `${item.name} lost visibility or hit testing`);
    assertViewportAnchored(item.after, item.name);
  }
  const callsBeforeResize = freshMutationCases.results.at(-1).calls;

  await setWindowRect(1200, 900);
  const resizeSetup = await execute(`
    const api=window.__shadowHostApi,root=document.documentElement;
    root.style.cssText='';root.className='';root.removeAttribute('data-link-trigger');root.setAttribute('data-resize-trigger','yes');
    const sheet=document.createElement('style');sheet.id='dynamic-media-sheet';sheet.textContent='@media (max-width: 900px){html[data-resize-trigger="yes"]{perspective:1000px}}';document.head.append(sheet);
    const container=await api.createMountPoint(),host=container.getRootNode().host;window.__dynamicHost=host;
    const probes=window.__dynamicProbeElements=window.__dynamicProbes(container);
    const initial={matches:matchMedia('(max-width: 900px)').matches,open:host.matches(':popover-open'),perspective:getComputedStyle(root).perspective};
    return initial;
  `);
  assert.equal(resizeSetup.matches, false, 'Resize test must start above the media breakpoint');
  assert.equal(resizeSetup.open, false);
  await setWindowRect(800, 900);
  const narrow = await execute(`await window.__dynamicFlush();return {...await window.__dynamicSnapshot(window.__dynamicHost,window.__dynamicProbeElements),matches:matchMedia('(max-width: 900px)').matches,perspective:getComputedStyle(document.documentElement).perspective}`);
  assert.equal(narrow.matches, true);
  assert.equal(narrow.perspective, '1000px');
  assert.equal(narrow.open, true, 'Resize media CSS did not promote the existing host');
  assert.equal(narrow.showCalls, callsBeforeResize + 1);
  assert.deepEqual(narrow.after, narrow.before, 'Resize-triggered promotion moved fixed probes');
  assert.ok(narrow.hits.every((hit,index) => hit.visible && hit.document === 'translate-it-host-main' && hit.shadow === ['dynamic-top-left','dynamic-bottom-right'][index]));
  assertViewportAnchored(narrow, 'Resize-triggered promotion');
  await setWindowRect(1200, 900);
  const wide = await execute(`await window.__dynamicFlush();return {...await window.__dynamicSnapshot(window.__dynamicHost,window.__dynamicProbeElements),matches:matchMedia('(max-width: 900px)').matches,perspective:getComputedStyle(document.documentElement).perspective}`);
  assert.equal(wide.matches, false);
  assert.equal(wide.perspective, 'none');
  assert.equal(wide.open, true, 'Resize media deactivation demoted the host');
  assert.equal(wide.showCalls, callsBeforeResize + 1, 'Resize rerun called showPopover again');
  assert.deepEqual(wide.after, wide.before);
  assertViewportAnchored(wide, 'Resize after promotion');
  const resizeCleanup = await execute(`
    const api=window.__shadowHostApi;api.setMountedApp({unmount(){}});api.cleanupVueApp();await window.__dynamicFlush();
    return window.__dynamicShowCalls;
  `);
  await setWindowRect(800, 900);
  const afterCleanupResize = await execute(`await window.__dynamicFlush();return {host:!!document.getElementById('translate-it-host-main'),calls:window.__dynamicShowCalls}`);
  assert.deepEqual(afterCleanupResize, {host:false,calls:resizeCleanup}, 'Cleaned-up resize observer reacted later');
  const resizeRemount = await execute(`
    const container=await window.__shadowHostApi.createMountPoint(),host=container.getRootNode().host;
    window.__dynamicHost=host;const probes=window.__dynamicProbeElements=window.__dynamicProbes(container);
    return {...await window.__dynamicSnapshot(host,probes),open:host.matches(':popover-open')};
  `);
  assert.equal(resizeRemount.open, true, 'Remount under active resize media did not promote');
  assert.equal(resizeRemount.showCalls, resizeCleanup + 1);
  assert.deepEqual(resizeRemount.after, resizeRemount.before);
  assertViewportAnchored(resizeRemount, 'Resize-triggered remount');
  await execute(`window.__shadowHostApi.setMountedApp({unmount(){}});window.__shadowHostApi.cleanupVueApp()`);

  const iframeDynamic = await execute(`
    const frame=document.createElement('iframe');frame.style.cssText='width:500px;height:350px;border:0';frame.srcdoc='<html><head><style>.frame-contained{contain:layout style}</style></head><body style="height:2500px;margin:0"></body></html>';document.body.append(frame);
    await new Promise(resolve=>frame.addEventListener('load',resolve,{once:true}));const w=frame.contentWindow,root=w.document.documentElement;
    const original=Object.getOwnPropertyDescriptor(w.HTMLElement.prototype,'showPopover'),native=w.HTMLElement.prototype.showPopover;w.__frameShowCalls=0;
    w.HTMLElement.prototype.showPopover=function(...args){if(this.id==='translate-it-host-iframe')w.__frameShowCalls++;return native.apply(this,args)};
    w.__dynamicFlush=async()=>{await new Promise(resolve=>w.requestAnimationFrame(()=>w.requestAnimationFrame(resolve)));await new Promise(resolve=>setTimeout(resolve,60))};
    w.__dynamicProbes=(container)=>{const top=w.document.createElement('button'),fab=w.document.createElement('button');top.id='dynamic-top-left';fab.id='dynamic-bottom-right';top.style.cssText='position:fixed;left:24px;top:32px;width:64px;height:44px;pointer-events:auto';fab.style.cssText='position:fixed;right:24px;bottom:32px;width:64px;height:44px;pointer-events:auto';container.append(top,fab);return[top,fab]};
    w.__dynamicSnapshot=async(host,probes)=>{w.scrollTo(0,0);await new Promise(resolve=>w.requestAnimationFrame(resolve));const before=probes.map(e=>{const r=e.getBoundingClientRect();return[r.left,r.top,r.right,r.bottom]}),viewport={width:root.clientWidth,height:root.clientHeight};w.scrollTo(321,643);await new Promise(resolve=>w.requestAnimationFrame(()=>w.requestAnimationFrame(resolve)));const after=probes.map(e=>{const r=e.getBoundingClientRect();return[r.left,r.top,r.right,r.bottom]}),hits=probes.map(e=>{const r=e.getBoundingClientRect(),x=r.left+r.width/2,y=r.top+r.height/2;return{visible:e.checkVisibility(),document:w.document.elementFromPoint(x,y)?.id||w.document.elementFromPoint(x,y)?.tagName,shadow:host.shadowRoot.elementFromPoint(x,y)?.id||host.shadowRoot.elementFromPoint(x,y)?.tagName}});w.scrollTo(0,0);return{open:host.matches(':popover-open'),hostSame:host===w.__dynamicHost,showCalls:w.__frameShowCalls,before,after,viewport,hits}};
    const api=w.__shadowHostApi=w.Function(${JSON.stringify(runtimeImplementation)})();root.style.cssText='';
    const container=await api.createMountPoint(),host=container.getRootNode().host;w.__dynamicHost=host;
    const probes=w.__dynamicProbes(container,w);const before=await w.__dynamicSnapshot(host,probes,w);
    root.classList.add('frame-contained');await w.__dynamicFlush();const after=await w.__dynamicSnapshot(host,probes,w);
    root.classList.remove('frame-contained');await w.__dynamicFlush();const removed=await w.__dynamicSnapshot(host,probes,w);
    api.setMountedApp({unmount(){}});api.cleanupVueApp();await w.__dynamicFlush();root.classList.add('frame-contained');await w.__dynamicFlush();
    const quiet={host:!!w.document.getElementById('translate-it-host-iframe'),calls:w.__frameShowCalls};
    const remount=await api.createMountPoint(),remountHost=remount.getRootNode().host;
    const remountProbes=w.__dynamicProbes(remount,w),remountOpen=remountHost.matches(':popover-open');const remounted=await w.__dynamicSnapshot(remountHost,remountProbes,w);
    api.setMountedApp({unmount(){}});api.cleanupVueApp();
    if(original)Object.defineProperty(w.HTMLElement.prototype,'showPopover',original);else delete w.HTMLElement.prototype.showPopover;
    frame.remove();return{before,after,removed,quiet,remounted,remountOpen,calls:w.__frameShowCalls};
  `);
  assert.equal(iframeDynamic.before.open, false);
  assert.equal(iframeDynamic.after.open, true, 'Iframe class mutation did not promote its frame-local host');
  assert.deepEqual(iframeDynamic.after.after, iframeDynamic.after.before);
  assertViewportAnchored(iframeDynamic.after, 'Iframe containment activation');
  assert.equal(iframeDynamic.after.showCalls, 1);
  assert.ok(iframeDynamic.after.hits.every((hit,index) => hit.visible && hit.document === 'translate-it-host-iframe' && hit.shadow === ['dynamic-top-left','dynamic-bottom-right'][index]));
  assert.equal(iframeDynamic.removed.open, true, 'Removing iframe containment demoted the host');
  assert.equal(iframeDynamic.removed.showCalls, 1);
  assert.deepEqual(iframeDynamic.quiet, {host:false,calls:1}, 'Cleaned-up iframe observer reacted later');
  assert.equal(iframeDynamic.remountOpen, true);
  assert.equal(iframeDynamic.calls, 2);
  assert.deepEqual(iframeDynamic.remounted.after, iframeDynamic.remounted.before);
  assertViewportAnchored(iframeDynamic.remounted, 'Iframe promoted remount');
  assert.ok(iframeDynamic.remounted.hits.every((hit,index) => hit.visible && hit.document === 'translate-it-host-iframe' && hit.shadow === ['dynamic-top-left','dynamic-bottom-right'][index]));
  await execute(`
    const descriptor=window.__dynamicShowDescriptor;
    if(descriptor)Object.defineProperty(HTMLElement.prototype,'showPopover',descriptor);
  `);
  console.log('PASS: Chrome static and dynamic root CSS host promotion, cleanup, remount, iframe, stylesheet, link, resize, geometry, and pointer regressions.');
} finally {
  if (session && base) { try { await request(`/session/${session}`, 'DELETE'); } catch { /* ChromeDriver may have already closed the session. */ } }
  driver.kill('SIGTERM');
  await Promise.race([new Promise((resolve) => driver.once('exit', resolve)), delay(2000)]);
  if (driver.exitCode === null) driver.kill('SIGKILL');
  await rm(profile, { recursive: true, force: true });
}
