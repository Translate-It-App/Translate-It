# Localization Guide

To localize **Translate It!** into your local language, please follow the steps outlined in this document.

---

## How to Localize

Here is the simplest way to do it:

### 1. Clone the Repository
First, clone the project to your local machine:
```bash
git clone https://github.com/Translate-It-App/Translate-It.git
```

### 2. Find Your Language
All translation files are located in the `_locales/` folder.
- If your language already exists (e.g., `_locales/fa/` for Farsi), you can help by improving the existing translations.
- If it doesn't exist, we can help you set it up!

### 3. Translating the Strings
The translations are stored in a file called `messages.json`. It looks like this:

```json
"settings_title": {
  "message": "Settings"
}
```

**Your Task:**
- Change the text inside `"message"` (e.g., `"Settings"`) to your language.
- **Important:** Do **NOT** change the key on the left (e.g., `"settings_title"`).

### 4. Special Placeholders
Some messages have placeholders like `{appName}` or `{version}`.
- Please keep these exactly as they are (including the curly braces) so the extension can fill in the correct information automatically.

---

## 🛠 For Advanced Users (Scripts)

If you are comfortable using the terminal, we have some tools to make things easier:

1. **Check Sync Status**: Run `pnpm run i18n:sync:status` to see if there are any new English words that need translation.
2. **Auto-Add Missing Keys**: Run `pnpm run i18n:sync:fix` to automatically add any missing keys from English to your language file.
3. **Remove Unused Keys**: Run `pnpm run i18n:check:fix` to identify and remove keys that are no longer used in the source code (this keeps the project clean).
4. **Clean Up Notes**: After you finish translating, run `pnpm run i18n:purge [your-language-code]` to remove the "UNTRANSLATED" notes.

---

## ✅ Submitting Your Translation

Once you are happy with your translations:
1. Submit a **Pull Request** on GitHub.
2. We will review it and include it in the next update!

*If you find the technical steps (like GitHub or PRs) confusing, feel free to open an **Issue** and attach your translated `messages.json` file there. We'll handle the rest!*

---

**Detailed Technical Guide**: If you are a developer and want to know how the localization system works behind the scenes, see the [Localization Architecture Guide](../technical/LOCALIZATION.md).
