import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { URL as NodeURL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { JSDOM } from "jsdom";
import { startServer } from "./live-benchmark/serve.mjs";

const directory = new NodeURL("./live-benchmark/", import.meta.url);
const html = await readFile(new NodeURL("./index.html", directory), "utf8");
const script = await readFile(new NodeURL("./benchmark.js", directory), "utf8");
const storageKey = "translate-it-page-translation-ab-results-v1";
const pageHtml = html.replace(
  '<script src="./benchmark.js" defer></script>',
  `<script>${script}</script>`,
);

function createPage(
  url = "http://127.0.0.1/?variant=A&level=1",
  initialRecords = [],
) {
  return new JSDOM(pageHtml, {
    url,
    runScripts: "dangerously",
    beforeParse(window) {
      window.localStorage.setItem(storageKey, JSON.stringify(initialRecords));
      window.confirm = () => true;
      window.HTMLElement.prototype.getBoundingClientRect = () => ({
        width: 100,
        height: 20,
        top: 10,
        left: 10,
        right: 110,
        bottom: 30,
      });
    },
  });
}

const emit = (window, type, detail) =>
  window.dispatchEvent(new window.CustomEvent(type, { detail }));
const results = (window) => JSON.parse(window.localStorage.getItem(storageKey));
async function exportResults(window) {
  let blob;
  window.URL.createObjectURL = (value) => {
    blob = value;
    return "blob:benchmark";
  };
  window.URL.revokeObjectURL = () => {};
  window.document.getElementById("ti-ab-export").click();
  return new Promise((resolve, reject) => {
    const reader = new window.FileReader();
    reader.onload = () => resolve(JSON.parse(reader.result));
    reader.onerror = reject;
    reader.readAsText(blob);
  });
}
async function copyResults(window, writeText = vi.fn().mockResolvedValue()) {
  Object.defineProperty(window.navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });
  window.document.getElementById("ti-ab-copy").click();
  await new Promise((resolve) => window.setTimeout(resolve, 0));
  return writeText.mock.calls[0]?.[0];
}

