import { readFile } from "node:fs/promises";
import { URL as NodeURL } from "node:url";
import { describe, expect, it } from "vitest";
import { JSDOM } from "jsdom";
import { ElementSelector } from "../../src/features/element-selection/core/ElementSelector.js";
import { startServer } from "./select-element/live-benchmark/serve.mjs";
import { installLiveBenchmarkMetadataBridge } from "../../src/features/element-selection/utils/liveBenchmarkMetadataBridge.js";

const directory = new NodeURL("./select-element/live-benchmark/", import.meta.url);
const html = await readFile(new NodeURL("./index.html", directory), "utf8");
const script = await readFile(new NodeURL("./benchmark.js", directory), "utf8");
const key = "translate-it-select-element-live-benchmark-v2";
const page = html.replace('<script src="./benchmark.js" defer></script>', `<script>${script}</script>`);
const createPage = (records = [], beforeParse = () => {}, autoMetadata = true) => new JSDOM(page, {
  url: "http://127.0.0.1/",
  runScripts: "dangerously",
  beforeParse(window) {
    window.localStorage.setItem(key, JSON.stringify(records));
    window.confirm = () => true;
    if (autoMetadata) window.document.addEventListener("translate-it:select-element-benchmark:metadata-request", (event) => {
      const request = JSON.parse(event.detail);
      window.document.dispatchEvent(new window.CustomEvent("translate-it:select-element-benchmark:configured-metadata", {
        detail: JSON.stringify({ trialId: request.trialId, capturePhase: request.capturePhase }),
      }));
    });
    beforeParse(window);
  },
});
const emitProbe = (window, type, payload) => {
  const trialId = window.document.querySelector("#fixture-root")?.getAttribute("data-translate-it-live-benchmark-trial");
  window.document.dispatchEvent(new window.CustomEvent(`translate-it:select-element-benchmark:${type}`, {
    detail: JSON.stringify({ trialId, ...payload }),
  }));
};

