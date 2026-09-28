<template>
  <section
    class="ti-live-dubbing-control"
    :aria-label="t('popup_view_live_dubbing', 'Live Dubbing')"
  >
    <!-- Section 1: Status + primary action row -->
    <div class="ti-live-dubbing-control-action-row">
      <span
        v-if="statusText"
        class="ti-live-dubbing-wave"
        :class="`ti-live-dubbing-wave--${waveState}`"
        aria-hidden="true"
      >
        <span
          v-for="bar in 5"
          :key="bar"
          class="ti-live-dubbing-wave__bar"
        />
      </span>
      <span
        class="ti-live-dubbing-control-status"
        dir="auto"
        aria-live="polite"
      >{{ statusText }}</span>

      <BaseButton
        v-if="!isRunning && !isStopping"
        size="sm"
        :disabled="startDisabled || isUnavailable || isLoading || isStarting || isStopping || isCleanupPending"
        :text="t('live_dubbing_action_start', 'Start')"
        :aria-label="t('live_dubbing_action_start_aria_label', 'Start live dubbing')"
        @click="start"
      />
      <BaseButton
        v-if="isRunning || isStopping"
        size="sm"
        variant="danger"
        :disabled="isStopping"
        :text="isCleanupPending ? t('live_dubbing_action_cleanup', 'Clean up') : t('live_dubbing_action_stop', 'Stop')"
        :aria-label="isCleanupPending ? t('live_dubbing_action_cleanup_aria_label', 'Clean up live dubbing') : t('live_dubbing_action_stop_aria_label', 'Stop live dubbing')"
        @click="stop"
      />
      <BaseButton
        v-if="isCleanupPending"
        size="sm"
        variant="danger"
        :text="t('live_dubbing_action_cleanup', 'Clean up')"
        :aria-label="t('live_dubbing_action_cleanup_aria_label', 'Clean up live dubbing')"
        @click="stop"
      />
    </div>

    <p
      v-if="showUnavailableExplanation"
      class="ti-live-dubbing-control-unavailable"
      dir="auto"
      role="status"
    >
      {{ unavailableExplanation }}
    </p>

    <!-- Section 2: Status / error messages -->
    <p
      v-if="showErrorParagraph"
      class="ti-live-dubbing-control-error"
      dir="auto"
      role="alert"
    >
      {{ errorParagraphText }}
    </p>

    <!-- Section 2b: Non-terminal transcript-delivery note (subtitles only) -->
    <p
      v-if="showSubtitlesUnavailableNote"
      class="ti-live-dubbing-control-volume-error"
      role="status"
    >
      {{ t('live_dubbing_subtitles_unavailable', 'Subtitles unavailable on this tab.') }}
    </p>

    <!-- Section 3: Volume controls -->
    <div
      v-if="showVolumeControl"
      class="ti-live-dubbing-control-volumes"
    >
      <div class="ti-live-dubbing-control-volume">
        <label
          class="ti-live-dubbing-control-volume-label"
          for="ti-live-dubbing-volume"
        >{{ t('live_dubbing_volume_original_label', 'Original') }}</label>
        <input
          id="ti-live-dubbing-volume"
          type="range"
          class="ti-live-dubbing-control-volume-slider"
          min="0"
          max="100"
          step="1"
          :value="displayVolume ?? 0"
          :disabled="!isVolumeControllable || !volumeResolved"
          @input="onVolumeInput"
        >
        <span
          class="ti-live-dubbing-control-volume-value"
          aria-live="polite"
        >{{ displayVolume != null ? displayVolume + '%' : '—' }}</span>
      </div>

      <div class="ti-live-dubbing-control-volume">
        <label
          class="ti-live-dubbing-control-volume-label"
          for="ti-live-dubbing-dubbed-volume"
        >{{ t('live_dubbing_volume_dubbed_label', 'Dubbed Volume') }}</label>
        <input
          id="ti-live-dubbing-dubbed-volume"
          type="range"
          class="ti-live-dubbing-control-volume-slider"
          min="0"
          max="100"
          step="1"
          :value="displayDubbedVolume ?? 0"
          :disabled="!isVolumeControllable || !dubbedVolumeResolved"
          @input="onDubbedVolumeInput"
        >
        <span
          class="ti-live-dubbing-control-volume-value"
          aria-live="polite"
        >{{ displayDubbedVolume != null ? displayDubbedVolume + '%' : '—' }}</span>
      </div>
    </div>

    <p
      v-if="volumeError"
      class="ti-live-dubbing-control-volume-error"
      role="status"
    >
      {{ volumeError }}
    </p>

    <p
      v-if="dubbedVolumeError"
      class="ti-live-dubbing-control-volume-error"
      role="status"
    >
      {{ dubbedVolumeError }}
    </p>
  </section>
</template>

<script setup>
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import BaseButton from '@/components/base/BaseButton.vue'
import { useMessaging } from '@/shared/messaging/composables/useMessaging.js'
import { MessageContexts } from '@/shared/messaging/core/MessagingConstants.js'
import './LiveDubbingControl.scss'
import {
  LIVE_DUBBING_ACTIONS,
  LIVE_DUBBING_PROVIDER_IDS,
  LIVE_DUBBING_PROVIDER_ID
} from '@/features/live-dubbing/constants.js'
import { isAuthorizedLiveDubbingOffscreenControlSender } from '@/features/live-dubbing/contracts.js'
import { useUnifiedI18n } from '@/composables/shared/useUnifiedI18n.js'

const { t } = useUnifiedI18n()

const props = defineProps({
  targetLanguage: {
    type: String,
    required: true
  },
  providerId: {
    type: String,
    default: LIVE_DUBBING_PROVIDER_ID,
    validator: (value) => LIVE_DUBBING_PROVIDER_IDS.includes(value)
  },
  startDisabled: {
    type: Boolean,
    default: false
  }
})

const emit = defineEmits(['busy-change', 'status-resolved'])
const { sendMessage } = useMessaging(MessageContexts.POPUP)
const extensionBrowser = typeof browser !== 'undefined' ? browser : null
const SAFE_TERMINAL_ERROR = /^[A-Za-z][A-Za-z0-9_.-]{0,79}$/
const state = ref('loading')
const authoritativeStatus = ref(null)
const sessionId = ref(null)
const sessionDescriptor = ref(null)
const sessionProviderId = ref(null)
const errorMessage = ref('')
const terminalOutcome = ref(null)
// ── Transcript-delivery availability (presentation-only) ─────────────────────
// Sanitized `transcriptDeliveryUnavailable` values, keyed by authoritative
// session identity. Presentation-only: no payloads, errors, or persistence.
const subtitlesUnavailableBySession = ref(new Map())

