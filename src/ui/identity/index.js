const PASSWORD_DIALOG_ID = "identity-password-dialog";
const PASSWORD_META_STORAGE_KEY = "wingman_identity_password_meta";
const SESSION_STORAGE_KEY = "nostr_session";
const PASSWORD_CACHE_TTL_MS = 10 * 60 * 1000;
const DEFAULT_LOG_N = 18;
const BECH32_PREFIX = "ncryptsec";
const KEY_SECURITY_BYTE = 0x01;
const ENCRYPTION_VERSION = 0x02;

import { scryptAsync } from "/vendor/@noble/hashes/scrypt.js";
import { xchacha20poly1305 } from "/vendor/@noble/ciphers/chacha.js";
import { bech32 } from "/vendor/@scure/base/index.js";

const textEncoder = typeof TextEncoder !== "undefined" ? new TextEncoder() : null;

class PasswordPromptCancelledError extends Error {
  constructor() {
    super("Password entry cancelled");
    this.name = "PasswordPromptCancelledError";
  }
}

const getCrypto = () => {
  if (typeof globalThis !== "undefined" && globalThis.crypto && typeof globalThis.crypto.getRandomValues === "function") {
    return globalThis.crypto;
  }
  throw new Error("Secure random generator unavailable");
};

const randomBytes = (length) => {
  const crypto = getCrypto();
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
};

const concatBytes = (...arrays) => {
  const totalLength = arrays.reduce((sum, arr) => sum + arr.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  arrays.forEach((arr) => {
    result.set(arr, offset);
    offset += arr.length;
  });
  return result;
};

const wipeBytes = (bytes) => {
  if (!bytes) return;
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = 0;
  }
};