describe("manual live Page Translation benchmark", () => {
  it("preserves the exact 120 original target paragraphs", () => {
    const dom = new JSDOM(html);
    const targets = [...dom.window.document.querySelectorAll("p[data-item]")];
    const text = targets.map((target) => target.textContent).join("");

    expect(targets).toHaveLength(120);
    expect(targets.map((target) => target.dataset.item)).toEqual(
      Array.from({ length: 120 }, (_, index) => String(index + 1)),
    );
    expect(targets.every((target) => !/[\r\n]/.test(target.textContent))).toBe(
      true,
    );
    expect(text).toHaveLength(15998);
    expect(createHash("sha256").update(text).digest("hex")).toBe(
      "5ba0ff3774bd66b70d81d63a6a0fccaaa44e1d0efa0fb597cd83a3343a81b97a",
    );
    dom.window.close();
  });

  it.each([
    ["G", "G"],
    ["V2", "V2"],
    ["BASELINE-2026", "BASELINE-2026"],
    ["baseline_2026", "BASELINE_2026"],
    ["", null],
    ["bad!", null],
    ["ß", null],
    ["---", null],
    ["A".repeat(65), null],
  ])("normalizes URL variant %j to %j", (input, expected) => {
    const dom = createPage(
      `http://127.0.0.1/?variant=${encodeURIComponent(input)}&level=1`,
    );
    const { window } = dom;
    emit(window, "page-translate-start", { sessionId: "variant" });
    emit(window, "page-translate-cancelled", {
      sessionId: "variant",
      reason: "cancelled",
    });
    expect(results(window)[0].variant).toBe(expected);
    dom.window.close();
  });

  it("keeps valid stored variants and sanitizes them consistently across storage, copy, and export", async () => {
    const storedVariants = [
      "A",
      "B",
      "C",
      "D",
      "E",
      "F",
      "V2",
      "BASELINE-2026",
      "lower_case",
      "invalid!",
      "",
      "X".repeat(65),
    ];
    const initialRecords = storedVariants.map((variant) => ({ variant }));
    const dom = createPage(
      "http://127.0.0.1/?variant=BASELINE-2026&level=1",
      initialRecords,
    );
    const { window } = dom;

    emit(window, "page-translate-start", { sessionId: "new-variant" });
    emit(window, "page-translate-cancelled", {
      sessionId: "new-variant",
      reason: "cancelled",
    });
    const expectedVariants = [
      ...storedVariants.slice(0, 8),
      "LOWER_CASE",
      null,
      null,
      null,
      "BASELINE-2026",
    ];
    const savedVariants = results(window).map((record) => record.variant);
    expect(savedVariants).toEqual(expectedVariants);

    const copied = JSON.parse(await copyResults(window));
    const exported = await exportResults(window);
    expect(copied.trials.map((record) => record.variant)).toEqual(
      expectedVariants,
    );
    expect(exported.trials.map((record) => record.variant)).toEqual(
      expectedVariants,
    );
    expect(copied.trials).toEqual(exported.trials);
    dom.window.close();
  });

  it("serves the fixture on loopback using an available port and closes cleanly", async () => {
    const fixture = await startServer();
    try {
      expect(new NodeURL(fixture.url).hostname).toBe("127.0.0.1");
      const response = await fetch(fixture.url);
      const page = await response.text();
      expect(response.status).toBe(200);
      expect((page.match(/data-item="/g) || []).length).toBe(120);
      expect(page).toContain('<script src="./benchmark.js" defer></script>');
      const scriptResponse = await fetch(
        new NodeURL("./benchmark.js", fixture.url),
      );
      expect(scriptResponse.status).toBe(200);
      expect(await scriptResponse.text()).toContain("page-translate-complete");
      expect(
        (await fetch(new NodeURL("../package.json", fixture.url))).status,
      ).toBe(404);
    } finally {
      await fixture.close();
    }
    expect(fixture.server.listening).toBe(false);
  });

  it("rejects stale events and records a simulated complete 120-target trial without API requests", async () => {
    const dom = createPage();
    const { window } = dom;
    expect(window.document.querySelectorAll("p[data-item]")).toHaveLength(120);
    emit(window, "page-translate-start", { sessionId: "current" });
    window.document.querySelectorAll("p[data-item]").forEach((p) => {
      p.textContent = `translated ${p.dataset.item}`;
    });
    await new Promise((resolve) => window.setTimeout(resolve, 0));

    emit(window, "page-translate-progress", {
      sessionId: "stale",
      failedCount: 1,
    });
    emit(window, "page-translate-error", {
      sessionId: "stale",
      message: "stale failure",
    });
    emit(window, "page-translate-complete", {
      sessionId: "stale",
      translatedCount: 120,
    });
    expect(results(window)).toHaveLength(0);
    expect(
      window.document.querySelector("[data-latest-status]").textContent,
    ).toBe("Running");

    emit(window, "page-translate-complete", {
      sessionId: "current",
      translatedCount: 120,
      failedCount: 0,
    });
    emit(window, "page-translate-complete", {
      sessionId: "current",
      translatedCount: 120,
      failedCount: 0,
    });
    expect(results(window)).toHaveLength(1);
    expect(results(window)[0]).toMatchObject({
      status: "passed",
      timings: {
        firstAcceptedMs: expect.any(Number),
        firstVisibleMs: expect.any(Number),
        allTargetsMs: expect.any(Number),
        completeMs: expect.any(Number),
      },
      correctness: {
        targetCount: 120,
        translatedCount: 120,
        completionObserved: true,
      },
      errors: [],
    });
    expect(results(window)[0]).not.toHaveProperty("sessionId");
    expect(
      window.document.querySelector('[data-value="build"]').textContent,
    ).toBe("A");
    expect(
      window.document.querySelector('[data-value="level"]').textContent,
    ).toBe("1");
    expect(
      window.document.querySelector('[data-count="trials"]').textContent,
    ).toBe("1");
    expect(
      window.document.querySelector('[data-count="passed"]').textContent,
    ).toBe("1");
    expect(
      window.document.querySelector('[data-count="failed"]').textContent,
    ).toBe("0");
    expect(
      window.document.querySelector("[data-latest-status]").textContent,
    ).toBe("Passed");
    expect(
      window.document.querySelector('[data-latest="complete"]').textContent,
    ).toMatch(/^\d+ ms$/);
    expect(
      [...window.document.querySelector(".ti-ab-actions").children].map(
        (button) => button.id,
      ),
    ).toEqual(["ti-ab-export", "ti-ab-copy", "ti-ab-clear"]);
    const copyButton = window.document.getElementById("ti-ab-copy");
    expect(copyButton.getAttribute("aria-label")).toBe(
      "Copy results to clipboard",
    );
    expect(copyButton.getAttribute("title")).toBe("Copy results to clipboard");
    expect(copyButton.textContent.trim()).toBe("");

    const copiedText = await copyResults(window);
    const copied = JSON.parse(copiedText);
    expect(copied).toMatchObject({
      metadataOnly: true,
      trials: [
        {
          status: "passed",
          correctness: { translatedCount: 120, completionObserved: true },
        },
      ],
    });
    expect(
      window.document.getElementById("ti-ab-copy-feedback").textContent,
    ).toBe("Copied results to clipboard.");
    const exported = await exportResults(window);
    const withoutExportTime = (payload) => {
      const copy = { ...payload };
      delete copy.exportedAt;
      return copy;
    };
    expect(withoutExportTime(copied)).toEqual(withoutExportTime(exported));

    const cancelledPage = createPage();
    emit(cancelledPage.window, "page-translate-start", { sessionId: "next" });
    emit(cancelledPage.window, "page-translate-cancelled", {
      sessionId: "next",
      reason: "api-key=secret-token",
    });
    const saved = JSON.stringify(results(cancelledPage.window));
    expect(results(cancelledPage.window)[0]).toMatchObject({
      status: "failed",
      cancellation: "cancelled",
    });
    expect(
      cancelledPage.window.document.querySelector("[data-latest-reason]")
        .textContent,
    ).toBe("Cancelled");
    expect(saved).not.toContain("secret-token");
    expect(saved).not.toContain("local library reviews historical records");
    dom.window.close();
    cancelledPage.window.close();
  });

  it("persists interrupted trials and never includes sensitive error payloads in saved/exported metadata", async () => {
    const dom = createPage();
    const { window } = dom;
    emit(window, "page-translate-start", { sessionId: "interrupted" });
    emit(window, "page-translation-internal-error", {
      sessionId: "interrupted",
      error: {
        message: "Authorization: Bearer private-credential source text payload",
      },
    });
    window.dispatchEvent(new window.Event("pagehide"));
    window.dispatchEvent(new window.Event("beforeunload"));
    expect(results(window)).toHaveLength(1);
    expect(results(window)[0]).toMatchObject({
      status: "failed",
      correctness: { completionObserved: false },
      interruption: { reason: "page unloaded before a terminal event" },
      errors: [{ type: "page-translation-internal-error" }],
    });
    expect(
      window.document.querySelector("[data-latest-reason]").textContent,
    ).toBe("Interrupted (page unloaded)");

    const copiedText = await copyResults(window);
    expect(copiedText).not.toContain("private-credential");
    expect(copiedText).not.toContain("source text payload");
    const exportJson = await exportResults(window);
    const exportText = JSON.stringify(exportJson);
    expect(exportJson).toMatchObject({
      metadataOnly: true,
      trials: [{ status: "failed" }],
    });
    expect(exportText).not.toContain("private-credential");
    expect(exportText).not.toContain("source text payload");
    dom.window.close();
  });

  it("keeps a trial active through temporary IDLE until matching COMPLETE", async () => {
    const dom = createPage();
    const { window } = dom;
    emit(window, "page-translate-start", { sessionId: "paused" });
    emit(window, "page-translate-idle", {
      sessionId: "paused",
      isTranslating: false,
    });
    expect(results(window)).toHaveLength(0);
    expect(
      window.document.querySelector("[data-latest-status]").textContent,
    ).toBe("Running");

    window.document.querySelectorAll("p[data-item]").forEach((p) => {
      p.textContent = `translated ${p.dataset.item}`;
    });
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    emit(window, "page-translate-complete", {
      sessionId: "paused",
      translatedCount: 120,
      failedCount: 0,
    });
    expect(results(window)).toHaveLength(1);
    expect(results(window)[0].status).toBe("passed");
    dom.window.close();
  });

  it("does not count targets that become visible after START for first-visible timing", async () => {
    const dom = createPage();
    const { window } = dom;
    const newlyVisible = window.document.querySelector('p[data-item="1"]');
    let rect = {
      width: 100,
      height: 20,
      top: window.innerHeight + 10,
      left: 10,
      right: 110,
      bottom: window.innerHeight + 30,
    };
    newlyVisible.getBoundingClientRect = () => rect;

    emit(window, "page-translate-start", { sessionId: "visibility-snapshot" });
    rect = {
      width: 100,
      height: 20,
      top: 10,
      left: 10,
      right: 110,
      bottom: 30,
    };
    newlyVisible.textContent = "translated after becoming visible";
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    emit(window, "page-translate-cancelled", {
      sessionId: "visibility-snapshot",
    });

    expect(results(window)[0].timings.firstAcceptedMs).toEqual(
      expect.any(Number),
    );
    expect(results(window)[0].timings.firstVisibleMs).toBeNull();
    dom.window.close();
  });

  it("retains the translation-error reason after finish renders the latest trial", () => {
    const dom = createPage();
    const { window } = dom;
    emit(window, "page-translate-start", { sessionId: "error" });
    emit(window, "page-translate-error", {
      sessionId: "error",
      message: "sensitive provider response",
    });

    expect(
      window.document.querySelector("[data-latest-status]").textContent,
    ).toBe("Failed");
    expect(
      window.document.querySelector("[data-latest-reason]").textContent,
    ).toBe("Translation error");
    expect(JSON.stringify(results(window))).not.toContain(
      "sensitive provider response",
    );
    dom.window.close();
  });

  it("shows failure feedback when clipboard access is unavailable", async () => {
    const dom = createPage();
    const { window } = dom;
    Object.defineProperty(window.navigator, "clipboard", {
      configurable: true,
      value: undefined,
    });

    window.document.getElementById("ti-ab-copy").click();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    const feedback = window.document.getElementById("ti-ab-copy-feedback");
    expect(feedback.textContent).toBe(
      "Copy failed: clipboard unavailable or permission denied.",
    );
    expect(feedback.dataset.status).toBe("error");
    dom.window.close();
  });

  it("shows failure feedback when clipboard permission is rejected", async () => {
    const dom = createPage();
    const { window } = dom;
    const writeText = vi.fn().mockRejectedValue(new Error("Permission denied"));
    Object.defineProperty(window.navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });

    window.document.getElementById("ti-ab-copy").click();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    const feedback = window.document.getElementById("ti-ab-copy-feedback");
    expect(writeText).toHaveBeenCalledOnce();
    expect(feedback.textContent).toBe(
      "Copy failed: clipboard unavailable or permission denied.",
    );
    expect(feedback.textContent).not.toContain("Copied results");
    expect(feedback.dataset.status).toBe("error");
    dom.window.close();
  });

  it("does not pass a non-clean initial page", () => {
    const dom = createPage();
    const { window } = dom;
    window.document.querySelector('p[data-item="1"]').textContent =
      "already translated";
    emit(window, "page-translate-start", { sessionId: "dirty" });
    emit(window, "page-translate-complete", {
      sessionId: "dirty",
      translatedCount: 120,
    });
    expect(results(window)).toHaveLength(1);
    expect(results(window)[0]).toMatchObject({
      status: "failed",
      correctness: { initialPageClean: false, completionObserved: false },
    });
    expect(
      window.document.querySelector("[data-latest-reason]").textContent,
    ).toBe("Initial page DOM is not clean");
    dom.window.close();
  });

  it("shows the latest trial's Build/Level and failure reason, not current URL labels", () => {
    const latestTrial = {
      variant: "B",
      level: 2,
      timestamp: "2026-11-23T12:00:00.000Z",
      endTimestamp: "2026-11-23T12:00:01.000Z",
      status: "failed",
      timings: {
        startMs: 0,
        firstAcceptedMs: 12,
        firstVisibleMs: null,
        allTargetsMs: null,
        completeMs: 1000,
      },
      correctness: {
        targetCount: 120,
        translatedCount: 70,
        allTargetsTranslated: false,
        completionObserved: false,
        initialPageClean: true,
      },
      errors: [{ type: "page-translate-error", atMs: 900, failedCount: null }],
      cancellation: null,
      interruption: null,
    };
    const dom = createPage(undefined, [latestTrial]);
    const { window } = dom;

    expect(
      window.document.querySelector('[data-value="build"]').textContent,
    ).toBe("A");
    expect(
      window.document.querySelector('[data-value="level"]').textContent,
    ).toBe("1");
    expect(
      window.document.querySelector("[data-latest-build]").textContent,
    ).toBe("B");
    expect(
      window.document.querySelector("[data-latest-level]").textContent,
    ).toBe("2");
    expect(
      window.document.querySelector("[data-latest-status]").textContent,
    ).toBe("Failed");
    expect(
      window.document.querySelector("[data-latest-reason]").textContent,
    ).toBe("Translation error");
    dom.window.close();
  });
});