// ── Presentation-only loading delay ──────────────────────────────────────────
// The initial GET_LIVE_DUBBING_STATUS read can resolve quickly for a cached
// session. The first 150ms while it is still pending render no status text
// (not "Ready", not "Checking availability…"); only if it is still pending
// after 150ms does "Checking availability…" appear. A resolve within the
// window goes straight to the authoritative status. This only gates
// presentation — the GET request, lifecycle ownership, behavioral loading
// (Start disabled), and status resolution are not delayed.
const pendingStatusReveal = ref(false)
const statusRevealTimerElapsed = ref(false)
const isInitialStatusLoadingVisible = computed(() =>
  state.value === 'loading' && pendingStatusReveal.value && statusRevealTimerElapsed.value
)
let statusRevealTimer = null
const LOADING_PRESENTATION_DELAY_MS = 150
let operationGeneration = 0
// Presentation-only ordering, fully independent from operationGeneration.
// Tokens are scoped to their session so an old-session notification cannot
// fence a different session's status read or refresh.
let subtitlesRefreshGeneration = 0
let subtitlesRefreshEpoch = 0
const subtitlesRefreshGenerations = new Map()
let removeRuntimeListener = null
let initialStatusResolved = false

// ── Volume state (local only, no Pinia/storage) ──────────────────────────────
// desiredVolume: optimistic value the UI reflects, 0..1
// confirmedVolume: last backend-confirmed value, 0..1 — rollback target
// volumeResolved: true once the first queryOriginalVolume or sendVolume succeeds
// pendingVolumeShot: immutable {fence, volume, generation} snapshot captured at user-input
//   time for fence-scoped sends — prevents stale-session writes when the fence shifts
//   between scheduling and executing.  generation is bumped at input time so that any
//   older in-flight query/write is immediately invalidated when the user acts.
const desiredVolume = ref(null)
const confirmedVolume = ref(null)
const volumeResolved = ref(false)
const volumeError = ref('')
let volumeRequestGeneration = 0
let volumeThrottleTimer = null
const VOLUME_THROTTLE_MS = 80
let pendingVolumeShot = null
const volumeRecoveryInProgress = ref(false)
const MAX_VOLUME_RECOVERY_DEPTH = 1

// ── Dubbed volume state (local only, no Pinia/storage) ───────────────────────
// Mirrors the Original Volume state exactly, with an independent generation
// counter so a bump in one slider never discards pending ops of the other.
const desiredDubbedVolume = ref(null)
const confirmedDubbedVolume = ref(null)
const dubbedVolumeResolved = ref(false)
const dubbedVolumeError = ref('')
let dubbedVolumeRequestGeneration = 0
let dubbedVolumeThrottleTimer = null
const DUBBED_VOLUME_THROTTLE_MS = 80
let pendingDubbedVolumeShot = null
const dubbedVolumeRecoveryInProgress = ref(false)
const MAX_DUBBED_VOLUME_RECOVERY_DEPTH = 1

const isStarting = computed(() => state.value === 'starting')
const isRunning = computed(() => state.value === 'running')
const isStopping = computed(() => state.value === 'stopping')
const isCleanupPending = computed(() => state.value === 'cleanup')
const isTransitioning = computed(() => isStarting.value || isStopping.value)
const isUnavailable = computed(() => state.value === 'unavailable')
// Behavioral loading state — true whenever the initial status query is
// pending, independent of whether the loading text is presentation-visible.
// Start stays disabled for this entire window.
const isLoading = computed(() => state.value === 'loading')
const isIdle = computed(() => state.value === 'idle')
const isBusy = computed(() => isTransitioning.value || isRunning.value || isCleanupPending.value)
// Presentation-only: UI state is authoritative for the status line. State
// transitions, session retention and cleanup behavior are untouched.
const displayStatus = computed(() => {
  if (state.value === 'cleanup') return 'cleanup'
  // Local pending STOP always presents as "stopping" (same message as the
  // authoritative STOPPING stage) instead of a stale RUNNING/ERROR status.
  if (state.value === 'stopping') return 'stopping'
  return authoritativeStatus.value || state.value
})
const statusText = computed(() => {
  // Hidden initial-loading window: the GET is still pending and the
  // presentation delay has not elapsed — render no status text at all, so
  // fast reads never flash "Ready" or "Checking availability…". Once the
  // delay elapses the loading text shows; once resolved the authoritative
  // status replaces it immediately.
  if (state.value === 'loading' && !isInitialStatusLoadingVisible.value) return ''
  return ({
    loading: t('live_dubbing_status_loading', 'Checking availability…'),
    idle: t('live_dubbing_status_idle', 'Ready'),
    // Local transient states — explicit so they never fall through to the
    // generic "Error" fallback (e.g. Ready → Error → Running on START).
    starting: t('live_dubbing_status_starting', 'Starting…'),
    stopping: t('live_dubbing_status_stopping', 'Stopping…'),
    PREPARING_CAPTURE: t('live_dubbing_status_preparing_capture', 'Preparing capture…'),
    CONNECTING_PROVIDER: t('live_dubbing_status_connecting_provider', 'Connecting to provider…'),
    RUNNING: t('live_dubbing_status_running', 'Running'),
    STOPPING: t('live_dubbing_status_stopping', 'Stopping…'),
    ERROR: t('live_dubbing_status_error', 'Error'),
    unavailable: t('live_dubbing_status_unavailable', 'Unavailable'),
    cleanup: t('live_dubbing_status_cleanup', 'Cleanup required')
  }[displayStatus.value] || t('live_dubbing_status_error', 'Error'))
})
const waveState = computed(() => {
  if (['PREPARING_CAPTURE', 'CONNECTING_PROVIDER', 'starting'].includes(displayStatus.value)) return 'calm'
  if (['RUNNING', 'running'].includes(displayStatus.value)) return 'active'
  if (['STOPPING', 'stopping'].includes(displayStatus.value)) return 'slow'
  return 'static'
})

const isVolumeControllable = computed(() =>
  ['PREPARING_CAPTURE', 'CONNECTING_PROVIDER', 'RUNNING'].includes(authoritativeStatus.value)
    && !isStopping.value
)
const showVolumeControl = computed(() => isVolumeControllable.value && sessionId.value != null)
const displayVolume = computed(() => {
  if (!volumeResolved.value) return null
  const v = desiredVolume.value ?? confirmedVolume.value
  return Math.round(v * 100)
})
const displayDubbedVolume = computed(() => {
  if (!dubbedVolumeResolved.value) return null
  const v = desiredDubbedVolume.value ?? confirmedDubbedVolume.value
  return Math.round(v * 100)
})
const volumeFence = computed(() => {
  const d = sessionDescriptor.value
  return d ? `${d.sessionId}|${d.providerId}|${d.eventSequence ?? ''}` : null
})

