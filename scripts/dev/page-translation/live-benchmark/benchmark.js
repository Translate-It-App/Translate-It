(() => {
  "use strict";
  const STORAGE_KEY = "translate-it-page-translation-ab-results-v1";
  const params = new URLSearchParams(location.search);
  const targetCount = params.get("targets") === "600" ? 600 : 120;
  const fixture = document.getElementById("target-fixture");
  for (let index = 121; index <= targetCount; index++) {
    const paragraph = document.createElement("p");
    paragraph.dataset.item = String(index);
    paragraph.textContent = `The research team evaluates regional planning scenario ${index} to improve long-term community services.`;
    fixture.append(paragraph);
  }
  const TARGETS = [...document.querySelectorAll("p[data-item]")];
  const originals = new Map(TARGETS.map((p) => [p, p.textContent]));
  document.querySelectorAll("[data-target-count]").forEach((element) => {
    element.textContent = String(TARGETS.length);
  });
  function normalizeVariant(value) {
    return typeof value === "string" &&
      /^[A-Za-z0-9_-]{1,64}$/.test(value) &&
      /[A-Za-z0-9]/.test(value)
      ? value.toUpperCase()
      : null;
  }
  const variant = normalizeVariant(params.get("variant"));
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
  function updateLatest(label, status, record = null) {
    const el = document.getElementById("ti-ab-latest");
    el.querySelector("[data-latest-status]").textContent = label;
    el.dataset.status = status || "";
    const metrics = {
      firstAccepted: record?.timings?.firstAcceptedMs,
      firstVisible: record?.timings?.firstVisibleMs,
      allTargets: record?.timings?.allTargetsMs,
      complete: record?.timings?.completeMs,
    };
    for (const [key, value] of Object.entries(metrics)) {
      el.querySelector(`[data-latest="${key}"]`).textContent = fmt(value);
    }
    el.querySelector("[data-latest-build]").textContent = record
      ? (record.variant ?? "not set")
      : "—";
    el.querySelector("[data-latest-level]").textContent = record
      ? (record.level ?? "not set")
      : "—";
    el.querySelector("[data-latest-target-count]").textContent =
      record?.correctness?.targetCount ?? "—";
    el.querySelector("[data-latest-reason]").textContent =
      latestFailureReason(record);
  }
  function latestFailureReason(record) {
    if (!record) return "";
    if (record.cancellation === "cancelled") return "Cancelled";
    if (record.interruption?.reason === "superseded_by_new_start")
      return "Interrupted (new translation started)";
    if (record.interruption?.reason === "page unloaded before a terminal event")
      return "Interrupted (page unloaded)";
    if (record.correctness?.initialPageClean === false)
      return "Initial page DOM is not clean";
    if (
      record.errors?.some(
        (error) =>
          error &&
          ["page-translate-error", "page-translation-internal-error"].includes(
            error.type,
          ),
      )
    )
      return "Translation error";
    if (record.errors?.length) return "Translation failures reported";
    return record.status === "failed" ? "Translation incomplete" : "";
  }
  function render() {
    const labels = document.getElementById("ti-ab-label");
    labels.querySelector('[data-value="build"]').textContent =
      variant || "not set";
    labels.querySelector('[data-value="level"]').textContent =
      level ?? "not set";
    const passed = records.filter((r) => r.status === "passed").length;
    const counts = document.getElementById("ti-ab-counts");
    counts.querySelector('[data-count="trials"]').textContent = records.length;
    counts.querySelector('[data-count="passed"]').textContent = passed;
    counts.querySelector('[data-count="failed"]').textContent =
      records.length - passed;
    const latest = records.at(-1);
    if (latest)
      updateLatest(
        latest.status === "passed" ? "Passed" : "Failed",
        latest.status,
        latest,
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
      variant: normalizeVariant(record.variant),
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
  function serializeResults() {
    return JSON.stringify(
      {
        schemaVersion: 1,
        exportedAt: new Date().toISOString(),
        metadataOnly: true,
        trials: records.map(exportRecord),
      },
      null,
      2,
    );
  }
  let copyFeedbackTimer;
  function showCopyFeedback(message, isError = false) {
    const feedback = document.getElementById("ti-ab-copy-feedback");
    feedback.textContent = message;
    feedback.dataset.status = isError ? "error" : "success";
    clearTimeout(copyFeedbackTimer);
    copyFeedbackTimer = setTimeout(() => {
      feedback.textContent = "";
      feedback.dataset.status = "";
    }, 1800);
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
      finish("failed");
    }
    const initialTranslatedCount = translatedParagraphs().length;
    const initialPageClean =
      TARGETS.length === targetCount &&
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
      finish("failed");
      return;
    }
    updateLatest("Running", "running", active.record);
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
  function finish(status) {
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
    const detail = event.detail || {};
    addError("page-translate-error", detail);
    if (detail.isFatal !== false) finish("failed");
  });
  window.addEventListener("page-translation-internal-error", (event) => {
    if (!matchesActive(event)) return;
    addError("page-translation-internal-error", event.detail);
  });
  window.addEventListener("page-translate-cancelled", (event) => {
    if (!matchesActive(event)) return;
    active.record.cancellation = "cancelled";
    finish("failed");
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
    const blob = new Blob([serializeResults()], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "page-translation-ab-results.json";
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  });
  document.getElementById("ti-ab-copy").addEventListener("click", async () => {
    try {
      if (typeof navigator.clipboard?.writeText !== "function")
        throw new Error("Clipboard API unavailable");
      await navigator.clipboard.writeText(serializeResults());
      showCopyFeedback("Copied results to clipboard.");
    } catch {
      showCopyFeedback(
        "Copy failed: clipboard unavailable or permission denied.",
        true,
      );
    }
  });
  document.getElementById("ti-ab-clear").addEventListener("click", () => {
    if (!confirm("Clear all saved Page Translation A/B results?")) return;
    records = [];
    save();
    updateLatest("Waiting for Page Translation START", "");
    render();
  });
  render();
})();
