(() => {
  "use strict";
  const KEY = "translate-it-select-element-live-benchmark-v2";
  const fixture = document.getElementById("fixture");
  const counts = {
    Small: { logicalParentCount: 8, textNodeCount: 8 },
    Medium: { logicalParentCount: 50, textNodeCount: 50 },
    Large: { logicalParentCount: 300, textNodeCount: 300 },
    "Mixed HTML": { logicalParentCount: 25, textNodeCount: 50 },
  };
  let records = load();
  let active = null;
  let pendingMetadata = null;
  const METADATA_TIMEOUT_MS = 2500;
  const probeEvents = {
    accepted: "translate-it:select-element-benchmark:accepted-click",
    dispatch: "translate-it:select-element-benchmark:request-dispatch",
    terminal: "translate-it:select-element-benchmark:operation-terminal",
    metadata: "translate-it:select-element-benchmark:runtime-metadata",
    configured: "translate-it:select-element-benchmark:configured-metadata",
  };
  document.documentElement.setAttribute("data-translate-it-live-benchmark", "true");

  function buildFixture(name) {
    fixture.replaceChildren();
    const root = document.createElement("section");
    root.id = "fixture-root";
    root.dataset.target = "fixture";
    const parentCount = counts[name].logicalParentCount;
    for (let i = 1; i <= parentCount; i++) {
      const parent = document.createElement("p");
      if (name === "Mixed HTML") {
        parent.append(`Selectable Mixed HTML text unit ${i} `);
        const emphasis = document.createElement(i % 2 ? "strong" : "em");
        emphasis.textContent = `formatted ${i}.`;
        parent.append(emphasis);
      } else parent.textContent = `Selectable ${name} text unit ${i}.`;
      root.append(parent);
    }
    fixture.append(root);
  }
  function clean(record) {
    const n = (v) => Number.isFinite(v) && v >= 0 ? v : null;
    const iso = (v) => typeof v === "string" && Number.isFinite(Date.parse(v)) ? new Date(v).toISOString() : null;
    return {
      label: record.label === "baseline" ? "baseline" : "candidate",
      trialType: ["warm-up", "warm", "cold"].includes(record.trialType) ? record.trialType : "unknown",
      fixture: Object.hasOwn(counts, record.fixture) ? record.fixture : null,
      logicalParentCount: Number.isSafeInteger(record.logicalParentCount) ? record.logicalParentCount : null,
      textNodeCount: Number.isSafeInteger(record.textNodeCount) ? record.textNodeCount : null,
      timestamp: iso(record.timestamp), endTimestamp: iso(record.endTimestamp),
      status: ["successful", "partial", "failed", "cancelled", "incomplete"].includes(record.status) ? record.status : "incomplete",
      timings: { selectionClickMs: n(record.timings?.selectionClickMs), clickToRequestDispatchMs: n(record.timings?.clickToRequestDispatchMs), clickToTerminalMs: n(record.timings?.clickToTerminalMs), firstMutationMs: n(record.timings?.firstMutationMs), lastMutationMs: n(record.timings?.lastMutationMs) },
      mutatedUnitCount: Number.isSafeInteger(record.mutatedUnitCount) ? record.mutatedUnitCount : null,
      terminalStatus: ["successful", "partial", "failed", "cancelled"].includes(record.terminalStatus) ? record.terminalStatus : null,
      metadata: {
        adapterResolved: {
          provider: safeText(record.metadata?.adapterResolved?.provider ?? record.metadata?.runtime?.provider),
          extractionMode: ["V2", "V3"].includes(String(record.metadata?.adapterResolved?.extractionMode ?? record.metadata?.runtime?.extractionMode).toUpperCase())
            ? String(record.metadata?.adapterResolved?.extractionMode ?? record.metadata?.runtime?.extractionMode).toUpperCase() : null,
          sourceLanguage: safeText(record.metadata?.adapterResolved?.sourceLanguage ?? record.metadata?.runtime?.sourceLanguage),
          targetLanguage: safeText(record.metadata?.adapterResolved?.targetLanguage ?? record.metadata?.runtime?.targetLanguage),
        },
        providerConfirmed: { status: "not-observed", provider: null, model: null },
        configured: {
          provider: safeText(record.metadata?.configured?.provider),
          model: safeModel(record.metadata?.configured?.model),
          optimizationLevel: Number.isInteger(record.metadata?.configured?.optimizationLevel)
            && record.metadata.configured.optimizationLevel >= 1 && record.metadata.configured.optimizationLevel <= 5
            ? record.metadata.configured.optimizationLevel : null,
          sourceLanguage: safeText(record.metadata?.configured?.sourceLanguage),
          targetLanguage: safeText(record.metadata?.configured?.targetLanguage),
          aiContext: typeof record.metadata?.configured?.aiContext === "boolean" ? record.metadata.configured.aiContext : null,
          conversationHistory: typeof record.metadata?.configured?.conversationHistory === "boolean" ? record.metadata.configured.conversationHistory : null,
          translationFont: typeof record.metadata?.configured?.translationFont === "boolean" ? record.metadata.configured.translationFont : null,
          extensionVersion: safeText(record.metadata?.configured?.extensionVersion),
          capturePhase: ["before-measurement", "after-measurement"].includes(record.metadata?.configured?.capturePhase)
            ? record.metadata.configured.capturePhase : null,
        },
      },
    };
  }
  function safeText(value) { return typeof value === "string" && /^[\w .:/+-]{1,80}$/.test(value) ? value : null; }
  function safeModel(value) {
    const model = safeText(value);
    return model && !/(?:https?:\/\/|www\.|:\/\/|api[_ -]?key|token|secret|password|bearer|\bsk-(?:proj-)?[a-z0-9_-]{8,}\b|(?:^|[\s/])(?:[a-z0-9-]+\.)+[a-z]{2,}(?:[/:?#]|$))/i.test(model) ? model : null;
  }
  function load() {
    try {
      const stored = JSON.parse(localStorage.getItem(KEY) || "[]");
      const normalized = Array.isArray(stored) ? stored.filter((r) => r && typeof r === "object").map(clean) : [];
      localStorage.setItem(KEY, JSON.stringify(normalized));
      return normalized;
    } catch { return []; }
  }
  function save() { try { localStorage.setItem(KEY, JSON.stringify(records)); } catch { /* Storage may be disabled. */ } }
  function captureConfigured(record, phase, trialId = active?.trialId) {
    record.metadata.configured.capturePhase = phase;
    save();
    pendingMetadata = { trialId, phase, record };
    pendingMetadata.timeout = setTimeout(() => {
      if (!pendingMetadata || pendingMetadata.trialId !== trialId) return;
      if (phase === "before-measurement" && active) {
        active.record.status = "incomplete";
        active.record.endTimestamp = new Date().toISOString();
        const timedOutRecord = clean(active.record);
        records.push(timedOutRecord);
        pendingMetadata.record = timedOutRecord;
        active = null;
        save();
        render();
        ["fixture-choice", "trial-label", "trial-type"].forEach((id) => { document.getElementById(id).disabled = true; });
      }
      document.getElementById("trial-state").textContent = "Metadata read timed out; waiting for it to settle. Reload the extension if it never does.";
    }, METADATA_TIMEOUT_MS);
    document.dispatchEvent(new CustomEvent("translate-it:select-element-benchmark:metadata-request", {
      detail: JSON.stringify({ trialId: pendingMetadata.trialId, capturePhase: phase }),
    }));
  }
  function serializeResults() {
    return JSON.stringify({ schemaVersion: 4, exportedAt: new Date().toISOString(), metadataOnly: true, trials: records.map(clean) }, null, 2);
  }
  function formatMs(value) { return Number.isFinite(value) ? `${value.toFixed(1)} ms` : "—"; }
  function render() {
    const output = document.getElementById("results");
    output.replaceChildren();
    const configurations = new Map();
    for (const record of records) {
      const comparableSettings = { ...record.metadata.configured };
      delete comparableSettings.extensionVersion;
      const key = JSON.stringify({
        runtimeProvider: record.metadata?.adapterResolved?.provider ?? null,
        runtimeSourceLanguage: record.metadata?.adapterResolved?.sourceLanguage ?? null,
        runtimeTargetLanguage: record.metadata?.adapterResolved?.targetLanguage ?? null,
        model: record.metadata?.configured?.model ?? null,
        extractionMode: record.metadata?.adapterResolved?.extractionMode ?? null,
        optimizationLevel: record.metadata?.configured?.optimizationLevel ?? null,
        configured: comparableSettings,
        trialType: record.trialType ?? "unknown",
      });
      if (!configurations.has(key)) configurations.set(key, { key, records: [], record });
      configurations.get(key).records.push(record);
    }
    for (const configuration of configurations.values()) for (const name of Object.keys(counts)) {
      const section = document.createElement("section");
      const heading = document.createElement("div");
      heading.className = "fixture-heading";
      const fixtureName = document.createElement("strong");
      fixtureName.textContent = name;
      const meta = configuration.record.metadata;
      const model = meta.configured.model ?? "unknown model";
      const provider = meta.adapterResolved.provider ?? meta.configured.provider ?? "unknown provider";
      const mode = meta.adapterResolved.extractionMode ?? "unknown mode";
      const level = meta.configured.optimizationLevel == null ? "unknown level" : `level ${meta.configured.optimizationLevel}`;
      const headingText = document.createElement("p");
      headingText.className = "configuration-heading";
      headingText.textContent = `${provider} · ${model} · ${mode} · ${level} · ${configuration.record.trialType}`;
      section.append(headingText);
      heading.append(fixtureName);
      section.append(heading);
      for (const label of ["baseline", "candidate"]) {
        const record = [...configuration.records].reverse().find((item) => item.fixture === name && item.label === label);
        const row = document.createElement("div");
        row.className = `metric-row ${label}`;
        const title = document.createElement("strong");
        title.textContent = `${label}: ${record ? record.status : "no trial"}`;
        row.append(title);
        if (record) {
          const metrics = document.createElement("dl");
          metrics.className = "metric-values";
          const addMetric = (name, value) => {
            const term = document.createElement("dt");
            term.textContent = name;
            const detail = document.createElement("dd");
            detail.textContent = value;
            metrics.append(term, detail);
          };
          addMetric("Fixture units", `${record.logicalParentCount ?? "—"} parents / ${record.textNodeCount ?? "—"} text nodes`);
          addMetric("Processing", formatMs(record.timings.selectionClickMs));
          addMetric("Dispatch", formatMs(record.timings.clickToRequestDispatchMs));
          addMetric("Click to terminal", formatMs(record.timings.clickToTerminalMs));
          addMetric("First mutation", formatMs(record.timings.firstMutationMs));
          addMetric("Last mutation", formatMs(record.timings.lastMutationMs));
          addMetric("Changed parents", `${record.mutatedUnitCount ?? "—"}`);
          addMetric("Terminal status", record.terminalStatus ?? "—");
          row.append(metrics);
        } else {
          const empty = document.createElement("span");
          empty.textContent = "No trial recorded";
          row.append(empty);
        }
        section.append(row);
      }
      output.append(section);
    }
  }
  function finish(status) {
    if (!active) return;
    active.record.status = status;
    active.record.endTimestamp = new Date().toISOString();
    records.push(clean(active.record));
    const completed = records.at(-1);
    const cold = active.record.trialType === "cold" && active.record.terminalStatus !== null;
    const trialId = active.trialId;
    save();
    active = null;
    document.getElementById("trial-state").textContent = `Recorded ${status}`;
    document.getElementById("fixture-choice").disabled = cold || Boolean(pendingMetadata);
    document.getElementById("trial-label").disabled = cold || Boolean(pendingMetadata);
    document.getElementById("trial-type").disabled = cold || Boolean(pendingMetadata);
    document.getElementById("start-trial").disabled = cold || Boolean(pendingMetadata);
    render();
    if (cold) captureConfigured(completed, "after-measurement", trialId);
  }
  document.getElementById("fixture-choice").addEventListener("change", (e) => { if (!active) buildFixture(e.target.value); });
  document.getElementById("start-trial").addEventListener("click", () => {
    if (active || pendingMetadata) return;
    const name = document.getElementById("fixture-choice").value;
    buildFixture(name);
    observer.takeRecords();
    const root = document.querySelector("#fixture-root");
    const trialId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    root.setAttribute("data-translate-it-live-benchmark-root", "true");
    root.setAttribute("data-translate-it-live-benchmark-trial", trialId);
    const parents = [...document.querySelectorAll("#fixture-root > p")];
    active = {
      start: null, trialId, metadataReady: document.getElementById("trial-type").value === "cold", parents, originals: new Map(parents.map((parent) => [parent, parent.textContent])),
      record: { label: document.getElementById("trial-label").value, trialType: document.getElementById("trial-type").value, metadata: { runtime: {}, configured: {} }, fixture: name, logicalParentCount: counts[name].logicalParentCount, textNodeCount: counts[name].textNodeCount, timestamp: new Date().toISOString(), status: "incomplete", timings: {}, mutatedUnitCount: 0, terminalStatus: null },
    };
    const isCold = active.record.trialType === "cold";
    document.getElementById("fixture-choice").disabled = true;
    document.getElementById("trial-label").disabled = true;
    document.getElementById("trial-type").disabled = true;
    document.getElementById("start-trial").disabled = true;
    if (isCold) {
      active.metadataReady = true;
      document.getElementById("trial-state").textContent = "Ready; activate Select Element, then click the fixture root padding";
    } else {
      document.getElementById("trial-state").textContent = "Collecting configuration metadata before measurement";
      captureConfigured(active.record, "before-measurement");
    }
  });
  document.addEventListener(probeEvents.accepted, (event) => {
    if (!active || !active.metadataReady || active.start !== null) return;
    let detail;
    try { detail = JSON.parse(event.detail); } catch { return; }
    if (detail.trialId !== active.trialId || !Number.isFinite(detail.clickTimeStamp)) return;
    active.start = detail.clickTimeStamp;
    active.record.timings.selectionClickMs = Math.max(0, detail.acceptedAt - detail.clickTimeStamp);
    active.record.timings.clickToRequestDispatchMs = null;
    document.getElementById("trial-state").textContent = "Selection accepted; measuring extension request dispatch";
  });
  document.addEventListener(probeEvents.metadata, (event) => {
    if (!active) return;
    try {
      const data = JSON.parse(event.detail);
      if (data.trialId !== active.trialId) return;
      active.record.metadata.adapterResolved = {
        provider: safeText(data.provider),
        extractionMode: ["V2", "V3"].includes(String(data.extractionMode).toUpperCase())
          ? String(data.extractionMode).toUpperCase() : null,
        sourceLanguage: safeText(data.sourceLanguage),
        targetLanguage: safeText(data.targetLanguage),
      };
    } catch { /* Ignore malformed development probe data. */ }
  });
  document.addEventListener(probeEvents.configured, (event) => {
    if (!pendingMetadata) return;
    try {
      const data = JSON.parse(event.detail);
      if (data.trialId !== pendingMetadata.trialId || data.capturePhase !== pendingMetadata.phase) return;
      clearTimeout(pendingMetadata.timeout);
      const target = pendingMetadata.record;
      target.metadata.configured = Object.fromEntries(
        ["provider", "model", "optimizationLevel", "sourceLanguage", "targetLanguage", "extensionVersion"]
          .map((key) => [key, key === "optimizationLevel"
            ? (Number.isInteger(data[key]) && data[key] >= 1 && data[key] <= 5 ? data[key] : null)
            : key === "model" ? safeModel(data[key]) : safeText(data[key])]),
      );
      for (const key of ["aiContext", "conversationHistory", "translationFont"])
        target.metadata.configured[key] = typeof data[key] === "boolean" ? data[key] : null;
      target.metadata.configured.capturePhase = pendingMetadata.phase;
      const wasActive = active?.trialId === pendingMetadata.trialId;
      pendingMetadata = null;
      save();
      render();
      if (wasActive) {
        active.metadataReady = true;
        document.getElementById("trial-state").textContent = "Metadata ready; activate Select Element, then click the fixture root padding";
      } else {
        ["fixture-choice", "trial-label", "trial-type"].forEach((id) => { document.getElementById(id).disabled = false; });
        document.getElementById("start-trial").disabled = false;
        document.getElementById("trial-state").textContent = "Metadata settled; retry is available";
      }
    } catch { /* Ignore malformed development probe data. */ }
  });
  document.addEventListener("translate-it:select-element-benchmark:extension-ready", () => {
    if (!pendingMetadata) return;
    clearTimeout(pendingMetadata.timeout);
    pendingMetadata = null;
    if (active) {
      active.record.status = "incomplete";
      active.record.endTimestamp = new Date().toISOString();
      records.push(clean(active.record));
      active = null;
      save();
      render();
    }
    ["fixture-choice", "trial-label", "trial-type"].forEach((id) => { document.getElementById(id).disabled = false; });
    document.getElementById("start-trial").disabled = false;
    document.getElementById("trial-state").textContent = "Extension reloaded; retry is available";
  });
  document.addEventListener(probeEvents.dispatch, (event) => {
    if (!active || active.start === null || active.record.timings.clickToRequestDispatchMs != null) return;
    try {
      const { at, trialId } = JSON.parse(event.detail);
      if (trialId !== active.trialId) return;
      if (Number.isFinite(at)) active.record.timings.clickToRequestDispatchMs = Math.max(0, at - active.start);
    } catch { /* Ignore malformed development probe data. */ }
  });
  document.addEventListener(probeEvents.terminal, (event) => {
    if (!active || active.start === null || active.record.terminalStatus !== null) return;
    try {
      const { at, status, trialId } = JSON.parse(event.detail);
      if (trialId !== active.trialId) return;
      if (!["successful", "partial", "failed", "cancelled"].includes(status)) return;
      active.record.terminalStatus = status;
      if (Number.isFinite(at)) active.record.timings.clickToTerminalMs = Math.max(0, at - active.start);
    } catch { /* Ignore malformed development probe data. */ }
  });
  const observer = new MutationObserver((mutations) => {
    if (!active || active.start === null) return;
    const affected = new Set();
    for (const mutation of mutations) {
      const target = mutation.target.nodeType === Node.TEXT_NODE ? mutation.target.parentElement : mutation.target;
      const parent = target?.closest?.("#fixture-root > p");
      if (parent && active.originals.has(parent)) affected.add(parent);
    }
    const changed = [...affected].filter((parent) => parent.isConnected && parent.textContent !== active.originals.get(parent));
    if (!changed.length) return;
    const elapsed = Math.max(0, performance.now() - active.start);
    if (active.record.timings.firstMutationMs == null) active.record.timings.firstMutationMs = elapsed;
    active.record.timings.lastMutationMs = elapsed;
    active.record.mutatedUnitCount = active.parents.filter((parent) => parent.isConnected && parent.textContent !== active.originals.get(parent)).length;
  });
  observer.observe(fixture, { subtree: true, childList: true, characterData: true });
  document.getElementById("finish-trial").addEventListener("click", () => {
    const status = document.getElementById("outcome").value;
    if (active && status) finish(status);
  });
  document.getElementById("export").addEventListener("click", () => {
    const blob = new Blob([serializeResults()], { type: "application/json" });
    const link = document.createElement("a"); link.href = URL.createObjectURL(blob); link.download = "select-element-benchmark.json"; link.click(); setTimeout(() => URL.revokeObjectURL(link.href), 0);
  });
  document.getElementById("copy").addEventListener("click", async () => {
    const feedback = document.getElementById("copy-feedback");
    try {
      if (typeof navigator.clipboard?.writeText !== "function") throw new Error("Clipboard API unavailable");
      await navigator.clipboard.writeText(serializeResults());
      feedback.textContent = "Copied results to clipboard.";
    } catch {
      feedback.textContent = "Copy failed: clipboard unavailable or permission denied.";
    }
  });
  document.getElementById("clear").addEventListener("click", () => { if (confirm("Clear all saved results?")) { records = []; save(); render(); } });
  window.addEventListener("pagehide", () => finish("incomplete"));
  buildFixture(document.getElementById("fixture-choice").value);
  render();
})();
