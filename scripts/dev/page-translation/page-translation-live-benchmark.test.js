import { readFile } from "node:fs/promises";
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

function createPage(url = "http://127.0.0.1/?variant=A&level=1") {
  return new JSDOM(pageHtml, {
    url,
    runScripts: "dangerously",
    beforeParse(window) {
      window.localStorage.setItem(storageKey, "[]");
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
    expect(window.document.querySelector("#ti-ab-latest").textContent).toMatch(
      /^Running/,
    );

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
    expect(window.document.querySelector("#ti-ab-latest").textContent).toMatch(
      /^Running/,
    );

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
    dom.window.close();
  });
});
