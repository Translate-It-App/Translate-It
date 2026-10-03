import { describe, it, expect, vi, beforeEach } from "vitest";
import { mount } from "@vue/test-utils";
import { ref } from "vue";
import PageTranslationButton from "./PageTranslationButton.vue";
import enMessages from "../../../_locales/en/messages.json";
import faMessages from "../../../_locales/fa/messages.json";
import jaMessages from "../../../_locales/ja/messages.json";

// Mock components
vi.mock("@/components/base/BaseButton.vue", () => ({
  default: {
    name: "BaseButton",
    template:
      '<button :title="title" :disabled="disabled" :class="{ \'ti-btn--disabled\': disabled }"><slot /></button>',
    props: ["variant", "disabled", "title"],
  },
}));

vi.mock("@/components/base/LoadingSpinner.vue", () => ({
  default: {
    name: "LoadingSpinner",
    template: '<div class="spinner"></div>',
  },
}));

vi.mock("@iconify/vue", () => ({
  Icon: {
    name: "Icon",
    template: '<i class="icon"></i>',
  },
}));

vi.mock("@/components/shared/PageTranslationStatus.vue", () => ({
  default: {
    name: "PageTranslationStatus",
    props: ["statusData", "mode"],
    template: '<div class="status-badge"></div>',
  },
}));

// Mock Composables
const mockUsePageTranslation = {
  isTranslating: ref(false),
  isTranslated: ref(false),
  isAutoTranslating: ref(false),
  progress: ref(0),
  message: ref(""),
  canTranslate: ref(true),
  canRestore: ref(false),
  hasError: ref(false),
  translatePage: vi.fn(),
  restorePage: vi.fn(),
  stopAutoTranslation: vi.fn(),
  cancelTranslation: vi.fn(),
};

vi.mock("../composables/usePageTranslation.js", () => ({
  usePageTranslation: () => mockUsePageTranslation,
}));

vi.mock("@/composables/shared/useUnifiedI18n.js", () => ({
  useUnifiedI18n: () => ({
    t: vi.fn((key) => key),
  }),
}));

vi.mock("@/core/extensionContext.js", () => ({
  default: {
    safeGetURL: vi.fn((path) => path),
  },
}));

const mockUseAutoTranslateRules = {
  isAutoTranslateToggleVisible: ref(false),
  isActive: ref(false),
  hasPageRule: ref(false),
  hasSiteRule: ref(false),
  siteScopeAvailable: ref(true),
  showManageRules: ref(false),
  scopeActions: { togglePageScope: vi.fn(), toggleSiteScope: vi.fn() },
  openManageRules: vi.fn(),
  normalizedPageUrl: ref('https://example.com/page'),
  siteRule: ref(null),
  hasBroaderMatchingRule: ref(false),
  isFileUrl: ref(false),
  isAutoTranslateToggleActive: ref(false),
  isAutoTranslateToggleDisabled: ref(false),
  autoTranslateToggleTitle: ref("Add to auto-translate rules"),
  toggleAutoTranslateForCurrentPage: vi.fn(),
};

vi.mock("../composables/useAutoTranslateRules.js", () => ({
  useAutoTranslateRules: () => mockUseAutoTranslateRules,
}));

const mockUseActiveTabUrl = {
  activeTabUrl: ref("https://example.com/page"),
  isActiveTabUrlLoading: ref(false),
  refreshActiveTabUrl: vi.fn(),
};

vi.mock("@/composables/core/useActiveTabUrl.js", () => ({
  useActiveTabUrl: () => mockUseActiveTabUrl,
}));

