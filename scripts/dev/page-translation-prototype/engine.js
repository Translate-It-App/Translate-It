(() => {
  'use strict';
  const ATTRIBUTES = ['title', 'alt', 'placeholder'];
  const DEFAULT_EXCLUDED = 'script,style,noscript,code,pre,textarea,input,select,button,[data-translate-it-ui]';
  const own = (node) => node.nodeType === 2 ? node.value : node.nodeValue;
  const composedOwner = (node) => node.nodeType === 2 ? node.ownerElement : node.nodeType === 3 ? (node.parentElement || node.parentNode?.host) : node;
  function mockTranslate(text) { return text.startsWith('⟦TI⟧') ? text : `⟦TI⟧${text}`; }

  function createEngine({ root = document.body, mode = 'viewport', budgetMs = 6, maxStepsPerSlice = 250, marginPx = 150, excludedSelectors = [] } = {}) {
    if (!root || !['viewport', 'baseline'].includes(mode) || !Number.isFinite(budgetMs) || budgetMs <= 0 || !Number.isInteger(maxStepsPerSlice) || maxStepsPerSlice < 1) throw new TypeError('Invalid engine options');
    const doc = root.ownerDocument || document, view = doc.defaultView || window;
    // Validate user selectors individually so one malformed selector cannot disable defaults.
    const customSelectors = excludedSelectors.filter((s) => { try { doc.createElement('div').matches(s); return true; } catch { return false; } });
    const owned = new Map(), candidates = new Set(), queuedCandidates = new Set(), queuedRoots = new Set(), observers = new Map();
    const changedNodes = new Set(), addedRoots = new Set();
    const report = { mode, visitedNodes: 0, restoreVisitedNodes: 0, translatedNodes: 0, firstVisibleMs: null, processingMs: 0, restoreMs: 0, restoredNodes: 0, preservedExternalNodes: 0, ownedNodes: 0, maxSliceMs: 0, maxRestoreSliceMs: 0 };
    let active = false, stopped = false, initialDone = false, timer = null, queue = [], queueHead = 0, waiters = [], startResolve, startPromise, startedAt = 0, restorePromise = null, mutationsQueued = false, rescan = null, rescanDirty = false, maintenance = null, maintenanceDirty = false;
    const connected = (node) => {
      const owner = node?.nodeType === 11 ? node.host : composedOwner(node);
      if (!owner?.isConnected) return false;
      for (let p = owner; p; p = p.parentElement || p.parentNode?.host) if (p === root) return true;
      return owner === root;
    };
    const excluded = (node) => {
      const element = composedOwner(node);
      let editable = false, editabilityKnown = false;
      for (let e = element; e; e = e.parentElement || e.parentNode?.host) {
        if (e.matches?.(DEFAULT_EXCLUDED)) return true;
        if (customSelectors.some((s) => e.matches(s))) return true;
        if (!editabilityKnown && e.hasAttribute?.('contenteditable')) {
          editabilityKnown = true;
          const value = e.getAttribute('contenteditable').trim().toLowerCase();
          editable = value !== 'false';
        }
        if (e === root) break;
      }
      return editable;
    };
    const visible = (node) => {
      const el = composedOwner(node);
      if (!el) return false;
      let r; try { r = el.getBoundingClientRect(); } catch { return false; }
      return (r.width > 0 || r.height > 0) && r.bottom >= -marginPx && r.top <= view.innerHeight + marginPx && r.right >= -marginPx && r.left <= view.innerWidth + marginPx;
    };
    const add = (node) => {
      if (!node || stopped || queuedCandidates.has(node)) return;
      queuedCandidates.add(node); queue.push({ kind: 'candidate', node });
    };
    // Each iterator step examines one DOM node; child/sibling links are advanced lazily.
    function* walk(start) {
      const stack = [{ node: start, nextChild: null, childStarted: false, entered: false, shadow: false }];
      while (stack.length) {
        const f = stack[stack.length - 1];
        if (!f.entered) { f.entered = true; yield f.node; continue; }
        if (f.node.nodeType === 1 && !f.shadow) { f.shadow = true; if (f.node.shadowRoot) { stack.push({ node: f.node.shadowRoot, entered: false, nextChild: null, childStarted: false, shadow: false }); continue; } }
        const child = f.childStarted ? f.nextChild : (f.childStarted = true, f.node.firstChild);
        if (child) { f.nextChild = child.nextSibling; stack.push({ node: child, entered: false, nextChild: null, shadow: false }); }
        else stack.pop();
      }
    }
    const observeShadow = (node) => {
      if (node.nodeType !== 1 || !node.shadowRoot || observers.has(node.shadowRoot)) return false;
      const ob = new view.MutationObserver(onMutations); ob.observe(node.shadowRoot, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ATTRIBUTES }); observers.set(node.shadowRoot, { observer: ob, host: node });
      return true;
    };
    function queueWalk(node) { if (!queuedRoots.has(node)) { queuedRoots.add(node); queue.push({ kind: 'walk', root: node, iterator: walk(node) }); } }
    const discover = (node) => {
      report.visitedNodes++;
        if (node.nodeType === 1) {
        observeShadow(node);
        if (!excluded(node)) for (const name of ATTRIBUTES) { const attr = node.getAttributeNode(name); if (attr) { candidates.add(attr); add(attr); } }
      } else if (node.nodeType === 3 && composedOwner(node) && !excluded(node) && node.nodeValue.trim()) { candidates.add(node); add(node); }
    };
    const write = (node) => {
      if (stopped || !active) return;
      if (!connected(node) || excluded(node) || (node.nodeType === 2 && (!ATTRIBUTES.includes(node.name.toLowerCase()) || node.ownerElement.getAttributeNode(node.name) !== node))) { candidates.delete(node); return; }
      const value = own(node);
      if (!value?.trim() || owned.has(node)) { candidates.delete(node); return; }
      const translated = mockTranslate(value);
      if (translated === value) { candidates.delete(node); return; }
      if (!visible(node)) return;
      if (report.firstVisibleMs === null) report.firstVisibleMs = performance.now() - startedAt;
      const setter = (v) => { if (node.nodeType === 2) node.value = v; else node.nodeValue = v; };
      owned.set(node, { original: value, applied: translated, setter, owner: composedOwner(node) });
      setter(translated); report.translatedNodes++; candidates.delete(node);
    };
    const hasJobs = () => queueHead < queue.length;
    const settle = () => { if (initialDone && !hasJobs()) { const list = waiters; waiters = []; list.forEach((r) => r(getStats())); } };
    const schedule = () => { if (timer === null && active && hasJobs()) timer = view.setTimeout(flush, 0); };
    const flush = () => {
      timer = null;
      if (!active || stopped) return;
      const began = performance.now(); let count = 0;
      while (hasJobs() && count < maxStepsPerSlice && performance.now() - began < budgetMs) {
        const job = queue[queueHead]; queue[queueHead++] = null; count++;
        if (job.kind === 'candidate') { queuedCandidates.delete(job.node); write(job.node); }
        else if (job.kind === 'mutations') {
          mutationsQueued = false;
          const changed = changedNodes.values().next();
          if (!changed.done) {
            changedNodes.delete(changed.value);
            const node = changed.value;
            if (connected(node) && node.nodeType === 3 && !owned.has(node)) { candidates.add(node); add(node); }
            else if (node.nodeType === 1) {
              requestMaintenance();
              if (connected(node) && !excluded(node)) for (const name of ATTRIBUTES) { const attr = node.getAttributeNode(name); if (attr && !owned.has(attr)) { candidates.add(attr); add(attr); } }
            }
          }
          const added = addedRoots.values().next();
          if (!added.done) { addedRoots.delete(added.value); if (connected(added.value)) queueWalk(added.value); }
          if (changedNodes.size || addedRoots.size) { mutationsQueued = true; queue.push({ kind: 'mutations' }); }
        } else if (job.kind === 'maintenance') {
          let next;
          if (job.kindCursor === 'observers') {
            next = job.iterator.next();
            if (!next.done) { const [shadow, entry] = next.value; if (!connected(entry.host)) { entry.observer.disconnect(); observers.delete(shadow); } }
          } else {
            next = job.iterator.next();
            if (!next.done) { const node = next.value; if (!connected(node) || (node.nodeType === 2 && (node.ownerElement.getAttributeNode(node.name) !== node || excluded(node)))) candidates.delete(node); }
          }
          if (next.done) {
            if (job.kindCursor === 'observers') { job.kindCursor = 'candidates'; job.iterator = candidates.values(); job.remaining = candidates.size; queue.push(job); }
            else { maintenance = null; if (maintenanceDirty) { maintenanceDirty = false; requestMaintenance(); } }
          } else { job.remaining--; if (job.remaining > 0) queue.push(job); else if (job.kindCursor === 'observers') { job.kindCursor = 'candidates'; job.iterator = candidates.values(); job.remaining = candidates.size; queue.push(job); } else { maintenance = null; if (maintenanceDirty) { maintenanceDirty = false; requestMaintenance(); } } }
        } else if (job.kind === 'rescan') {
          if (job.remaining > 0) {
            const next = job.iterator.next(); job.remaining--;
            if (!next.done) write(next.value);
            queue.push(job);
          } else {
            rescan = null;
            if (rescanDirty) { rescanDirty = false; startRescan(); }
          }
        } else {
          if (job.kind === 'walk' && !connected(job.root)) { queuedRoots.delete(job.root); continue; }
          const next = job.iterator.next();
          if (!next.done) {
            if (job.kind === 'walk') discover(next.value);
            else write(next.value);
            queue.push(job);
          } else if (job.kind === 'walk') queuedRoots.delete(job.root);
        }
      }
      const elapsed = performance.now() - began; report.processingMs += elapsed; report.maxSliceMs = Math.max(report.maxSliceMs, elapsed);
      if (queueHead > 64 && queueHead * 2 >= queue.length) { queue.splice(0, queueHead); queueHead = 0; }
      if (!hasJobs()) { queue = []; queueHead = 0; if (!initialDone) { initialDone = true; startResolve?.(getStats()); } }
      if (hasJobs()) schedule(); else settle();
    };
    function onMutations(records) {
      if (!active || stopped) return;
      for (const record of records) {
        if (record.type === 'childList') { for (const node of record.addedNodes) addedRoots.add(node); for (const node of record.removedNodes) { addedRoots.delete(node); requestMaintenance(); } }
        else if (record.type === 'characterData') { if (connected(record.target) && !owned.has(record.target)) changedNodes.add(record.target); }
        else {
          const attr = record.target.getAttributeNode(record.attributeName);
          if (connected(record.target) && (!attr || !owned.has(attr))) changedNodes.add(record.target);
        }
      }
      if (!mutationsQueued && (changedNodes.size || addedRoots.size)) { mutationsQueued = true; queue.push({ kind: 'mutations' }); }
      schedule();
    }
    function requestMaintenance() {
      if (maintenance) { maintenanceDirty = true; return; }
      maintenance = { kind: 'maintenance', kindCursor: 'observers', iterator: observers.entries(), remaining: observers.size };
      if (maintenance.remaining) queue.push(maintenance);
      else { maintenance.kindCursor = 'candidates'; maintenance.iterator = candidates.values(); maintenance.remaining = candidates.size; if (maintenance.remaining) queue.push(maintenance); else maintenance = null; }
    }
    const getStats = () => ({ ...report, ownedNodes: owned.size, candidateCount: candidates.size, pendingJobCount: queue.length - queueHead + changedNodes.size + addedRoots.size, observerCount: observers.size });
    const whenIdle = () => !hasJobs() && initialDone ? Promise.resolve(getStats()) : new Promise((resolve) => waiters.push(resolve));
    const onScroll = () => {
      if (!active || stopped) return;
      if (rescan) rescanDirty = true; else startRescan(); schedule();
    };
    function startRescan() { const count = candidates.size; rescan = { kind: 'rescan', iterator: candidates.values(), remaining: count }; if (count) queue.push(rescan); else rescan = null; }
    const start = () => {
      if (startPromise) return whenIdle();
      active = true; stopped = false; startedAt = performance.now();
      startPromise = new Promise((resolve) => { startResolve = resolve; });
      if (mode === 'viewport') {
        const seedStarted = performance.now();
        const xs = Math.max(1, Math.min(4, Math.ceil(view.innerWidth / 300))), ys = Math.max(1, Math.min(4, Math.ceil(view.innerHeight / 300)));
        const seeds = new Set();
        for (let y = 0; y < ys; y++) for (let x = 0; x < xs; x++) {
          const target = doc.elementFromPoint?.((x + .5) * view.innerWidth / xs, (y + .5) * view.innerHeight / ys);
          for (let n = target; n; n = n.parentElement || n.parentNode?.host) {
            if (connected(n)) discover(n);
            if (n === root) break;
          }
          if (target && connected(target)) seeds.add(target);
        }
        for (const seed of seeds) queueWalk(seed);
        const seedElapsed = performance.now() - seedStarted; report.processingMs += seedElapsed; report.maxSliceMs = Math.max(report.maxSliceMs, seedElapsed);
      }
      if (mode === 'baseline') {
        const began = performance.now();
        for (const n of walk(root)) { report.visitedNodes++; if (n.nodeType === 1) observeShadow(n); discoverBaseline(n); }
        // Discovery precedes synchronous processing in the comparison mode.
        const nodes = [...candidates];
        for (const n of nodes) write(n);
        const elapsed = performance.now() - began; report.processingMs += elapsed; report.maxSliceMs = Math.max(report.maxSliceMs, elapsed);
        initialDone = true; startResolve(getStats());
      } else queueWalk(root);
      const ob = new view.MutationObserver(onMutations); ob.observe(root, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ATTRIBUTES }); observers.set(root, { observer: ob, host: root });
      view.addEventListener('scroll', onScroll, true);
      if (mode === 'viewport') schedule();
      return startPromise;
    };
    const discoverBaseline = (node) => {
      if (node.nodeType === 1 && !excluded(node)) for (const name of ATTRIBUTES) { const attr = node.getAttributeNode(name); if (attr) candidates.add(attr); }
      else if (node.nodeType === 3 && composedOwner(node) && !excluded(node) && node.nodeValue.trim()) candidates.add(node);
    };
    const stop = () => {
      if (stopped) return;
      stopped = true; active = false;
      if (timer !== null) view.clearTimeout(timer); timer = null;
      observers.forEach(({ observer }) => observer.disconnect()); observers.clear(); view.removeEventListener('scroll', onScroll, true);
      queue = []; queueHead = 0; candidates.clear(); queuedCandidates.clear(); queuedRoots.clear(); changedNodes.clear(); addedRoots.clear(); rescan = null; rescanDirty = false; maintenance = null; maintenanceDirty = false; mutationsQueued = false;
      if (!initialDone) { initialDone = true; startResolve?.(getStats()); }
      settle();
    };
    const restore = () => {
      if (restorePromise) return restorePromise;
      stop(); const then = performance.now();
      if (mode === 'baseline') {
        for (const node of walk(root)) {
          report.restoreVisitedNodes++;
          if (node.nodeType === 3 && owned.has(node)) restoreOne(node, owned.get(node));
          if (node.nodeType === 1) for (const name of ATTRIBUTES) {
            const attr = node.getAttributeNode(name);
            if (attr && owned.has(attr)) restoreOne(attr, owned.get(attr));
          }
        }
        owned.clear(); candidates.clear();
        report.restoreMs += performance.now() - then; restorePromise = Promise.resolve(getStats()); return restorePromise;
      }
      restorePromise = new Promise((resolve) => {
        const iterator = owned.entries();
        const batch = () => {
          const began = performance.now(); let count = 0, next;
          while (count++ < maxStepsPerSlice && performance.now() - began < budgetMs && !(next = iterator.next()).done) {
            report.restoreVisitedNodes++;
            restoreOne(next.value[0], next.value[1]);
          }
          report.maxRestoreSliceMs = Math.max(report.maxRestoreSliceMs, performance.now() - began);
          if (next?.done) { owned.clear(); candidates.clear(); report.restoreMs += performance.now() - then; resolve(getStats()); }
          else view.setTimeout(batch, 0);
        };
        batch();
      });
      return restorePromise;
    };
    const restoreOne = (node, rec) => {
      if (!connected(node) || !connected(rec.owner)) return;
      if (own(node) !== rec.applied) { report.preservedExternalNodes++; return; }
      rec.setter(rec.original); report.restoredNodes++;
    };
    return { start, whenIdle, stop, restore, cleanup: restore, getStats };
  }
  globalThis.TranslateItViewportPrototype = { createEngine, mockTranslate };
})();
