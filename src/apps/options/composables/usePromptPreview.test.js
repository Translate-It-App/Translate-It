import { describe, it, expect, vi } from 'vitest'
import { usePromptPreview } from './usePromptPreview.js'

vi.mock('@/features/translation/providers/utils/AIConversationHelper.js', () => ({
  AIConversationHelper: {
    preparePromptAndText: vi.fn(async () => ({ systemPrompt: 'subtitle system', userText: 'subtitle user' }))
  }
}))

// Mocking config getters since they are imported dynamically
vi.mock('@/shared/config/config.js', async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...actual,
    CONFIG: {
      ...actual.CONFIG,
      PROMPT_BASE_FIELD: 'FIELD: $_{PROMPT_INSTRUCTIONS}\n\n$_{TEXT}',
      PROMPT_BASE_FIELD_AUTO: 'FIELD_AUTO: $_{PROMPT_INSTRUCTIONS}\n\n$_{TEXT}',
      PROMPT_BASE_DICTIONARY: 'DICT: $_{TEXT}',
    },
    getPromptBASESelectAsync: vi.fn(() => Promise.resolve('SELECT: $_{PROMPT_INSTRUCTIONS}\n\n$_{TEXT}')),
    getPromptPopupTranslateAsync: vi.fn(() => Promise.resolve('POPUP: $_{PROMPT_INSTRUCTIONS}\n\n$_{TEXT}')),
    getPromptBASEFieldAsync: vi.fn(() => Promise.resolve('FIELD: $_{PROMPT_INSTRUCTIONS}\n\n$_{TEXT}')),
    getPromptBASEFieldAutoAsync: vi.fn(() => Promise.resolve('FIELD_AUTO: $_{PROMPT_INSTRUCTIONS}\n\n$_{TEXT}')),
    getPromptBASEScreenCaptureAsync: vi.fn(() => Promise.resolve('SCREEN: $_{PROMPT_INSTRUCTIONS}\n\n$_{TEXT}')),
    getPromptBASEBatchAsync: vi.fn(() => Promise.resolve('BATCH: $_{PROMPT_INSTRUCTIONS}\n\n$_{TEXT}')),
    getPromptBASEAIBatchAsync: vi.fn(() => Promise.resolve('AI_BATCH: $_{PROMPT_INSTRUCTIONS}\n\n$_{TEXT}')),
    getPromptBASEAIBatchAutoAsync: vi.fn(() => Promise.resolve('AI_BATCH_AUTO: $_{PROMPT_INSTRUCTIONS}\n\n$_{TEXT}')),
    getEnableDictionaryAsync: vi.fn(() => Promise.resolve(true)),
    getPromptDictionaryAsync: vi.fn(() => Promise.resolve('DICT: $_{TEXT}')),
    getSourceLanguageAsync: vi.fn(() => Promise.resolve('en')),
  }
})

