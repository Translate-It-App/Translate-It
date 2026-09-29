# Installation Guide

This document provides detailed instructions for installing the **Translate It!** web extension.

## Official Stores (Recommended)

The easiest way to install the extension is via the official web stores:

<p align="center">
  <a target="_blank" href="https://chromewebstore.google.com/detail/AI%20Writing%20Companion%20for%20Chrome/jfkpmcnebiamnbbkpmmldomjijiahmbd/">
    <img src="../Store/Chrome-Store.png" alt="Chrome" height="60" />
  </a>
  <a target="_blank" href="https://addons.mozilla.org/en-GB/firefox/addon/ai-writing-companion/">
    <img src="../Store/Firefox-Store.png" alt="Firefox" height="60" />
  </a>
</p>

---

## 🛠 Manual Installation

If you prefer to install the extension manually or use a specific version, follow the steps below.

### Chrome, Edge, Brave (Chromium-based)

1. **Download:** [Download the latest Chrome version here](https://github.com/Translate-It-App/Translate-It/tree/main/dist/Publish/).
2. **Extract:** Unzip the downloaded file.
3. **Open Extensions Page:** Open your browser and navigate to [`chrome://extensions/`](chrome://extensions/shortcuts).
4. **Enable Developer Mode:** Toggle the **Developer mode** switch in the top right corner.
5. **Install:** Drag and drop the extracted folder anywhere on the extensions page, or click **Load unpacked** and select the folder.
6. **Done!** You can now pin the extension to your toolbar.

---

### Firefox

1. **Download:** [Download the latest Firefox version here](https://github.com/Translate-It-App/Translate-It/tree/main/dist/Publish/).
2. **Extract:** Unzip the downloaded file.
3. **Open Debugging Page:** Open Firefox and navigate to `about:debugging#/runtime/this-firefox`.
4. **Load Temporary Add-on:** Click the **Load Temporary Add-on...** button.
5. **Select Manifest:** Navigate to the extracted folder and select the `manifest.json` file.
6. **Done!** The extension is now loaded.

*Note: Temporary add-ons in Firefox are removed when the browser is restarted. For permanent installation, use the official store.*

---

### Mobile Browsers (Kiwi, Lemur, Firefox Android)

1. **Kiwi / Lemur:**
   - Follow the **Chromium-based** manual installation steps above. 
   - Note: In mobile, you need to enable "Developer mode" in the browser's menu first.
2. **Firefox Android:**
   - Use the **Firefox Official Store** link. Please note that Firefox Android only supports extensions from verified collections or official stores.

---

## 🔑 Initial Setup

After installation:
1. Click the **extension icon** in your toolbar.
2. Go to **Options** (gear icon).
3. Select the **Languages** tab.
4. Choose your preferred **Translation Provider**.
5. Enter your **API Key** if required (see the [API Guide](./API_GUIDE.md) for more info).