const loadPasswordMeta = () => {
  if (typeof window === "undefined" || !window.localStorage) return null;
  try {
    const raw = window.localStorage.getItem(PASSWORD_META_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    if (typeof parsed.logN !== "number" || !Number.isFinite(parsed.logN)) return null;
    return {
      logN: parsed.logN,
      version: typeof parsed.version === "number" ? parsed.version : 1,
      createdAt: typeof parsed.createdAt === "number" ? parsed.createdAt : null,
    };
  } catch {
    return null;
  }
};

const writePasswordMeta = (meta) => {
  if (typeof window === "undefined" || !window.localStorage) return;
  try {
    const payload = {
      version: 1,
      logN: meta.logN ?? DEFAULT_LOG_N,
      createdAt: meta.createdAt ?? Date.now(),
    };
    window.localStorage.setItem(PASSWORD_META_STORAGE_KEY, JSON.stringify(payload));
  } catch {
    // ignore storage failures
  }
};

const clearPasswordMeta = () => {
  if (typeof window === "undefined" || !window.localStorage) return;
  try {
    window.localStorage.removeItem(PASSWORD_META_STORAGE_KEY);
  } catch {
    // ignore
  }
};

const sessionCache = {
  save(session) {
    if (typeof window === "undefined" || !window.localStorage) return;
    const payload = {
      schema: 1,
      npub: session.npub ?? null,
      encryptedNsec: session.encryptedNsec ?? null,
      sessionExpiresAt: session.sessionExpiresAt ?? null,
      method: session.method ?? "local_keys",
      logN: session.logN ?? DEFAULT_LOG_N,
      createdAt: Date.now(),
    };
    try {
      window.localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(payload));
      if (typeof payload.encryptedNsec === "string" && payload.encryptedNsec.length > 0) {
        writePasswordMeta({ logN: payload.logN, createdAt: payload.createdAt });
      }
    } catch {
      // ignore storage failures
    }
  },
  load() {
    if (typeof window === "undefined" || !window.localStorage) return null;
    try {
      const raw = window.localStorage.getItem(SESSION_STORAGE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object") return null;
      if (parsed.sessionExpiresAt && Number.isFinite(parsed.sessionExpiresAt)) {
        if (Date.now() > Number(parsed.sessionExpiresAt)) {
          window.localStorage.removeItem(SESSION_STORAGE_KEY);
          return null;
        }
      }
      return parsed;
    } catch {
      return null;
    }
  },
  clear() {
    if (typeof window === "undefined" || !window.localStorage) return;
    try {
      window.localStorage.removeItem(SESSION_STORAGE_KEY);
    } catch {
      // ignore
    }
  },
  hasEncryptedNsec() {
    const session = sessionCache.load();
    return Boolean(session && typeof session.encryptedNsec === "string" && session.encryptedNsec.length > 0);
  },
};

let cachedPassword = null;
let cacheExpiresAt = 0;
let activePromptPromise = null;
let passwordDialogElements = null;

const getCachedPassword = () => {
  if (!cachedPassword) return null;
  if (Date.now() > cacheExpiresAt) {
    cachedPassword = null;
    cacheExpiresAt = 0;
    return null;
  }
  return cachedPassword;
};

const setCachedPassword = (password) => {
  cachedPassword = password;
  cacheExpiresAt = Date.now() + PASSWORD_CACHE_TTL_MS;
};

const clearPasswordCache = () => {
  cachedPassword = null;
  cacheExpiresAt = 0;
};

const ensureDialogElements = () => {
  if (passwordDialogElements) return passwordDialogElements;
  if (typeof document === "undefined") return null;
  const dialog = document.getElementById(PASSWORD_DIALOG_ID);
  if (!(dialog instanceof HTMLDialogElement)) return null;
  const form = dialog.querySelector('form[data-role="form"]');
  const passwordInput = form?.querySelector('input[name="password"]') ?? null;
  const confirmField = form?.querySelector('[data-role="confirm-field"]') ?? null;
  const confirmInput = confirmField?.querySelector('input[name="passwordConfirm"]') ?? null;
  const errorEl = form?.querySelector('[data-role="error"]') ?? null;
  const clearButton = form?.querySelector('[data-action="identity-password-clear"]') ?? null;
  const title = form?.querySelector('[data-role="title"]') ?? null;
  const description = form?.querySelector('[data-role="description"]') ?? null;

  passwordDialogElements = {
    dialog,
    form,
    passwordInput,
    confirmField,
    confirmInput,
    errorEl,
    clearButton,
    title,
    description,
  };
  return passwordDialogElements;
};

const showPasswordDialog = async ({
  mode,
  message,
  errorMessage,
  allowReset,
}) => {
  const elements = ensureDialogElements();
  if (!elements) {
    throw new Error("Password dialog unavailable");
  }

  const { dialog, form, passwordInput, confirmField, confirmInput, errorEl, clearButton, title, description } =
    elements;
  if (!form || !passwordInput || !dialog) {
    throw new Error("Password dialog incomplete");
  }

  const needsConfirmation = mode === "create";

  if (title) {
    title.textContent = needsConfirmation ? "Protect Your Key" : "Unlock Saved Key";
  }
  if (description) {
    description.textContent =
      message ??
      (needsConfirmation
        ? "Create a password to encrypt your Nostr private key on this device."
        : "Enter the password you previously set to unlock cached sessions.");
  }

  if (confirmField) {
    confirmField.hidden = !needsConfirmation;
  }
  if (confirmInput) {
    confirmInput.required = needsConfirmation;
    confirmInput.value = "";
    confirmInput.autocomplete = needsConfirmation ? "new-password" : "current-password";
  }

  passwordInput.value = "";
  passwordInput.autocomplete = needsConfirmation ? "new-password" : "current-password";

  if (errorEl) {
    if (errorMessage) {
      errorEl.textContent = errorMessage;
      errorEl.hidden = false;
    } else {
      errorEl.hidden = true;
      errorEl.textContent = "";
    }
  }

  if (clearButton) {
    clearButton.hidden = !allowReset;
  }

  let submittedData = null;

  return new Promise((resolve) => {
    const handleSubmit = (event) => {
      event.preventDefault();
      const password = passwordInput.value.trim();
      if (!password) {
        if (errorEl) {
          errorEl.textContent = "Password is required";
          errorEl.hidden = false;
        }
        passwordInput.focus();
        return;
      }
      if (needsConfirmation && confirmInput) {
        const confirmation = confirmInput.value.trim();
        if (password !== confirmation) {
          if (errorEl) {
            errorEl.textContent = "Passwords do not match";
            errorEl.hidden = false;
          }
          confirmInput.focus();
          confirmInput.select();
          return;
        }
      }
      submittedData = { password };
      dialog.close("confirm");
    };

    const handleClear = () => {
      submittedData = { cleared: true };
      dialog.close("clear");
    };

    const handleCancel = () => {
      if (!submittedData) {
        submittedData = { cancelled: true };
      }
    };

    const handleClose = () => {
      form.removeEventListener("submit", handleSubmit);
      dialog.removeEventListener("cancel", handleCancel);
      dialog.removeEventListener("close", handleClose);
      if (clearButton) {
        clearButton.removeEventListener("click", handleClear);
      }
      if (submittedData?.cleared) {
        resolve({ cleared: true });
        return;
      }
      if (dialog.returnValue === "confirm" && submittedData?.password) {
        resolve({ password: submittedData.password });
        return;
      }
      resolve(null);
    };

    form.addEventListener("submit", handleSubmit);
    dialog.addEventListener("cancel", handleCancel, { once: true });
    dialog.addEventListener("close", handleClose, { once: true });
    if (clearButton && !clearButton.hidden) {
      clearButton.addEventListener("click", handleClear);
    }

    dialog.returnValue = "";
    dialog.showModal();
    requestAnimationFrame(() => {
      passwordInput.focus();
      passwordInput.select();
    });
  });
};

const runPasswordPrompt = async ({ mode, reason, errorMessage, validate } = {}) => {
  const hasEncrypted = sessionCache.hasEncryptedNsec();
  let passwordMeta = loadPasswordMeta();
  let effectiveMode = mode;
  if (!effectiveMode || (effectiveMode !== "create" && effectiveMode !== "unlock")) {
    effectiveMode = passwordMeta ? "unlock" : "create";
  }
  let validationError = errorMessage ?? null;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const result = await showPasswordDialog({
      mode: effectiveMode,
      message: reason,
      errorMessage: validationError,
      allowReset: hasEncrypted || Boolean(passwordMeta),
    });

    if (!result) {
      throw new PasswordPromptCancelledError();
    }

    if (result.cleared) {
      sessionCache.clear();
      clearPasswordMeta();
      clearPasswordCache();
      passwordMeta = null;
      effectiveMode = "create";
      validationError = null;
      if (typeof window !== "undefined") {
        window.dispatchEvent(new CustomEvent("wingman:identity-encrypted-cleared"));
      }
      continue;
    }

    const password = result.password;
    if (!password) {
      validationError = "Password is required";
      continue;
    }

    if (typeof validate === "function") {
      try {
        const validationResult = await validate(password);
        if (!validationResult) {
          validationError = "Incorrect password";
          clearPasswordCache();
          continue;
        }
      } catch (error) {
        console.warn("[identity] password validation failed", error);
        validationError = "Unable to validate password";
        clearPasswordCache();
        continue;
      }
    }

    if (effectiveMode === "create") {
      writePasswordMeta({ logN: DEFAULT_LOG_N, createdAt: Date.now() });
    }

    setCachedPassword(password);
    return password;
  }
};

