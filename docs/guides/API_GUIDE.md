# API Configuration Guide

To use AI-powered translation providers, you need a valid API key from the respective provider.

---

## 🔑 Getting an API Key

Below are the most common providers and how to get their API keys.

| Provider | Access | How to Get |
| :--- | :--- | :--- |
| **Google Translate** | Free | *No API key needed* |
| **Microsoft Translator** | Free | *No API key needed* |
| **Yandex Translate** | Free | *No API key needed* |
| **Lingva Translate** | Free | *No API key needed* |
| **Google Gemini** | Free/Paid | [Google AI Studio](https://aistudio.google.com/apikey/) |
| **DeepL** | Free/Paid | [DeepL API Keys](https://www.deepl.com/en/your-account/keys/) |
| **OpenRouter** | Paid | [OpenRouter API Keys](https://openrouter.ai/settings/keys/) |
| **Requesty** | Paid | [Requesty API Keys](https://app.requesty.ai/api-keys) |
| **OpenAI** | Paid | [OpenAI API Keys](https://platform.openai.com/api-keys/) |
| **DeepSeek** | Paid | [DeepSeek API Keys](https://platform.deepseek.com/api-keys/) |
| **WebAI to API** | Free | [Local Server](https://github.com/Amm1rr/WebAI-to-API/) |

---

## Multiple API Keys Support

You can enter **multiple API keys** for each provider (one per line). The extension will:
- ✅ Automatically try the next key if the current one fails (e.g., quota limit).
- ✅ Reorder working keys to the top for better performance.

---

## 🛠 Advanced Provider Settings

You can customize each provider's settings to balance quality and cost:

- **Google Gemini:** Change the `API URL` to use different models (e.g., `gemini-2.0-flash`).
- **OpenAI:** Enter specific model names like `gpt-4o` or `gpt-3.5-turbo`.
- **OpenRouter:** Support for a variety of models; use the model name from the [OpenRouter Docs](https://openrouter.ai/models).
- **Requesty:** Access many models through one API; pick a curated model or enter any model ID (e.g., `openai/gpt-4o-mini`) from the [Requesty Docs](https://docs.requesty.ai).
- **DeepSeek:** Customize model settings as per [DeepSeek Docs](https://api-docs.deepseek.com/api/list-models/); optionally set a thinking level.
- **DeepL:** Configure API tier (Free or Pro) and formality settings.
- **Custom (OpenAI Compatible):** Connect to self-hosted models (e.g., **Ollama**) or any third-party OpenAI-compatible API by providing a custom `API URL` and `Model Name`.

---

## Default Models

If you don't specify a model, these are the defaults used:
- **OpenAI / OpenRouter:** `gpt-3.5-turbo`
- **Requesty:** `openai/gpt-4o-mini`
- **Google Gemini / WebAI to API:** `gemini-1.5-flash`
- **DeepSeek:** `deepseek-flash`
