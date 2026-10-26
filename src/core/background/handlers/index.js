// src/background/handlers/index.js
// This file serves as a barrel file, importing and exporting all individual handlers.

// Common handlers
export * from "./lazy/handleCommonLazy.js";
export * from "./common/handleShowOSNotification.js";
export * from "./common/handleContentScriptWillReload.js";

// Lifecycle handlers
export * from "./lifecycle/handleContextInvalid.js";
export * from "./lifecycle/handleExtensionReloaded.js";
export * from "./lifecycle/handleRestartContentScript.js";
export * from "./lifecycle/handleBackgroundReloadExtension.js";

// Translation handlers
export * from "./lazy/handleTranslationLazy.js";

// TTS handlers - Lazy loaded for better performance
export * from "./lazy/handleTTSLazy.js";

// Element selection handlers - Lazy loaded for better performance
export * from "./lazy/handleElementSelectionLazy.js";

// Screen capture handlers - Lazy loaded for better performance
export * from "./lazy/handleScreenCaptureLazy.js";

// Text selection handlers
export * from "./text-selection/handleGetSelectedText.js";
export * from "./text-selection/handlePendingDisplayInvalidation.js";

// Page exclusion handlers
export * from "./page-exclusion/handleIsCurrentPageExcluded.js";
export * from "./page-exclusion/handleSetExcludeCurrentPage.js";

// Page translation handlers
export * from "./page-translation/handlePageTranslation.js";
export * from "./mouse-hover/handleMouseHoverFrameEvent.js";

// Sidepanel handlers
export * from "./sidepanel/handleOpenSidePanel.js";

// Vue integration handlers - Lazy loaded for better performance
export * from "./lazy/handleVueIntegrationLazy.js";

// Subtitle translation handlers
export * from "./subtitle/handleSubtitleTranslation.js";
