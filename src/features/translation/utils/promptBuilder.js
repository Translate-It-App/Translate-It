// src/features/translation/utils/promptBuilder.js
import {
  getPromptAsync,
  getPromptAutoAsync,
  getPromptBASESelectAsync,
  getPromptPopupTranslateAsync,
  getPromptBASEFieldAsync,
  getPromptBASEFieldAutoAsync,
  getEnableDictionaryAsync,
  getPromptDictionaryAsync,
  getPromptBASEBatchAsync, // Import the new getter
  getPromptBASEAIBatchAsync,
  getPromptBASEAIBatchAutoAsync,
  getPromptBASEScreenCaptureAsync,
  getSourceLanguageAsync,
  TranslationMode,
} from "@/shared/config/config.js";

import { getLanguageNameFromCode, getCanonicalCode } from '@/shared/config/languageConstants.js';
import { shouldUseAutoPromptAsync } from '@/features/translation/utils/bilingualPromptHelper.js';

import { getScopedLogger } from '@/shared/logging/logger.js';
import { LOG_COMPONENTS } from '@/shared/logging/logConstants.js';
import { NewlineManager } from '@/features/translation/utils/NewlineManager.js';
const logger = getScopedLogger(LOG_COMPONENTS.BACKGROUND, 'promptBuilder');


/**
 * بررسی می‌کند که آیا آبجکت ورودی مطابق با فرمت JSON خاص است
 * (آرایه‌ای از آبجکت‌ها که هر کدام دارای ویژگی text به‌صورت رشته هستند).
 *
 * @param {any} obj - آبجکت مورد بررسی.
 * @returns {boolean}
 */
function isSpecificTextJsonFormat(obj) {
  return (
    Array.isArray(obj) &&
    obj.length > 0 &&
    obj.every(
      (item) =>
        typeof item === "object" &&
        item !== null &&
        typeof item.text === "string",
    )
  );
}

/**
 * ساخت پرامت نهایی بر اساس ورودی، زبان‌ها و حالت ترجمه.
 *
 * @param {string} text - متنی که باید ترجمه شود.
 * @param {string} sourceLang - زبان مبدا.
 * @param {string} targetLang - زبان مقصد.
 * @param {string} [translateMode=TranslationMode.Field] - حالت ترجمه (مانند Popup_Translate، Dictionary_Translation، و غیره).
 * @param {string} [providerType='translate'] - The type of the provider ('ai' or 'translate').
 * @returns {Promise<string>} - پرامت نهایی ساخته شده.
 */
