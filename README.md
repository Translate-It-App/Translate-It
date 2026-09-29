# Translate It!
> Translate the web, your way.

<p align="center">
  <a target="_blank" href="https://chromewebstore.google.com/detail/AI%20Writing%20Companion%20for%20Chrome/jfkpmcnebiamnbbkpmmldomjijiahmbd/">
    <img src="./docs/Store/Chrome-Store.png" alt="Chrome" height="60" />
  </a>
  <a target="_blank" href="https://addons.mozilla.org/en-GB/firefox/addon/ai-writing-companion/">
    <img src="./docs/Store/Firefox-Store.png" alt="Firefox" height="60" />
  </a>
</p>

<br>

---

<br>

<div align="center">
  <strong>
    • English | 
    • <a href="./docs/README_FARSI.md">فارسی</a> | 
    • <a href="./docs/README_JAPANESE.md">日本語</a>
  </strong>
</div>

<br>

<p align="center">
  <img src="./docs/Images/Options.jpg" alt="Translate It Extension" height="400" />
</p>

**Translate It** is not just a translator; it's a high-performance, modular ecosystem designed to bridge the language gap across any device. Engineered with a "zero-pressure" philosophy, it is optimized to run seamlessly in modern browsers without taxing system resources or bloating RAM, even when dozens of tabs are active. Built with **Vue.js 3** and powered by **10+ Providers**, it offers a surgical approach to web translation with a focus on privacy, speed, and cost-efficiency.

<br>

<p align="center">
  <a href="https://youtu.be/VxgRWlx20wU">
    <b>Watch Demo on YouTube</b>
  </a>
  <br>
  <a href="https://youtu.be/VxgRWlx20wU">
    <img src="./docs/Images/Windows.png" alt="Watch the video" width="560" />
  </a>
</p>

---

## Goals

- **Privacy and control:** You decide how your translations are processed. Where supported, you can use local or offline providers, or configure the cloud service you prefer.
- **Freedom to choose:** You’re not tied to a single provider. Switch between local, free, traditional, and AI-powered services whenever you need.
- **One tool for different needs:** Translate selected text, input fields, page elements, full pages, PDFs, subtitles, images with OCR, text on hover, and live audio.
- **Built for everyday browsing:** Designed to work smoothly with dynamic pages, long content, continuous translation, and both desktop and mobile browsers.

---

## Features at a Glance

| Feature | Description |
| :--- | :--- |
| **Text Selection** | Instant translation icon/box right where you select text. |
| **Element Mode** | Click any UI element to translate it inline while keeping the layout. |
| **Whole Page** | Auto-translate entire pages with lazy-loading and smart memory management. |
| **PDF Translator** | Translate local and online PDF documents with bilingual reading, OCR support for scanned PDFs, and TXT/Markdown/HTML export. |
| **Mouse Hover** | Instant translation tooltip triggered by moving mouse over text (supports Word/Sentence/Container scopes). |
| **Desktop/Mobile FAB** | Multipurpose draggable hub for instant OCR, Page Translation, Element Mode, and rapid feature toggles. |
| **In-Field (Ctrl+/)** | Translate your input inside text fields before sending. |
| **Smart Dictionary** | Definitions, synonyms, and usage examples with multi-accent TTS. |
| **History & Export** | Keep track of your translations and export them for later use. |
| **Resource Tracker** | Advanced memory management to keep your browser fast. |

---

## Supported Providers

Choose from traditional, AI, local, and specialized providers:

- **Traditional:** [Google](https://translate.google.com/), [Microsoft](https://www.microsoft.com/translator/), [DeepL](https://www.deepl.com/translator), [Yandex](https://translate.yandex.com/), [Lingva](https://github.com/TheDavidDelta/lingva-translate), [Bing](https://www.bing.com/translator)
- **AI:** [Gemini](https://ai.google.dev/), [OpenAI](https://openai.com/api/), [OpenRouter](https://openrouter.ai/), [Requesty](https://www.requesty.ai/), [DeepSeek](https://platform.deepseek.com/)
- **Custom & Local:** OpenAI Compatible, [WebAI-to-API](https://github.com/Amm1rr/WebAI-to-API/), Browser Translation
- **Dictionary:** [Vajehyab](https://vajehyab.com/)

Some providers require an API key, while others work without one.


---

## Getting Started

### 1. Installation
Install via the official stores for the best experience:

<p align="center">
  <a target="_blank" href="https://chromewebstore.google.com/detail/AI%20Writing%20Companion%20for%20Chrome/jfkpmcnebiamnbbkpmmldomjijiahmbd/">
    <img src="./docs/Store/Chrome-Store.png" alt="Chrome" height="50" />
  </a>
  <a target="_blank" href="https://addons.mozilla.org/en-GB/firefox/addon/ai-writing-companion/">
    <img src="./docs/Store/Firefox-Store.png" alt="Firefox" height="50" />
  </a>
</p>

*For manual installation, see the [Installation Guide](./docs/guides/INSTALLATION.md).*

### 2. Configuration
Most AI providers require an API key.
- Follow the [**API Configuration Guide**](./docs/guides/API_GUIDE.md) to set up Gemini, OpenAI, etc.
- *Free providers like Google and Yandex work out of the box.*

### 3. Mastering Shortcuts
Maximize your productivity with the [**User Guide**](./docs/guides/USAGE.md).

---

## Key Features

### 1. Advanced Translation Engines
- **Progressive Streaming Engine:** Don't wait for large translations! The system splits long texts into optimized segments and renders them in real-time as they arrive, providing a fluid and responsive experience across all providers.
- **10+ Providers:** Switch between advanced AI models (LLMs) and traditional providers (Google, Microsoft, DeepL) instantly.

<br>

### 2. Surgical Element Translation (Point-and-Click)
- **Visual Highlight:** Activate the mode and hover over any paragraph, button, or menu to see a real-time orange highlight. Click to translate that specific element instantly.
- **Layout Preservation:** Translate text directly inside the website's structure. Your page layout remains 100% intact.
- **Hover Preview:** Need to see the source? Simply hover over any translated element to see the original text in a surgical tooltip.
<!-- ELEMENT_SELECTION_SCREENSHOT_PLACEHOLDER -->

<br>

### 3. Smart Whole-Page Translation (Lazy-Loading)
- **Infinite Scrolling Support:** Automatically detects and translates new content as you scroll down. Perfect for social media and long-form articles.
- **Dual Execution Modes:** 
  - **Fluid Mode:** Translates content in real-time as it enters the viewport.
  - **On-Stop Mode:** Waits for you to finish scrolling before initiating translation, saving API costs and reducing visual noise.
<!-- WHOLE_PAGE_SCREENSHOT_PLACEHOLDER -->

<br>

### 4. Screen Capture & OCR (Anything-to-Text)
- **Visual Translation:** Capture and translate text from images, videos, PDFs, or any non-selectable web area.
- **Offline Engine:** Powered by Tesseract.js with local model caching for "True Offline" privacy.
<!-- OCR_SCREENSHOT_PLACEHOLDER -->

<br>

### 5. PDF Translator
- **Local & Online Documents:** Open PDF files from your device or a URL.
- **Bilingual & Translated Views:** Translate pages on demand and switch between bilingual and translated views.
- **Navigate & Select:** Move between pages and select PDF text naturally.
- **Scanned PDF OCR & Export:** Extract text from scanned PDFs with OCR, then export translations to TXT, Markdown, or HTML.
<!-- PDF_TRANSLATOR_SCREENSHOT_PLACEHOLDER -->

<br>

### 6. Subtitle Translation (SRT)
- **Easy File Translation:** Upload your movie or course subtitles (`.srt`) and translate them to any language in seconds.
- **Perfect Timing & Style:** Your video timestamps, italics, and bold text stay exactly as they are. No broken files.
- **Live Preview:** Watch the translation happen line-by-line with a clear progress bar and estimated time remaining.
- **Fast & Reliable:** Built to handle even long movies smoothly without missing a single line.

<br>

### 7. Smart Optimization Slider (Economy vs. Turbo)
Take full control over your API costs and UI speed with **Optimization Levels (1-5)**:
- **Economy Mode (Level 1):** Packs 70% more text per request. Perfect for saving AI tokens and preventing IP bans on traditional providers.
- **Turbo Mode (Level 5):** Maximizes concurrency for the fastest possible UI response.
<!-- OPTIMIZATION_SLIDER_PLACEHOLDER -->

<br>

### 8. Cross-Platform Ergonomics
- **Mobile Bottom Sheet:** A native-like, thumb-friendly interface for mobile browsers (Firefox Android, Kiwi, Lemur) with gesture support.
- **Desktop/Mobile FAB Menu:** A draggable, persistent floating action button for instant access to OCR, Page Translation, Element Mode, and rapid feature toggles (like instant TTS or direct-translation mode).

<br>

### 9. Mouse on Hover (Instant Glance)
- **Glance-to-Translate:** Move your mouse over any text while holding a modifier key (like Ctrl) to see an instant translation in a non-intrusive tooltip.
- **Smart Scoping:** Choose your focus: translate a single **Word**, a full **Sentence**, or the entire **Container** block automatically.

---

## Developer & Contributing

We follow a **Feature-Based Architecture** using Vue 3, Pinia, and Vite.
- **Architecture:** Explore [ARCHITECTURE.md](./docs/technical/ARCHITECTURE.md) to understand the modular system.
- **Contributing:** Read [CONTRIBUTING.md](./docs/guides/CONTRIBUTING.md) for local setup instructions.
- **Localization:** Help us reach more people by following the [Localization Guide](./docs/guides/LOCALIZATION_GUIDE.md).

---

## Support & Partnerships

Translate It is free and open source. Sponsorship directly supports its continued development, testing, and maintenance.

- **Sponsorship:** Support the project through [GitHub Sponsors](https://github.com/sponsors/Amm1rr). See [SPONSORSHIP.md](./SPONSORSHIP.md).
- **Partnerships:** Technical, ecosystem, and commercial collaborations are handled separately. See [PARTNERSHIPS.md](./PARTNERSHIPS.md).

---

<p align="center">
  <a href="https://www.greptile.com/?utm_source=oss_badge&utm_medium=readme&utm_campaign=greptile_for_open_source">
    <img src="https://www.greptile.com/badge.svg" alt="Greptile: The War on Bugs">
  </a>
</p>

---

## License

This project is licensed under the **Apache License 2.0**.

For more details, please see the [LICENSE](LICENSE) file.

---

<p align="center">
  <a href="https://www.star-history.com/#Translate-It-App/Translate-It&Date">
    <img alt="Star History Chart" src="https://api.star-history.com/svg?repos=Translate-It-App/Translate-It&type=Date" />
  </a>
</p>