describe('usePromptPreview', () => {
  const mockT = vi.fn((key) => key)

  it('shows Field AI system and user messages with the sample only in the user message', async () => {
    const { promptExamples, generateExamples } = usePromptPreview()
    
    await generateExamples({
      template: 'Custom Template: $_{TEXT}',
      isAuto: false,
      sourceLang: 'en',
      targetLang: 'fa',
      t: mockT
    })

    expect(promptExamples.value.length).toBeGreaterThan(0)
    const fieldExample = promptExamples.value.find(ex => ex.mode === 'prompt_preview_mode_field')
    expect(fieldExample.prompt).toContain('Custom Template')
    expect(fieldExample.prompt).toContain('FIELD:')
    expect(fieldExample.prompt).toContain('[SYSTEM PROMPT]')
    expect(fieldExample.prompt).toContain('[USER MESSAGE]\nHello, how are you today? This is a sample text for previewing translation prompts.')
    expect(fieldExample.prompt.match(/Hello, how are you today\?/g)).toHaveLength(1)
    expect(fieldExample.prompt).toContain('the text provided in the user message')
  })

  it('generates examples for Auto template and forces auto source', async () => {
    const { promptExamples, generateExamples } = usePromptPreview()
    
    await generateExamples({
      template: 'Auto Template: $_{TEXT}',
      isAuto: true,
      sourceLang: 'en', // Should be ignored in favor of 'auto'
      targetLang: 'fa',
      t: mockT
    })

    const fieldExample = promptExamples.value.find(ex => ex.mode === 'prompt_preview_mode_field')
    expect(fieldExample.prompt).toContain('Auto Template')
    expect(fieldExample.prompt).toContain('FIELD_AUTO:')
    expect(fieldExample.prompt).toContain('[USER MESSAGE]')
  })

  it('shows Dictionary AI system and user messages', async () => {
    const { promptExamples, generateExamples } = usePromptPreview()

    await generateExamples({
      template: 'Dictionary draft: $_{TEXT}',
      isAuto: false,
      sourceLang: 'en',
      targetLang: 'fa',
      t: mockT
    })

    const dictionaryExample = promptExamples.value.find(ex => ex.mode === 'prompt_preview_mode_dictionary')
    expect(dictionaryExample.prompt).toContain('[SYSTEM PROMPT]')
    expect(dictionaryExample.prompt).toContain('DICT: the text provided in the user message')
    expect(dictionaryExample.prompt).toContain('[USER MESSAGE]\nDiscovery')
    expect(dictionaryExample.prompt).not.toContain('DICT: Discovery')
  })

  it.each([
    ['Field', 'getPromptBASEFieldAsync', 'PROMPT_BASE_FIELD', 'prompt_preview_mode_field', 'Hello, how are you today? This is a sample text for previewing translation prompts.'],
    ['Dictionary', 'getPromptDictionaryAsync', 'PROMPT_BASE_DICTIONARY', 'prompt_preview_mode_dictionary', 'Discovery'],
  ])('shows customized %s base wrapper in the AI system message', async (_name, getterName, _key, mode) => {
    const config = await import('@/shared/config/config.js')
    vi.mocked(config[getterName]).mockResolvedValueOnce('<custom>$_{PROMPT_INSTRUCTIONS} [$_{TEXT}]</custom>')
    const { promptExamples, generateExamples } = usePromptPreview()

    await generateExamples({
      template: 'Unsaved instruction',
      isAuto: false,
      sourceLang: 'en',
      targetLang: 'fa',
      t: mockT,
    })

    const example = promptExamples.value.find(item => item.mode === mode)
    const sample = _name === 'Field' ? 'Hello, how are you today? This is a sample text for previewing translation prompts.' : 'Discovery'
    expect(example.prompt).toContain(`[SYSTEM PROMPT]\n<custom>Unsaved instruction [${sample}]</custom>`)
    expect(example.prompt).toContain('[USER MESSAGE]\nTranslate the source text according to the system instructions.')
    expect(example.prompt.split(sample)).toHaveLength(2)
  })

  it('keeps Popup and Selection non-AI previews inline', async () => {
    const { promptExamples, generateExamples } = usePromptPreview()

    await generateExamples({
      template: 'Inline draft: $_{TEXT}',
      isAuto: false,
      sourceLang: 'en',
      targetLang: 'fa',
      t: mockT
    })

    for (const mode of ['prompt_preview_mode_popup', 'prompt_preview_mode_selection']) {
      const example = promptExamples.value.find(item => item.mode === mode)
      expect(example.prompt).toContain('Inline draft:')
      expect(example.prompt).toContain('Hello, how are you today?')
      expect(example.prompt).not.toContain('[SYSTEM PROMPT]')
      expect(example.prompt).not.toContain('[USER MESSAGE]')
    }
  })

  it('shows batch system prompt separately from its JSON user payload', async () => {
    const { promptExamples, generateExamples } = usePromptPreview()
    
    await generateExamples({
      template: 'Batch Template: $_{TEXT}',
      isAuto: false,
      sourceLang: 'en',
      targetLang: 'fa',
      t: mockT
    })

    const batchExample = promptExamples.value.find(ex => ex.mode === 'prompt_preview_mode_batch')
    expect(batchExample.prompt).toContain('AI_BATCH:')
    expect(batchExample.prompt).toContain('[SYSTEM PROMPT]')
    expect(batchExample.prompt).toContain('the text provided in the user message')
    expect(batchExample.prompt).toContain('[USER MESSAGE (JSON)]')
    expect(batchExample.prompt).toContain('"translations":[{"id":"1","text":"Welcome to our website"}')
    expect(batchExample.prompt).not.toContain('Welcome to our website\n')
  })

  it('keeps Subtitle preview delegated to the runtime helper', async () => {
    const { promptExamples, generateExamples } = usePromptPreview()

    await generateExamples({
      template: 'Subtitle draft',
      templateKey: 'PROMPT_SUBTITLE_USER',
      isAuto: false,
      sourceLang: 'en',
      targetLang: 'fa',
      t: mockT
    })

    expect(promptExamples.value).toHaveLength(1)
    expect(promptExamples.value[0].prompt).toBe('[SYSTEM PROMPT]\nsubtitle system\n\n[USER MESSAGE (JSON)]\nsubtitle user')
  })

  it('reflects the unsaved draft template in the AI system prompt', async () => {
    const { promptExamples, generateExamples } = usePromptPreview()

    await generateExamples({
      template: 'Unsaved draft instruction',
      isAuto: false,
      sourceLang: 'en',
      targetLang: 'fa',
      t: mockT
    })

    expect(promptExamples.value.find(ex => ex.mode === 'prompt_preview_mode_field').prompt)
      .toContain('Unsaved draft instruction')
  })

  it('prevents race conditions - latest request wins even if older request finishes last', async () => {
    const { promptExamples, generateExamples, loadingExamples } = usePromptPreview()
    
    // Create a way to control the timing of the first request
    let resolveSlowRequest;
    const slowRequestPromise = new Promise(resolve => {
      resolveSlowRequest = resolve;
    });

    const { getPromptBASEFieldAsync } = await import('@/shared/config/config.js');
    
    // Setup the mock to be slow ONLY for the first call
    vi.mocked(getPromptBASEFieldAsync).mockImplementationOnce(async () => {
      await slowRequestPromise;
      return 'FIELD: $_{PROMPT_INSTRUCTIONS}\n\n$_{TEXT}';
    });

    // 1. Start a "slow" request (Request A)
    const p1 = generateExamples({
      template: 'Slow Template',
      isAuto: false,
      sourceLang: 'en',
      targetLang: 'fa',
      t: mockT
    })

    // 2. Start a "fast" request (Request B) immediately after
    // This will increment lastGenerationId to 2
    const p2 = generateExamples({
      template: 'Fast Template',
      isAuto: false,
      sourceLang: 'en',
      targetLang: 'fa',
      t: mockT
    })

    // 3. Request B (Fast) should finish quickly because it's not blocked
    await p2;
    expect(promptExamples.value[0].prompt).toContain('Fast Template');
    
    // 4. Now resolve Request A (Slow)
    resolveSlowRequest();
    await p1;

    // 5. Assert: Request A (Slow) MUST NOT have overwritten Request B (Fast)
    expect(promptExamples.value[0].prompt).toContain('Fast Template');
    expect(promptExamples.value[0].prompt).not.toContain('Slow Template');
    expect(loadingExamples.value).toBe(false);
  })
})
