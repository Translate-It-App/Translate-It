// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { modeOrder, mapProviderBatchIds, parseScenarioSelection, validateDiscoveryFlags, validateExactTargetIds, validateFixtureGeometry, validateSampleCount } from './page-translation-e2e-benchmark/scenario-plan.mjs';
import { createFixture } from './page-translation-e2e-benchmark/fixture.mjs';
import { summarizeAcceptanceTimes, isDuplicateAcceptedMutation, trackAcceptedTarget } from './page-translation-e2e-benchmark/measurement-lifecycle.mjs';
import { captureViewportWindow, installPrimitiveAdmissionObserver } from './page-translation-e2e-benchmark/trace.mjs';

describe('large-page benchmark plan and geometry checks', () => {
  it('defaults to the preserved small fixture and accepts the three large layouts', () => {
    expect(parseScenarioSelection()).toEqual(['small']);
    expect(parseScenarioSelection('early-visible,in-window-visible,late-visible')).toEqual([
      'early-visible', 'in-window-visible', 'late-visible',
    ]);
    expect(() => parseScenarioSelection('early-visible,early-visible')).toThrow('Duplicate');
    expect(() => parseScenarioSelection('not-a-fixture')).toThrow('Unsupported');
  });

  it('cyclically rotates every selected mode with balanced complete and partial cycles', () => {
    expect(modeOrder(['legacy', 'sliced'], 0, 0)).toEqual(['legacy', 'sliced']);
    expect(modeOrder(['legacy', 'sliced'], 0, 1)).toEqual(['sliced', 'legacy']);
    expect(modeOrder(['legacy', 'sliced'], 1, 0)).toEqual(['sliced', 'legacy']);
    expect(modeOrder(['legacy', 'sliced', 'viewport'], 0, 0)).toEqual(['legacy', 'sliced', 'viewport']);
    expect(modeOrder(['legacy', 'sliced', 'viewport'], 0, 1)).toEqual(['sliced', 'viewport', 'legacy']);
    expect(modeOrder(['legacy', 'sliced', 'viewport'], 1, 0)).toEqual(['sliced', 'viewport', 'legacy']);
    expect(modeOrder(['legacy', 'viewport'], 0, 0)).toEqual(['legacy', 'viewport']);
    expect(modeOrder(['legacy', 'viewport'], 0, 1)).toEqual(['viewport', 'legacy']);
    for (const modes of [['legacy', 'sliced'], ['legacy', 'sliced', 'viewport']]) {
      const cycle = Array.from({ length: modes.length }, (_, ordinal) => modeOrder(modes, 0, ordinal));
      for (let position = 0; position < modes.length; position++) {
        expect(cycle.map(order => order[position]).sort()).toEqual([...modes].sort());
      }
      const tenRounds = Array.from({ length: 10 }, (_, ordinal) => modeOrder(modes, 0, ordinal));
      expect(tenRounds).toEqual(Array.from({ length: 10 }, (_, ordinal) => modeOrder(modes, 0, ordinal)));
      for (let position = 0; position < modes.length; position++) {
        const positionCounts = modes.map(mode => tenRounds.filter(order => order[position] === mode).length);
        expect(Math.max(...positionCounts) - Math.min(...positionCounts)).toBeLessThanOrEqual(1);
      }
    }
    expect(modeOrder(['legacy', 'sliced', 'viewport'], 0, 4).slice(0, 2)).toEqual(['sliced', 'viewport']);
    expect(modeOrder(['legacy'], 0, 0)).toEqual(['legacy']);
  });

  it.each([3, 5, 40])('accepts %s measured samples', count => {
    expect(validateSampleCount(count)).toBe(count);
  });

  it.each([2, 41, Number.NaN, 3.5])('rejects invalid sample count %s', count => {
    expect(() => validateSampleCount(count)).toThrow('integer between 3 and 40');
  });

  it.each([
    ['legacy', false, false], ['sliced', true, false], ['viewport', true, true],
  ])('validates content-bundle discovery flags for %s', (mode, slicedDiscoveryEnabled, viewportFirstDiscoveryEnabled) => {
    expect(validateDiscoveryFlags(mode, { slicedDiscoveryEnabled, viewportFirstDiscoveryEnabled }).ok).toBe(true);
    expect(validateDiscoveryFlags(mode, { slicedDiscoveryEnabled: !slicedDiscoveryEnabled, viewportFirstDiscoveryEnabled }).ok).toBe(false);
  });

  it('requires observed viewport, scroll, target count and visible IDs to match fixture oracles', () => {
    const fixture = {
      targetCount: 2, targetTexts: ['one', 'two'],
      targets: [{ id: 'target-1', source: 'one' }, { id: 'target-2', source: 'two' }],
      visibleIds: ['target-2'], viewport: { width: 1280, height: 900 }, scroll: { x: 0, y: 0 },
    };
    expect(validateFixtureGeometry(fixture, {
      targetCount: 2, visibleIds: ['target-2'], viewport: { width: 1280, height: 900 }, scroll: { x: 0, y: 0 },
    }).ok).toBe(true);
    expect(validateFixtureGeometry(fixture, {
      targetCount: 2, visibleIds: [], viewport: { width: 1280, height: 900 }, scroll: { x: 0, y: 4 },
    }).issues).toEqual(expect.arrayContaining([
      'actual scroll position does not match fixture configuration',
      'actual visible IDs do not match fixture geometry oracle',
    ]));
  });

  it('keeps large-layout source IDs stable while ordering the early, in-window, and late visible targets', () => {
    const scenarios = parseScenarioSelection('early-visible,in-window-visible,late-visible').map(createFixture);
    const expectedVisible = ['target-500', 'target-501', 'target-502', 'target-503'];
    const sourceById = scenarios.map(fixture => new Map(fixture.targets.map(target => [target.id, target.source])));
    for (const fixture of scenarios) {
      expect(fixture.targetCount).toBe(1000);
      expect(fixture.visibleIds).toEqual(expectedVisible);
      expect(fixture.targetTexts).toEqual(fixture.targets.map(target => target.source));
      expect(new Set(fixture.targets.map(target => target.id)).size).toBe(1000);
    }
    const stableIds = [...sourceById[0].keys()].sort();
    for (const id of stableIds) expect(sourceById[1].get(id)).toBe(sourceById[0].get(id));
    for (const id of stableIds) expect(sourceById[2].get(id)).toBe(sourceById[0].get(id));
    expect(scenarios[0].targets.slice(0, 4).map(target => target.id)).toEqual(expectedVisible);
    expect(scenarios[1].targets.slice(0, 2).every(target => !target.visible)).toBe(true);
    expect(scenarios[1].targets.slice(2, 6).map(target => target.id)).toEqual(expectedVisible);
    expect(scenarios[2].targets.slice(0, 100).some(target => target.visible)).toBe(false);
    expect(validateExactTargetIds('admission', ['target-500', 'target-500'], ['target-500']).issues).toContain('duplicate admission target ID: target-500');
  });

  it('records first acceptance and complete visible/all sets, leaving incomplete timing unavailable', () => {
    const acceptedIds = new Set();
    const firstAcceptedAtById = {};
    const completionTimes = { visible: null, all: null };
    for (const [id, at] of [['a', 12], ['c', 20], ['b', 24]]) {
      trackAcceptedTarget({ id, at, acceptedIds, firstAcceptedAtById, visibleIds: ['a', 'b'], targetCount: 3, completionTimes });
    }
    expect(completionTimes).toEqual({ visible: 24, all: 24 });
    expect(summarizeAcceptanceTimes(firstAcceptedAtById, ['a', 'b'], ['a', 'b', 'c'])).toEqual({
      firstAcceptedAt: 12,
      firstAcceptedAtUnavailableReason: null,
      visibleSetCompletionAt: 24,
      visibleSetCompletionUnavailableReason: null,
      allTargetsCompletionAt: 24,
      allTargetsCompletionUnavailableReason: null,
    });
    const incomplete = summarizeAcceptanceTimes({ a: 12 }, ['a', 'b'], ['a', 'b', 'c']);
    expect(incomplete.visibleSetCompletionAt).toBeNull();
    expect(incomplete.allTargetsCompletionAt).toBeNull();
    expect(incomplete.allTargetsCompletionUnavailableReason).toContain('1/3');
  });

  it('observes per-instance primitive admissions without changing production arguments, return, errors, or scheduler method', () => {
    const nodeA = { id: 'a' };
    const nodeB = { id: 'b' };
    const callback = () => {};
    const result = { accepted: true };
    const order = [];
    const scheduler = { enqueue() { return 'scheduler-untouched'; } };
    const nodesTranslator = {
      translate(node, suppliedCallback) {
        expect(this).toBe(nodesTranslator);
        expect(suppliedCallback).toBe(callback);
        return node === nodeA ? result : 'second';
      },
    };
    const session = { domTranslator: { nodesTranslator } };
    expect(installPrimitiveAdmissionObserver(session, ([node]) => order.push(node.id))).toBe(true);
    expect(nodesTranslator.translate(nodeA, callback)).toBe(result);
    expect(nodesTranslator.translate(nodeB, callback)).toBe('second');
    expect(order).toEqual(['a', 'b']);
    expect(scheduler.enqueue()).toBe('scheduler-untouched');
    const failure = new Error('production failure');
    nodesTranslator.translate = function(node) { if (node === nodeA) throw failure; return node; };
    expect(installPrimitiveAdmissionObserver(session, () => {})).toBe(true);
    expect(() => nodesTranslator.translate(nodeA)).toThrow(failure);
  });

  it('captures the supplied live discovery-window candidate state at admission, not fixture-index guesses', () => {
    const nodeA = { dataset: { benchId: 'actual-a' } };
    const nodeB = { dataset: { benchId: 'actual-b' } };
    const viewportWindow = {
      phase: 'geometry', enumerationSteps: 100,
      candidates: [{ node: nodeA, visible: false }, { node: nodeB, visible: true }],
    };
    const observed = captureViewportWindow({ discovery: { queue: [{ viewportWindow }] } }, node => node.dataset.benchId);
    expect(observed).toEqual({
      phaseAtAdmission: 'geometry', enumerationSteps: 100, candidateCount: 2,
      candidateDetails: [{ id: 'actual-a', visible: false }, { id: 'actual-b', visible: true }],
      windowCandidateIds: ['actual-a', 'actual-b'], visibleCandidateIds: ['actual-b'],
    });
  });

  it('maps physical provider batches to ordered target IDs and validates an exact source set', () => {
    const sourceToId = new Map([['source-a', 'a'], ['source-b', 'b']]);
    const physicalBatches = [['source-b'], ['source-a']];
    const mapped = mapProviderBatchIds(physicalBatches, sourceToId);
    expect(mapped).toEqual([['b'], ['a']]);
    expect(validateExactTargetIds('provider source', mapped.flat(), ['a', 'b']).ok).toBe(true);
    expect(validateExactTargetIds('provider source', [['b'], ['missing']].flat(), ['a', 'b']).ok).toBe(false);
  });

  it('detects repeated accepted characterData writes in one MutationObserver delivery and childList replacements across deliveries', async () => {
    const host = document.createElement('div');
    const text = document.createTextNode('source');
    host.append(text);
    document.body.append(host);
    const expectedText = '\u200efixture translation: source';
    const characterDataRecords = [];
    const characterObserver = new MutationObserver(records => characterDataRecords.push(...records));
    characterObserver.observe(host, { subtree: true, characterData: true, characterDataOldValue: true });
    text.data = expectedText;
    text.data = expectedText;
    await new Promise(resolve => setTimeout(resolve, 0));
    characterObserver.disconnect();
    expect(characterDataRecords).toHaveLength(2);
    expect(isDuplicateAcceptedMutation({ wasAlreadyAccepted: false, expectedText, resultingText: host.textContent, records: characterDataRecords })).toBe(true);
    expect(isDuplicateAcceptedMutation({
      wasAlreadyAccepted: false, expectedText, resultingText: expectedText,
      records: [{ type: 'characterData', oldValue: 'source', target: text }, { type: 'childList', addedNodes: [text] }],
    })).toBe(false);

    const childListRecords = [];
    const childListObserver = new MutationObserver(records => childListRecords.push(...records));
    childListObserver.observe(host, { subtree: true, childList: true });
    host.textContent = expectedText;
    await new Promise(resolve => setTimeout(resolve, 0));
    const firstReplacement = childListRecords.splice(0);
    host.textContent = expectedText;
    await new Promise(resolve => setTimeout(resolve, 0));
    childListObserver.disconnect();
    expect(firstReplacement).toHaveLength(1);
    expect(isDuplicateAcceptedMutation({ wasAlreadyAccepted: true, expectedText, resultingText: host.textContent, records: childListRecords })).toBe(true);
    expect(isDuplicateAcceptedMutation({ wasAlreadyAccepted: false, expectedText, resultingText: 'unaccepted rewrite', records: childListRecords })).toBe(false);
    host.textContent = 'unaccepted rewrite';
    await new Promise(resolve => setTimeout(resolve, 0));
    childListRecords.splice(0);
    host.textContent = expectedText;
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(isDuplicateAcceptedMutation({ wasAlreadyAccepted: false, expectedText, resultingText: host.textContent, records: childListRecords })).toBe(false);
    host.remove();
  });
});
