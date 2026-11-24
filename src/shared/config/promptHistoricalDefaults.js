/**
 * Historical Prompt Defaults Registry
 * 
 * ============================================================================
 * WHY HISTORICAL DEFAULTS EXIST:
 * When editable prompt templates are updated in Translate-It, we need a way
 * to upgrade users who are using the default templates to the latest version,
 * while strictly preserving user-customized prompts.
 *
 * SCOPE: EDITABLE-ONLY.
 * Historical prompt migration applies ONLY to editable persisted prompts.
 * Non-editable internal wrappers (PROMPT_REGISTRY.editable === false) are
 * CONFIG-owned implementation defaults: they are not persisted, not exported,
 * not imported, and never migrated. Do NOT register them here.
 * 
 * HOW SAFE PROMPT MIGRATION WORKS:
 * 1. Missing Prompt: If a prompt key is missing in user settings, we add the current CONFIG default.
 * 2. Empty Prompt: If a prompt is empty or blank, we restore the current CONFIG default.
 * 3. Exact Current Default Match: If the stored prompt exactly matches the current CONFIG default,
 *    we leave it unchanged.
 * 4. Historical Default Match: If the stored prompt matches any of the legacy defaults registered
 *    in this file, it means the user never customized it. We safely upgrade it to the latest CONFIG default.
 * 5. Customized Prompt: If it does not match current or legacy defaults, we preserve the user's edits.
 * 
 * WHEN DEVELOPERS MUST ADD ENTRIES:
 * Whenever you modify an EDITABLE default prompt in `src/shared/config/config.js`
 * (e.g., changing CONFIG.PROMPT_TEMPLATE):
 * 1. Copy the EXACT previous multi-line default string.
 * 2. Add it to this registry under the corresponding prompt key as a new object:
 *    {
 *      version: 'vX.Y.Z',      // The version range in which this default was active
 *      reason: 'Description',  // Why the default was changed (e.g. 'Added formatting support')
 *      value: `...`            // The exact legacy default template string
 *    }
 * 3. Users may upgrade across multiple versions. Keep old legacy defaults in this file
 *    indefinitely to ensure all updating users can be safely migrated.
 * ============================================================================
 */

export const HISTORICAL_PROMPT_DEFAULTS = {
  PROMPT_TEMPLATE: [
    {
      version: 'v1.26.0',
      reason: 'Consolidated repetitive translation quality guidance',
      value: `- Translate the input text from $_{SOURCE} (or any other language) into $_{TARGET}.
- Produce fluent, natural, and idiomatic translations as if written by a native speaker.
- Prioritize clarity, tone, and readability while preserving the original intent and formatting.
- Maintain the original formatting, structure, and line breaks exactly.
- If the input is already in $_{TARGET}, keep it unchanged or provide a natural refinement if necessary.
- Do **not** include any additional explanations, comments, markdown, or extra content.

$_{TEXT}`
    }
  ],
  PROMPT_TEMPLATE_AUTO: [
    {
      version: 'v1.26.0',
      reason: 'Consolidated repetitive translation quality guidance',
      value: `- Translate the input text into $_{TARGET}.
- Produce fluent, natural, and idiomatic translations as if written by a native speaker.
- Prioritize clarity, tone, and readability while preserving the original intent and formatting.
- Maintain the original formatting, structure, and line breaks exactly.
- If the input is already in $_{TARGET}, translate it into $_{SOURCE} only if the entire context suggests a reverse translation is intended.
- Do **not** include any additional explanations, comments, markdown, or extra content.

$_{TEXT}`
    }
  ],
  PROMPT_BASE_FIELD: [],
  PROMPT_BASE_FIELD_AUTO: [],
  PROMPT_BASE_POPUP_TRANSLATE: [],
  PROMPT_BASE_DICTIONARY: [],
  PROMPT_SUBTITLE_USER: []
};
