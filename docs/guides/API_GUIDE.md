# API Configuration Guide

Some API-based providers require a valid API key, while others — including local or custom configurations — can work without one depending on setup.

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
| **Cheaper Inference** | Paid | [Cheaper Inference](https://cheaperinference.com) |
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

- **Google Gemini:** Select the model from the Model selector. Use a custom `API URL` only when choosing Custom Model. Catalog selections from Google's official endpoint use Google's official API.
- **OpenAI:** Enter specific model names like `gpt-6-luna` or `gpt-6-sol`, or browse and search the model catalog after adding an API key.
- **OpenRouter:** Support for a variety of models; browse and search the catalog, or use the model name from the [OpenRouter Docs](https://openrouter.ai/models).
- **Requesty:** Access many models through one API; browse and search the catalog, or enter any model ID (e.g., `openai/gpt-4o-mini`) from the [Requesty Docs](https://docs.requesty.ai).
- **Cheaper Inference:** Access models from several labs through one OpenAI-compatible API; browse and search the catalog, or enter any model ID (e.g., `gpt-5.4-mini`) from the [Cheaper Inference Docs](https://cheaperinference.com/docs).
- **DeepSeek:** Customize model settings as per [DeepSeek Docs](https://api-docs.deepseek.com/api/list-models/); browse and search the catalog after adding an API key, and optionally set a thinking level.
- **WebAI to API:** Browse the models advertised by your local server after entering its URL, or enter a custom model name manually.
- **DeepL:** Configure API tier (Free or Pro) and formality settings.
- **Custom (OpenAI Compatible):** Connect to self-hosted models (e.g., **Ollama**) or any third-party OpenAI-compatible API by providing a custom `API URL` and `Model Name`.

---

## Browsing and Selecting Models

For **Google Gemini**, **OpenAI**, **OpenRouter**, **Requesty**, **Cheaper Inference**, and **DeepSeek**, the provider panel can load a searchable model catalog for you:

1. Enter the required credentials: an API key is required for Gemini, OpenAI, and DeepSeek, while OpenRouter, Requesty, and Cheaper Inference can also browse public catalogs without one.
2. Wait for the model catalog to load — the panel shows loading, failure, and empty states.
3. Use the search field to filter by model ID or name. Up to 50 matching models are displayed at a time; when more results are available, the panel shows how many matches were found.
4. Pick a model from the catalog picker, or keep a curated or saved model from the main Model selector. OpenRouter also displays per-model pricing.

OpenRouter catalog prices are base USD rates per million tokens; rates may vary by tier, and additional fees may apply.

**WebAI to API** works differently: after entering the server URL, the models advertised by your server are added directly to the main Model selector. There is no separate searchable catalog.

Your saved model is always preserved: if it is not listed by the provider, it stays selected and the panel tells you it was not advertised. Choosing **Custom Model** keeps manual entry — for Gemini this is a custom API URL containing the model name; for the other providers it is a manually typed model name, used as-is.

**Custom endpoints (Gemini and DeepSeek):** automatic catalog discovery only runs against the official provider endpoint. When a custom API URL is configured, the catalog is not loaded and your key is never sent to the official catalog — keep configuring the model manually. For Gemini, catalog selections use Google's official API only while the saved endpoint is official; a saved custom URL always stays authoritative for translation and key validation and is never silently replaced.

---

## Default Models

If you don't specify a model, these are the defaults used:
- **OpenAI:** `gpt-6-luna`
- **OpenRouter:** `openai/gpt-6-luna`
- **Requesty:** `openai/gpt-4o-mini`
- **Cheaper Inference:** `gpt-5.4-mini`
- **Google Gemini:** `gemini-3.8-flash`
- **WebAI to API:** `gemini-3-flash`
- **DeepSeek:** `deepseek-flash`