const ensurePassword = async (options = {}) => {
  const cached = getCachedPassword();
  if (cached) return cached;

  if (!activePromptPromise) {
    activePromptPromise = runPasswordPrompt(options).finally(() => {
      activePromptPromise = null;
    });
  }

  return activePromptPromise;
};

const deriveSymmetricKey = async (password, salt, logN = DEFAULT_LOG_N) => {
  if (!textEncoder) throw new Error("TextEncoder not supported");
  const normalizedPassword = password.normalize("NFKC");
  const passwordBytes = textEncoder.encode(normalizedPassword);
  try {
    const N = 1 << logN;
    return await scryptAsync(passwordBytes, salt, {
      N,
      r: 8,
      p: 1,
      dkLen: 32,
    });
  } finally {
    wipeBytes(passwordBytes);
  }
};

const encryptPrivateKeyWithPassword = async (rawKey, password, logN = DEFAULT_LOG_N) => {
  if (!(rawKey instanceof Uint8Array)) {
    throw new TypeError("rawKey must be a Uint8Array");
  }
  if (rawKey.length !== 32) {
    throw new Error("rawKey must be 32 bytes");
  }

  const salt = randomBytes(16);
  const nonce = randomBytes(24);
  const associatedData = new Uint8Array([KEY_SECURITY_BYTE]);
  const symmetricKey = await deriveSymmetricKey(password, salt, logN);

  try {
    const cipher = xchacha20poly1305(symmetricKey, nonce, associatedData);
    const ciphertext = cipher.encrypt(rawKey);
    const payload = concatBytes(
      new Uint8Array([ENCRYPTION_VERSION]),
      new Uint8Array([logN]),
      salt,
      nonce,
      associatedData,
      ciphertext,
    );
    const words = bech32.toWords(payload);
    return bech32.encode(BECH32_PREFIX, words, 5000);
  } finally {
    wipeBytes(symmetricKey);
    wipeBytes(salt);
    wipeBytes(nonce);
    wipeBytes(associatedData);
  }
};

const encryptPrivateKey = async (rawKey, options = {}) => {
  const logN = options.logN ?? DEFAULT_LOG_N;
  const password = await ensurePassword({ mode: options.mode, reason: options.reason });
  return encryptPrivateKeyWithPassword(rawKey, password, logN);
};

