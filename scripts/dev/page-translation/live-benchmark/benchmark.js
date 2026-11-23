(() => {
  "use strict";
  const STORAGE_KEY = "translate-it-page-translation-ab-results-v1";
  const TARGETS = [...document.querySelectorAll("p[data-item]")];
  const originals = new Map(TARGETS.map((p) => [p, p.textContent]));
  const params = new URLSearchParams(location.search);
  const variantValue = (params.get("variant") || "").toUpperCase();
  const variant = /^[A-F]$/.test(variantValue) ? variantValue : null;
  const levelValue = Number(params.get("level"));
  const level =
    Number.isInteger(levelValue) && levelValue >= 1 && levelValue <= 5
      ? levelValue
      : null;
  let active = null;
  const seenSessions = new Set();
  let records = load();

  function load() {
    try {
      const value = JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
      return Array.isArray(value)
        ? value
            .filter(
              (record) =>
                record && typeof record === "object" && !Array.isArray(record),
            )
            .map(exportRecord)
        : [];
    } catch {
      return [];
    }
  }
  function save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(records));
    } catch {
      console.warn("[Page benchmark] Could not persist results.");
    }
  }
  function translatedParagraphs() {
    return TARGETS.filter((p) => {
      const text = p.textContent.trim();
      return text && text !== originals.get(p).trim();
    });
  }
  function elapsed() {
    return active ? Math.max(0, performance.now() - active.startClock) : null;
  }
  function countTranslated() {
    if (!active) return;
    const count = translatedParagraphs().length;
    if (count && active.timings.firstAcceptedMs == null)
      active.timings.firstAcceptedMs = elapsed();
    if (count === TARGETS.length && active.timings.allTargetsMs == null)
      active.timings.allTargetsMs = elapsed();
  }
  function isVisible(element) {
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return (
      style.visibility !== "hidden" &&
      style.display !== "none" &&
      Number(style.opacity) !== 0 &&
      rect.width > 0 &&
      rect.height > 0 &&
      rect.bottom > 0 &&
      rect.right > 0 &&
      rect.top < innerHeight &&
      rect.left < innerWidth
    );
  }
  function updateLatest(text, status) {
    const el = document.getElementById("ti-ab-latest");
    el.textContent = text;
    el.dataset.status = status || "";
  }
  function render() {
    document.getElementById("ti-ab-label").textContent =
      `Selected Build: ${variant || "not set"} · Optimization Level: ${level ?? "not set"} (URL labels only; does not configure the extension)`;
    const passed = records.filter((r) => r.status === "passed").length;
    document.getElementById("ti-ab-counts").textContent =
      `Trials: ${records.length} · Passed: ${passed} · Failed: ${records.length - passed}`;
    const latest = records.at(-1);
    if (latest)
      updateLatest(
        `${latest.status} · ${latest.variant ?? "?"} L${latest.level ?? "?"} · first ${fmt(latest.timings.firstAcceptedMs)} · visible ${fmt(latest.timings.firstVisibleMs)} · all 120 ${fmt(latest.timings.allTargetsMs)} · complete ${fmt(latest.timings.completeMs)}`,
        latest.status,
      );
  }
  function fmt(value) {
    return value == null ? "—" : `${Math.round(value)} ms`;
  }
  function exportRecord(record) {
    const metric = (value) =>
      Number.isFinite(value) && value >= 0 ? value : null;
    const timestamp = (value) =>
      typeof value === "string" && Number.isFinite(Date.parse(value))
        ? new Date(value).toISOString()
        : null;
    const allowedErrors = new Set([
      "page-translate-progress",
      "page-translate-complete",
      "page-translate-error",
      "page-translation-internal-error",
    ]);
    return {
      variant: /^[A-F]$/.test(record.variant) ? record.variant : null,
      level:
        Number.isInteger(record.level) && record.level >= 1 && record.level <= 5
          ? record.level
          : null,
      timestamp: timestamp(record.timestamp),
      endTimestamp: timestamp(record.endTimestamp),
      status: record.status === "passed" ? "passed" : "failed",
      timings: Object.fromEntries(
        [
          "startMs",
          "firstAcceptedMs",
          "firstVisibleMs",
          "allTargetsMs",
          "completeMs",
        ].map((key) => [key, metric(record.timings?.[key])]),
      ),
      correctness: {
        targetCount: metric(record.correctness?.targetCount),
        translatedCount: metric(record.correctness?.translatedCount),
        allTargetsTranslated: record.correctness?.allTargetsTranslated === true,
        completionObserved: record.correctness?.completionObserved === true,
        initialPageClean: record.correctness?.initialPageClean === true,
      },
      errors: Array.isArray(record.errors)
        ? record.errors
            .filter((error) => error && allowedErrors.has(error.type))
            .map((error) => ({
              type: error.type,
              atMs: metric(error.atMs),
              failedCount: Number.isSafeInteger(error.failedCount)
                ? error.failedCount
                : null,
            }))
        : [],
      cancellation: record.cancellation === "cancelled" ? "cancelled" : null,
      interruption: [
        "page unloaded before a terminal event",
        "superseded_by_new_start",
      ].includes(record.interruption?.reason)
        ? {
            reason: record.interruption.reason,
            atMs: metric(record.interruption.atMs),
          }
        : null,
    };
  }
  function start(event) {
    const detail = event.detail || {};
    const id = detail.sessionId;
    if (typeof id !== "string" || !id) return;
    if (seenSessions.has(id)) return;
    seenSessions.add(id);
    if (active) {
      active.record.interruption = {
        reason: "superseded_by_new_start",
        atMs: elapsed(),
      };
      finish("failed", "superseded by a new Page Translation START");
    }
    const initialTranslatedCount = translatedParagraphs().length;
    const initialPageClean =
      TARGETS.length === 120 &&
      TARGETS.every((p) => p.textContent === originals.get(p));
    const initiallyVisibleTargets = new Set(TARGETS.filter(isVisible));
    active = {
      sessionId: id,
      initiallyVisibleTargets,
      startClock: performance.now(),
      record: {
        variant,
        level,
        timestamp: new Date().toISOString(),
        status: "incomplete",
        timings: {
          startMs: 0,
          firstAcceptedMs: null,
          firstVisibleMs: null,
          allTargetsMs: null,
          completeMs: null,
        },
        correctness: {
          targetCount: TARGETS.length,
          translatedCount: initialTranslatedCount,
          allTargetsTranslated: false,
          completionObserved: false,
          initialPageClean,
        },
        errors: [],
        cancellation: null,
        interruption: null,
      },
      timings: {
        firstAcceptedMs: null,
        firstVisibleMs: null,
        allTargetsMs: null,
      },
    };
    if (!initialPageClean) {
      finish("failed", "initial page DOM is not clean");
      return;
    }
    updateLatest(
      `Running · ${variant || "?"} L${level ?? "?"} · START observed`,
      "running",
    );
  }
  function matchesActive(event) {
    return Boolean(active && event.detail?.sessionId === active.sessionId);
  }
  function addError(type, detail) {
    active.record.errors.push({
      type,
      atMs: elapsed(),
      failedCount: Number.isSafeInteger(detail?.failedCount)
        ? detail.failedCount
        : null,
    });
  }
  function finish(status, reason) {
    if (!active) return;
    if (active.record.correctness.initialPageClean) countTranslated();
    active.record.timings = {
      ...active.timings,
      startMs: 0,
      completeMs: active.record.timings.completeMs,
    };
    active.record.correctness.translatedCount = translatedParagraphs().length;
    active.record.correctness.allTargetsTranslated =
      active.record.correctness.translatedCount === TARGETS.length;
    active.record.status =
      status === "passed" &&
      active.record.correctness.initialPageClean &&
      active.record.correctness.allTargetsTranslated &&
      active.record.correctness.completionObserved &&
      active.record.errors.length === 0
        ? "passed"
        : "failed";
    active.record.endTimestamp = new Date().toISOString();
    records.push(active.record);
    save();
    updateLatest(
      `${active.record.status} · ${variant || "?"} L${level ?? "?"} · first ${fmt(active.timings.firstAcceptedMs)} · visible ${fmt(active.timings.firstVisibleMs)} · all 120 ${fmt(active.timings.allTargetsMs)} · complete ${fmt(active.record.timings.completeMs)}${reason ? ` · ${reason}` : ""}`,
      active.record.status,
    );
    active = null;
    render();
  }
  window.addEventListener("page-translate-start", start);
  window.addEventListener("page-translate-progress", (event) => {
    if (!matchesActive(event)) return;
    const detail = event.detail || {};
    if (detail.failedCount > 0)
      addError("page-translate-progress", {
        message: `${detail.failedCount} translation item(s) failed`,
        failedCount: detail.failedCount,
      });
  });
  window.addEventListener("page-translate-complete", (event) => {
    if (!matchesActive(event)) return;
    const detail = event.detail || {};
    active.record.correctness.completionObserved = true;
    active.record.timings.completeMs = elapsed();
    if (detail.failedCount > 0)
      addError("page-translate-complete", {
        message: `${detail.failedCount} translation item(s) failed`,
        failedCount: detail.failedCount,
      });
    countTranslated();
    finish("passed");
  });
  window.addEventListener("page-translate-error", (event) => {
    if (!matchesActive(event)) return;
    addError("page-translate-error", event.detail);
    finish("failed", "translation error");
  });
  window.addEventListener("page-translation-internal-error", (event) => {
    if (!matchesActive(event)) return;
    addError("page-translation-internal-error", event.detail);
  });
  window.addEventListener("page-translate-cancelled", (event) => {
    if (!matchesActive(event)) return;
    active.record.cancellation = "cancelled";
    finish("failed", "cancelled");
  });
  function persistInterruptedTrial() {
    if (!active) return;
    active.record.interruption = {
      reason: "page unloaded before a terminal event",
      atMs: elapsed(),
    };
    finish("failed");
  }
  window.addEventListener("pagehide", persistInterruptedTrial);
  window.addEventListener("beforeunload", persistInterruptedTrial);
  const observer = new MutationObserver((mutations) => {
    if (!active) return;
    const affected = new Set();
    for (const mutation of mutations) {
      const target =
        mutation.target.nodeType === Node.ELEMENT_NODE
          ? mutation.target
          : mutation.target.parentElement;
      const paragraph = target?.closest?.("p[data-item]");
      if (paragraph) affected.add(paragraph);
      for (const node of mutation.addedNodes || []) {
        if (node.nodeType !== Node.ELEMENT_NODE) continue;
        if (node.matches?.("p[data-item]")) affected.add(node);
        node.querySelectorAll?.("p[data-item]").forEach((p) => affected.add(p));
      }
    }
    for (const p of affected) {
      const text = p.textContent.trim();
      if (!text || text === originals.get(p)) continue;
      const now = elapsed();
      if (active.timings.firstAcceptedMs == null)
        active.timings.firstAcceptedMs = now;
      if (
        active.timings.firstVisibleMs == null &&
        active.initiallyVisibleTargets.has(p)
      )
        active.timings.firstVisibleMs = now;
    }
    countTranslated();
  });
  observer.observe(document.querySelector("main"), {
    subtree: true,
    childList: true,
    characterData: true,
  });
  document.getElementById("ti-ab-export").addEventListener("click", () => {
    const payload = {
      schemaVersion: 1,
      exportedAt: new Date().toISOString(),
      metadataOnly: true,
      trials: records.map(exportRecord),
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "page-translation-ab-results.json";
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  });
  document.getElementById("ti-ab-clear").addEventListener("click", () => {
    if (!confirm("Clear all saved Page Translation A/B results?")) return;
    records = [];
    save();
    updateLatest("Latest: waiting for Page Translation START", "");
    render();
  });
  render();
})();
