(() => {
  'use strict';
  const ATTRIBUTES = ['title', 'alt', 'placeholder'];
  const DEFAULT_EXCLUDED = 'script,style,noscript,code,pre,textarea,input,select,button,[data-translate-it-ui]';
  const MAX_AUDIT_SCOPES = 64, MAX_AUDIT_SHEETS = 128, MAX_AUDIT_RULES = 512, MAX_AUDIT_BYTES = 262144, MAX_BATCH_DATA_NAMES = 32, MAX_HEAD_NODES = 512;
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
    const report = { mode, visitedNodes: 0, seedAncestorVisits: 0, seedSubtreeVisits: 0, rootTraversalVisits: 0, seedTargetRepeatVisits: 0, restoreVisitedNodes: 0, translatedNodes: 0, firstVisibleMs: null, processingMs: 0, restoreMs: 0, restoredNodes: 0, preservedExternalNodes: 0, ownedNodes: 0, maxSliceMs: 0, maxRestoreSliceMs: 0, geometryChecks: 0, prunedBranches: 0, discoveryPasses: 0, discoveryRequests: 0, discoveryRequestsStart: 0, discoveryRequestsScroll: 0, discoveryRequestsResize: 0, discoveryRequestsDomMutation: 0, discoveryRequestsHeadMutation: 0, discoveryRequestsBodyMutation: 0, discoveryRequestsStylesheetLoad: 0, discoveryRequestsStylesheetError: 0, discoveryRequestsImmediate: 0, discoveryRequestsCoalesced: 0, discoveryFollowupPasses: 0, domMutationObserverBatches: 0, rootMutationObserverBatches: 0, headMutationObserverBatches: 0, bodyMutationObserverBatches: 0, mutationChildListRecords: 0, mutationUnownedCharacterDataRecords: 0, mutationRelevantAttributeRecords: 0, mutationDataAttributeRecords: 0, mutationCssReferencedBatches: 0, mutationCssClearBatches: 0, mutationCssFallbackBatches: 0, mutationAuditMs: 0, mutationAuditCount: 0, mutationAuditFallbacks: 0 };
    let active = false, stopped = false, initialDone = false, timer = null, queue = [], queueHead = 0, waiters = [], startResolve, startPromise, startedAt = 0, restorePromise = null, mutationsQueued = false, rescan = null, rescanDirty = false, maintenance = null, maintenanceDirty = false, viewportJob = null, viewportDirty = false, observerSweepDirty = false, bodyLinkInventoryOverflow = false, bodyPendingLinkOverflow = false, uncertainRootsOverflow = false, headObserver = null, bodyObserver = null;
    const pendingStylesheetLinks = new Map(), stylesheetResources = new Set(), uncertainStylesheetRoots = new Set(), stylesheetEventTargets = new Set(), handledStylesheetEvents = new WeakSet();
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
      let r; try { report.geometryChecks++; r = el.getBoundingClientRect(); } catch { return false; }
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
      const ob = new view.MutationObserver(onMutations); ob.observe(node.shadowRoot, { subtree: true, childList: true, characterData: true, attributes: true });
      node.shadowRoot.addEventListener('scroll', onScroll, true);
      node.shadowRoot.addEventListener('load', onStylesheetSettled, true);
      node.shadowRoot.addEventListener('error', onStylesheetSettled, true);
      stylesheetEventTargets.add(node.shadowRoot);
      observers.set(node.shadowRoot, { observer: ob, host: node, scrollTarget: node.shadowRoot, styleNodes: new Set() });
      return true;
    };
    const isStylesheetLink = (node) => node?.nodeType === 1 && node.localName === 'link' && node.relList?.contains('stylesheet');
    const updatePendingLink = (link, force = false) => {
      if (!isStylesheetLink(link) || !link.isConnected || link.ownerDocument !== doc) { pendingStylesheetLinks.delete(link); return; }
      const resourceOverflow = trackStylesheetResource(link);
      let sheet = null;
      try { sheet = link.sheet; } catch { /* inaccessible or still loading: retain conservatively */ }
      if (force || !sheet) {
        if (pendingStylesheetLinks.has(link)) { if (force) pendingStylesheetLinks.set(link, true); return resourceOverflow; }
        if (pendingStylesheetLinks.size >= MAX_AUDIT_SHEETS) return true;
        pendingStylesheetLinks.set(link, force);
      } else pendingStylesheetLinks.delete(link);
      return resourceOverflow;
    };
    function trackStylesheetResource(node) {
      if (stylesheetResources.has(node)) return;
      if (stylesheetResources.size >= MAX_AUDIT_SHEETS) return true;
      stylesheetResources.add(node);
      return false;
    }
    function markUncertainStylesheetRoot(node) {
      for (const rootNode of uncertainStylesheetRoots) {
        if (rootNode === node || rootNode.contains?.(node)) return;
        if (node.contains?.(rootNode)) uncertainStylesheetRoots.delete(rootNode);
      }
      if (uncertainStylesheetRoots.size >= MAX_AUDIT_SCOPES) { uncertainRootsOverflow = true; return; }
      uncertainStylesheetRoots.add(node);
    }
    const belongsToRemovedSubtree = (node, removed) => {
      for (let current = node; current; current = current.parentNode?.host || current.parentNode || current.host || null) if (current === removed) return true;
      return false;
    };
    const liveInDocument = (node) => !!node?.isConnected && (node.ownerDocument || node.host?.ownerDocument) === doc;
    const pruneStylesheetStateInSubtree = (removed) => {
      let relevant = false;
      for (const node of stylesheetResources) if (belongsToRemovedSubtree(node, removed) && !liveInDocument(node)) { stylesheetResources.delete(node); relevant = true; }
      for (const link of pendingStylesheetLinks.keys()) if (belongsToRemovedSubtree(link, removed) && !liveInDocument(link)) { pendingStylesheetLinks.delete(link); relevant = true; }
      for (const rootNode of uncertainStylesheetRoots) if (belongsToRemovedSubtree(rootNode, removed) && !liveInDocument(rootNode)) { uncertainStylesheetRoots.delete(rootNode); relevant = true; }
      return relevant || uncertainRootsOverflow;
    };
    const scanHeadResources = (start, added, budget = MAX_HEAD_NODES) => {
      const stack = [{ node: start, entered: false, nextChild: null, childStarted: false }];
      let visited = 0, relevant = false, resourceOverflow = false;
      while (stack.length && visited < budget) {
        const frame = stack[stack.length - 1];
        if (!frame.entered) {
          frame.entered = true; visited++;
          const node = frame.node;
          if (isStylesheetLink(node)) {
            relevant = true;
            if (added && updatePendingLink(node)) resourceOverflow = true;
            if (trackStylesheetResource(node)) resourceOverflow = true;
          } else if (pendingStylesheetLinks.has(node)) {
            relevant = true;
          } else if (node?.nodeType === 1 && node.localName === 'style') { relevant = true; if (trackStylesheetResource(node)) resourceOverflow = true; }
          continue;
        }
        const child = frame.childStarted ? frame.nextChild : (frame.childStarted = true, frame.node.firstChild);
        if (child) { frame.nextChild = child.nextSibling; stack.push({ node: child, entered: false, nextChild: null, childStarted: false }); }
        else stack.pop();
      }
      const truncated = stack.length > 0;
      return { relevant: relevant || resourceOverflow || truncated, visited, overflow: resourceOverflow || truncated, truncated };
    };
    const captureBodyStylesheetLinks = () => {
      const links = doc.body?.getElementsByTagName('link');
      bodyLinkInventoryOverflow = false; bodyPendingLinkOverflow = false;
      if (!links) return;
      prunePendingStylesheetLinks();
      const count = links.length;
      if (count > MAX_AUDIT_SHEETS) bodyLinkInventoryOverflow = true;
      for (let i = 0; i < Math.min(count, MAX_AUDIT_SHEETS); i++) if (updatePendingLink(links[i])) bodyPendingLinkOverflow = true;
    };
    const prunePendingStylesheetLinks = () => {
      for (const [link, force] of pendingStylesheetLinks) {
        if (!isStylesheetLink(link) || !link.isConnected || link.ownerDocument !== doc) { pendingStylesheetLinks.delete(link); continue; }
        if (!force) { try { if (link.sheet) pendingStylesheetLinks.delete(link); } catch { /* keep the link pending */ } }
      }
    };
    const pruneShadowStyleNodes = (scope, entry) => {
      for (const styleNode of entry.styleNodes) if (!connected(styleNode) || styleNode.getRootNode() !== scope) entry.styleNodes.delete(styleNode);
    };
    const recordShadowSheet = (node) => {
      if (node.nodeType !== 1) return;
      const isStyle = node.localName === 'style', isLink = node.localName === 'link' && node.relList?.contains('stylesheet');
      if (!isStyle && !isLink) return;
      if (trackStylesheetResource(node)) markUncertainStylesheetRoot(node);
      const scope = node.getRootNode(), entry = scope?.host ? observers.get(scope) : null;
      if (!entry) return;
      pruneShadowStyleNodes(scope, entry);
      if (entry.styleNodes.has(node)) return;
      if (entry.styleNodes.size >= MAX_AUDIT_SHEETS) { markUncertainStylesheetRoot(node); return; }
      entry.styleNodes.add(node);
    };
    function queueWalk(node) { if (!queuedRoots.has(node)) { queuedRoots.add(node); queue.push({ kind: 'walk', root: node, iterator: walk(node) }); } }
    const discover = (node) => {
      report.visitedNodes++;
      if (node.nodeType === 1) {
        observeShadow(node);
        if (!excluded(node)) for (const name of ATTRIBUTES) { const attr = node.getAttributeNode(name); if (attr) { candidates.add(attr); add(attr); } }
      } else if (node.nodeType === 3 && composedOwner(node) && !excluded(node) && node.nodeValue.trim()) { candidates.add(node); add(node); }
    };
    const outsideViewport = (node) => {
      if (node.nodeType !== 1 || node === root) return false;
      let rect;
      try { report.geometryChecks++; rect = node.getBoundingClientRect(); } catch { return false; }
      return rect.width > 0 && rect.height > 0 && (rect.bottom < -marginPx || rect.top > view.innerHeight + marginPx || rect.right < -marginPx || rect.left > view.innerWidth + marginPx);
    };
    function* walkViewport(start) {
      const stack = [{ node: start, nextChild: null, childStarted: false, entered: false, shadow: false }];
      while (stack.length) {
        const frame = stack[stack.length - 1];
        if (!frame.entered) { frame.entered = true; yield frame.node; continue; }
        if (!connected(frame.node)) { stack.pop(); continue; }
        if (frame.node.nodeType === 1 && outsideViewport(frame.node)) { report.prunedBranches++; stack.pop(); continue; }
        if (frame.node.nodeType === 1 && !frame.shadow) { frame.shadow = true; if (frame.node.shadowRoot) { stack.push({ node: frame.node.shadowRoot, entered: false, nextChild: null, childStarted: false, shadow: false }); continue; } }
        const child = frame.childStarted ? frame.nextChild : (frame.childStarted = true, frame.node.firstChild);
        if (child) { frame.nextChild = child.nextSibling; stack.push({ node: child, entered: false, nextChild: null, shadow: false }); }
        else stack.pop();
      }
    }
    function* viewportTraversal(seeds, setPhase) {
      for (const target of seeds) {
        setPhase('seedAncestor');
        for (let node = target; node; node = node.parentElement || node.parentNode?.host) {
          if (!connected(node)) break;
          yield node;
          if (node === root) break;
        }
        setPhase('seedSubtree');
        if (connected(target)) { report.seedTargetRepeatVisits++; yield* walkViewport(target); }
      }
      setPhase('rootTraversal');
      yield* walkViewport(root);
    }
    const discoverViewport = (node, phase) => {
      report.visitedNodes++;
      if (phase === 'seedAncestor') report.seedAncestorVisits++;
      else if (phase === 'seedSubtree') report.seedSubtreeVisits++;
      else report.rootTraversalVisits++;
      if (!connected(node)) return;
      if (node.nodeType === 1) {
        observeShadow(node);
        recordShadowSheet(node);
        if (node.localName === 'style' && trackStylesheetResource(node)) markUncertainStylesheetRoot(node);
        if (updatePendingLink(node)) markUncertainStylesheetRoot(node);
        if (!excluded(node)) for (const name of ATTRIBUTES) { const attr = node.getAttributeNode(name); if (attr) write(attr); }
      } else if (node.nodeType === 3 && composedOwner(node) && !excluded(node) && node.nodeValue.trim()) write(node);
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
    const hasWork = () => mode === 'viewport' ? !!viewportJob : hasJobs();
    const settle = () => { if (initialDone && !hasWork()) { const list = waiters; waiters = []; list.forEach((r) => r(getStats())); } };
    const schedule = () => { if (timer === null && active && hasWork()) timer = view.setTimeout(flush, 0); };
    const hitTestSeeds = () => {
      const xs = Math.max(1, Math.min(4, Math.ceil(view.innerWidth / 300))), ys = Math.max(1, Math.min(4, Math.ceil(view.innerHeight / 300)));
      const seeds = new Set();
      for (let y = 0; y < ys; y++) for (let x = 0; x < xs; x++) {
        const target = doc.elementFromPoint?.((x + .5) * view.innerWidth / xs, (y + .5) * view.innerHeight / ys);
        if (target && connected(target)) seeds.add(target);
      }
      return seeds;
    };
    function beginViewportPass(followup = false) {
      const cleanup = observerSweepDirty ? observers.entries() : null;
      const cleanupRemaining = observerSweepDirty ? observers.size : 0;
      observerSweepDirty = false;
      viewportJob = { iterator: null, cleanup, cleanupRemaining, visitPhase: 'seedAncestor' };
      report.discoveryPasses++;
      if (followup && mode === 'viewport') report.discoveryFollowupPasses++;
    }
    function requestViewportPass(trigger) {
      if (!active || stopped) return;
      if (mode === 'viewport') {
        report.discoveryRequests++;
        if (trigger === 'start') report.discoveryRequestsStart++;
        else if (trigger === 'scroll') report.discoveryRequestsScroll++;
        else if (trigger === 'resize') report.discoveryRequestsResize++;
        else if (trigger === 'headMutation') report.discoveryRequestsHeadMutation++;
        else if (trigger === 'bodyMutation') report.discoveryRequestsBodyMutation++;
        else if (trigger === 'stylesheetLoad') report.discoveryRequestsStylesheetLoad++;
        else if (trigger === 'stylesheetError') report.discoveryRequestsStylesheetError++;
        else report.discoveryRequestsDomMutation++;
      }
      if (viewportJob) {
        if (mode === 'viewport') report.discoveryRequestsCoalesced++;
        viewportDirty = true;
      } else {
        if (mode === 'viewport') report.discoveryRequestsImmediate++;
        beginViewportPass();
      }
      schedule();
    }
    function flushViewport() {
      const began = performance.now(); let count = 0;
      while (viewportJob && count < maxStepsPerSlice && performance.now() - began < budgetMs) {
        count++;
        if (viewportJob.cleanup && viewportJob.cleanupRemaining > 0) {
          const next = viewportJob.cleanup.next(); viewportJob.cleanupRemaining--;
          if (!next.done) {
            const [shadow, entry] = next.value;
            if (shadow !== root && !connected(entry.host)) {
              entry.observer.disconnect(); entry.scrollTarget?.removeEventListener('scroll', onScroll, true);
              entry.scrollTarget?.removeEventListener('load', onStylesheetSettled, true); entry.scrollTarget?.removeEventListener('error', onStylesheetSettled, true);
              if (entry.scrollTarget) stylesheetEventTargets.delete(entry.scrollTarget);
              observers.delete(shadow);
            }
          }
          continue;
        }
        viewportJob.cleanup = null;
        if (!viewportJob.iterator) { viewportJob.iterator = viewportTraversal(hitTestSeeds(), (phase) => { viewportJob.visitPhase = phase; }); continue; }
        const next = viewportJob.iterator.next();
        if (!next.done) discoverViewport(next.value, viewportJob.visitPhase);
        else {
          viewportJob = null;
          if (viewportDirty) { viewportDirty = false; beginViewportPass(true); }
        }
      }
      const elapsed = performance.now() - began; report.processingMs += elapsed; report.maxSliceMs = Math.max(report.maxSliceMs, elapsed);
      if (!viewportJob) {
        if (!initialDone) { initialDone = true; startResolve?.(getStats()); }
        settle();
      } else schedule();
    }
    const flush = () => {
      timer = null;
      if (!active || stopped) return;
      if (mode === 'viewport') { flushViewport(); return; }
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
            if (!next.done) { const [shadow, entry] = next.value; if (shadow !== root && !connected(entry.host)) { entry.observer.disconnect(); entry.scrollTarget?.removeEventListener('scroll', onScroll, true); entry.scrollTarget?.removeEventListener('load', onStylesheetSettled, true); entry.scrollTarget?.removeEventListener('error', onStylesheetSettled, true); if (entry.scrollTarget) stylesheetEventTargets.delete(entry.scrollTarget); observers.delete(shadow); } }
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
    const auditDataAttributes = (names) => {
      report.mutationAuditCount++;
      const began = performance.now();
      const state = { result: 'clear', rules: 0, sheets: 0, scopes: 0, bytes: 0, seenSheets: new WeakSet(), seenScopes: new WeakSet() };
      const fallback = () => { state.result = 'fallback'; };
      const inspectText = (text) => {
        if (typeof text !== 'string') { fallback(); return; }
        state.bytes += text.length * 3;
        if (state.bytes > MAX_AUDIT_BYTES || text.includes('\\')) { fallback(); return; }
        const value = text.toLowerCase();
        for (const name of names) {
          let at = value.indexOf(name);
          while (at !== -1) {
            const isIdent = (ch) => ch !== undefined && /[a-z0-9_-]/i.test(ch);
            if (!isIdent(value[at - 1]) && !isIdent(value[at + name.length])) { state.result = 'referenced'; return; }
            at = value.indexOf(name, at + name.length);
          }
        }
      };
      const inspectRules = (rules, depth) => {
        if (depth > 64) { fallback(); return; }
        let length;
        try { length = rules.length; } catch { fallback(); return; }
        if (!Number.isInteger(length)) { fallback(); return; }
        for (let i = 0; i < length && state.result === 'clear'; i++) {
          if (++state.rules > MAX_AUDIT_RULES) { fallback(); return; }
          let rule, type, supported = false;
          try { rule = rules[i]; type = rule?.type; } catch { fallback(); return; }
          if (!rule) { fallback(); return; }
          if (type === 3) {
            let imported;
            try { imported = rule.styleSheet; } catch { fallback(); return; }
            if (!imported) { fallback(); return; }
            const result = inspectSheet(imported, depth + 1);
            if (result !== 'clear') { state.result = result; return; }
            supported = true;
          } else {
            let selector, style, nested, conditionText, name, start, end;
            try { selector = rule.selectorText; style = rule.style; nested = rule.cssRules; conditionText = rule.conditionText; name = rule.name; start = rule.start; end = rule.end; } catch { fallback(); return; }
            if (typeof selector === 'string') { inspectText(selector); supported = true; }
            if (style) {
              let css;
              try { css = style.cssText; } catch { fallback(); return; }
              inspectText(css); supported = true;
            }
            if (typeof conditionText === 'string') { inspectText(conditionText); supported = true; }
            if (typeof name === 'string') { inspectText(name); supported = true; }
            for (const range of [start, end]) if (range != null) {
              let prelude;
              try { prelude = typeof range === 'string' ? range : range.prelude; } catch { fallback(); return; }
              if (typeof prelude !== 'string') { fallback(); return; }
              inspectText(prelude); supported = true;
            }
            if (nested != null) { inspectRules(nested, depth + 1); if (!supported) fallback(); else supported = true; }
            if (type === 10) supported = true;
            if (!supported) fallback();
          }
        }
      };
      const inspectSheet = (sheet, depth = 0) => {
        if (state.result !== 'clear') return state.result;
        if (!sheet || (typeof sheet !== 'object' && typeof sheet !== 'function')) { fallback(); return state.result; }
        if (state.seenSheets.has(sheet)) return state.result;
        state.seenSheets.add(sheet);
        if (++state.sheets > MAX_AUDIT_SHEETS) { fallback(); return state.result; }
        let rules;
        try { rules = sheet.cssRules; } catch { fallback(); return state.result; }
        if (!rules) { fallback(); return state.result; }
        inspectRules(rules, depth);
        return state.result;
      };
      const inspectList = (list) => {
        if (state.result !== 'clear') return;
        let length;
        try { length = list.length; } catch { fallback(); return; }
        if (!Number.isInteger(length)) { fallback(); return; }
        if (length > MAX_AUDIT_SHEETS) { fallback(); return; }
        for (let i = 0; i < length && state.result === 'clear'; i++) {
          let sheet;
          try { sheet = list[i]; } catch { fallback(); return; }
          inspectSheet(sheet);
        }
      };
      const inspectScope = (scope) => {
        if (state.result !== 'clear' || !scope || state.seenScopes.has(scope)) return;
        state.seenScopes.add(scope);
        if (++state.scopes > MAX_AUDIT_SCOPES) { fallback(); return; }
        let sheets, adopted;
        try { sheets = scope.styleSheets; adopted = scope.adoptedStyleSheets; } catch { fallback(); return; }
        if (scope.nodeType === 9 && sheets == null) { fallback(); return; }
        if (sheets != null) inspectList(sheets);
        if (adopted != null) inspectList(adopted);
        const entry = observers.get(scope);
        if (entry) {
          pruneShadowStyleNodes(scope, entry);
          for (const styleNode of entry.styleNodes) {
            const isLink = styleNode.localName === 'link' && styleNode.relList?.contains('stylesheet');
            let sheet;
            try { sheet = styleNode.sheet; } catch { fallback(); return; }
            if (!sheet) { if (isLink || styleNode.localName === 'style') { fallback(); return; } continue; }
            inspectSheet(sheet); if (state.result !== 'clear') return;
          }
        }
      };
      try {
        if (customSelectors.length > MAX_AUDIT_RULES) fallback();
        for (let i = 0; i < customSelectors.length && state.result === 'clear'; i++) {
          const selector = customSelectors[i];
          if (selector.includes('\\')) { fallback(); break; }
          inspectText(selector);
        }
        if (state.result === 'clear') {
          prunePendingStylesheetLinks();
          if (bodyLinkInventoryOverflow || bodyPendingLinkOverflow || uncertainRootsOverflow || uncertainStylesheetRoots.size || pendingStylesheetLinks.size) fallback();
        }
        if (state.result === 'clear') {
          inspectScope(doc);
          for (let scope = root.getRootNode(); scope?.host && state.result === 'clear'; scope = scope.host.getRootNode()) inspectScope(scope);
          for (const scope of observers.keys()) { if (scope.nodeType === 11) inspectScope(scope); if (state.result !== 'clear') break; }
        }
      } catch { fallback(); }
      report.mutationAuditMs += performance.now() - began;
      if (state.result === 'fallback') report.mutationAuditFallbacks++;
      return state.result;
    };
    function onHeadMutations(records) {
      if (!active || stopped) return;
      report.domMutationObserverBatches++; report.headMutationObserverBatches++;
      let invalidate = false;
      for (const record of records) {
        if (record.type === 'childList') {
          report.mutationChildListRecords++;
          for (const node of record.addedNodes) {
            const scan = scanHeadResources(node, true);
            if (scan.overflow) markUncertainStylesheetRoot(node);
            if (scan.relevant) invalidate = true;
          }
          for (const node of record.removedNodes) if (pruneStylesheetStateInSubtree(node)) invalidate = true;
          if (record.target?.nodeType === 1 && record.target.localName === 'style') invalidate = true;
        } else if (record.type === 'characterData') {
          if (!owned.has(record.target)) report.mutationUnownedCharacterDataRecords++;
          if (record.target.parentElement?.localName === 'style') invalidate = true;
        } else {
          const target = record.target, name = record.attributeName.toLowerCase();
          if (isStylesheetLink(target) || pendingStylesheetLinks.has(target)) {
            const wasPending = pendingStylesheetLinks.has(target);
            if (['href', 'rel', 'type', 'disabled', 'media'].includes(name) && updatePendingLink(target, ['href', 'rel', 'type'].includes(name))) markUncertainStylesheetRoot(target);
            if (wasPending || isStylesheetLink(target)) { invalidate = true; report.mutationRelevantAttributeRecords++; }
          } else if (target?.nodeType === 1 && target.localName === 'style' && ['type', 'media', 'title', 'disabled'].includes(name)) { invalidate = true; report.mutationRelevantAttributeRecords++; }
        }
      }
      if (bodyLinkInventoryOverflow) invalidate = true;
      if (invalidate) requestViewportPass('headMutation');
    }
    function onBodyMutations(records) {
      if (!active || stopped) return;
      report.domMutationObserverBatches++; report.bodyMutationObserverBatches++;
      let invalidate = false, budget = MAX_HEAD_NODES;
      for (const record of records) {
        if (record.type === 'childList') {
          report.mutationChildListRecords++;
          for (const node of record.removedNodes) {
            if (pruneStylesheetStateInSubtree(node)) invalidate = true;
          }
          for (const node of record.addedNodes) {
            if (!node.isConnected || connected(node)) continue;
            if (budget <= 0) { markUncertainStylesheetRoot(node); invalidate = true; continue; }
            const result = scanHeadResources(node, true, budget); budget -= result.visited;
            if (result.overflow) markUncertainStylesheetRoot(node);
            if (result.relevant) invalidate = true;
          }
        } else {
          const target = record.target, name = record.attributeName.toLowerCase();
          if (!target.isConnected || connected(target)) continue;
          if (isStylesheetLink(target) || pendingStylesheetLinks.has(target)) {
            if (updatePendingLink(target, ['href', 'rel', 'type'].includes(name))) markUncertainStylesheetRoot(target);
            invalidate = true; report.mutationRelevantAttributeRecords++;
          } else if (target.localName === 'style' && ['type', 'media', 'title', 'disabled'].includes(name)) { invalidate = true; report.mutationRelevantAttributeRecords++; }
        }
      }
      if (records.some((record) => record.type === 'childList') && (bodyLinkInventoryOverflow || bodyPendingLinkOverflow)) { captureBodyStylesheetLinks(); invalidate = true; }
      if (bodyLinkInventoryOverflow || bodyPendingLinkOverflow) invalidate = true;
      if (invalidate) requestViewportPass('bodyMutation');
    }
    const onStylesheetSettled = (event) => {
      if (!active || stopped || !isStylesheetLink(event.target)) return;
      if (handledStylesheetEvents.has(event)) return;
      handledStylesheetEvents.add(event);
      if (event.type === 'error') pendingStylesheetLinks.delete(event.target);
      else if (updatePendingLink(event.target)) markUncertainStylesheetRoot(event.target);
      requestViewportPass(event.type === 'error' ? 'stylesheetError' : 'stylesheetLoad');
    };
    function onMutations(records) {
      if (!active || stopped) return;
      if (mode === 'viewport') {
        report.domMutationObserverBatches++; report.rootMutationObserverBatches++;
        let invalidate = false, overflow = false, linkScanBudget = MAX_HEAD_NODES;
        const dataNames = new Set(); let dataAttributeRecords = 0;
        for (const record of records) {
          if (record.type === 'childList') {
            report.mutationChildListRecords++;
            invalidate = true; observerSweepDirty ||= record.removedNodes.length > 0;
            for (const node of record.removedNodes) pruneStylesheetStateInSubtree(node);
            for (const node of record.addedNodes) {
              if (linkScanBudget <= 0) { markUncertainStylesheetRoot(node); continue; }
              const scan = scanHeadResources(node, true, linkScanBudget);
              linkScanBudget -= scan.visited;
              if (scan.overflow) markUncertainStylesheetRoot(node);
            }
          }
          else if (record.type === 'characterData') { if (!owned.has(record.target)) { invalidate = true; report.mutationUnownedCharacterDataRecords++; } }
          else {
            if (record.attributeNamespace) { invalidate = true; report.mutationRelevantAttributeRecords++; continue; }
            if (record.target?.localName === 'link' && ['href', 'rel', 'type', 'disabled', 'media'].includes(record.attributeName.toLowerCase()) && updatePendingLink(record.target, ['href', 'rel', 'type'].includes(record.attributeName.toLowerCase()))) markUncertainStylesheetRoot(record.target);
            const attr = record.target.getAttributeNode(record.attributeName);
            if (attr && owned.has(attr)) continue;
            const name = record.attributeName.toLowerCase();
            if (name === 'data-translate-it-ui') { invalidate = true; report.mutationRelevantAttributeRecords++; }
            else if (name.startsWith('data-') && /^data-[a-z0-9_-]+$/i.test(name)) {
              report.mutationDataAttributeRecords++; dataAttributeRecords++;
              if (dataNames.has(name)) continue;
              if (dataNames.size === MAX_BATCH_DATA_NAMES) overflow = true;
              else dataNames.add(name);
            } else { invalidate = true; report.mutationRelevantAttributeRecords++; }
          }
        }
        if ((bodyLinkInventoryOverflow || bodyPendingLinkOverflow) && records.some((record) => record.type === 'childList')) captureBodyStylesheetLinks();
        if (!invalidate && overflow) {
          report.mutationAuditCount++; report.mutationAuditFallbacks++; report.mutationCssFallbackBatches++;
          report.mutationRelevantAttributeRecords += dataAttributeRecords; invalidate = true;
        } else if (!invalidate && dataNames.size) {
          const result = auditDataAttributes(dataNames);
          if (result === 'referenced') { report.mutationCssReferencedBatches++; report.mutationRelevantAttributeRecords += dataAttributeRecords; invalidate = true; }
          else if (result === 'fallback') { report.mutationCssFallbackBatches++; report.mutationRelevantAttributeRecords += dataAttributeRecords; invalidate = true; }
          else report.mutationCssClearBatches++;
        }
        if (invalidate) requestViewportPass('domMutation');
        return;
      }
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
    const getStats = () => ({ ...report, ownedNodes: owned.size, candidateCount: mode === 'viewport' ? 0 : candidates.size, pendingJobCount: mode === 'viewport' ? Number(!!viewportJob) : queue.length - queueHead + changedNodes.size + addedRoots.size, observerCount: observers.size });
    const whenIdle = () => !hasWork() && timer === null && initialDone ? Promise.resolve(getStats()) : new Promise((resolve) => waiters.push(resolve));
    const onScroll = () => {
      if (!active || stopped) return;
      if (mode === 'viewport') { requestViewportPass('scroll'); return; }
      if (rescan) rescanDirty = true; else startRescan(); schedule();
    };
    const onResize = () => { if (mode === 'viewport') requestViewportPass('resize'); };
    function startRescan() { const count = candidates.size; rescan = { kind: 'rescan', iterator: candidates.values(), remaining: count }; if (count) queue.push(rescan); else rescan = null; }
    const start = () => {
      if (startPromise) return whenIdle();
      active = true; stopped = false; startedAt = performance.now();
      startPromise = new Promise((resolve) => { startResolve = resolve; });
      if (mode === 'baseline') {
        const began = performance.now();
        for (const n of walk(root)) { report.visitedNodes++; if (n.nodeType === 1) observeShadow(n); discoverBaseline(n); }
        // Discovery precedes synchronous processing in the comparison mode.
        const nodes = [...candidates];
        for (const n of nodes) write(n);
        const elapsed = performance.now() - began; report.processingMs += elapsed; report.maxSliceMs = Math.max(report.maxSliceMs, elapsed);
        initialDone = true; startResolve(getStats());
      }
      const ob = new view.MutationObserver(onMutations); ob.observe(root, { subtree: true, childList: true, characterData: true, attributes: true }); observers.set(root, { observer: ob, host: root });
      view.addEventListener('scroll', onScroll, true);
      if (mode === 'viewport') {
        view.addEventListener('resize', onResize);
        stylesheetEventTargets.add(doc);
        const rootScope = root.getRootNode?.();
        if (rootScope?.host) stylesheetEventTargets.add(rootScope);
        captureBodyStylesheetLinks();
        if (doc.head) {
          const headScan = scanHeadResources(doc.head, true);
          if (headScan.overflow) markUncertainStylesheetRoot(doc.head);
          headObserver = new view.MutationObserver(onHeadMutations);
          headObserver.observe(doc.head, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['rel', 'href', 'disabled', 'media', 'type', 'title'] });
        }
        const bodyCovered = doc.body && (root === doc.body || root === doc.documentElement || root.contains?.(doc.body));
        if (doc.body && !bodyCovered) {
          bodyObserver = new view.MutationObserver(onBodyMutations);
          bodyObserver.observe(doc.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['rel', 'href', 'type', 'disabled', 'media'] });
        }
        for (const target of stylesheetEventTargets) {
          target.addEventListener('load', onStylesheetSettled, true);
          target.addEventListener('error', onStylesheetSettled, true);
        }
        requestViewportPass('start');
      }
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
      headObserver?.disconnect(); headObserver = null; bodyObserver?.disconnect(); bodyObserver = null;
      for (const target of stylesheetEventTargets) { target.removeEventListener('load', onStylesheetSettled, true); target.removeEventListener('error', onStylesheetSettled, true); }
      stylesheetEventTargets.clear();
      pendingStylesheetLinks.clear(); stylesheetResources.clear(); uncertainStylesheetRoots.clear(); bodyLinkInventoryOverflow = false; bodyPendingLinkOverflow = false; uncertainRootsOverflow = false;
      observers.forEach(({ observer, scrollTarget }) => { observer.disconnect(); scrollTarget?.removeEventListener('scroll', onScroll, true); }); observers.clear(); view.removeEventListener('scroll', onScroll, true); view.removeEventListener('resize', onResize);
      queue = []; queueHead = 0; candidates.clear(); queuedCandidates.clear(); queuedRoots.clear(); changedNodes.clear(); addedRoots.clear(); rescan = null; rescanDirty = false; maintenance = null; maintenanceDirty = false; mutationsQueued = false; viewportJob = null; viewportDirty = false;
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
        for (const [node, rec] of owned) if (!rec.owner?.isConnected || (node.nodeType === 3 && !node.parentNode)) restoreOne(node, rec);
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
      const detachedText = node.nodeType === 3 && !node.parentNode;
      if (composedOwner(node) !== rec.owner && !detachedText) return;
      if (node.nodeType === 2 && node.ownerElement.getAttributeNode(node.name) !== node) return;
      if (rec.owner.isConnected && !connected(rec.owner)) return;
      if (own(node) !== rec.applied) { report.preservedExternalNodes++; return; }
      rec.setter(rec.original); report.restoredNodes++;
    };
    return { start, whenIdle, stop, restore, cleanup: restore, getStats };
  }
  globalThis.TranslateItViewportPrototype = { createEngine, mockTranslate };
})();
