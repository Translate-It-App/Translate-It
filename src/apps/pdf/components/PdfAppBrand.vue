<template>
  <div class="pdf-app-brand">
    <img
      class="pdf-app-brand__icon"
      :src="iconSrc"
      :alt="title"
      width="20"
      height="20"
    >
    <div class="pdf-app-brand__text">
      <span
        class="pdf-app-brand__title"
        dir="auto"
      >{{ title }}</span>
      <span
        class="pdf-app-brand__subtitle"
        dir="auto"
      >{{ subtitle }}</span>
    </div>
  </div>
</template>

<script setup>
defineProps({
  iconSrc: {
    type: String,
    required: true
  },
  title: {
    type: String,
    required: true
  },
  subtitle: {
    type: String,
    required: true
  }
})
</script>

<style lang="scss" scoped>
@use 'toolbar-colors' as *;
@use '../../../assets/styles/base/brand-tokens' as *;

.pdf-app-brand {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.pdf-app-brand__icon {
  width: 20px;
  height: 20px;
  display: block;
  flex-shrink: 0;
}

.pdf-app-brand__text {
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
}

.pdf-app-brand__title {
  font-size: 13px;
  font-weight: 600;
  line-height: 1.15;
  color: $tb-text-primary;
  background: linear-gradient(90deg, $brand-title-gradient-dark-start, $brand-title-gradient-dark-end);
  -webkit-background-clip: text;
  background-clip: text;
  -webkit-text-fill-color: transparent;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.pdf-app-brand__subtitle {
  font-size: 10px;
  font-weight: 400;
  line-height: 1.2;
  color: $tb-text-secondary;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
</style>