const decodeEncryptedPayload = (encrypted) => {
  const decoded = bech32.decode(encrypted, 5000);
  if (decoded.prefix !== BECH32_PREFIX) {
    throw new Error("Unsupported encrypted key format");
  }
  const payload = new Uint8Array(bech32.fromWords(decoded.words));
  if (payload.length < 1 + 1 + 16 + 24 + 1 + 16) {
    throw new Error("Encrypted payload is too short");
  }

  const version = payload[0];
  if (version !== ENCRYPTION_VERSION) {
    throw new Error(`Unsupported encrypted key version: ${version}`);
  }

  const logN = payload[1];
  const salt = payload.slice(2, 18);
  const nonce = payload.slice(18, 42);
  const associatedDataByte = payload[42];
  const ciphertext = payload.slice(43);

  if (ciphertext.length < 16) {
    throw new Error("Encrypted payload is truncated");
  }

  return {
    logN,
    salt,
    nonce,
    associatedData: new Uint8Array([associatedDataByte]),
    ciphertext,
  };
};

const decryptPrivateKeyWithPassword = async (encrypted, password) => {
  const { logN, salt, nonce, associatedData, ciphertext } = decodeEncryptedPayload(encrypted);
  const symmetricKey = await deriveSymmetricKey(password, salt, logN);
  try {
    const cipher = xchacha20poly1305(symmetricKey, nonce, associatedData);
    const plaintext = cipher.decrypt(ciphertext);
    if (plaintext.length !== 32) {
      throw new Error("Decrypted key must be 32 bytes");
    }
    return plaintext;
  } finally {
    wipeBytes(symmetricKey);
    wipeBytes(salt);
    wipeBytes(nonce);
    wipeBytes(associatedData);
  }
};

const decryptPrivateKey = async (encrypted) => {
  const password = await ensurePassword({ mode: "unlock" });
  return decryptPrivateKeyWithPassword(encrypted, password);
};

const decryptPrivateKeyWithPrompt = async (encrypted, { reason } = {}) => {
  let errorMessage = null;
  while (true) {
    let password;
    try {
      password = await ensurePassword({ mode: "unlock", reason, errorMessage });
    } catch (error) {
      throw error;
    }
    try {
      const plaintext = await decryptPrivateKeyWithPassword(encrypted, password);
      return plaintext;
    } catch (error) {
      console.warn("[identity] failed to decrypt cached key:", error instanceof Error ? error.message : error);
      clearPasswordCache();
      errorMessage = "Incorrect password";
    }
  }
};

const exportEncryptedSession = () => {
  const session = sessionCache.load();
  if (!session) return null;
  return {
    npub: session.npub ?? null,
    encryptedNsec: session.encryptedNsec ?? null,
    sessionExpiresAt: session.sessionExpiresAt ?? null,
    method: session.method ?? "local_keys",
    logN: session.logN ?? DEFAULT_LOG_N,
  };
};

if (typeof window !== "undefined") {
  let lastIdentityAuthenticated = false;
  window.addEventListener("wingman:identity-ui-state", (event) => {
    const detail = event?.detail;
    if (!detail || typeof detail !== "object") return;
    const isAuthenticated = Boolean(detail.authenticated);
    if (lastIdentityAuthenticated && !isAuthenticated) {
      clearPasswordCache();
      sessionCache.clear();
    }
    lastIdentityAuthenticated = isAuthenticated;
  });
}

const identityApi = typeof globalThis !== "undefined" && globalThis.wingmanIdentity ? globalThis.wingmanIdentity : {};

identityApi.uiPrompts = {
  ensurePassword,
  clearPasswordCache,
  PasswordPromptCancelledError,
};

identityApi.crypto = {
  encryptPrivateKey,
  encryptPrivateKeyWithPassword,
  decryptPrivateKey,
  decryptPrivateKeyWithPassword,
  decryptPrivateKeyWithPrompt,
  decodeEncryptedPayload,
  constants: {
    defaultLogN: DEFAULT_LOG_N,
    version: ENCRYPTION_VERSION,
  },
};

identityApi.sessionCache = {
  save: sessionCache.save,
  load: sessionCache.load,
  clear: sessionCache.clear,
  hasEncryptedNsec: sessionCache.hasEncryptedNsec,
  export: exportEncryptedSession,
};

identityApi.passwordMeta = {
  load: loadPasswordMeta,
  clear: clearPasswordMeta,
};

globalThis.wingmanIdentity = identityApi;

export {
  PasswordPromptCancelledError,
  ensurePassword,
  clearPasswordCache,
  encryptPrivateKey,
  encryptPrivateKeyWithPassword,
  decryptPrivateKey,
  decryptPrivateKeyWithPassword,
  decryptPrivateKeyWithPrompt,
  sessionCache,
  loadPasswordMeta,
  clearPasswordMeta,
  exportEncryptedSession,
};