const getErrorMessage = (error, fallback = 'Live dubbing failed.', providerId = sessionProviderId.value || props.providerId) => {
  if (error === 'LIVE_DUBBING_OFFSCREEN_LOST') {
    return t('live_dubbing_offscreen_lost_error')
  }
  if (error === 'LIVE_DUBBING_PROVIDER_BOOTSTRAP_UNAVAILABLE') {
    return providerId === 'openai'
      ? t('live_dubbing_provider_bootstrap_openai_error')
      : t('live_dubbing_provider_bootstrap_gemini_error')
  }
  if (error === 'LIVE_DUBBING_PROVIDER_SETUP_FAILED') {
    return t('live_dubbing_provider_setup_failed_error')
  }
  const hardcoded = {
    LIVE_DUBBING_UNSUPPORTED: 'Live dubbing is not supported in this browser.',
    INVALID_TARGET_LANGUAGE: 'This target language is not supported for live dubbing.'
  }
  return hardcoded[error] || (typeof error === 'string' && error ? error : fallback)
}

const unwrap = (response) => response?.data || response || {}

const normalizeTerminalOutcome = (value) => {
  if (!value || typeof value !== 'object'
    || !LIVE_DUBBING_PROVIDER_IDS.includes(value.providerId)
    || typeof value.error !== 'string' || !value.error.trim()
    || !SAFE_TERMINAL_ERROR.test(value.error.trim())
    || !Number.isFinite(value.occurredAt)) return null

  // The service worker owns sanitization. Keep a bounded scalar copy here and
  // deliberately discard providerDiagnostic before anything reaches the DOM.
  return {
    providerId: value.providerId,
    error: value.error.trim().slice(0, 240),
    occurredAt: value.occurredAt
  }
}

const nextOperationGeneration = () => {
  operationGeneration += 1
  return operationGeneration
}

// ── Unavailable-state explanation ──────────────────────────────────────────
// `state === 'unavailable'` has two distinct causes: the browser genuinely
// lacks the required APIs (LIVE_DUBBING_UNSUPPORTED), or a runtime /
// status-query / transport failure. The explanation reflects the concrete
// cause instead of always blaming the browser. The unavailable paragraph is
// suppressed when the error paragraph already shows the identical text, so a
// single failure never renders the same message twice.
/**
 * Presentation-only terminal outcome. With an active session/descriptor the
 * authoritative outcome is respected exactly as stored; with NO active
 * session, a persisted outcome from a previous provider (e.g. a Gemini error
 * seen after an idle switch to OpenAI) is ignored so it cannot bleed into
 * another provider's UI. Storage/background ownership is untouched.
 */
const displayTerminalOutcome = computed(() => {
  const outcome = terminalOutcome.value
  if (!outcome) return null
  if (sessionId.value != null || sessionDescriptor.value != null) return outcome
  return outcome.providerId === props.providerId ? outcome : null
})

const isUnsupportedCause = computed(() =>
  displayTerminalOutcome.value?.error === 'LIVE_DUBBING_UNSUPPORTED'
  || errorMessage.value === getErrorMessage('LIVE_DUBBING_UNSUPPORTED'))

const unavailableExplanation = computed(() => {
  if (!isUnavailable.value) return ''
  if (isUnsupportedCause.value) return getErrorMessage('LIVE_DUBBING_UNSUPPORTED')
  if (errorMessage.value) return errorMessage.value
  if (displayTerminalOutcome.value?.error) return getErrorMessage(displayTerminalOutcome.value.error)
  return t('live_dubbing_unavailable_generic', 'Live dubbing is currently unavailable.')
})

const errorParagraphText = computed(() => errorMessage.value
  || (isIdle.value && displayTerminalOutcome.value
    ? getErrorMessage(displayTerminalOutcome.value.error, 'Live dubbing failed.', displayTerminalOutcome.value.providerId)
    : ''))

const showUnavailableExplanation = computed(() => isUnavailable.value
  && !!unavailableExplanation.value
  && (isUnsupportedCause.value || unavailableExplanation.value !== errorMessage.value))

const showErrorParagraph = computed(() => {
  if (!errorParagraphText.value) return false
  // When the cause is genuinely unsupported, the unavailable paragraph carries
  // the canonical explanation. Suppress the error paragraph entirely so the
  // generic "Live dubbing is unavailable." (set by applyStatus) never bleeds
  // through alongside it. Generic unavailable failures still dedupe via the
  // same-text check below; other states are untouched.
  if (isUnavailable.value && isUnsupportedCause.value) return false
  if (showUnavailableExplanation.value && errorParagraphText.value === unavailableExplanation.value) return false
  return true
})

// Non-terminal subtitles note: shown only while a session is active and
// controllable (running or starting) AND the recorded presentation session
// matches the active session. Never affects START/STOP enablement,
// lifecycle logic, or existing paragraphs.
const showSubtitlesUnavailableNote = computed(() =>
  subtitlesUnavailableBySession.value.get(sessionId.value) === true
    && sessionId.value != null
    && (isRunning.value || isStarting.value))

const setSubtitlesUnavailable = (sessionId, unavailable) => {
  if (sessionId == null) return
  subtitlesUnavailableBySession.value.set(sessionId, unavailable)
}

const clearSubtitlesUnavailable = (sessionId = null) => {
  if (sessionId == null) subtitlesUnavailableBySession.value.clear()
  else subtitlesUnavailableBySession.value.delete(sessionId)
}

const captureSubtitlesSnapshot = () => ({
  generation: subtitlesRefreshGeneration,
  epoch: subtitlesRefreshEpoch
})

const isSubtitlesFenced = (sessionId, snapshot) => snapshot != null && (
  snapshot.epoch !== subtitlesRefreshEpoch
  || (subtitlesRefreshGenerations.get(sessionId) || 0) > snapshot.generation
)

const invalidateSubtitlesRefreshes = () => {
  subtitlesRefreshEpoch += 1
  subtitlesRefreshGenerations.clear()
}

