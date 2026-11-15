// src/utils/secureStorage.js

/**
 * Secure Storage Utility for API Keys
 * Uses Web Crypto API for strong encryption
 */

import { PROMPT_REGISTRY } from '@/shared/config/PromptRegistry.js';


class SecureStorage {
  constructor() {
    this.algorithm = "AES-GCM";
    this.keyLength = 256;
    this.ivLength = 12; // 96 bits for GCM
    this.saltLength = 16; // 128 bits
    this.iterations = 100000; // PBKDF2 iterations
  }

  /**
   * Generate a cryptographically secure random salt
   * @returns {Uint8Array} Random salt
   */
  generateSalt() {
    return crypto.getRandomValues(new Uint8Array(this.saltLength));
  }

  /**
   * Generate a cryptographically secure random IV
   * @returns {Uint8Array} Random IV
   */
  generateIV() {
    return crypto.getRandomValues(new Uint8Array(this.ivLength));
  }

  /**
   * Derive encryption key from password using PBKDF2
   * @param {string} password - User password
   * @param {Uint8Array} salt - Random salt
   * @returns {Promise<CryptoKey>} Derived encryption key
   */
  async deriveKey(password, salt) {
    const encoder = new TextEncoder();
    const keyMaterial = await crypto.subtle.importKey(
      "raw",
      encoder.encode(password),
      { name: "PBKDF2" },
      false,
      ["deriveKey"],
    );

    return crypto.subtle.deriveKey(
      {
        name: "PBKDF2",
        salt: salt,
        iterations: this.iterations,
        hash: "SHA-256",
      },
      keyMaterial,
      { name: this.algorithm, length: this.keyLength },
      false,
      ["encrypt", "decrypt"],
    );
  }

  /**
   * Convert ArrayBuffer to Base64 string
   * @param {ArrayBuffer} buffer - Buffer to convert
   * @returns {string} Base64 string
   */
  arrayBufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary = "";
    for (let i = 0; i < bytes.byteLength; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  }

