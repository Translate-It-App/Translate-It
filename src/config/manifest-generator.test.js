import { describe, expect, it } from 'vitest';
import { generateManifest } from '../../config/manifest-generator.js';

describe('Firefox popup shortcut', () => {
  it('allows a user-assigned shortcut to open the Firefox translation popup', () => {
    const manifest = generateManifest('firefox');
    expect(manifest.action.default_popup).toBe('src/html/popup.html');
    expect(manifest.commands._execute_action).toEqual({});
    expect(manifest.commands['SELECT-ELEMENT-COMMAND']).toBeDefined();
  });
});

describe('live dubbing manifest capability', () => {
  it('adds Chrome capture permissions only and keeps Chrome minimum at 116', () => {
    const chromeManifest = generateManifest('chrome');
    const firefoxManifest = generateManifest('firefox');

    expect(chromeManifest.minimum_chrome_version).toBe('116');
    expect(chromeManifest.permissions).toContain('tabCapture');
    expect(chromeManifest.permissions).toContain('activeTab');
    expect(firefoxManifest.permissions).not.toContain('tabCapture');
    expect(firefoxManifest.permissions).not.toContain('activeTab');
  });

  it('grants alarms only on Chrome for offscreen idle cleanup', () => {
    const chromeManifest = generateManifest('chrome');
    const firefoxManifest = generateManifest('firefox');

    expect(chromeManifest.permissions).toContain('alarms');
    expect(firefoxManifest.permissions).not.toContain('alarms');
  });

  it('does not expose the Chrome offscreen document through web accessible resources', () => {
    const chromeManifest = generateManifest('chrome');
    const resources = chromeManifest.web_accessible_resources.flatMap(({ resources }) => resources);

    expect(resources).not.toContain('src/html/offscreen.html');
    expect(resources).not.toContain('src/html/offscreen.js');
  });

  it('uses the live-dubbing description on Chrome and a dubbing-free description on Firefox', () => {
    const chromeManifest = generateManifest('chrome');
    const firefoxManifest = generateManifest('firefox');

    expect(chromeManifest.description).toBe('__MSG_description__');
    expect(firefoxManifest.description).toBe('__MSG_descriptionFirefox__');
  });

  it('injects the lightweight media observer in Chrome frames only', () => {
    const chromeScript = generateManifest('chrome').content_scripts.find(({ js }) =>
      js.includes('src/features/live-dubbing/content/index-media-observer.js'));
    const firefoxManifest = generateManifest('firefox');

    expect(chromeScript).toMatchObject({ all_frames: true, run_at: 'document_idle', match_about_blank: true, match_origin_as_fallback: true });
    expect(chromeScript.matches).toContain('<all_urls>');
    expect(firefoxManifest.content_scripts.some(({ js }) => js.includes('index-media-observer.js'))).toBe(false);
  });
});