const applyStatus = (response, { preserveSession = false, syncTerminalOutcome = false, subtitlesSnapshot = null } = {}) => {
  const result = unwrap(response)
  const descriptor = result.status && typeof result.status === 'object' ? result.status : result
  const nextTerminalOutcome = normalizeTerminalOutcome(result.terminalOutcome)
  if (syncTerminalOutcome) terminalOutcome.value = nextTerminalOutcome
  const nextSessionId = descriptor.sessionId || result.session?.id || null
  const prevSessionId = sessionId.value
  if (nextSessionId) {
    sessionId.value = nextSessionId
    sessionDescriptor.value = descriptor
    if (LIVE_DUBBING_PROVIDER_IDS.includes(descriptor.providerId)) sessionProviderId.value = descriptor.providerId
  } else if (!preserveSession) {
    sessionId.value = null
    sessionDescriptor.value = null
    sessionProviderId.value = null
  }
  // Session loss invalidates pending refreshes and clears presentation data.
  // On replacement, discard records for sessions no longer relevant but keep
  // any already-recorded value for the incoming session.
  if (sessionId.value == null) {
    invalidateSubtitlesRefreshes()
    clearSubtitlesUnavailable()
  } else if (prevSessionId != null && sessionId.value !== prevSessionId) {
    for (const recordedSessionId of subtitlesUnavailableBySession.value.keys()) {
      if (recordedSessionId !== sessionId.value) clearSubtitlesUnavailable(recordedSessionId)
    }
  }

  if (result.available === false || result.error === 'LIVE_DUBBING_UNSUPPORTED' || descriptor.status === 'unavailable') {
    authoritativeStatus.value = null
    state.value = 'unavailable'
    if (sessionId.value == null) clearSubtitlesUnavailable()
    else if (!isSubtitlesFenced(sessionId.value, subtitlesSnapshot)) clearSubtitlesUnavailable(sessionId.value)
    errorMessage.value = getErrorMessage(result.error, 'Live dubbing is unavailable.')
    return
  }

  const status = descriptor.status
  const statuses = ['PREPARING_CAPTURE', 'CONNECTING_PROVIDER', 'RUNNING', 'STOPPING', 'ERROR']
  authoritativeStatus.value = statuses.includes(status) ? status : null
  const stateMap = {
    PREPARING_CAPTURE: 'starting',
    CONNECTING_PROVIDER: 'starting',
    RUNNING: 'running',
    STOPPING: 'stopping',
    ERROR: sessionId.value ? 'cleanup' : 'error'
  }
  state.value = stateMap[status] || (result.error && result.success === false ? 'error' : 'idle')
  // Presentation-only transcript-delivery flag, session-scoped. A non-fenced
  // authoritative response with an explicit boolean associates that value
  // with that response's session. A lifecycle response without the field
  // (START/STOP) preserves refresh-obtained state for the continuing
  // session. A newer refresh fences only the boolean for this response's
  // session; replacement cleanup above removes old records but preserves an
  // already-recorded value for the incoming session when this field is omitted.
  if (sessionId.value == null) {
    clearSubtitlesUnavailable()
  } else {
    const responseSessionId = sessionId.value
    const subtitlesFenced = isSubtitlesFenced(responseSessionId, subtitlesSnapshot)
    if (!subtitlesFenced && typeof result.transcriptDeliveryUnavailable === 'boolean') {
      setSubtitlesUnavailable(responseSessionId, result.transcriptDeliveryUnavailable)
    }
  }
  errorMessage.value = status === 'ERROR' || result.error
    ? getErrorMessage(descriptor.lastError || result.error)
    : ''
}

// ── Volume fencing helpers ────────────────────────────────────────────────────

const nextVolumeGeneration = () => {
  volumeRequestGeneration += 1
  return volumeRequestGeneration
}

const resetVolumeState = () => {
  nextVolumeGeneration()
  if (volumeThrottleTimer != null) {
    clearTimeout(volumeThrottleTimer)
    volumeThrottleTimer = null
  }
  pendingVolumeShot = null
  desiredVolume.value = null
  confirmedVolume.value = null
  volumeResolved.value = false
  volumeError.value = ''
}

const nextDubbedVolumeGeneration = () => {
  dubbedVolumeRequestGeneration += 1
  return dubbedVolumeRequestGeneration
}

const resetDubbedVolumeState = () => {
  nextDubbedVolumeGeneration()
  if (dubbedVolumeThrottleTimer != null) {
    clearTimeout(dubbedVolumeThrottleTimer)
    dubbedVolumeThrottleTimer = null
  }
  pendingDubbedVolumeShot = null
  desiredDubbedVolume.value = null
  confirmedDubbedVolume.value = null
  dubbedVolumeResolved.value = false
  dubbedVolumeError.value = ''
}

const isSessionMismatchError = (result) => result?.success === false && (
  result.error === 'LIVE_DUBBING_SESSION_MISMATCH'
  || result.error === 'LIVE_DUBBING_EVENT_SEQUENCE_MISMATCH'
  || result.error === 'LIVE_DUBBING_SESSION_UNAVAILABLE'
)

/** Snapshot the current session fence so sends scheduled for later can verify
 *  the fence is still valid at execution time. */
const captureCurrentFence = () => {
  const d = sessionDescriptor.value
  if (!d) return null
  return { sessionId: d.sessionId, providerId: d.providerId, eventSequence: d.eventSequence }
}

/**
 * Refresh lifecycle status for volume recovery without bumping the lifecycle
 * generation counter.  Snapshots the current generation, sends a STATUS query,
 * and discards the result if the generation changed during the round-trip.
 * This prevents volume-mismatch recovery from invalidating in-flight
 * START/STOP operations.
 * @returns {boolean} true if the result was accepted (generation unchanged)
 */
const refreshLifecycleForVolume = async () => {
  const generation = operationGeneration
  const subtitlesSnapshot = captureSubtitlesSnapshot()
  try {
    const response = await sendMessage({ action: 'GET_LIVE_DUBBING_STATUS' })
    if (generation !== operationGeneration) return false
    applyStatus(response, { syncTerminalOutcome: true, subtitlesSnapshot })
    return true
  } catch {
    if (generation !== operationGeneration) return false
    return false
  }
}

/**
 * Refresh lifecycle status for dubbed-volume recovery without bumping the
 * lifecycle generation counter.  Independent from refreshLifecycleForVolume —
 * uses the dubbed generation guard so Original Volume work is unaffected.
 * @returns {boolean} true if the result was accepted (generation unchanged)
 */
