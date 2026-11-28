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
  const probeEvents = {
    accepted: "translate-it:select-element-benchmark:accepted-click",
    dispatch: "translate-it:select-element-benchmark:request-dispatch",
    terminal: "translate-it:select-element-benchmark:operation-terminal",
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
      fixture: Object.hasOwn(counts, record.fixture) ? record.fixture : null,
      logicalParentCount: Number.isSafeInteger(record.logicalParentCount) ? record.logicalParentCount : null,
      textNodeCount: Number.isSafeInteger(record.textNodeCount) ? record.textNodeCount : null,
      timestamp: iso(record.timestamp), endTimestamp: iso(record.endTimestamp),
      status: ["successful", "partial", "failed", "cancelled", "incomplete"].includes(record.status) ? record.status : "incomplete",
      timings: { selectionClickMs: n(record.timings?.selectionClickMs), clickToRequestDispatchMs: n(record.timings?.clickToRequestDispatchMs), clickToTerminalMs: n(record.timings?.clickToTerminalMs), firstMutationMs: n(record.timings?.firstMutationMs), lastMutationMs: n(record.timings?.lastMutationMs) },
      mutatedUnitCount: Number.isSafeInteger(record.mutatedUnitCount) ? record.mutatedUnitCount : null,
      terminalStatus: ["successful", "partial", "failed", "cancelled"].includes(record.terminalStatus) ? record.terminalStatus : null,
    };
  }
  function load() {
    try {
      const stored = JSON.parse(localStorage.getItem(KEY) || "[]");
      return Array.isArray(stored) ? stored.filter((r) => r && typeof r === "object").map(clean) : [];
    } catch { return []; }
  }
  function save() { try { localStorage.setItem(KEY, JSON.stringify(records)); } catch { /* Storage may be disabled. */ } }
  function serializeResults() {
    return JSON.stringify({ schemaVersion: 2, exportedAt: new Date().toISOString(), metadataOnly: true, trials: records.map(clean) }, null, 2);
  }
  function formatMs(value) { return Number.isFinite(value) ? `${value.toFixed(1)} ms` : "—"; }
  function render() {
    const output = document.getElementById("results");
    output.replaceChildren();
    for (const name of Object.keys(counts)) {
      const section = document.createElement("section");
      const heading = document.createElement("div");
      heading.className = "fixture-heading";
      const fixtureName = document.createElement("strong");
      fixtureName.textContent = name;
      heading.append(fixtureName);
      section.append(heading);
      for (const label of ["baseline", "candidate"]) {
        const record = [...records].reverse().find((item) => item.fixture === name && item.label === label);
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
    save();
    active = null;
    document.getElementById("trial-state").textContent = `Recorded ${status}`;
    document.getElementById("fixture-choice").disabled = false;
    document.getElementById("trial-label").disabled = false;
    document.getElementById("start-trial").disabled = false;
    render();
  }
  document.getElementById("fixture-choice").addEventListener("change", (e) => { if (!active) buildFixture(e.target.value); });
  document.getElementById("start-trial").addEventListener("click", () => {
    if (active) finish("incomplete");
    const name = document.getElementById("fixture-choice").value;
    buildFixture(name);
    observer.takeRecords();
    const root = document.querySelector("#fixture-root");
    const trialId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    root.setAttribute("data-translate-it-live-benchmark-root", "true");
    root.setAttribute("data-translate-it-live-benchmark-trial", trialId);
    const parents = [...document.querySelectorAll("#fixture-root > p")];
    active = {
      start: null, trialId, parents, originals: new Map(parents.map((parent) => [parent, parent.textContent])),
      record: { label: document.getElementById("trial-label").value, fixture: name, logicalParentCount: counts[name].logicalParentCount, textNodeCount: counts[name].textNodeCount, timestamp: new Date().toISOString(), status: "incomplete", timings: {}, mutatedUnitCount: 0, terminalStatus: null },
    };
    document.getElementById("fixture-choice").disabled = true;
    document.getElementById("trial-label").disabled = true;
    document.getElementById("start-trial").disabled = true;
    document.getElementById("trial-state").textContent = "Armed; activate Select Element, then click the fixture root padding";
  });
  document.addEventListener(probeEvents.accepted, (event) => {
    if (!active || active.start !== null) return;
    let detail;
    try { detail = JSON.parse(event.detail); } catch { return; }
    if (detail.trialId !== active.trialId || !Number.isFinite(detail.clickTimeStamp)) return;
    active.start = detail.clickTimeStamp;
    active.record.timings.selectionClickMs = Math.max(0, detail.acceptedAt - detail.clickTimeStamp);
    active.record.timings.clickToRequestDispatchMs = null;
    document.getElementById("trial-state").textContent = "Selection accepted; measuring extension request dispatch";
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
