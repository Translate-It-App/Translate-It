import { ref } from 'vue'
import { TranslationMode } from '@/shared/config/config.js'
import { NewlineManager } from '@/features/translation/utils/NewlineManager.js'

const SOURCE_TEXT_REFERENCE = '⟦SOURCE_TEXT_IN_USER_MESSAGE⟧'

/**
 * Composable to manage prompt preview generation logic.
 * Decouples the UI from the complex prompt assembly logic.
 */
export function usePromptPreview(customLogger = null) {
  const logger = customLogger || { error: (...args) => console.error('[usePromptPreview]', ...args) }
  const promptExamples = ref([])
  const loadingExamples = ref(false)
  let lastGenerationId = 0

  // Sample data for previews
  const SAMPLE_TEXT = "Hello, how are you today? This is a sample text for previewing translation prompts."
  const SAMPLE_WORD = "Discovery"
  const SAMPLE_JSON = JSON.stringify([
    { id: "1", text: "Welcome to our website" },
    { id: "2", text: "Click here to learn more" },
    { id: "3", text: "Contact us for support" }
  ])

  /**
   * Internal helper to build a prompt using a provided template string instead of storage.
   * Mirrors runtime logic from promptBuilder.js and AIConversationHelper.js.
   */
  const buildPromptWithTemplate = async (template, text, sourceLang, targetLang, translateMode, providerType) => {
    const {
      getPromptBASESelectAsync,
      getPromptPopupTranslateAsync,
      getPromptBASEFieldAsync,
      getPromptBASEFieldAutoAsync,
      getPromptBASEScreenCaptureAsync,
      getPromptBASEBatchAsync,
      getPromptBASEAIBatchAsync,
      getPromptBASEAIBatchAutoAsync,
      getPromptSubtitleBaseAsync,
      getPromptSubtitleBatchAsync,
      getEnableDictionaryAsync,
      getPromptDictionaryAsync,
      getSourceLanguageAsync,
      CONFIG,
    } = await import('@/shared/config/config.js')

    const { getLanguageNameFromCode, getCanonicalCode } = await import('@/shared/config/languageConstants.js')
    const { AIConversationHelper } = await import('@/features/translation/providers/utils/AIConversationHelper.js')
    const { HISTORICAL_PROMPT_DEFAULTS } = await import('@/shared/config/promptHistoricalDefaults.js')
    const { shouldUseAutoPromptAsync } = await import('@/features/translation/utils/bilingualPromptHelper.js')

    const isSpecificTextJsonFormat = (obj) => {
      return (
        Array.isArray(obj) &&
        obj.length > 0 &&
        obj.every(
          (item) => typeof item === 'object' && item !== null && typeof item.text === 'string'
        )
      )
    }

    let isJsonMode = false
    try {
      const parsedText = JSON.parse(text)
      if (isSpecificTextJsonFormat(parsedText)) {
        isJsonMode = true
      }
    } catch {
      // Not JSON
    }

    const isAI = providerType === 'ai'
    const capitalize = (s) => s.charAt(0).toUpperCase() + s.slice(1)

    let actualSourceLang = sourceLang === 'auto' ? await getSourceLanguageAsync() : sourceLang
    if (actualSourceLang === 'auto') {
      actualSourceLang = 'en'
    }

    const sourceName = capitalize(getLanguageNameFromCode(getCanonicalCode(actualSourceLang)) || actualSourceLang)
    const targetName = capitalize(getLanguageNameFromCode(getCanonicalCode(targetLang)) || targetLang)

    // Assembly instructions from template
    const promptInstructions = template
      .replace(/\$_{TEXT}\s*/g, '')
      .replace(/\n\s*$/g, '')
      .replace(/\$_{SOURCE}/g, sourceName)
      .replace(/\$_{TARGET}/g, targetName)

    // Handle Subtitle Mode (High-Fidelity Preview)
    if (translateMode === TranslationMode.Subtitle) {
      const metadata = {
        promptTemplate: await getPromptSubtitleBaseAsync(),
        instruction: template,
        batchInstruction: await getPromptSubtitleBatchAsync()
      }

      // Convert sample text (array of cue objects) for the helper
      const cues = typeof text === 'string' ? JSON.parse(text) : text
      
      const { systemPrompt, userText } = await AIConversationHelper.preparePromptAndText(
        cues,
        sourceLang,
        targetLang,
        translateMode,
        'ai',
        null,
        metadata
      )

      return `[SYSTEM PROMPT]\n${systemPrompt}\n\n[USER MESSAGE (JSON)]\n${userText}`
    }

    const shouldUseBatchPrompt = isAI && (
      translateMode === TranslationMode.Select_Element ||
      translateMode === TranslationMode.Page ||
      isJsonMode
    )

    if (shouldUseBatchPrompt) {
      const batchPromptTemplate = sourceLang === 'auto'
        ? await getPromptBASEAIBatchAutoAsync()
        : await getPromptBASEAIBatchAsync()

      const systemPrompt = batchPromptTemplate
        .replace(/\$_{SOURCE}/g, sourceName)
        .replace(/\$_{TARGET}/g, targetName)
        .replace(/\$_{PROMPT_INSTRUCTIONS}/g, promptInstructions)
        .replace(/\$_{COUNT}/g, String(JSON.parse(text).length))
        .replace(/\$_{MARKER_PRESERVATION_INSTRUCTIONS}/g, '')
        .replace(/\$_{TEXT}/g, 'the text provided in the user message')

      const userText = JSON.stringify({
        translations: JSON.parse(text).map((item, index) => ({
          id: String(item.id ?? item.i ?? index),
          text: item.text
        }))
      })

      return `[SYSTEM PROMPT]\n${systemPrompt.trim()}\n\n[USER MESSAGE (JSON)]\n${userText}`
    }

    if (translateMode === TranslationMode.Select_Element && !isJsonMode) {
      const batchPromptTemplate = await getPromptBASEBatchAsync()
      return batchPromptTemplate
        .replace(/\$_{SOURCE}/g, sourceName)
        .replace(/\$_{TARGET}/g, targetName)
        .replace(/\$_{PROMPT_INSTRUCTIONS}/g, promptInstructions)
        .replace(/\$_{TEXT}/g, text)
    }

    let promptBase
    let editableBaseKey
    if (isJsonMode) {
      promptBase = await getPromptBASESelectAsync()
    } else if (translateMode === TranslationMode.Popup_Translate || translateMode === TranslationMode.Sidepanel_Translate) {
      promptBase = await getPromptPopupTranslateAsync()
    } else if (await getEnableDictionaryAsync() && translateMode === TranslationMode.Dictionary_Translation) {
      promptBase = await getPromptDictionaryAsync()
      editableBaseKey = 'PROMPT_BASE_DICTIONARY'
    } else {
      if (translateMode === TranslationMode.ScreenCapture) {
        promptBase = await getPromptBASEScreenCaptureAsync()
      } else {
        const useAutoPrompt = await shouldUseAutoPromptAsync(sourceLang, TranslationMode.Field)
        editableBaseKey = useAutoPrompt ? 'PROMPT_BASE_FIELD_AUTO' : 'PROMPT_BASE_FIELD'
        promptBase = useAutoPrompt ? await getPromptBASEFieldAutoAsync() : await getPromptBASEFieldAsync()
      }
    }

    const resolvedPrompt = promptBase
      .replace(/\$_{SOURCE}/g, sourceName)
      .replace(/\$_{TARGET}/g, targetName)
      .replace(/\$_{PROMPT_INSTRUCTIONS}/g, promptInstructions)

    if (isAI) {
      const isCustomizedEditableBase = editableBaseKey
        && promptBase !== CONFIG[editableBaseKey]
        && !(HISTORICAL_PROMPT_DEFAULTS[editableBaseKey] || []).some((entry) => (
          (typeof entry === 'string' ? entry : entry?.value) === promptBase
        ))
      if (isCustomizedEditableBase) {
        const renderCustomBase = (sourceText) => promptBase
          .replace(/\$_{SOURCE}/g, sourceName)
          .replace(/\$_{TARGET}/g, targetName)
          .replace(/\$_{PROMPT_INSTRUCTIONS}/g, promptInstructions)
          .replace(/\$_{COUNT}/g, '1')
          .replace(/\$_{TEXT}/g, () => sourceText)
        const sourceFreeBase = renderCustomBase(SOURCE_TEXT_REFERENCE)
        const protectedText = NewlineManager.protect(text)
        const userBase = renderCustomBase(protectedText)
          + (promptBase.includes('$_{TEXT}') ? '' : `\n${protectedText}`)
        return `[SYSTEM PROMPT]\n${sourceFreeBase.trim()}\n\n[USER MESSAGE]\n${userBase}`
      }
      const systemPrompt = resolvedPrompt.replace(/\$_{TEXT}/g, 'the text provided in the user message')
      return `[SYSTEM PROMPT]\n${systemPrompt.trim()}\n\n[USER MESSAGE]\n${text}`
    }

    return resolvedPrompt.replace(/\$_{TEXT}/g, text)
  }

  /**
   * Generates a set of preview examples for various translation modes.
   */
  const generateExamples = async ({ template, templateKey, isAuto, sourceLang, targetLang, t }) => {
    const myGenerationId = ++lastGenerationId
    loadingExamples.value = true
    const examples = []
    
    // For Auto template preview, we force source language to 'auto' to see bidirectional logic
    const effectiveSourceLang = isAuto ? 'auto' : (sourceLang || 'en')
    const isSubtitle = templateKey === 'PROMPT_SUBTITLE_USER'

    try {
      // Modes to generate
      const modes = isSubtitle ? [
        { mk: 'prompt_preview_mode_subtitle', dk: 'prompt_preview_desc_subtitle', m: TranslationMode.Subtitle, type: 'ai' }
      ] : [
        { mk: 'prompt_preview_mode_field', dk: 'prompt_preview_desc_field', m: TranslationMode.Field, type: 'ai' },
        { mk: 'prompt_preview_mode_popup', dk: 'prompt_preview_desc_popup', m: TranslationMode.Popup_Translate, type: 'translate' },
        { mk: 'prompt_preview_mode_selection', dk: 'prompt_preview_desc_selection', m: TranslationMode.Selection, type: 'translate' },
        { mk: 'prompt_preview_mode_batch', dk: 'prompt_preview_desc_batch', m: TranslationMode.Select_Element, type: 'ai' },
        { mk: 'prompt_preview_mode_dictionary', dk: 'prompt_preview_desc_dictionary', m: TranslationMode.Dictionary_Translation, type: 'ai' }
      ]

      for (const modeSpec of modes) {
        // Abandon if a newer request has started
        if (myGenerationId !== lastGenerationId) return

        let sample
        if (modeSpec.m === TranslationMode.Subtitle) {
          sample = JSON.stringify([
            { i: 1, text: "Welcome to the @@SUB_TAG_0@@Translate It@@SUB_TAG_1@@ extension!" },
            { i: 2, text: "Let's translate some movie subtitles." }
          ])
        } else if (modeSpec.m === TranslationMode.Select_Element) {
          sample = SAMPLE_JSON
        } else if (modeSpec.m === TranslationMode.Dictionary_Translation) {
          sample = SAMPLE_WORD
        } else {
          sample = SAMPLE_TEXT
        }

        const prompt = await buildPromptWithTemplate(template, sample, effectiveSourceLang, targetLang, modeSpec.m, modeSpec.type)
        
        examples.push({
          mode: t(modeSpec.mk) || modeSpec.mk,
          description: t(modeSpec.dk) || modeSpec.dk,
          prompt
        })
      }

      // Only apply if this is still the latest request
      if (myGenerationId === lastGenerationId) {
        promptExamples.value = examples
        loadingExamples.value = false
      }
    } catch (error) {
      if (myGenerationId === lastGenerationId) {
        logger.error('Error generating examples:', error)
        loadingExamples.value = false
      }
    }
  }

  return {
    promptExamples,
    loadingExamples,
    generateExamples
  }
}