const refreshLifecycleForDubbedVolume = async () => {
  const generation = operationGeneration
  const subtitlesSnapshot = captureSubtitlesSnapshot()
  try {
    const response = await sendMessage({ action: 'GET_LIVE_DUBBING_STATUS' })
    if (generation !== operationGeneration) return false
    applyStatus(response, { syncTerminalOutcome: true, subtitlesSnapshot })
    return true
  } catch {
    if (generation !== operationGeneration) return false
    return false
  }
}

/**
 * Recover the runtime original-audio volume for the active session.
 * Never assumes 0 — always queries the backend.
 * @param {number} depth - recursion guard; 0 = first attempt, 1 = one retry
 */
const queryOriginalVolume = async (generation = nextVolumeGeneration(), depth = 0) => {
  const descriptor = sessionDescriptor.value
  if (!descriptor?.sessionId || !descriptor?.providerId) return

  try {
    const response = await sendMessage({
      action: LIVE_DUBBING_ACTIONS.GET_ORIGINAL_VOLUME,
      data: {
        sessionId: descriptor.sessionId,
        providerId: descriptor.providerId,
        eventSequence: descriptor.eventSequence
      }
    })
    if (generation !== volumeRequestGeneration) return

    const result = unwrap(response)

    if (result.success === false) {
      if (isSessionMismatchError(result)) {
        if (volumeRecoveryInProgress.value) return
        if (depth >= MAX_VOLUME_RECOVERY_DEPTH) return
        volumeRecoveryInProgress.value = true
        const recoveryGeneration = volumeRequestGeneration
        const fenceBeforeRefresh = volumeFence.value
        try {
          const accepted = await refreshLifecycleForVolume()
          if (recoveryGeneration !== volumeRequestGeneration) return
          // If the exact fence changed during refresh, the watcher owns the
          // new-fence read — do not retry here to avoid duplicate queries.
          if (volumeFence.value !== fenceBeforeRefresh) return
          if (accepted && isVolumeControllable.value && sessionId.value) {
            void queryOriginalVolume(nextVolumeGeneration(), depth + 1)
          }
        } finally {
          volumeRecoveryInProgress.value = false
        }
        return
      }
      // LIVE_DUBBING_ORIGINAL_AUDIO_UNAVAILABLE and other non-mismatch errors:
      // keep last-confirmed, show inline error — never terminal, never stop/cleanup
      volumeError.value = 'Original audio unavailable'
      return
    }

    if (typeof result.originalVolume === 'number'
      && Number.isFinite(result.originalVolume)
      && result.originalVolume >= 0
      && result.originalVolume <= 1) {
      confirmedVolume.value = result.originalVolume
      desiredVolume.value = result.originalVolume
      volumeError.value = ''
      volumeResolved.value = true
    }
  } catch {
    if (generation !== volumeRequestGeneration) return
    // Transport failure: keep last-confirmed, silent — no toast, no terminal
  }
}

/**
 * Recover the runtime dubbed-audio volume for the active session.
 * Mirrors queryOriginalVolume with an independent generation counter.
 * Never assumes 0 — always queries the backend.
 * @param {number} generation - request generation snapshot; stale responses are discarded
 * @param {number} depth - recursion guard; 0 = first attempt, 1 = one retry
 */
const queryDubbedVolume = async (generation = nextDubbedVolumeGeneration(), depth = 0) => {
  const descriptor = sessionDescriptor.value
  if (!descriptor?.sessionId || !descriptor?.providerId) return

  try {
    const response = await sendMessage({
      action: LIVE_DUBBING_ACTIONS.GET_DUBBED_VOLUME,
      data: {
        sessionId: descriptor.sessionId,
        providerId: descriptor.providerId,
        eventSequence: descriptor.eventSequence
      }
    })
    if (generation !== dubbedVolumeRequestGeneration) return

    const result = unwrap(response)

    if (result.success === false) {
      if (isSessionMismatchError(result)) {
        desiredDubbedVolume.value = confirmedDubbedVolume.value
        if (dubbedVolumeRecoveryInProgress.value) return
        if (depth >= MAX_DUBBED_VOLUME_RECOVERY_DEPTH) return
        dubbedVolumeRecoveryInProgress.value = true
        const recoveryGeneration = dubbedVolumeRequestGeneration
        const fenceBeforeRefresh = volumeFence.value
        try {
          const accepted = await refreshLifecycleForDubbedVolume()
          if (recoveryGeneration !== dubbedVolumeRequestGeneration) return
          // If the exact fence changed during refresh, the watcher owns the
          // new-fence read — do not retry here to avoid duplicate queries.
          if (volumeFence.value !== fenceBeforeRefresh) return
          if (accepted && isVolumeControllable.value && sessionId.value) {
            void queryDubbedVolume(nextDubbedVolumeGeneration(), depth + 1)
          }
        } finally {
          dubbedVolumeRecoveryInProgress.value = false
        }
        return
      }
      // LIVE_DUBBING_DUBBED_AUDIO_UNAVAILABLE and other non-mismatch errors:
      // keep last-confirmed, show inline error — never terminal, never stop/cleanup
      dubbedVolumeError.value = 'Dubbed audio unavailable'
      return
    }

    if (typeof result.dubbedVolume === 'number'
      && Number.isFinite(result.dubbedVolume)
      && result.dubbedVolume >= 0
      && result.dubbedVolume <= 1) {
      confirmedDubbedVolume.value = result.dubbedVolume
      desiredDubbedVolume.value = result.dubbedVolume
      dubbedVolumeError.value = ''
      dubbedVolumeResolved.value = true
    }
  } catch {
    if (generation !== dubbedVolumeRequestGeneration) return
    // Transport failure: keep last-confirmed, silent — no toast, no terminal
  }
}

/**
 * Send a volume write to the backend with fencing.
 * Success commits confirmedVolume; failure rolls back desiredVolume;
 * superseded = non-error, no rollback, no error display.
 * @param {number} depth - recursion guard; 0 = first attempt, 1 = one retry
 */
