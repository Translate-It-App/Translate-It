<template>
  <div
    class="ti-translation-icon"
    :class="{ dark: isDarkTheme }"
    data-translate-ui="true"
    role="toolbar"
    aria-label="Text selection tools"
  >
    <button
      v-if="showTranslate"
      class="ti-icon-btn ti-icon-btn--translate"
      :title="translateTitle"
      :aria-label="translateAriaLabel || translateTitle"
      role="button"
      tabindex="0"
      @click.stop.prevent="emit('translate')"
      @pointerdown.stop.prevent="emit('translate-pointerdown', $event)"
      @mouseup.left.prevent.stop
      @contextmenu.stop
      @keydown="onKeydownTranslate"
    >
      <svg
        class="ti-icon-btn__svg"
        viewBox="0 0 64 64"
        xmlns="http://www.w3.org/2000/svg"
        aria-hidden="true"
      >
        <g><path
          fill="#0fa438"
          d="M 1.5,-0.5 C 10.5,-0.5 19.5,-0.5 28.5,-0.5C 30.4285,3.28543 31.7618,7.28543 32.5,11.5C 33.5946,16.7841 35.2613,21.7841 37.5,26.5C 37.8333,27.8333 38.1667,29.1667 38.5,30.5C 39.6047,34.3517 40.938,38.0184 42.5,41.5C 43.1098,42.391 43.4431,43.391 43.5,44.5C 43.4326,45.9587 43.7659,47.2921 44.5,48.5C 39.5,49.1667 34.5,49.8333 29.5,50.5C 19.4176,50.8074 9.41756,50.4741 -0.5,49.5C -0.5,33.5 -0.5,17.5 -0.5,1.5C 0.5,1.16667 1.16667,0.5 1.5,-0.5 Z"
        /></g>
        <g><path
          fill="#e1eae1"
          d="M 16.5,10.5 C 17.8221,10.33 18.9887,10.6634 20,11.5C 23.3371,19.3461 26.1705,27.3461 28.5,35.5C 27.1779,35.67 26.0113,35.3366 25,34.5C 24.6954,29.6915 22.1954,27.6915 17.5,28.5C 15.8333,28.8333 14.1667,29.1667 12.5,29.5C 11.8333,31.1667 11.1667,32.8333 10.5,34.5C 9.27704,35.6139 7.94371,35.7805 6.5,35C 9.70148,26.7659 13.0348,18.5992 16.5,10.5 Z"
        /></g>
        <g><path
          fill="#25a640"
          d="M 20.5,23.5 C 18.7354,24.4614 16.7354,24.7947 14.5,24.5C 15.562,21.4844 16.7286,18.4844 18,15.5C 19.1356,18.0964 19.969,20.763 20.5,23.5 Z"
        /></g>
        <g><path
          fill="#6a8491"
          d="M 43.5,44.5 C 43.4431,43.391 43.1098,42.391 42.5,41.5C 46.3171,39.3756 46.3171,37.0423 42.5,34.5C 43.2421,33.7132 44.0754,33.0465 45,32.5C 47.8245,36.6749 49.9912,36.3416 51.5,31.5C 47.2172,30.5078 42.8839,30.1744 38.5,30.5C 38.1667,29.1667 37.8333,27.8333 37.5,26.5C 40.5,26.5 43.5,26.5 46.5,26.5C 46.5,25.5 46.5,24.5 46.5,23.5C 47.8333,23.5 49.1667,23.5 50.5,23.5C 50.5,24.5 50.5,25.5 50.5,26.5C 53.5,26.5 56.5,26.5 59.5,26.5C 59.5,27.8333 59.5,29.1667 59.5,30.5C 58.1667,30.5 56.8333,30.5 55.5,30.5C 54.7263,33.3809 53.3929,36.0476 51.5,38.5C 52.5794,40.543 54.246,41.8763 56.5,42.5C 57.7445,43.9554 57.5778,45.2887 56,46.5C 53.5426,45.0222 51.0426,43.6888 48.5,42.5C 46.8228,43.1869 45.1561,43.8535 43.5,44.5 Z"
        /></g>
        <g><path
          fill="#93c298"
          d="M 20.5,23.5 C 21.0431,23.56 21.3764,23.8933 21.5,24.5C 19.0268,25.7969 16.6934,25.7969 14.5,24.5C 16.7354,24.7947 18.7354,24.4614 20.5,23.5 Z"
        /></g>
        <g><path
          fill="#e5eae8"
          d="M 38.5,30.5 C 42.8839,30.1744 47.2172,30.5078 51.5,31.5C 49.9912,36.3416 47.8245,36.6749 45,32.5C 44.0754,33.0465 43.2421,33.7132 42.5,34.5C 46.3171,37.0423 46.3171,39.3756 42.5,41.5C 40.938,38.0184 39.6047,34.3517 38.5,30.5 Z"
        /></g>
        <g><path
          fill="#f0f1f1"
          d="M 32.5,11.5 C 42.9154,11.1917 53.2487,11.525 63.5,12.5C 63.5,28.8333 63.5,45.1667 63.5,61.5C 62.5,61.8333 61.8333,62.5 61.5,63.5C 52.5,63.5 43.5,63.5 34.5,63.5C 34.5,63.1667 34.5,62.8333 34.5,62.5C 38.1803,58.817 41.5136,54.817 44.5,50.5C 45.8333,49.8333 45.8333,49.1667 44.5,48.5C 43.7659,47.2921 43.4326,45.9587 43.5,44.5C 45.1561,43.8535 46.8228,43.1869 48.5,42.5C 51.0426,43.6888 53.5426,45.0222 56,46.5C 57.5778,45.2887 57.7445,43.9554 56.5,42.5C 54.246,41.8763 52.5794,40.543 51.5,38.5C 53.3929,36.0476 54.7263,33.3809 55.5,30.5C 56.8333,30.5 58.1667,30.5 59.5,30.5C 59.5,29.1667 59.5,27.8333 59.5,26.5C 56.5,26.5 53.5,26.5 50.5,26.5C 50.5,25.5 50.5,24.5 50.5,23.5C 49.1667,23.5 47.8333,23.5 46.5,23.5C 46.5,24.5 46.5,25.5 46.5,26.5C 43.5,26.5 40.5,26.5 37.5,26.5C 35.2613,21.7841 33.5946,16.7841 32.5,11.5 Z"
        /></g>
        <g><path
          fill="#2d9397"
          d="M 44.5,48.5 C 45.8333,49.1667 45.8333,49.8333 44.5,50.5C 39.5,50.5 34.5,50.5 29.5,50.5C 34.5,49.8333 39.5,49.1667 44.5,48.5 Z"
        /></g>
        <g><path
          fill="#1c66c0"
          d="M 29.5,50.5 C 34.5,50.5 39.5,50.5 44.5,50.5C 41.5136,54.817 38.1803,58.817 34.5,62.5C 32.8346,58.505 31.1679,54.505 29.5,50.5 Z"
        /></g>
      </svg>
    </button>

    <button
      v-if="showTts"
      class="ti-icon-btn"
      :class="ttsClasses"
      :title="ttsTitle"
      :aria-label="ttsAriaLabel || ttsTitle"
      role="button"
      tabindex="0"
      @click.stop.prevent="emit('tts')"
      @pointerdown.stop.prevent="emit('tts-pointerdown', $event)"
      @mouseup.left.prevent.stop
      @contextmenu.stop
      @keydown="onKeydownTTS"
    >
      <svg
        v-if="ttsState === 'idle'"
        class="ti-icon-btn__svg"
        viewBox="0 0 24 24"
      >
        <path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z" />
      </svg>

      <svg
        v-else-if="ttsState === 'loading'"
        class="ti-icon-btn__svg"
        viewBox="0 0 24 24"
      >
        <path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02z" />
        <path
          opacity="0.5"
          d="M14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z"
        />
      </svg>

      <svg
        v-else-if="ttsState === 'playing'"
        class="ti-icon-btn__svg"
        viewBox="0 0 24 24"
      >
        <path d="M6 6h12v12H6z" />
      </svg>

      <svg
        v-else-if="ttsState === 'error'"
        class="ti-icon-btn__svg"
        viewBox="0 0 24 24"
      >
        <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z" />
      </svg>
    </button>
  </div>