export async function buildPrompt(
  text = "$_{TEXT}",
  sourceLang,
  targetLang,
  translateMode = TranslationMode.Field,
  providerType = 'translate',
  { instructionsOnly = false } = {},
) {
  let isJsonMode = false;
  try {
    const parsedText = JSON.parse(text);
    if (isSpecificTextJsonFormat(parsedText)) {
      isJsonMode = true;
    }
  } catch {
    // Not JSON
  }

  const isAI = providerType === 'ai';

  // Use full language names for better AI performance
  // Capitalize first letter of language names for better presentation
  const capitalize = (s) => s.charAt(0).toUpperCase() + s.slice(1);
  
  // In 'auto' mode, we still need the actual source language for reverse translation logic in templates
  let actualSourceLang = sourceLang === 'auto' ? await getSourceLanguageAsync() : sourceLang;
  
  // If the stored setting is also 'auto', fallback to 'en' to avoid "Auto to Auto" translation
  if (actualSourceLang === 'auto') {
    actualSourceLang = 'en';
  }
  
  const sourceName = capitalize(getLanguageNameFromCode(getCanonicalCode(actualSourceLang)) || actualSourceLang);
  const targetName = capitalize(getLanguageNameFromCode(getCanonicalCode(targetLang)) || targetLang);
  const useAutoPrompt = await shouldUseAutoPromptAsync(sourceLang, translateMode);

  // Resolve instructions from template
  const promptTemplate = useAutoPrompt
    ? await getPromptAutoAsync()
    : await getPromptAsync();

  // Remove $_{TEXT} from prompt instructions since it will be replaced in the base prompt
  const promptInstructionsWithoutText = promptTemplate
    .replace(/\$_{TEXT}\s*/g, '')  // Remove $_{TEXT} placeholder and trailing whitespace
    .replace(/\n\s*$/g, '');        // Remove trailing empty lines

  const promptInstructions = promptInstructionsWithoutText
    .replace(/\$_{SOURCE}/g, sourceName)
    .replace(/\$_{TARGET}/g, targetName);

  // Handle AI provider batch translation for select_element or any JSON text
  if (isAI && (translateMode === TranslationMode.Select_Element || translateMode === TranslationMode.PDF || isJsonMode)) {
    logger.debug('AI provider in Batch mode. Using AI batch prompt.');
    const batchPromptTemplate = useAutoPrompt
      ? await getPromptBASEAIBatchAutoAsync()
      : await getPromptBASEAIBatchAsync();

    let jsonCount = 1;
    try {
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed)) {
        jsonCount = parsed.length;
      } else if (parsed && Array.isArray(parsed.translations)) {
        jsonCount = parsed.translations.length;
      }
    } catch {
      // Ignore JSON parsing errors for count estimation
    }

    return batchPromptTemplate
      .replace(/\$_{SOURCE}/g, sourceName)
      .replace(/\$_{TARGET}/g, targetName)
      .replace(/\$_{PROMPT_INSTRUCTIONS}/g, promptInstructions)
      .replace(/\$_{COUNT}/g, String(jsonCount))
      .replace(/\$_{TEXT}/g, text);
  }


  // If mode is Select_Element and text is NOT JSON,
  // it means it's a pre-processed batch of texts. Use the batch prompt.
  if ((translateMode === TranslationMode.Select_Element || translateMode === TranslationMode.PDF) && !isJsonMode) {
    logger.debug('AI provider in structured batch mode. Using batch prompt.');
    const batchPromptTemplate = await getPromptBASEBatchAsync();
    return batchPromptTemplate
      .replace(/\$_{SOURCE}/g, sourceName)
      .replace(/\$_{TARGET}/g, targetName)
      .replace(/\$_{PROMPT_INSTRUCTIONS}/g, promptInstructions)
      .replace(/\$_{TEXT}/g, text);
  }

  // For other cases, select the base prompt accordingly.
  let promptBase;
  if (isJsonMode) {
    // This handles reliable AI providers in structured batch modes, as they get raw JSON.
    promptBase = await getPromptBASESelectAsync();
  } else if (
    translateMode === TranslationMode.Popup_Translate ||
    translateMode === TranslationMode.Sidepanel_Translate
  ) {
    promptBase = await getPromptPopupTranslateAsync();
  } else if (await getEnableDictionaryAsync() && translateMode === TranslationMode.Dictionary_Translation) {
    promptBase = await getPromptDictionaryAsync();
  } else {
    // Fallback for simple field translation or other modes (Selection, Field, ScreenCapture, etc.)
    if (translateMode === TranslationMode.ScreenCapture) {
      promptBase = await getPromptBASEScreenCaptureAsync();
    } else {
      promptBase = useAutoPrompt 
        ? await getPromptBASEFieldAutoAsync() 
        : await getPromptBASEFieldAsync();
    }
  }

  // Now, build the final prompt by injecting languages and instructions.
  let finalPromptWithInstructions = promptBase
    .replace(/\$_{SOURCE}/g, sourceName)
    .replace(/\$_{TARGET}/g, targetName)
    .replace(/\$_{PROMPT_INSTRUCTIONS}/g, promptInstructions)
    .replace(/\$_{COUNT}/g, '1');

  if (instructionsOnly) {
    return finalPromptWithInstructions.replace(/\$_{TEXT}/g, 'the text provided in the user message');
  }

  // Inject the actual text to be translated.
  // $_{TEXT} is now required in the prompt template, so we can safely replace it.
  const protectedText = isAI ? NewlineManager.protect(text) : text;
  const finalPrompt = finalPromptWithInstructions.replace(
    /\$_{TEXT}/g,
    protectedText,
  );

  return finalPrompt;
}