const sendVolume = async (depth = 0) => {
  const shot = pendingVolumeShot
  pendingVolumeShot = null
  if (!shot?.fence?.sessionId || !shot.fence?.providerId) return

  const { fence, volume, generation } = shot

  // Pre-send fence check: skip if session shifted since input was captured
  const current = sessionDescriptor.value
  if (!current
    || current.sessionId !== fence.sessionId
    || current.providerId !== fence.providerId
    || current.eventSequence !== fence.eventSequence) return

  try {
    const response = await sendMessage({
      action: LIVE_DUBBING_ACTIONS.SET_ORIGINAL_VOLUME,
      data: {
        sessionId: fence.sessionId,
        providerId: fence.providerId,
        eventSequence: fence.eventSequence,
        volume
      }
    })
    if (generation !== volumeRequestGeneration) return

    const result = unwrap(response)

    if (result.success === false) {
      if (isSessionMismatchError(result)) {
        if (volumeRecoveryInProgress.value) return
        if (depth >= MAX_VOLUME_RECOVERY_DEPTH) return
        volumeRecoveryInProgress.value = true
        const recoveryGeneration = volumeRequestGeneration
        const fenceBeforeRefresh = volumeFence.value
        try {
          const accepted = await refreshLifecycleForVolume()
          if (recoveryGeneration !== volumeRequestGeneration) return
          if (volumeFence.value !== fenceBeforeRefresh) return
          if (accepted && isVolumeControllable.value && sessionId.value) {
            void queryOriginalVolume(nextVolumeGeneration(), depth + 1)
          }
        } finally {
          volumeRecoveryInProgress.value = false
        }
        return
      }
      if (result.error === 'LIVE_DUBBING_ORIGINAL_AUDIO_UNAVAILABLE') {
        desiredVolume.value = confirmedVolume.value
        volumeError.value = 'Original audio unavailable'
        return
      }
      // Unknown failure: rollback to last-confirmed
      desiredVolume.value = confirmedVolume.value
      return
    }

    // Superseded = latest-wins: non-error, no rollback, no commit, no error
    if (result.ignored && result.superseded) return

    // Success: commit confirmed
    if (typeof result.originalVolume === 'number'
      && Number.isFinite(result.originalVolume)
      && result.originalVolume >= 0
      && result.originalVolume <= 1) {
      confirmedVolume.value = result.originalVolume
      desiredVolume.value = result.originalVolume
      volumeError.value = ''
      volumeResolved.value = true
    }
  } catch {
    if (generation !== volumeRequestGeneration) return
    // Transport failure: rollback to last-confirmed
    desiredVolume.value = confirmedVolume.value
  }
}

/**
 * Trailing throttle for volume input: fires at most once every VOLUME_THROTTLE_MS.
 * Unlike debounce, it does NOT reset the timer on subsequent inputs — the first
 * input starts the cycle, and the next input after the cycle starts a new one.
 * This provides runtime updates during drag while bounding message frequency.
 */
const onVolumeInput = (event) => {
  const raw = Number(event.target.value)
  const clamped = Math.max(0, Math.min(100, raw))
  desiredVolume.value = clamped / 100
  volumeError.value = ''
  const generation = nextVolumeGeneration()
  const fence = captureCurrentFence()
  if (fence) {
    pendingVolumeShot = Object.freeze({ fence, volume: desiredVolume.value, generation })
  }

  // Trailing throttle: skip if a timer is already running
  if (volumeThrottleTimer != null) return
  volumeThrottleTimer = setTimeout(() => {
    volumeThrottleTimer = null
    void sendVolume()
  }, VOLUME_THROTTLE_MS)
}

/**
 * Send a dubbed-volume write to the backend with fencing.
 * Mirrors sendVolume with an independent generation counter.
 * Success commits confirmedDubbedVolume; session-mismatch rolls back and
 * recovers; unavailable rolls back with an inline error; invalid keeps the
 * optimistic value with an inline error; other failures roll back.
 * Superseded = non-error, no rollback, no error display.
 * @param {number} depth - recursion guard; 0 = first attempt, 1 = one retry
 */
const sendDubbedVolume = async (depth = 0) => {
  const shot = pendingDubbedVolumeShot
  pendingDubbedVolumeShot = null
  if (!shot?.fence?.sessionId || !shot.fence?.providerId) return

  const { fence, volume, generation } = shot

  // Pre-send fence check: skip if session shifted since input was captured
  const current = sessionDescriptor.value
  if (!current
    || current.sessionId !== fence.sessionId
    || current.providerId !== fence.providerId
    || current.eventSequence !== fence.eventSequence) return

  try {
    const response = await sendMessage({
      action: LIVE_DUBBING_ACTIONS.SET_DUBBED_VOLUME,
      data: {
        sessionId: fence.sessionId,
        providerId: fence.providerId,
        eventSequence: fence.eventSequence,
        volume
      }
    })
    if (generation !== dubbedVolumeRequestGeneration) return

    const result = unwrap(response)

    if (result.success === false) {
      if (isSessionMismatchError(result)) {
        desiredDubbedVolume.value = confirmedDubbedVolume.value
        if (dubbedVolumeRecoveryInProgress.value) return
        if (depth >= MAX_DUBBED_VOLUME_RECOVERY_DEPTH) return
        dubbedVolumeRecoveryInProgress.value = true
        const recoveryGeneration = dubbedVolumeRequestGeneration
        const fenceBeforeRefresh = volumeFence.value
        try {
          const accepted = await refreshLifecycleForDubbedVolume()
          if (recoveryGeneration !== dubbedVolumeRequestGeneration) return
          if (volumeFence.value !== fenceBeforeRefresh) return
          if (accepted && isVolumeControllable.value && sessionId.value) {
            void queryDubbedVolume(nextDubbedVolumeGeneration(), depth + 1)
          }
        } finally {
          dubbedVolumeRecoveryInProgress.value = false
        }
        return
      }
      if (result.error === 'LIVE_DUBBING_DUBBED_AUDIO_UNAVAILABLE') {
        desiredDubbedVolume.value = confirmedDubbedVolume.value
        dubbedVolumeError.value = 'Dubbed audio unavailable'
        return
      }
      if (result.error === 'LIVE_DUBBING_DUBBED_VOLUME_INVALID') {
        dubbedVolumeError.value = 'Invalid dubbed volume'
        return
      }
      // Unknown failure: rollback to last-confirmed
      desiredDubbedVolume.value = confirmedDubbedVolume.value
      return
    }

    // Superseded = latest-wins: non-error, no rollback, no commit, no error
    if (result.ignored && result.superseded) return

    // Success: commit confirmed
    if (typeof result.dubbedVolume === 'number'
      && Number.isFinite(result.dubbedVolume)
      && result.dubbedVolume >= 0
      && result.dubbedVolume <= 1) {
      confirmedDubbedVolume.value = result.dubbedVolume
      desiredDubbedVolume.value = result.dubbedVolume
      dubbedVolumeError.value = ''
      dubbedVolumeResolved.value = true
    }
  } catch {
    if (generation !== dubbedVolumeRequestGeneration) return
    // Transport failure: rollback to last-confirmed
    desiredDubbedVolume.value = confirmedDubbedVolume.value
  }
}