describe("Select Element live benchmark", () => {
  it.each([["Small", 8, 8], ["Medium", 50, 50], ["Large", 300, 300], ["Mixed HTML", 25, 50]])(
      "creates %s with %i logical parents and %i text nodes",
    (name, parentCount, textNodeCount) => {
      const dom = createPage();
      const { window } = dom;
      const choice = window.document.getElementById("fixture-choice");
      choice.value = name;
      choice.dispatchEvent(new window.Event("change"));
      const roots = [...window.document.querySelectorAll("#fixture > section[data-target]")];
      expect(roots).toHaveLength(1);
      roots[0].getBoundingClientRect = () => ({ width: 300, height: 300 });
      const walker = window.document.createTreeWalker(roots[0], window.NodeFilter.SHOW_TEXT);
      let observedTextNodeCount = 0;
      while (walker.nextNode()) observedTextNodeCount++;
      expect(observedTextNodeCount).toBe(textNodeCount);
      expect(roots[0].querySelectorAll(":scope > p")).toHaveLength(parentCount);
      expect(roots[0].getBoundingClientRect().width * roots[0].getBoundingClientRect().height).toBeLessThanOrEqual(120000);
      expect(roots[0].getBoundingClientRect().width * roots[0].getBoundingClientRect().height).toBeGreaterThanOrEqual(4000);
      if (name === "Mixed HTML") expect(roots[0].querySelectorAll("strong, em")).toHaveLength(25);
      expect(window.document.getElementById("benchmark-panel").getAttribute("translate")).toBe("no");
      expect(window.document.getElementById("benchmark-panel").dataset.translateIgnore).toBe("true");
      dom.window.close();
    },
  );

  it("lets ElementSelector choose the full fixture root when the root itself is clicked", () => {
    const root = document.createElement("section");
    root.style.cssText = "width:300px;height:300px;overflow:auto";
    root.innerHTML = Array.from({ length: 8 }, (_, i) =>
      `<p>Selectable fixture paragraph ${i + 1} with enough words.</p>`,
    ).join("");
    Object.defineProperties(root, {
      offsetWidth: { value: 300 },
      offsetHeight: { value: 300 },
    });
    document.body.append(root);
    const selector = new ElementSelector();
    try {
      expect(selector.findBestTextElement(root)).toBe(root);
      expect(selector.isSelectionCandidate(root)).toBe(true);
    } finally {
      root.remove();
    }
  });

  it("records armed/mutation proxy timings, explicit status, visible comparison, and safe metadata only", async () => {
      const dom = createPage([{
      label: "baseline", fixture: "Small", targetCount: 8, status: "successful",
      sourceText: "secret page text", token: "credential",
      timings: { selectionClickMs: -1, firstMutationMs: "bad", lastMutationMs: 7 },
    }]);
    const { window } = dom;
    window.document.getElementById("start-trial").click();
    emitProbe(window, "accepted-click", { trialId: "previous-trial", clickTimeStamp: 0, acceptedAt: 0 });
    emitProbe(window, "accepted-click", { clickTimeStamp: 1, acceptedAt: 10 });
    emitProbe(window, "accepted-click", { clickTimeStamp: 2, acceptedAt: 100 });
    const root = window.document.querySelector("#fixture-root");
    root.querySelector("p").textContent = "changed";
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    const unrelated = window.document.createElement("p");
    unrelated.textContent = "unrelated new text";
    root.append(unrelated);
    root.append("unrelated text node");
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    window.document.getElementById("outcome").value = "partial";
    window.document.getElementById("finish-trial").click();
    const isolatedRecord = JSON.parse(window.localStorage.getItem(key)).at(-1);
    expect(isolatedRecord.timings.lastMutationMs).toBe(isolatedRecord.timings.firstMutationMs);
    expect(isolatedRecord.mutatedUnitCount).toBe(1);
    window.document.getElementById("start-trial").click();
    emitProbe(window, "accepted-click", { trialId: "stale", clickTimeStamp: 0, acceptedAt: 0 });
    emitProbe(window, "accepted-click", { clickTimeStamp: 1, acceptedAt: window.performance.now() });
    emitProbe(window, "runtime-metadata", {
      provider: "OpenAI", targetLanguage: "fr", extractionMode: "v3",
      model: "gpt-test", apiKey: "must-not-persist",
    });
    const newRoot = window.document.querySelector("#fixture-root");
    newRoot.querySelectorAll("p")[1].textContent = "second changed parent";
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    emitProbe(window, "operation-terminal", { at: window.performance.now(), status: "partial" });
    emitProbe(window, "operation-terminal", { at: window.performance.now() + 100, status: "failed" });
    window.document.getElementById("outcome").value = "partial";
    window.document.getElementById("finish-trial").click();
    const records = JSON.parse(window.localStorage.getItem(key));
    expect(records[0]).toMatchObject({
      label: "baseline", fixture: "Small", logicalParentCount: null,
      status: "successful", textNodeCount: null, timings: { selectionClickMs: null, clickToRequestDispatchMs: null, firstMutationMs: null },
      terminalStatus: null,
    });
    expect(records[1]).toMatchObject({
      label: "baseline", fixture: "Small", status: "partial",
      timings: { selectionClickMs: expect.any(Number), clickToRequestDispatchMs: null, clickToTerminalMs: null, firstMutationMs: expect.any(Number), lastMutationMs: expect.any(Number) },
      mutatedUnitCount: 1, terminalStatus: null,
    });
    expect(records[1].timings.selectionClickMs).toBe(9);
    expect(records[2]).toMatchObject({ mutatedUnitCount: 1, terminalStatus: "partial", timings: { clickToTerminalMs: expect.any(Number) } });
    expect(records[2]).toMatchObject({ logicalParentCount: 8, textNodeCount: 8 });
    expect(records[2]).toMatchObject({
      trialType: "warm",
      metadata: { adapterResolved: { provider: "OpenAI", targetLanguage: "fr", extractionMode: "V3" }, providerConfirmed: { status: "not-observed", provider: null, model: null } },
    });
    expect(JSON.stringify(records[2])).not.toContain("must-not-persist");
    expect(window.document.getElementById("results").textContent).toContain("baseline: partial");
    expect(window.document.getElementById("results").textContent).toContain("candidate: no trial");
    expect(JSON.stringify(records)).not.toMatch(/secret page text|credential|changed/);
    dom.window.close();
  });

  it("copies the export JSON with full precision and announces copy failures", async () => {
    const copied = [];
    const dom = createPage([{
      label: "baseline", fixture: "Small", status: "successful",
      metadata: { configured: { extensionVersion: "1.0.0" } },
      timings: { selectionClickMs: 1.23456 },
    }], (window) => {
      Object.defineProperty(window.navigator, "clipboard", {
        configurable: true,
        value: { writeText: async (text) => copied.push(text) },
      });
      window.Blob = class {
        constructor(parts) { this.parts = parts; }
      };
      window.URL.createObjectURL = (blob) => {
        window.exported = blob.parts.join("");
        return "blob:export";
      };
      window.URL.revokeObjectURL = () => {};
      window.Date = class extends Date {
        constructor(...args) { super(...(args.length ? args : ["2026-01-01T00:00:00.000Z"])); }
        static now() { return new Date("2026-01-01T00:00:00.000Z").getTime(); }
      };
    });
    const { window } = dom;
    window.document.getElementById("export").click();
    window.document.getElementById("copy").click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(copied).toHaveLength(1);
    expect(copied[0]).toBe(window.exported);
    expect(JSON.parse(copied[0]).trials[0].timings.selectionClickMs).toBe(1.23456);
    expect(JSON.parse(copied[0]).schemaVersion).toBe(4);
    expect(JSON.parse(copied[0]).trials[0].trialType).toBe("unknown");
    expect(JSON.parse(copied[0]).trials[0].metadata.configured.model).toBeNull();
    expect(JSON.parse(copied[0]).trials[0].metadata.configured.extensionVersion).toBe("1.0.0");
    expect(window.document.getElementById("results").textContent).toContain("1.2 ms");
    expect(window.document.getElementById("copy-feedback").textContent).toBe("Copied results to clipboard.");
    window.navigator.clipboard.writeText = async () => { throw new Error("denied"); };
    window.document.getElementById("copy").click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(window.document.getElementById("copy-feedback").textContent).toMatch(/Copy failed/);
    dom.window.close();
  });

  it("captures only allowlisted configured metadata before warm-trial readiness", async () => {
    const dom = createPage([], () => {}, false);
    const { window } = dom;
    const start = window.document.getElementById("start-trial");
    start.click();
    const trialId = window.document.querySelector("#fixture-root").getAttribute("data-translate-it-live-benchmark-trial");
    emitProbe(window, "accepted-click", { clickTimeStamp: 1, acceptedAt: 2 });
    expect(window.document.getElementById("trial-state").textContent).toContain("Collecting");
    window.document.dispatchEvent(new window.CustomEvent("translate-it:select-element-benchmark:configured-metadata", {
      detail: JSON.stringify({ trialId, capturePhase: "before-measurement", provider: "OpenAI", model: "gpt-safe", optimizationLevel: 4,
        sourceLanguage: "en", targetLanguage: "fr", aiContext: true, conversationHistory: false,
        translationFont: true, extensionVersion: "1.2.3", apiKey: "secret", payload: "private", arbitrary: { secret: true } }),
    }));
    emitProbe(window, "accepted-click", { clickTimeStamp: 1, acceptedAt: window.performance.now() });
    window.document.getElementById("outcome").value = "successful";
    window.document.getElementById("finish-trial").click();
    const record = JSON.parse(window.localStorage.getItem(key))[0];
    expect(record.trialType).toBe("warm");
    expect(record.metadata.configured).toMatchObject({
      provider: "OpenAI", model: "gpt-safe", optimizationLevel: 4, sourceLanguage: "en",
      targetLanguage: "fr", aiContext: true, conversationHistory: false, translationFont: true,
      extensionVersion: "1.2.3",
    });
    expect(record.metadata.configured.capturePhase).toBe("before-measurement");
    expect(JSON.stringify(record)).not.toMatch(/secret|private|arbitrary/);
    dom.window.close();
  });

  it("holds Warm readiness and accepted-click timing until deferred metadata settles", async () => {
    const dom = createPage([], () => {}, false);
    const { window } = dom;
    let request;
    let resolveCapture;
    const deferred = new Promise((resolve) => { resolveCapture = resolve; });
    window.document.addEventListener("translate-it:select-element-benchmark:metadata-request", (event) => {
      request = JSON.parse(event.detail);
      deferred.then(() => window.document.dispatchEvent(new window.CustomEvent("translate-it:select-element-benchmark:configured-metadata", {
        detail: JSON.stringify({ trialId: request.trialId, capturePhase: request.capturePhase }),
      })));
    });
    window.document.getElementById("start-trial").click();
    emitProbe(window, "accepted-click", { clickTimeStamp: 1, acceptedAt: 10 });
    expect(window.document.getElementById("trial-state").textContent).toContain("Collecting");
    resolveCapture();
    await deferred;
    await Promise.resolve();
    expect(window.document.getElementById("trial-state").textContent).toContain("Metadata ready");
    emitProbe(window, "accepted-click", { clickTimeStamp: 2, acceptedAt: 12 });
    window.document.getElementById("outcome").value = "successful";
    window.document.getElementById("finish-trial").click();
    expect(JSON.parse(window.localStorage.getItem(key))[0].timings.selectionClickMs).toBe(10);
    dom.window.close();
  });

  it("completes the first Warm metadata request through the fresh-page lazy bridge", async () => {
    const dom = createPage([], () => {}, false);
    const { window } = dom;
    let complete;
    const captured = new Promise((resolve) => { complete = resolve; });
    installLiveBenchmarkMetadataBridge(window.document, () => Promise.resolve({
      captureBenchmarkMetadata: (event) => {
        const request = JSON.parse(event.detail);
        window.document.dispatchEvent(new window.CustomEvent("translate-it:select-element-benchmark:configured-metadata", {
          detail: JSON.stringify({ trialId: request.trialId, capturePhase: request.capturePhase, model: "ready" }),
        }));
        complete();
      },
    }));
    window.document.getElementById("start-trial").click();
    await captured;
    expect(window.document.getElementById("trial-state").textContent).toContain("Metadata ready");
    expect(JSON.parse(window.localStorage.getItem(key))).toHaveLength(0);
    dom.window.close();
  });

  it("collects cold metadata only after measurement and keeps its end timestamp", () => {
    const dom = createPage([], () => {}, false);
    const { window } = dom;
    const requests = [];
    let timeout;
    window.setTimeout = (callback) => { timeout = callback; return 1; };
    window.clearTimeout = () => {};
    window.document.addEventListener("translate-it:select-element-benchmark:metadata-request", (event) => requests.push(JSON.parse(event.detail)));
    window.document.getElementById("trial-type").value = "cold";
    window.document.getElementById("start-trial").click();
    expect(window.document.getElementById("start-trial").disabled).toBe(true);
    expect(requests).toHaveLength(0);
    emitProbe(window, "accepted-click", { clickTimeStamp: 1, acceptedAt: 2 });
    emitProbe(window, "operation-terminal", { at: window.performance.now(), status: "successful" });
    window.document.getElementById("outcome").value = "successful";
    window.document.getElementById("finish-trial").click();
    const before = JSON.parse(window.localStorage.getItem(key))[0];
    expect(requests).toEqual([expect.objectContaining({ capturePhase: "after-measurement" })]);
    expect(before.endTimestamp).toBeTruthy();
    const fixtureRoot = window.document.querySelector("#fixture-root");
    expect(window.document.getElementById("fixture-choice").disabled).toBe(true);
    expect(window.document.getElementById("trial-label").disabled).toBe(true);
    timeout();
    expect(window.document.getElementById("start-trial").disabled).toBe(true);
    expect(JSON.parse(window.localStorage.getItem(key))[0].metadata.configured.capturePhase).toBe("after-measurement");
    window.document.dispatchEvent(new window.CustomEvent("translate-it:select-element-benchmark:configured-metadata", {
      detail: JSON.stringify({ trialId: requests[0].trialId, capturePhase: "after-measurement", model: "model-x" }),
    }));
    const after = JSON.parse(window.localStorage.getItem(key))[0];
    expect(after.endTimestamp).toBe(before.endTimestamp);
    expect(after.metadata.configured.capturePhase).toBe("after-measurement");
    expect(window.document.getElementById("start-trial").disabled).toBe(false);
    expect(window.document.getElementById("fixture-choice").disabled).toBe(false);
    expect(window.document.querySelector("#fixture-root")).toBe(fixtureRoot);
    dom.window.close();
  });

  it("does not start cold metadata reads for an incomplete in-flight translation", () => {
    const dom = createPage([], () => {}, false);
    const { window } = dom;
    const requests = [];
    window.document.addEventListener("translate-it:select-element-benchmark:metadata-request", (event) => requests.push(event.detail));
    window.document.getElementById("trial-type").value = "cold";
    window.document.getElementById("start-trial").click();
    emitProbe(window, "accepted-click", { clickTimeStamp: 1, acceptedAt: 2 });
    window.dispatchEvent(new window.Event("pagehide"));
    expect(requests).toHaveLength(0);
    expect(JSON.parse(window.localStorage.getItem(key))[0]).toMatchObject({
      status: "incomplete", endTimestamp: expect.any(String), metadata: { configured: { capturePhase: null } },
    });
    dom.window.close();
  });

  it("does not collect metadata for an unstarted Cold trial", () => {
    const dom = createPage([], () => {}, false);
    const { window } = dom;
    const requests = [];
    window.document.addEventListener("translate-it:select-element-benchmark:metadata-request", (event) => requests.push(event.detail));
    window.document.getElementById("trial-type").value = "cold";
    window.document.getElementById("start-trial").click();
    window.dispatchEvent(new window.Event("pagehide"));
    expect(requests).toHaveLength(0);
    expect(JSON.parse(window.localStorage.getItem(key))[0].metadata.configured.capturePhase).toBeNull();
    dom.window.close();
  });

  it("does not capture cold metadata after an operator success without an observed terminal", () => {
    const dom = createPage([], () => {}, false);
    const { window } = dom;
    const requests = [];
    window.document.addEventListener("translate-it:select-element-benchmark:metadata-request", (event) => requests.push(event.detail));
    window.document.getElementById("trial-type").value = "cold";
    window.document.getElementById("start-trial").click();
    emitProbe(window, "accepted-click", { clickTimeStamp: 1, acceptedAt: 2 });
    window.document.getElementById("outcome").value = "successful";
    window.document.getElementById("finish-trial").click();
    expect(requests).toHaveLength(0);
    expect(JSON.parse(window.localStorage.getItem(key))[0]).toMatchObject({
      status: "successful", endTimestamp: expect.any(String), metadata: { configured: { capturePhase: null } },
    });
    dom.window.close();
  });

  it("keeps extension versions in exports without splitting otherwise equivalent comparisons", () => {
    const dom = createPage([
      { label: "baseline", fixture: "Small", trialType: "warm", metadata: { configured: { model: "same", extensionVersion: "1.0" } } },
      { label: "candidate", fixture: "Small", trialType: "warm", metadata: { configured: { model: "same", extensionVersion: "2.0" } } },
    ]);
    const { window } = dom;
    const exported = JSON.parse(window.localStorage.getItem(key));
    expect(exported.map((record) => record.metadata.configured.extensionVersion)).toEqual(["1.0", "2.0"]);
    expect(window.document.querySelectorAll("#results section")).toHaveLength(4);
    expect(window.document.querySelector("#results section").textContent).toContain("baseline: incomplete");
    dom.window.close();
  });

  it("times out warm metadata without measuring and unlocks only after the pending read settles", () => {
    const dom = createPage([], () => {}, false);
    const { window } = dom;
    let timeout;
    window.setTimeout = (callback) => { timeout = callback; return 1; };
    window.clearTimeout = () => {};
    window.document.getElementById("start-trial").click();
    const trialId = window.document.querySelector("#fixture-root").getAttribute("data-translate-it-live-benchmark-trial");
    emitProbe(window, "accepted-click", { clickTimeStamp: 1, acceptedAt: 2 });
    expect(window.document.getElementById("trial-state").textContent).toContain("Collecting");
    timeout();
    const record = JSON.parse(window.localStorage.getItem(key))[0];
    expect(record.status).toBe("incomplete");
    expect(record.endTimestamp).toBeTruthy();
    expect(record.metadata.configured.capturePhase).toBe("before-measurement");
    expect(record.timings.selectionClickMs).toBeNull();
    expect(window.document.getElementById("start-trial").disabled).toBe(true);
    window.document.dispatchEvent(new window.CustomEvent("translate-it:select-element-benchmark:configured-metadata", {
      detail: JSON.stringify({ trialId, capturePhase: "before-measurement", model: "settled" }),
    }));
    expect(window.document.getElementById("start-trial").disabled).toBe(false);
    dom.window.close();
  });

  it("unlocks an abandoned metadata wait when the extension bridge is reinitialized", () => {
    const dom = createPage([], () => {}, false);
    const { window } = dom;
    window.setTimeout = () => 1;
    window.clearTimeout = () => {};
    window.document.getElementById("start-trial").click();
    window.document.dispatchEvent(new window.Event("translate-it:select-element-benchmark:extension-ready"));
    expect(JSON.parse(window.localStorage.getItem(key))[0].status).toBe("incomplete");
    expect(window.document.getElementById("start-trial").disabled).toBe(false);
    dom.window.close();
  });

  it("rejects URL-like and credential-like model metadata on persistence", () => {
    const dom = createPage([
      { label: "baseline", fixture: "Small", metadata: { configured: { model: "https://secret.example/key" } } },
      { label: "baseline", fixture: "Small", metadata: { configured: { model: "api_key_secret_token" } } },
      { label: "baseline", fixture: "Small", metadata: { configured: { model: "sk-proj-abcdefghijklmnopqrstuvwxyz" } } },
      { label: "baseline", fixture: "Small", metadata: { configured: { model: "models.example.com/path" } } },
    ]);
    const models = JSON.parse(dom.window.localStorage.getItem(key)).map((record) => record.metadata.configured.model);
    expect(models).toEqual([null, null, null, null]);
    dom.window.close();
  });

  it("separates configuration and trial-type groups and rejects stale metadata", () => {
    const dom = createPage([
      { label: "baseline", fixture: "Small", trialType: "warm", metadata: { configured: { model: "model-a" }, runtime: { targetLanguage: "en" } } },
      { label: "candidate", fixture: "Small", trialType: "warm", metadata: { configured: { model: "model-a" }, runtime: { targetLanguage: "fr" } } },
      { label: "candidate", fixture: "Small", trialType: "warm", metadata: { configured: { model: "model-a", extensionVersion: "9.9.9" }, runtime: { targetLanguage: "en" } } },
      { label: "candidate", fixture: "Small", trialType: "warm", metadata: { configured: { model: "model-b" } } },
      { label: "candidate", fixture: "Small", trialType: "cold", metadata: { configured: { model: "model-a" } } },
    ]);
    const { window } = dom;
    const start = window.document.getElementById("start-trial");
    start.click();
    emitProbe(window, "configured-metadata", { trialId: "stale", provider: "Injected", model: "bad" });
    window.document.getElementById("outcome").value = "failed";
    window.document.getElementById("finish-trial").click();
    const records = JSON.parse(window.localStorage.getItem(key));
    expect(records).toHaveLength(6);
    expect(records[5].metadata.configured.provider).toBeNull();
    const output = window.document.getElementById("results").textContent;
    expect(output).toContain("· model-a ·");
    expect(output).toContain("· model-b ·");
    expect(window.document.querySelectorAll("#results section")).toHaveLength(20);
    expect(output).toContain("baseline: incomplete");
    expect(output).toContain("baseline: failed");
    dom.window.close();
  });

  it("resets translated fixture content and mutation tally before each trial", async () => {
    const dom = createPage();
    const { window } = dom;
    const start = window.document.getElementById("start-trial");
    const finish = window.document.getElementById("finish-trial");
    const outcome = window.document.getElementById("outcome");
    const tick = () => new Promise((resolve) => window.setTimeout(resolve, 0));
    start.click();
    emitProbe(window, "accepted-click", { clickTimeStamp: 1, acceptedAt: window.performance.now() });
    let units = [...window.document.querySelectorAll("#fixture-root > p")];
    units[0].textContent = "changed one";
    units[1].textContent = "changed two";
    await tick();
    outcome.value = "partial";
    finish.click();
    start.click();
    emitProbe(window, "accepted-click", { clickTimeStamp: 1, acceptedAt: window.performance.now() });
    units = [...window.document.querySelectorAll("#fixture-root > p")];
    expect(units).toHaveLength(8);
    expect(units[0].textContent).toBe("Selectable Small text unit 1.");
    units[0].firstChild.data = "second run change";
    await tick();
    outcome.value = "successful";
    finish.click();
    const records = JSON.parse(window.localStorage.getItem(key));
    expect(records.map((record) => record.mutatedUnitCount)).toEqual([2, 1]);
    expect(records.map((record) => record.status)).toEqual(["partial", "successful"]);
    dom.window.close();
  });

  it("marks unreported trials incomplete, excludes controls from targets, and serves only allowlisted files", async () => {
    const dom = createPage();
    const { window } = dom;
    window.document.getElementById("start-trial").click();
    expect(window.document.getElementById("start-trial").disabled).toBe(true);
    window.dispatchEvent(new window.Event("pagehide"));
    expect(JSON.parse(window.localStorage.getItem(key))[0].status).toBe("incomplete");
    expect(window.document.querySelectorAll("#fixture > [data-target]")).toHaveLength(1);
    dom.window.close();
    const fixture = await startServer();
    try {
      expect((await fetch(fixture.url)).status).toBe(200);
      expect((await fetch(new NodeURL("./benchmark.js", fixture.url))).status).toBe(200);
      expect((await fetch(new NodeURL("../README.md", fixture.url))).status).toBe(404);
    } finally { await fixture.close(); }
    expect(fixture.server.listening).toBe(false);
  });

  it("uses a new export schema for metadata and trial types", () => {
    expect(key).toBe("translate-it-select-element-live-benchmark-v2");
    expect(script).toContain("schemaVersion: 4");
    expect(html).toContain('<option value="warm" selected>Warm</option>');
    expect(script).toContain("trialType:");
    expect(script).not.toContain("translate-it-select-element-live-benchmark-v1");
  });
});
