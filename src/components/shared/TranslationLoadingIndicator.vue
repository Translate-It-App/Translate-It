<template>
  <div
    class="ti-translation-loading-indicator"
    role="status"
  >
    <span
      class="ti-translation-loading-indicator-eyes"
      aria-hidden="true"
    >
      <span class="ti-translation-loading-indicator-eye">
        <span class="ti-translation-loading-indicator-pupil" />
      </span>
      <span class="ti-translation-loading-indicator-eye">
        <span class="ti-translation-loading-indicator-pupil" />
      </span>
    </span>
    <span class="ti-translation-loading-indicator-label">{{ label }}</span>
  </div>
</template>

<script setup>
import "./TranslationLoadingIndicator.scss";

defineProps({
  label: {
    type: String,
    default: "Translating...",
  },
});
</script>