/**
 * Trailing throttle for dubbed-volume input: fires at most once every
 * DUBBED_VOLUME_THROTTLE_MS.  Unlike debounce, it does NOT reset the timer
 * on subsequent inputs — the first input starts the cycle, and the next
 * input after the cycle starts a new one.  Independent timer from Original.
 */
const onDubbedVolumeInput = (event) => {
  const raw = Number(event.target.value)
  const clamped = Math.max(0, Math.min(100, raw))
  desiredDubbedVolume.value = clamped / 100
  dubbedVolumeError.value = ''
  const generation = nextDubbedVolumeGeneration()
  const fence = captureCurrentFence()
  if (fence) {
    pendingDubbedVolumeShot = Object.freeze({ fence, volume: desiredDubbedVolume.value, generation })
  }

  // Trailing throttle: skip if a timer is already running
  if (dubbedVolumeThrottleTimer != null) return
  dubbedVolumeThrottleTimer = setTimeout(() => {
    dubbedVolumeThrottleTimer = null
    void sendDubbedVolume()
  }, DUBBED_VOLUME_THROTTLE_MS)
}

/**
 * Flush any pending volume send synchronously (called on unmount).
 * Only sends if the captured snapshot is still valid (current descriptor matches).
 */
const flushPendingVolumeSend = () => {
  if (volumeThrottleTimer != null) {
    clearTimeout(volumeThrottleTimer)
    volumeThrottleTimer = null
  }
  if (pendingVolumeShot) {
    const current = sessionDescriptor.value
    const { fence } = pendingVolumeShot
    const stillValid = current
      && current.sessionId === fence.sessionId
      && current.providerId === fence.providerId
      && current.eventSequence === fence.eventSequence
    if (stillValid && isVolumeControllable.value) {
      void sendVolume()
    } else {
      pendingVolumeShot = null
    }
  }
}

/**
 * Flush any pending dubbed-volume send synchronously (called on unmount).
 * Only sends if the captured snapshot is still valid (current descriptor matches).
 */
const flushPendingDubbedVolumeSend = () => {
  if (dubbedVolumeThrottleTimer != null) {
    clearTimeout(dubbedVolumeThrottleTimer)
    dubbedVolumeThrottleTimer = null
  }
  if (pendingDubbedVolumeShot) {
    const current = sessionDescriptor.value
    const { fence } = pendingDubbedVolumeShot
    const stillValid = current
      && current.sessionId === fence.sessionId
      && current.providerId === fence.providerId
      && current.eventSequence === fence.eventSequence
    if (stillValid && isVolumeControllable.value) {
      void sendDubbedVolume()
    } else {
      pendingDubbedVolumeShot = null
    }
  }
}

// ── Lifecycle ────────────────────────────────────────────────────────────────

const queryStatus = async (generation = nextOperationGeneration()) => {
  const prevFence = volumeFence.value
  const subtitlesSnapshot = captureSubtitlesSnapshot()
  try {
    const response = await sendMessage({ action: 'GET_LIVE_DUBBING_STATUS' })
    if (generation !== operationGeneration) return false
    applyStatus(response, { syncTerminalOutcome: true, subtitlesSnapshot })
    // After status recovery, recover volume if controllable — independent round trip.
    // The volumeFence watcher handles all fence transitions (active→active).
    // Only the initial mount (null→active) is owned here, since the watcher
    // skips the null→active transition.
    if (isVolumeControllable.value && sessionId.value && prevFence === null) {
      void queryOriginalVolume()
      void queryDubbedVolume()
    } else if (!isVolumeControllable.value || !sessionId.value) {
      resetVolumeState()
      resetDubbedVolumeState()
    }
    return true
  } catch (error) {
    if (generation !== operationGeneration) return false
    state.value = 'unavailable'
    authoritativeStatus.value = null
    if (!isSubtitlesFenced(sessionId.value, subtitlesSnapshot)) {
      if (sessionId.value == null) clearSubtitlesUnavailable()
      else clearSubtitlesUnavailable(sessionId.value)
    }
    errorMessage.value = getErrorMessage(error?.message, 'Live dubbing is unavailable.')
    resetVolumeState()
    resetDubbedVolumeState()
    return false
  }
}

const start = async () => {
  const generation = nextOperationGeneration()
  const subtitlesSnapshot = captureSubtitlesSnapshot()
  const prevFence = volumeFence.value
  state.value = 'starting'
  // Presentation-only: drop stale authoritative status so a retry shows "Starting…".
  authoritativeStatus.value = null
  errorMessage.value = ''
  try {
    const response = await sendMessage({
      action: 'START_LIVE_DUBBING',
      data: { targetLanguage: props.targetLanguage, providerId: props.providerId }
    })
    if (generation !== operationGeneration) return
    applyStatus(response, { subtitlesSnapshot })
    if (state.value === 'idle') state.value = 'running'
    if (state.value === 'running' && !normalizeTerminalOutcome(unwrap(response).terminalOutcome)) {
      terminalOutcome.value = null
    }
    // Recover volume for the newly established controllable session.
    // The volumeFence watcher skips the initial null→active transition, so
    // START must own this recovery path.  For active→active (restart), the
    // watcher handles it.
    if (isVolumeControllable.value && sessionId.value && prevFence === null) {
      void queryOriginalVolume()
      void queryDubbedVolume()
    }
  } catch (error) {
    if (generation !== operationGeneration) return
    // Preserve structured START failure context (session, cleanupPending,
    // retryable, status, safe diagnostics) so a retained session stays
    // stoppable instead of resetting to clean idle.
    const failure = error?.data || error?.response?.data
    if (failure && typeof failure === 'object') {
      applyStatus(failure, { preserveSession: true, subtitlesSnapshot })
      if (state.value === 'idle') state.value = 'error'
      if (!errorMessage.value) errorMessage.value = getErrorMessage(error?.message, 'Unable to start live dubbing.')
    } else {
      state.value = 'error'
      errorMessage.value = getErrorMessage(error?.message, 'Unable to start live dubbing.')
    }
  }
}

