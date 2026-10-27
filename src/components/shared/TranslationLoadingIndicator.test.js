import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import { compile } from 'sass';
import { resolve } from 'node:path';
import postcss from 'postcss';
import TranslationLoadingIndicator from './TranslationLoadingIndicator.vue';

describe('TranslationLoadingIndicator.vue', () => {
  it('exposes one localized status and hides its artwork from assistive technology', () => {
    const wrapper = mount(TranslationLoadingIndicator, {
      props: { label: 'Translating now' },
    });

    expect(wrapper.findAll('[role="status"]')).toHaveLength(1);
    expect(wrapper.get('[role="status"]').text()).toBe('Translating now');
    expect(wrapper.findAll('[aria-hidden="true"]')).toHaveLength(1);
    expect(wrapper.find('[tabindex], button, a, input').exists()).toBe(false);
  });

  it('defaults to the translating label', () => {
    expect(mount(TranslationLoadingIndicator).get('[role="status"]').text()).toBe('Translating...');
  });

  it('keeps sizing, theme colors, and reduced-motion rules in compiled styles', () => {
    const stylePath = resolve(process.cwd(), 'src/components/shared/TranslationLoadingIndicator.scss');
    const root = postcss.parse(compile(stylePath).css);
    const rule = (selector) => {
      let found;
      root.walkRules(selector, (candidate) => { found = candidate; });
      return found;
    };

    expect(rule('.ti-translation-loading-indicator').nodes.map(({ prop, value }) => [prop, value]))
      .toContainEqual(['color', 'var(--ti-loading-eye-color, var(--tab-button-color, #5f6368))']);
    const pupil = rule('.ti-translation-loading-indicator-pupil');
    expect(pupil.nodes.map(({ prop, value }) => [prop, value]))
      .toContainEqual(['background', 'var(--ti-loading-eye-color, currentcolor)']);
    expect(pupil.nodes.map(({ prop, value }) => [prop, value]))
      .toContainEqual(['box-shadow', '0 0 0 calc(2px * var(--ti-loading-size, 1)) var(--ti-loading-pupil-color, transparent)']);

    const label = rule('.ti-translation-loading-indicator-label');
    expect(label).toBeDefined();
    expect(label.nodes.map(({ prop }) => prop)).toEqual(expect.arrayContaining(['position', 'width', 'height', 'overflow', 'clip-path', 'white-space']));
    expect(label.nodes.map(({ prop, value }) => [prop, value])).toContainEqual(['position', 'absolute']);

    const eyes = rule('.ti-translation-loading-indicator-eyes');
    const eye = rule('.ti-translation-loading-indicator-eye');
    const declarations = (candidate) => Object.fromEntries(candidate.nodes.map(({ prop, value }) => [prop, value]));
    const eyesStyles = declarations(eyes);
    const eyeStyles = declarations(eye);
    const defaultEyeWidth = 'calc(1.0625rem * var(--ti-loading-size, 1))';
    const defaultEyeHeight = 'calc(1.6875rem * var(--ti-loading-size, 1))';

    expect(eyesStyles.width).toBe('min(4.5rem * var(--ti-loading-size, 1), 100%)');
    expect(eyesStyles['justify-content']).toBe('center');
    expect(eyesStyles['align-items']).toBe('center');
    expect(eyeStyles.width).toBeUndefined();
    expect(eyeStyles.flex).toBe(`0 0 ${defaultEyeWidth}`);
    expect(eyeStyles['box-sizing']).toBe('border-box');
    expect(eyeStyles.height).toBe(defaultEyeHeight);
    expect(eyeStyles.border).toBe('calc(2px * var(--ti-loading-size, 1)) solid var(--ti-loading-eye-color, currentcolor)');
    const eyeWidthInRem = Number.parseFloat(defaultEyeWidth.match(/[\d.]+(?=rem)/)[0]);
    const eyeHeightInRem = Number.parseFloat(defaultEyeHeight.match(/[\d.]+(?=rem)/)[0]);
    expect(eyeWidthInRem).toBeLessThan(eyeHeightInRem);
    expect(eyeWidthInRem / eyeHeightInRem).toBeCloseTo(0.63, 2);
    expect(eyeStyles.animation).toBe('ti-translation-eye-blink var(--ti-loading-duration, 2.8s) infinite');
    expect(declarations(rule('.ti-translation-loading-indicator-pupil')).animation)
      .toBe('ti-translation-eye-look var(--ti-loading-duration, 2.8s) infinite ease-in-out');

    const darkIndicator = rule('.ti-translation-display[class~=theme-dark] .ti-translation-loading-indicator');
    expect(darkIndicator.nodes.map(({ prop, value }) => [prop, value]))
      .toContainEqual(['color', 'var(--ti-loading-eye-color, var(--placeholder-color, #888))']);
    const darkPupil = rule('.ti-translation-display[class~=theme-dark] .ti-translation-loading-indicator-pupil');
    expect(darkPupil.nodes.map(({ prop, value }) => [prop, value]))
      .toContainEqual(['box-shadow', '0 0 0 calc(2px * var(--ti-loading-size, 1)) var(--ti-loading-pupil-color, transparent)']);
    expect(darkPupil.nodes.map(({ prop }) => prop)).not.toEqual(expect.arrayContaining(['color', 'background', 'border', 'border-color']));

    const darkChildRules = [];
    root.walkRules((candidate) => {
      if (candidate.selector.startsWith('.ti-translation-display[class~=theme-dark]')
        && /\.ti-translation-loading-indicator-(?:eye|pupil)/.test(candidate.selector)) {
        darkChildRules.push(candidate);
      }
    });
    expect(darkChildRules.flatMap((candidate) => candidate.nodes.map(({ prop }) => prop)))
      .not.toEqual(expect.arrayContaining(['color', 'background', 'border', 'border-color']));

    const reducedMotion = root.nodes.find((node) => node.type === 'atrule' && node.params === '(prefers-reduced-motion: reduce)');
    expect(reducedMotion).toBeDefined();
    const reducedRules = reducedMotion.nodes.filter((node) => node.type === 'rule');
    expect(reducedRules).toHaveLength(1);
    expect(reducedRules[0].selector).toContain('.ti-translation-loading-indicator-eye');
    expect(reducedRules[0].selector).toContain('.ti-translation-loading-indicator-pupil');
    expect(reducedRules[0].nodes.map(({ prop, value }) => [prop, value]))
      .toContainEqual(['animation', 'none']);
  });
});