describe("PageTranslationButton.vue", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUsePageTranslation.isTranslating.value = false;
    mockUsePageTranslation.isTranslated.value = false;
    mockUsePageTranslation.isAutoTranslating.value = false;
    mockUsePageTranslation.progress.value = 0;
    mockUsePageTranslation.canTranslate.value = true;
    mockUsePageTranslation.canRestore.value = false;
    mockUsePageTranslation.hasError.value = false;
  });

  it("should render translate button when idle", () => {
    const wrapper = mount(PageTranslationButton);
    expect(wrapper.text()).toContain("page_translation_btn_translate");
    expect(wrapper.findComponent({ name: "BaseButton" }).exists()).toBe(true);
  });

  it("should call translatePage when button is clicked", async () => {
    const wrapper = mount(PageTranslationButton);
    await wrapper.find("button").trigger("click");
    expect(mockUsePageTranslation.translatePage).toHaveBeenCalled();
  });

  it("should render loading state when translating", async () => {
    mockUsePageTranslation.isTranslating.value = true;
    const wrapper = mount(PageTranslationButton);
    expect(wrapper.findComponent({ name: "LoadingSpinner" }).exists()).toBe(
      true,
    );
    expect(wrapper.text()).toContain("popup_string_during_translate");
  });

  it("should render restore button when translated", async () => {
    mockUsePageTranslation.isTranslated.value = true;
    mockUsePageTranslation.canRestore.value = true;
    const wrapper = mount(PageTranslationButton);
    expect(wrapper.text()).toContain("page_translation_btn_restore");
  });

  it("should show progress bar when translating with progress > 0", async () => {
    mockUsePageTranslation.isTranslating.value = true;
    mockUsePageTranslation.progress.value = 45;
    const wrapper = mount(PageTranslationButton);
    const progressFill = wrapper.find(".progress-fill");
    expect(progressFill.exists()).toBe(true);
    expect(progressFill.attributes("style")).toContain("width: 45%");
  });

  it("should render text-only mode correctly", () => {
    const wrapper = mount(PageTranslationButton, {
      props: { textOnly: true },
    });
    expect(wrapper.find("a.toolbar-link").exists()).toBe(true);
    expect(wrapper.findComponent({ name: "BaseButton" }).exists()).toBe(false);
  });

  it("should handle cancel/stop correctly", async () => {
    mockUsePageTranslation.isAutoTranslating.value = true;
    const wrapper = mount(PageTranslationButton);
    await wrapper.find("button").trigger("click");
    expect(mockUsePageTranslation.stopAutoTranslation).toHaveBeenCalled();

    mockUsePageTranslation.isAutoTranslating.value = false;
    mockUsePageTranslation.isTranslating.value = true;
    await wrapper.find("button").trigger("click");
    expect(mockUsePageTranslation.cancelTranslation).toHaveBeenCalled();
  });

  it("should show error badge when hasError is true", () => {
    mockUsePageTranslation.hasError.value = true;
    const wrapper = mount(PageTranslationButton);
    expect(
      wrapper.findComponent({ name: "PageTranslationStatus" }).exists(),
    ).toBe(true);
  });

  it("should render safe mapped error message", () => {
    mockUsePageTranslation.hasError.value = true;
    mockUsePageTranslation.message.value = "Localized model error";
    const wrapper = mount(PageTranslationButton);

    expect(wrapper.find(".error-message").text()).toBe("Localized model error");
    expect(wrapper.text()).not.toContain("raw provider response body");
  });

  describe("Tooltips (i18n keys)", () => {
    const getBaseButtonTitle = (wrapper) =>
      wrapper.findComponent({ name: "BaseButton" }).props("title");

    it("should use translate tooltip key when idle", () => {
      const wrapper = mount(PageTranslationButton);
      expect(getBaseButtonTitle(wrapper)).toBe(
        "page_translation_tooltip_translate",
      );
      expect(wrapper.find("button").attributes("title")).toBe(
        "page_translation_tooltip_translate",
      );
    });

    it("should use cancel tooltip key during translation", () => {
      mockUsePageTranslation.isTranslating.value = true;
      const wrapper = mount(PageTranslationButton);
      expect(getBaseButtonTitle(wrapper)).toBe(
        "page_translation_tooltip_cancel",
      );
    });

    it("should use stop auto-translation tooltip key during auto-translation", () => {
      mockUsePageTranslation.isAutoTranslating.value = true;
      const wrapper = mount(PageTranslationButton);
      expect(getBaseButtonTitle(wrapper)).toBe(
        "page_translation_tooltip_stop_auto",
      );
    });

    it("should use restore tooltip key when restore is available", () => {
      mockUsePageTranslation.isTranslated.value = true;
      mockUsePageTranslation.canRestore.value = true;
      const wrapper = mount(PageTranslationButton);
      expect(getBaseButtonTitle(wrapper)).toBe(
        "page_translation_tooltip_restore",
      );
    });

    it("should use nothing-to-restore tooltip key when restore is unavailable", () => {
      mockUsePageTranslation.isTranslated.value = true;
      mockUsePageTranslation.canRestore.value = false;
      const wrapper = mount(PageTranslationButton);
      expect(getBaseButtonTitle(wrapper)).toBe(
        "page_translation_tooltip_nothing_to_restore",
      );
    });

    it("should define all tooltip keys in en/fa/ja locales", () => {
      const keys = [
        "page_translation_tooltip_translate",
        "page_translation_tooltip_in_progress",
        "page_translation_tooltip_stop_auto",
        "page_translation_tooltip_cancel",
        "page_translation_tooltip_restore_blocked",
        "page_translation_tooltip_nothing_to_restore",
        "page_translation_tooltip_restore",
      ];
      for (const key of keys) {
        for (const messages of [enMessages, faMessages, jaMessages]) {
          expect(messages[key]?.message, key).toBeTruthy();
        }
      }
    });
  });

  describe("Auto-Translate Star Toggle", () => {
    beforeEach(() => {
      mockUseAutoTranslateRules.isAutoTranslateToggleVisible.value = false;
      mockUseAutoTranslateRules.isActive.value = false;
      mockUseAutoTranslateRules.isAutoTranslateToggleDisabled.value = false;
      mockUseAutoTranslateRules.hasPageRule.value = false;
      mockUseAutoTranslateRules.hasSiteRule.value = false;
      mockUseAutoTranslateRules.siteScopeAvailable.value = true;
      mockUseAutoTranslateRules.showManageRules.value = false;
      mockUseAutoTranslateRules.scopeActions.togglePageScope.mockClear();
      mockUseAutoTranslateRules.scopeActions.toggleSiteScope.mockClear();
      mockUseAutoTranslateRules.openManageRules.mockClear();
      mockUseAutoTranslateRules.autoTranslateToggleTitle.value =
        "Add to auto-translate rules";
      mockUseAutoTranslateRules.toggleAutoTranslateForCurrentPage.mockClear();
    });

    it("should not show star button if showAutoTranslateToggle is false", () => {
      mockUseAutoTranslateRules.isAutoTranslateToggleVisible.value = true;
      const wrapper = mount(PageTranslationButton, {
        props: { showAutoTranslateToggle: false },
      });
      expect(wrapper.find(".page-translate-star-btn").exists()).toBe(false);
    });

    it("should not show star button if isAutoTranslateToggleVisible is false", () => {
      mockUseAutoTranslateRules.isAutoTranslateToggleVisible.value = false;
      const wrapper = mount(PageTranslationButton, {
        props: { showAutoTranslateToggle: true },
      });
      expect(wrapper.find(".page-translate-star-btn").exists()).toBe(false);
    });

    it("should show star button if showAutoTranslateToggle and isAutoTranslateToggleVisible are true", () => {
      mockUseAutoTranslateRules.isAutoTranslateToggleVisible.value = true;
      const wrapper = mount(PageTranslationButton, {
        props: { showAutoTranslateToggle: true },
      });
      expect(wrapper.find(".page-translate-star-btn").exists()).toBe(true);
    });

    it("should bind classes and attributes correctly", () => {
      mockUseAutoTranslateRules.isAutoTranslateToggleVisible.value = true;
      mockUseAutoTranslateRules.isActive.value = true;
      mockUseAutoTranslateRules.isAutoTranslateToggleDisabled.value = true;
      mockUseAutoTranslateRules.autoTranslateToggleTitle.value =
        "Broader rule match";

      const wrapper = mount(PageTranslationButton, {
        props: { showAutoTranslateToggle: true },
      });

      const btn = wrapper.find(".page-translate-star-btn");
      expect(btn.classes()).toContain("is-active");
      expect(btn.attributes("title")).toBe("auto_translate_scope_menu_label");
    });

    it("opens the scope menu without translating", async () => {
      mockUseAutoTranslateRules.isAutoTranslateToggleVisible.value = true;
      mockUseAutoTranslateRules.isAutoTranslateToggleDisabled.value = false;

      const wrapper = mount(PageTranslationButton, {
        props: { showAutoTranslateToggle: true },
      });

      await wrapper.find(".page-translate-star-btn").trigger("click");
      expect(wrapper.find('[role="group"]').exists()).toBe(true);
      expect(mockUsePageTranslation.translatePage).not.toHaveBeenCalled();
    });

    it("toggles page and site rules from menu items", async () => {
      mockUseAutoTranslateRules.isAutoTranslateToggleVisible.value = true;
      const wrapper = mount(PageTranslationButton, { props: { showAutoTranslateToggle: true } });
      await wrapper.find('.page-translate-star-btn').trigger('click');
      await wrapper.findAll('.auto-translate-scope-menu button')[0].trigger('click');
      await wrapper.findAll('.auto-translate-scope-menu button')[1].trigger('click');
      expect(mockUseAutoTranslateRules.scopeActions.togglePageScope).toHaveBeenCalledOnce();
      expect(mockUseAutoTranslateRules.scopeActions.toggleSiteScope).toHaveBeenCalledOnce();
    });

    it("hides site scope for file URLs and exposes broader-rule management", async () => {
      mockUseAutoTranslateRules.isAutoTranslateToggleVisible.value = true;
      mockUseAutoTranslateRules.siteScopeAvailable.value = false;
      mockUseAutoTranslateRules.showManageRules.value = true;
      const wrapper = mount(PageTranslationButton, { props: { showAutoTranslateToggle: true } });
      await wrapper.find('.page-translate-star-btn').trigger('click');
      expect(wrapper.findAll('.auto-translate-scope-menu button')).toHaveLength(2);
      expect(wrapper.text()).toContain('auto_translate_managed_by_broader_rule');
      await wrapper.findAll('.auto-translate-scope-menu button')[1].trigger('click');
      expect(mockUseAutoTranslateRules.openManageRules).toHaveBeenCalledOnce();
    });

    it("should not invoke toggleAutoTranslateForCurrentPage on click if disabled", async () => {
      mockUseAutoTranslateRules.isAutoTranslateToggleVisible.value = true;
      mockUseAutoTranslateRules.isAutoTranslateToggleDisabled.value = true;

      const wrapper = mount(PageTranslationButton, {
        props: { showAutoTranslateToggle: true },
      });

      await wrapper.find(".page-translate-star-btn").trigger("click");
      expect(wrapper.find('[role="group"]').exists()).toBe(true);
    });

    it("should not trigger page translation when star button is clicked", async () => {
      mockUseAutoTranslateRules.isAutoTranslateToggleVisible.value = true;
      mockUseAutoTranslateRules.isAutoTranslateToggleDisabled.value = false;

      const wrapper = mount(PageTranslationButton, {
        props: { showAutoTranslateToggle: true },
      });

      await wrapper.find(".page-translate-star-btn").trigger("click");
      expect(mockUsePageTranslation.translatePage).not.toHaveBeenCalled();
    });

    it("labels the star as a scope chooser and exposes scope states on its menu items", async () => {
      mockUseAutoTranslateRules.isAutoTranslateToggleVisible.value = true;
      mockUseAutoTranslateRules.isActive.value = false;
      mockUseAutoTranslateRules.hasPageRule.value = true;

      const wrapper = mount(PageTranslationButton, {
        props: { showAutoTranslateToggle: true },
      });

      const btn = wrapper.find(".page-translate-star-btn");
      expect(btn.attributes("title")).toBe("auto_translate_scope_menu_label");
      expect(btn.attributes("aria-label")).toBe("auto_translate_scope_menu_label");
      expect(btn.attributes("aria-pressed")).toBeUndefined();
      expect(btn.attributes("aria-haspopup")).toBeUndefined();
      await btn.trigger('click');
      const group = wrapper.find('[role="group"]');
      expect(group.attributes('aria-label')).toBe('auto_translate_scope_menu_label');
      expect(group.findAll('button')[0].attributes('aria-pressed')).toBe('true');
      expect(wrapper.find('[role="menuitemcheckbox"]').exists()).toBe(false);
      expect(wrapper.find('[role="menu"]').exists()).toBe(false);
    });

    it('closes on Escape and returns focus to the trigger', async () => {
      mockUseAutoTranslateRules.isAutoTranslateToggleVisible.value = true;
      const wrapper = mount(PageTranslationButton, {
        props: { showAutoTranslateToggle: true },
        attachTo: document.body,
      });
      const trigger = wrapper.get('.page-translate-star-btn');
      await trigger.trigger('click');
      expect(wrapper.get('[role="group"]').exists()).toBe(true);

      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await wrapper.vm.$nextTick();
      expect(wrapper.find('[role="group"]').exists()).toBe(false);
      expect(document.activeElement).toBe(trigger.element);
      wrapper.unmount();
    });

    it('closes when pointerdown occurs outside the scope chooser', async () => {
      mockUseAutoTranslateRules.isAutoTranslateToggleVisible.value = true;
      const wrapper = mount(PageTranslationButton, { props: { showAutoTranslateToggle: true } });
      await wrapper.get('.page-translate-star-btn').trigger('click');
      document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
      await wrapper.vm.$nextTick();
      expect(wrapper.find('[role="group"]').exists()).toBe(false);
    });

    it("should define the inherited aria-label key in en/fa/ja locales", () => {
      const key = "page_translation_auto_translate_inherited_label";
      for (const messages of [enMessages, faMessages, jaMessages]) {
        expect(messages[key]?.message, key).toBeTruthy();
      }
    });
  });

  describe("compact status badge rendering", () => {
    it("renders both spinner and status badge when compact + translating", async () => {
      mockUsePageTranslation.isTranslating.value = true;
      const wrapper = mount(PageTranslationButton, { props: { compact: true } });
      await wrapper.vm.$nextTick();

      expect(wrapper.classes()).toContain("compact-wrapper");
      expect(wrapper.findComponent({ name: "LoadingSpinner" }).exists()).toBe(true);
      expect(wrapper.findComponent({ name: "PageTranslationStatus" }).exists()).toBe(true);
      const badge = wrapper.find(".ti-btn-status-badge");
      expect(badge.exists()).toBe(true);
      // Badge lives inside the 22×22 status container alongside the spinner.
      expect(wrapper.find(".ti-btn-status-container .ti-btn-status-badge").exists()).toBe(true);
    });

    it("renders both spinner and status badge when compact + auto-translating", async () => {
      mockUsePageTranslation.isAutoTranslating.value = true;
      const wrapper = mount(PageTranslationButton, { props: { compact: true } });
      await wrapper.vm.$nextTick();

      expect(wrapper.findComponent({ name: "LoadingSpinner" }).exists()).toBe(true);
      expect(wrapper.find(".ti-btn-status-badge").exists()).toBe(true);
    });

    it("still renders the status badge for completed and error states in compact", async () => {
      mockUsePageTranslation.isTranslated.value = true;
      mockUsePageTranslation.canRestore.value = true;
      const completed = mount(PageTranslationButton, { props: { compact: true } });
      await completed.vm.$nextTick();
      expect(completed.find(".ti-btn-status-badge").exists()).toBe(true);
      // Completed state: no spinner.
      expect(completed.findComponent({ name: "LoadingSpinner" }).exists()).toBe(false);

      mockUsePageTranslation.isTranslated.value = false;
      mockUsePageTranslation.hasError.value = true;
      const errored = mount(PageTranslationButton, { props: { compact: true } });
      await errored.vm.$nextTick();
      expect(errored.find(".ti-btn-status-badge").exists()).toBe(true);
    });

    it("status badge carries no interaction semantics (decorative, non-focusable)", async () => {
      mockUsePageTranslation.isTranslating.value = true;
      const wrapper = mount(PageTranslationButton, { props: { compact: true } });
      await wrapper.vm.$nextTick();

      const badge = wrapper.find(".ti-btn-status-badge");
      expect(badge.exists()).toBe(true);
      expect(badge.element.tagName).toBe("DIV");
      expect(badge.attributes("tabindex")).toBeUndefined();
      expect(badge.attributes("role")).toBeUndefined();
      expect(badge.attributes("aria-label")).toBeUndefined();
      // Not a clickable target: no button/a wrapper semantics on the badge.
      expect(badge.attributes("type")).toBeUndefined();
      expect(badge.attributes("href")).toBeUndefined();
    });
  });

  describe("corner status badge (statusBadgePosition)", () => {
    const cornerProps = { compact: true, statusBadgePosition: "corner" };

    it("renders exactly ONE PageTranslationStatus, root-level (outside the status container)", async () => {
      mockUsePageTranslation.isTranslating.value = true;
      const wrapper = mount(PageTranslationButton, { props: cornerProps });
      await wrapper.vm.$nextTick();

      expect(
        wrapper.findAllComponents({ name: "PageTranslationStatus" }),
      ).toHaveLength(1);
      const corner = wrapper.find(".ti-compact-corner-status-badge");
      expect(corner.exists()).toBe(true);
      // Root-level: direct child of .page-translation-controls, never inside
      // the 22×22 .ti-btn-status-container; inner badge suppressed.
      expect(corner.element.parentElement).toBe(wrapper.element);
      expect(
        wrapper.find(".ti-btn-status-container .ti-compact-corner-status-badge")
          .exists(),
      ).toBe(false);
      expect(wrapper.find(".ti-btn-status-badge").exists()).toBe(false);
    });

    it("still centers the LoadingSpinner inside .ti-btn-status-container while translating", async () => {
      mockUsePageTranslation.isTranslating.value = true;
      const wrapper = mount(PageTranslationButton, { props: cornerProps });
      await wrapper.vm.$nextTick();

      expect(
        wrapper
          .find(".ti-btn-status-container")
          .findComponent({ name: "LoadingSpinner" })
          .exists(),
      ).toBe(true);
      // Spinner stays in the container; the corner badge never replaces it.
      expect(wrapper.find(".ti-compact-corner-status-badge").exists()).toBe(true);
    });

    it("auto-translating: spinner stays in the container, one corner status with the translating payload", async () => {
      mockUsePageTranslation.isAutoTranslating.value = true;
      mockUsePageTranslation.progress.value = 40;
      const wrapper = mount(PageTranslationButton, { props: cornerProps });
      await wrapper.vm.$nextTick();

      expect(
        wrapper
          .find(".ti-btn-status-container")
          .findComponent({ name: "LoadingSpinner" })
          .exists(),
      ).toBe(true);
      const statuses = wrapper.findAllComponents({
        name: "PageTranslationStatus",
      });
      expect(statuses).toHaveLength(1);
      expect(statuses[0].props("statusData")).toEqual({
        isTranslating: false,
        isAutoTranslating: true,
        isTranslated: false,
        progress: 40,
      });
      expect(wrapper.find(".ti-btn-status-badge").exists()).toBe(false);
    });

    it("completed and error states still render the corner status (exactly one)", async () => {
      mockUsePageTranslation.isTranslated.value = true;
      mockUsePageTranslation.canRestore.value = true;
      const completed = mount(PageTranslationButton, { props: cornerProps });
      await completed.vm.$nextTick();
      expect(
        completed.find(".ti-compact-corner-status-badge").exists(),
      ).toBe(true);
      expect(
        completed.findAllComponents({ name: "PageTranslationStatus" }),
      ).toHaveLength(1);
      expect(
        completed
          .findComponent({ name: "PageTranslationStatus" })
          .props("statusData"),
      ).toEqual({ isTranslated: true, isTranslating: false, isAutoTranslating: false });
      // Completed: no spinner.
      expect(
        completed.findComponent({ name: "LoadingSpinner" }).exists(),
      ).toBe(false);

      mockUsePageTranslation.isTranslated.value = false;
      mockUsePageTranslation.hasError.value = true;
      const errored = mount(PageTranslationButton, { props: cornerProps });
      await errored.vm.$nextTick();
      expect(errored.find(".ti-compact-corner-status-badge").exists()).toBe(true);
      expect(
        errored.findAllComponents({ name: "PageTranslationStatus" }),
      ).toHaveLength(1);
      expect(
        errored.findComponent({ name: "PageTranslationStatus" }).props("statusData"),
      ).toEqual({ hasError: true });
      expect(errored.find(".ti-btn-status-badge").exists()).toBe(false);
    });

    it("renders NO corner status when idle without a previous error", async () => {
      const wrapper = mount(PageTranslationButton, { props: cornerProps });
      await wrapper.vm.$nextTick();

      expect(wrapper.find(".ti-compact-corner-status-badge").exists()).toBe(false);
      expect(
        wrapper.findAllComponents({ name: "PageTranslationStatus" }),
      ).toHaveLength(0);
    });

    it('statusBadgePosition="inner" preserves the existing internal badge path', async () => {
      mockUsePageTranslation.isTranslating.value = true;
      const wrapper = mount(PageTranslationButton, {
        props: { compact: true, statusBadgePosition: "inner" },
      });
      await wrapper.vm.$nextTick();

      expect(
        wrapper.find(".ti-btn-status-container .ti-btn-status-badge").exists(),
      ).toBe(true);
      expect(wrapper.find(".ti-compact-corner-status-badge").exists()).toBe(false);
      expect(
        wrapper.findAllComponents({ name: "PageTranslationStatus" }),
      ).toHaveLength(1);
    });

    it("default compact (Sidepanel-style, prop omitted) stays inner", async () => {
      mockUsePageTranslation.isTranslating.value = true;
      const wrapper = mount(PageTranslationButton, { props: { compact: true } });
      await wrapper.vm.$nextTick();

      expect(
        wrapper.find(".ti-btn-status-container .ti-btn-status-badge").exists(),
      ).toBe(true);
      expect(wrapper.find(".ti-compact-corner-status-badge").exists()).toBe(false);
      expect(
        wrapper.findAllComponents({ name: "PageTranslationStatus" }),
      ).toHaveLength(1);
    });

    it("corner status is non-interactive (decorative, non-focusable)", async () => {
      mockUsePageTranslation.hasError.value = true;
      const wrapper = mount(PageTranslationButton, { props: cornerProps });
      await wrapper.vm.$nextTick();

      const badge = wrapper.find(".ti-compact-corner-status-badge");
      expect(badge.exists()).toBe(true);
      expect(badge.element.tagName).toBe("DIV");
      expect(badge.attributes("tabindex")).toBeUndefined();
      expect(badge.attributes("role")).toBeUndefined();
      expect(badge.attributes("aria-label")).toBeUndefined();
      expect(badge.attributes("type")).toBeUndefined();
      expect(badge.attributes("href")).toBeUndefined();
    });

    it("compact + corner + textOnly does NOT render the corner badge", async () => {
      mockUsePageTranslation.isTranslating.value = true;
      const wrapper = mount(PageTranslationButton, {
        props: { ...cornerProps, textOnly: true },
      });
      await wrapper.vm.$nextTick();

      expect(wrapper.find(".ti-compact-corner-status-badge").exists()).toBe(false);
      // textOnly branch: anchor link, not the compact BaseButton.
      expect(wrapper.find("a.toolbar-link").exists()).toBe(true);
    });

    it("textOnly + corner still renders exactly ONE existing text status", async () => {
      mockUsePageTranslation.isTranslating.value = true;
      const wrapper = mount(PageTranslationButton, {
        props: { ...cornerProps, textOnly: true },
      });
      await wrapper.vm.$nextTick();

      const statuses = wrapper.findAllComponents({
        name: "PageTranslationStatus",
      });
      expect(statuses).toHaveLength(1);
      // The one status is the text-only badge, not the corner variant.
      expect(wrapper.find(".ti-text-status-badge").exists()).toBe(true);
      expect(wrapper.find(".ti-compact-corner-status-badge").exists()).toBe(false);
    });

    it("compact non-textOnly + corner still renders exactly ONE root-level corner status", async () => {
      mockUsePageTranslation.isTranslating.value = true;
      const wrapper = mount(PageTranslationButton, { props: cornerProps });
      await wrapper.vm.$nextTick();

      const statuses = wrapper.findAllComponents({
        name: "PageTranslationStatus",
      });
      expect(statuses).toHaveLength(1);
      const corner = wrapper.find(".ti-compact-corner-status-badge");
      expect(corner.exists()).toBe(true);
      expect(corner.element.parentElement).toBe(wrapper.element);
      expect(wrapper.find(".ti-text-status-badge").exists()).toBe(false);
      expect(wrapper.find(".ti-btn-status-badge").exists()).toBe(false);
    });

    it("default/inner behavior unchanged with textOnly present (no corner leakage)", async () => {
      mockUsePageTranslation.isTranslating.value = true;
      const wrapper = mount(PageTranslationButton, {
        props: { compact: true, textOnly: true },
      });
      await wrapper.vm.$nextTick();

      expect(wrapper.find(".ti-compact-corner-status-badge").exists()).toBe(false);
      expect(
        wrapper.findAllComponents({ name: "PageTranslationStatus" }),
      ).toHaveLength(1);
      expect(wrapper.find(".ti-text-status-badge").exists()).toBe(true);
    });
  });

  describe("compact disabled rendering contract", () => {
    it("compact + disabled renders native disabled and .ti-btn--disabled", () => {
      const wrapper = mount(PageTranslationButton, {
        props: { compact: true, disabled: true },
      });
      const btn = wrapper.find(".is-compact-icon");
      expect(btn.exists()).toBe(true);
      expect(btn.attributes("disabled")).toBeDefined();
      expect(btn.classes()).toContain("ti-btn--disabled");
    });

    it("compact + enabled does NOT render disabled / .ti-btn--disabled", () => {
      const wrapper = mount(PageTranslationButton, {
        props: { compact: true },
      });
      const btn = wrapper.find(".is-compact-icon");
      expect(btn.attributes("disabled")).toBeUndefined();
      expect(btn.classes()).not.toContain("ti-btn--disabled");
    });
  });
});
