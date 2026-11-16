import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  initializeSettings: vi.fn(),
  warmupSettings: vi.fn(),
  initializeDebugMode: vi.fn(),
  featureInit: vi.fn().mockResolvedValue(undefined),
  onPolicyChanged: vi.fn(() => () => {}),
  checkExclusion: vi.fn().mockResolvedValue(true),
}))

vi.mock('./BaseContentScriptCore.js', () => ({
  BaseContentScriptCore: vi.fn(() => ({
    initializeBase: vi.fn().mockResolvedValue(true),
    injectStyles: vi.fn()
  }))
}))

vi.mock('@/shared/managers/SettingsManager.js', () => ({
  default: {
    initialize: mocks.initializeSettings,
    warmup: mocks.warmupSettings
  }
}))

vi.mock('@/shared/logging/DebugModeBridge.js', () => ({
  debugModeBridge: {
    initialize: mocks.initializeDebugMode
  }
}))

vi.mock('@/core/managers/content/FeatureManager.js', () => ({
  FeatureManager: {
    getInstance: () => ({
      get initialized() { return true; },
      initialize: mocks.featureInit,
      onPolicyChanged: mocks.onPolicyChanged,
      requestedFeatures: new Set(),
    }),
  },
}))

vi.mock('@/features/exclusion/utils/exclusion-utils.js', () => ({
  checkUrlExclusionAsync: mocks.checkExclusion,
}))

import { ContentScriptCore } from './ContentScriptCore.js'
import { IFrameContentScriptCore } from './IFrameContentScriptCore.js'

describe('content core settings readiness', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.warmupSettings.mockResolvedValue(undefined)
    mocks.initializeDebugMode.mockResolvedValue(undefined)
    mocks.featureInit.mockResolvedValue(undefined)
    mocks.onPolicyChanged.mockReturnValue(() => {})
    mocks.checkExclusion.mockResolvedValue(true)
  })

  it('does not complete main core initialization before settings are ready', async () => {
    let resolveSettings
    mocks.initializeSettings.mockImplementation(() => new Promise((resolve) => {
      resolveSettings = resolve
    }))

    const core = ContentScriptCore()
    let completed = false
    const initialization = core.initializeCritical().then((result) => {
      completed = true
      return result
    })

    await vi.waitFor(() => expect(mocks.initializeSettings).toHaveBeenCalledOnce())
    expect(completed).toBe(false)
    expect(mocks.initializeDebugMode).not.toHaveBeenCalled()

    resolveSettings()

    await expect(initialization).resolves.toBe(true)
    expect(mocks.initializeDebugMode).toHaveBeenCalledOnce()
    expect(mocks.warmupSettings).not.toHaveBeenCalled()
  })

  it('retries critical settings initialization without duplicating completed base setup', async () => {
    mocks.initializeSettings
      .mockRejectedValueOnce(new Error('settings unavailable'))
      .mockResolvedValueOnce(undefined)

    const core = ContentScriptCore()
    await expect(core.initializeCritical()).resolves.toBe(false)
    await expect(core.initializeCritical()).resolves.toBe(true)

    expect(mocks.initializeSettings).toHaveBeenCalledTimes(2)
    expect(mocks.initializeDebugMode).toHaveBeenCalledOnce()
  })

  it('does not complete iframe core initialization before settings are ready', async () => {
    let resolveSettings
    mocks.initializeSettings.mockImplementation(() => new Promise((resolve) => {
      resolveSettings = resolve
    }))

    const core = IFrameContentScriptCore()
    let completed = false
    const initialization = core.initializeCritical().then((result) => {
      completed = true
      return result
    })

    await vi.waitFor(() => expect(mocks.initializeSettings).toHaveBeenCalledOnce())
    expect(completed).toBe(false)

    resolveSettings()

    await expect(initialization).resolves.toBe(true)
    expect(mocks.warmupSettings).not.toHaveBeenCalled()
  })
})