</template>

<script setup>
import { computed } from 'vue'
import './SelectionActionPill.scss'

defineOptions({
  name: 'SelectionActionPill'
})

const props = defineProps({
  theme: {
    type: String,
    default: 'light'
  },
  showTranslate: {
    type: Boolean,
    default: true
  },
  showTts: {
    type: Boolean,
    default: true
  },
  translateTitle: {
    type: String,
    default: ''
  },
  translateAriaLabel: {
    type: String,
    default: ''
  },
  ttsTitle: {
    type: String,
    default: ''
  },
  ttsAriaLabel: {
    type: String,
    default: ''
  },
  ttsState: {
    type: String,
    default: 'idle'
  }
})

const emit = defineEmits([
  'translate',
  'translate-pointerdown',
  'tts',
  'tts-pointerdown'
])

const isDarkTheme = computed(() => props.theme === 'dark')

const ttsClasses = computed(() => [
  {
    'ti-icon-btn--playing': props.ttsState === 'playing',
    'ti-icon-btn--loading': props.ttsState === 'loading',
    'ti-icon-btn--error': props.ttsState === 'error'
  }
])

function onKeydownTranslate(event) {
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault()
    emit('translate')
  }
}

function onKeydownTTS(event) {
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault()
    emit('tts')
  }
}
</script>