const stop = async () => {
  // Invalidate in-flight volume work immediately: cancel throttle timers,
  // clear pending shots, bump generations so no old SET resolves after STOP.
  resetVolumeState()
  resetDubbedVolumeState()
  const generation = nextOperationGeneration()
  const subtitlesSnapshot = captureSubtitlesSnapshot()
  state.value = 'stopping'
  errorMessage.value = ''
  try {
    if (!sessionId.value && !sessionDescriptor.value?.sessionId) await queryStatus(generation)
    if (generation !== operationGeneration) return
    const response = await sendMessage({
      action: 'STOP_LIVE_DUBBING',
      data: { sessionId: sessionId.value || sessionDescriptor.value?.sessionId }
    })
    if (generation !== operationGeneration) return
    applyStatus(response, { preserveSession: true, subtitlesSnapshot })
    if (state.value === 'idle') {
      // Clean idle after STOP owns no session: drop subtitle-delivery
      // presentation state and invalidate pending refreshes alongside the
      // session identity. Failed/retained cleanup sessions keep their state
      // via the catch path below.
      clearSubtitlesUnavailable()
      invalidateSubtitlesRefreshes()
      sessionId.value = null
      sessionDescriptor.value = null
      sessionProviderId.value = null
    }
  } catch (error) {
    if (generation !== operationGeneration) return
    // Keep retained session available after transport failure so cleanup can retry.
    applyStatus(error?.data || error?.response?.data || error, { preserveSession: true, subtitlesSnapshot })
    state.value = sessionId.value ? 'cleanup' : 'error'
    errorMessage.value = getErrorMessage(error?.message, 'Unable to stop live dubbing.')
  }
}

const handleRuntimeMessage = (message, sender) => {
  if (!isAuthorizedLiveDubbingOffscreenControlSender(sender, extensionBrowser)) return
  if (message?.action === LIVE_DUBBING_ACTIONS.TRANSCRIPT_DELIVERY_CHANGED) {
    void refreshSubtitlesUnavailable(message?.data?.sessionId)
    return
  }
  if (message?.action !== LIVE_DUBBING_ACTIONS.TERMINAL_OUTCOME) return

  // Notifications only invalidate the view. The authoritative response is the
  // sole source used for rendering terminal outcome data.
  void queryStatus()
}

// ── Presentation-only transcript-delivery refresh ────────────────────────────
// Reads authoritative status without touching the lifecycle operation
// generation, so a delivery notification can never invalidate an in-flight
// START/STOP. Records the sanitized boolean with its session ownership:
// the notification session is a fence, never rendered state directly —
// rendering shows the note only while ownership matches the active
// session. Late results for a superseded session and refresh failures
// change nothing; a flag whose session is gone authoritatively is cleared.
// Lifecycle state, session ownership, volumes, terminal outcome, and error
// state are untouched.
const refreshSubtitlesUnavailable = async (notifiedSessionId) => {
  if (typeof notifiedSessionId !== 'string' || !notifiedSessionId) return
  subtitlesRefreshGeneration += 1
  const refreshGeneration = subtitlesRefreshGeneration
  subtitlesRefreshGenerations.set(notifiedSessionId, refreshGeneration)
  // Active lifecycle session at request start. The refresh may still apply
  // when the UI has since adopted the notified session, but never when it
  // moved away from it — a stale old-session refresh must not overwrite the
  // adopted session's state.
  const refreshSessionId = sessionId.value
  let result
  try {
    result = unwrap(await sendMessage({ action: 'GET_LIVE_DUBBING_STATUS' }))
  } catch {
    return
  }
  if (refreshGeneration !== subtitlesRefreshGenerations.get(notifiedSessionId)) return
  // Session-acceptance: latest-wins ordering above handles overlapping
  // refreshes; this handles lifecycle movement underneath a refresh. Accept
  // when the UI still owns the request-start session or has adopted the
  // notified session since; reject moves away from it. Session loss stays
  // covered by generation invalidation on the loss path itself.
  const activeSessionId = sessionId.value
  if (activeSessionId != null
    && activeSessionId !== refreshSessionId
    && activeSessionId !== notifiedSessionId) return
  const descriptor = result?.status && typeof result.status === 'object' ? result.status : result
  const currentSessionId = descriptor?.sessionId || result?.session?.id || null
  if (currentSessionId !== notifiedSessionId) {
    // The notified session is gone authoritatively: drop only its record.
    clearSubtitlesUnavailable(notifiedSessionId)
    return
  }
  // Authoritative read for the notified session: record its sanitized boolean
  // even if popup lifecycle still displays a different session.
  setSubtitlesUnavailable(notifiedSessionId, result.transcriptDeliveryUnavailable === true)
}

const clearInitialStatusReveal = () => {
  pendingStatusReveal.value = false
  statusRevealTimerElapsed.value = false
  if (statusRevealTimer != null) {
    clearTimeout(statusRevealTimer)
    statusRevealTimer = null
  }
}

const resolveInitialStatus = async () => {
  pendingStatusReveal.value = true
  statusRevealTimerElapsed.value = false
  statusRevealTimer = setTimeout(() => {
    statusRevealTimer = null
    if (pendingStatusReveal.value) statusRevealTimerElapsed.value = true
  }, LOADING_PRESENTATION_DELAY_MS)

  try {
    const resolved = await queryStatus()
    if (resolved && !initialStatusResolved) {
      initialStatusResolved = true
      emit('status-resolved')
    }
  } finally {
    clearInitialStatusReveal()
  }
}

onMounted(() => {
  if (typeof extensionBrowser?.runtime?.onMessage?.addListener === 'function') {
    extensionBrowser.runtime.onMessage.addListener(handleRuntimeMessage)
    removeRuntimeListener = () => extensionBrowser.runtime.onMessage.removeListener(handleRuntimeMessage)
  }
  void resolveInitialStatus()
})

onUnmounted(() => {
  removeRuntimeListener?.()
  removeRuntimeListener = null
  flushPendingVolumeSend()
  flushPendingDubbedVolumeSend()
  // Clear any pending presentation delay so a mid-fetch unmount never causes
  // a stale "Checking availability…" update on a returned component.
  clearInitialStatusReveal()
})

watch(isBusy, (busy) => emit('busy-change', busy), { immediate: true })

// Cancel pending volume sends and re-query when the session fence shifts
// externally (e.g. background restart assigns a new sessionId).
// Skip the initial mount transition (oldFence === null) — the first volume
// query is owned by queryStatus (mount) or start() (START-from-idle).
// The watcher always owns new-fence recovery, even when a mismatch recovery
// is in progress.  resetVolumeState() bumps volumeRequestGeneration which
// invalidates the old recovery's generation check, so no duplicate reads.
watch(volumeFence, (newFence, oldFence) => {
  if (oldFence === null) return
  resetVolumeState()
  resetDubbedVolumeState()
  if (isVolumeControllable.value && sessionId.value) {
    void queryOriginalVolume()
    void queryDubbedVolume()
  }
})

// Parent owns target-language control; popup close intentionally sends no dubbing cleanup.
</script>
