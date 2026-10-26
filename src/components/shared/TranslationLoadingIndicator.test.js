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
      .toContainEqual(['color', 'var(--text-color, #343a40)']);
    expect(rule('.ti-translation-loading-indicator-pupil').nodes.map(({ prop, value }) => [prop, value]))
      .toContainEqual(['box-shadow', '0 0 0 calc(2px * var(--ti-loading-size, 1)) var(--ti-loading-pupil-color, var(--bg-result-color, #fff))']);

    expect(rule('.ti-translation-loading-indicator-eyes').nodes.map(({ prop, value }) => [prop, value]))
      .toContainEqual(['width', 'min(4.5rem * var(--ti-loading-size, 1), 100%)']);
    expect(rule('.ti-translation-loading-indicator-eye').nodes.map(({ prop, value }) => [prop, value]))
      .toContainEqual(['width', 'min(1.75rem * var(--ti-loading-size, 1), 50%)']);
    expect(rule('.ti-translation-loading-indicator-eye').nodes.map(({ prop, value }) => [prop, value]))
      .toContainEqual(['border', 'calc(2px * var(--ti-loading-size, 1)) solid var(--ti-loading-eye-color, currentcolor)']);

    const darkIndicator = rule('.ti-translation-display[class~=theme-dark] .ti-translation-loading-indicator');
    expect(darkIndicator.nodes.map(({ prop, value }) => [prop, value]))
      .toContainEqual(['color', 'var(--text-color, #e8eaed)']);
    const darkPupil = rule('.ti-translation-display[class~=theme-dark] .ti-translation-loading-indicator-pupil');
    expect(darkPupil.nodes.map(({ prop, value }) => [prop, value]))
      .toContainEqual(['box-shadow', '0 0 0 calc(2px * var(--ti-loading-size, 1)) var(--ti-loading-pupil-color, #1a1a1a)']);

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