  /**
   * Convert Base64 string to ArrayBuffer
   * @param {string} base64 - Base64 string
   * @returns {ArrayBuffer} Converted buffer
   */
  base64ToArrayBuffer(base64) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes.buffer;
  }

  /**
   * Encrypt sensitive data
   * @param {object} data - Data to encrypt (API keys)
   * @param {string} password - User password
   * @returns {Promise<object>} Encrypted data package
   */
  async encryptData(data, password) {
    if (!password || password.trim() === "") {
      throw new Error("Password is required for encryption");
    }

    const salt = this.generateSalt();
    const iv = this.generateIV();
    const key = await this.deriveKey(password, salt);

    const encoder = new TextEncoder();
    const dataString = JSON.stringify(data);
    const dataBuffer = encoder.encode(dataString);

    const encryptedData = await crypto.subtle.encrypt(
      {
        name: this.algorithm,
        iv: iv,
      },
      key,
      dataBuffer,
    );

    return {
      encrypted: true,
      algorithm: this.algorithm,
      salt: this.arrayBufferToBase64(salt),
      iv: this.arrayBufferToBase64(iv),
      data: this.arrayBufferToBase64(encryptedData),
      timestamp: Date.now(),
    };
  }

  /**
   * Decrypt sensitive data
   * @param {object} encryptedPackage - Encrypted data package
   * @param {string} password - User password
   * @returns {Promise<object>} Decrypted data
   */
  async decryptData(encryptedPackage, password) {
    if (!password || password.trim() === "") {
      throw new Error("Password is required for decryption");
    }

    if (!encryptedPackage.encrypted) {
      throw new Error("Data is not encrypted");
    }

    const salt = new Uint8Array(
      this.base64ToArrayBuffer(encryptedPackage.salt),
    );
    const iv = new Uint8Array(this.base64ToArrayBuffer(encryptedPackage.iv));
    const encryptedData = this.base64ToArrayBuffer(encryptedPackage.data);

    const key = await this.deriveKey(password, salt);

    try {
      const decryptedBuffer = await crypto.subtle.decrypt(
        {
          name: this.algorithm,
          iv: iv,
        },
        key,
        encryptedData,
      );

      const decoder = new TextDecoder();
      const decryptedString = decoder.decode(decryptedBuffer);
      return JSON.parse(decryptedString);
    } catch {
      throw new Error("Incorrect password or corrupted data");
    }
  }

  /**
   * Extract API keys from settings object
   * @param {object} settings - All settings
   * @returns {object} API keys only
   */
  extractApiKeys(settings) {
    const apiKeys = {};
    const keyFields = [
      "API_KEY", // Legacy Gemini Key
      "GEMINI_API_KEY",
      "OPENAI_API_KEY",
      "OPENROUTER_API_KEY",
      "REQUESTY_API_KEY",
      "CHEAPERINFERENCE_API_KEY",
      "DEEPSEEK_API_KEY",
      "DEEPL_API_KEY",
      "CUSTOM_API_KEY",
      "PROXY_PASSWORD",
    ];

    keyFields.forEach((field) => {
      if (settings[field]) {
        apiKeys[field] = settings[field];
      }
    });

    return apiKeys;
  }

  /**
   * Create settings object without API keys and large user data
   * @param {object} settings - All settings
   * @returns {object} Settings without API keys and history
   */
  removeSensitiveAndLargeData(settings) {
    const cleanSettings = { ...settings };
    const excludeFields = [
      "API_KEY", // Legacy Gemini Key
      "GEMINI_API_KEY",
      "OPENAI_API_KEY",
      "OPENROUTER_API_KEY",
      "REQUESTY_API_KEY",
      "CHEAPERINFERENCE_API_KEY",
      "DEEPSEEK_API_KEY",
      "DEEPL_API_KEY",
      "CUSTOM_API_KEY",
      "PROXY_USERNAME",
      "PROXY_PASSWORD",
      "translationHistory", // Exclude history from settings export
      "TTS_VOICES_CACHE", // Exclude large TTS voice cache from export
    ];

    excludeFields.forEach((field) => {
      delete cleanSettings[field];
    });

    // Non-editable prompt wrappers are CONFIG-owned implementation defaults, not
    // user configuration. They are no longer persisted and must not be exported.
    Object.values(PROMPT_REGISTRY)
      .filter((prompt) => !prompt.editable)
      .forEach((prompt) => {
        delete cleanSettings[prompt.key];
      });

    return cleanSettings;
  }

  /**
   * Prepare settings for secure export
   * @param {object} settings - All settings
   * @param {string} password - Optional password for encryption
   * @returns {Promise<object>} Export-ready settings
   */
  async prepareForExport(settings, password = null) {
    const apiKeys = this.extractApiKeys(settings);
    const cleanSettings = this.removeSensitiveAndLargeData(settings);

    if (password && password.trim() !== "") {
      // Encrypt API keys
      const encryptedKeys = await this.encryptData(apiKeys, password);
      return {
        ...cleanSettings,
        _secureKeys: encryptedKeys,
        _hasEncryptedKeys: true,
      };
    } else {
      // No encryption - include keys as plain text (backward compatibility)
      return {
        ...cleanSettings,
        ...apiKeys,
        _hasEncryptedKeys: false,
      };
    }
  }

  /**
   * Process imported settings with encrypted keys
   * @param {object} importedSettings - Imported settings
   * @param {string} password - Password for decryption (if needed)
   * @returns {Promise<object>} Processed settings ready for storage
   */
  async processImportedSettings(importedSettings, password = null) {
    if (!importedSettings._hasEncryptedKeys || !importedSettings._secureKeys) {
      // No encryption - return as is (backward compatibility)
      const cleanSettings = { ...importedSettings };
      delete cleanSettings._hasEncryptedKeys;
      delete cleanSettings._secureKeys;
      return cleanSettings;
    }

    if (!password || password.trim() === "") {
      throw new Error("Password is required to import encrypted settings");
    }

    // Decrypt API keys
    const decryptedKeys = await this.decryptData(
      importedSettings._secureKeys,
      password,
    );

    // Combine with other settings
    const cleanSettings = { ...importedSettings };
    delete cleanSettings._hasEncryptedKeys;
    delete cleanSettings._secureKeys;

    return {
      ...cleanSettings,
      ...decryptedKeys,
    };
  }
}

export default new SecureStorage();
