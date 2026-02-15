/**
 * Identity state manager — state updates, auth handlers, DOM registration,
 * event bridges, wiring context, and persistence loading.
 *
 * Depends on identity/dom.js for display helpers and shared data structures.
 */

import { fetchIdentityProfile } from "./profile.js";
import { startSigningListener, stopSigningListener } from "../nip98/signing-listener.js";
import { createUnauthorizedGuard } from "../common/unauthorized-guard.js";
import { createAdminUsersState } from "../state/index.js";
import { showToast } from "../utils/toast.js";
import { fetchNpubProjects } from "../npub-projects/index.js";
import { normaliseNpubValue, isFiniteNumber, toFiniteTimestamp } from "./dom.js";

export function initIdentityStateManager(deps) {
  const {
    state,
    dom,
    sessionsStore,
    appsStore,
    render,
    fetchSessions,
    fetchApps,
    fetchConfig,
    normalisePortList,
    closeIdentityLoginDialog,
    navigateToHome,
    getCurrentRoute,
    setCurrentRoute,
    HOME_ROUTE,
    APP_LOG_PREVIEW_LINES,
  } = deps;

  const {
    IDENTITY_STORAGE_KEY,
    IDENTITY_EVENT_NAMES,
    identityDomEntries,
    identityDomEntryByNode,
    ensureButtonOriginalLabel,
    resetButtonState,
    setButtonState,
    showIdentityCopyFeedback,
    persistIdentityState,
    syncIdentityDisplay,
    syncIdentityDisplayForEntry,
    pruneIdentityDomEntries,
    detachIdentityDomEntry,
  } = dom;

  // ── helpers ─────────────────────────────────────────────────────

  const getConfiguredAdminNpub = () => {
    const configured = state.config?.adminNpub;
    return typeof configured === "string" && configured.trim().length > 0 ? configured.trim() : null;
  };

  // ── post-auth scheduling ────────────────────────────────────────

  let postAuthSessionsFetchScheduled = false;
  const requestPostAuthSessionsFetch = () => {
    if (postAuthSessionsFetchScheduled) return;
    postAuthSessionsFetchScheduled = true;
    const triggerFetch = async () => {
      postAuthSessionsFetchScheduled = false;
      await fetchSessions();
      if (state.identity.authenticated) {
        fetchApps({ tail: APP_LOG_PREVIEW_LINES }).catch(() => {});
        fetchNpubProjects().catch(() => {});
      }
      render();
    };
    if (typeof queueMicrotask === "function") {
      queueMicrotask(triggerFetch);
    } else {
      Promise.resolve().then(triggerFetch);
    }
  };

  let postAuthConfigRefreshScheduled = false;
  const requestPostAuthConfigRefresh = () => {
    if (postAuthConfigRefreshScheduled) return;
    postAuthConfigRefreshScheduled = true;
    const triggerRefresh = () => {
      postAuthConfigRefreshScheduled = false;
      void fetchConfig();
    };
    if (typeof queueMicrotask === "function") {
      queueMicrotask(triggerRefresh);
    } else {
      Promise.resolve().then(triggerRefresh);
    }
  };

  // ── profile picture refresh ─────────────────────────────────────

  let identityProfileRequest = { npub: null, inFlight: false };

  const refreshIdentityProfilePicture = async (options = {}) => {
    const npub = state.identity.npub;
    if (!npub) return;
    const normalized = normaliseNpubValue(npub);
    if (!normalized) return;
    if (identityProfileRequest.inFlight && identityProfileRequest.npub === normalized && !options.force) {
      return;
    }
    identityProfileRequest = { npub: normalized, inFlight: true };
    try {
      const payload = await fetchIdentityProfile({ npub, force: options.force });
      if (payload && typeof payload === "object") {
        if (typeof payload.pictureUrl === "string") {
          updateIdentityState({ picture: payload.pictureUrl }, { persist: true, emit: true });
        } else if (payload.pictureUrl === null) {
          updateIdentityState({ picture: null }, { persist: true, emit: true });
        }
      }
    } catch (error) {
      if (error?.name !== "AbortError") {
        console.warn("[identity] failed to refresh profile picture:", error);
      }
    } finally {
      identityProfileRequest = { npub: normalized, inFlight: false };
    }
  };

  // ── bot identity fetch ──────────────────────────────────────────

  const fetchBotIdentity = async () => {
    try {
      const response = await fetch("/api/bot-keys/me", { credentials: "include" });
      if (!response.ok) return;
      const data = await response.json();
      if (data && data.hasKey) {
        updateIdentityState({
          botNpub: data.botNpub ?? null,
          botPubkeyHex: data.botPubkeyHex ?? null,
          botUnlocked: Boolean(data.unlocked),
        }, { persist: true, emit: true });
      }
    } catch (error) {
      console.warn("[identity] failed to fetch bot identity:", error);
    }
  };

  // ── export bot nsec ──────────────────────────────────────────────

  async function handleExportBotNsec(entry) {
    const btn = entry.botExportButton;
    const feedback = entry.botExportFeedback;
    if (!btn) return;

    // Warn the user before proceeding
    const confirmed = window.confirm(
      "WARNING: You are about to copy your bot's private key (nsec) to the clipboard.\n\n" +
      "Anyone with this key can sign events as your bot identity. " +
      "Only proceed if you understand the risk and need to export it.\n\n" +
      "Continue?",
    );
    if (!confirmed) return;

    setButtonState(btn, { state: "loading", label: "Fetching\u2026", disable: true });

    try {
      // 1. Fetch the encrypted blob + sender pubkey
      const res = await fetch("/api/bot-keys/encrypted", { credentials: "include" });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error ?? `Failed to fetch encrypted key (${res.status})`);
      }
      const { encryptedToUser, senderPubkey } = await res.json();
      if (!encryptedToUser || !senderPubkey) {
        throw new Error("Missing encrypted data or sender pubkey from server");
      }

      // 2. Decrypt via NIP-07
      setButtonState(btn, { state: "loading", label: "Decrypting\u2026", disable: true });

      if (!window.nostr?.nip44?.decrypt) {
        throw new Error("NIP-07 extension with NIP-44 support required to export bot nsec");
      }
      let nsecHex = await window.nostr.nip44.decrypt(senderPubkey, encryptedToUser);

      // NIP-44 decrypt returns a string — trim whitespace and left-pad if a
      // leading zero was dropped (some NIP-07 extensions do this).
      if (typeof nsecHex === "string") nsecHex = nsecHex.trim();
      if (nsecHex && /^[0-9a-fA-F]{63}$/.test(nsecHex)) nsecHex = "0" + nsecHex;

      if (!nsecHex || !/^[0-9a-fA-F]{64}$/.test(nsecHex)) {
        throw new Error("Decryption returned invalid data");
      }

      // 3. Convert hex to bech32 nsec
      setButtonState(btn, { state: "loading", label: "Copying\u2026", disable: true });

      const nip19Module = await import("/vendor/nostr-tools/index.js");
      const secretBytes = new Uint8Array(32);
      for (let i = 0; i < 64; i += 2) {
        secretBytes[i / 2] = parseInt(nsecHex.substring(i, i + 2), 16);
      }
      const nsec = nip19Module.nip19.nsecEncode(secretBytes);

      // Wipe the byte array
      secretBytes.fill(0);

      // 4. Copy to clipboard
      await navigator.clipboard.writeText(nsec);

      setButtonState(btn, { state: "success", label: "Copied!", disable: false });
      if (feedback) {
        feedback.textContent = "nsec copied to clipboard";
        feedback.hidden = false;
        feedback.dataset.state = "success";
      }
      setTimeout(() => {
        resetButtonState(btn);
        if (feedback) {
          feedback.hidden = true;
          delete feedback.dataset.state;
        }
      }, 3000);
    } catch (err) {
      console.error("[identity] bot nsec export failed:", err);
      const message = err instanceof Error ? err.message : "Export failed";
      setButtonState(btn, { state: "error", label: "Failed", disable: false });
      if (feedback) {
        feedback.textContent = message;
        feedback.hidden = false;
        feedback.dataset.state = "error";
      }
      setTimeout(() => {
        resetButtonState(btn);
        if (feedback) {
          feedback.hidden = true;
          delete feedback.dataset.state;
        }
      }, 4000);
    }
  }

  // ── core state updater ──────────────────────────────────────────

  function updateIdentityState(partial, { persist = true, emit = true } = {}) {
    if (!partial || typeof partial !== "object") {
      return state.identity;
    }
    const current = state.identity;
    const next = {
      method: current.method,
      npub: current.npub,
      expiresAt: current.expiresAt,
      authenticated: current.authenticated,
      alias: current.alias,
      picture: current.picture ?? null,
      isAdmin: current.isAdmin,
      ports: Array.isArray(current.ports) ? [...current.ports] : [],
      balance: typeof current.balance === "number" ? current.balance : 0,
      botNpub: current.botNpub ?? null,
      botPubkeyHex: current.botPubkeyHex ?? null,
      botUnlocked: current.botUnlocked ?? false,
    };
    const wasAdmin = current.isAdmin;

    if ("isAuthenticated" in partial && partial.isAuthenticated === false) {
      next.method = "none";
      next.npub = null;
      next.expiresAt = null;
      next.ports = [];
    }

    if ("method" in partial && typeof partial.method === "string" && partial.method.length > 0) {
      next.method = partial.method;
    }

    if ("npub" in partial) {
      if (typeof partial.npub === "string" && partial.npub.trim().length > 0) {
        next.npub = partial.npub.trim();
      } else if (partial.npub === null) {
        next.npub = null;
      }
    } else if (typeof partial.pubkey === "string" && partial.pubkey.trim().length > 0 && !next.npub) {
      next.npub = partial.pubkey.trim();
    }

    const expiryCandidate =
      "expiresAt" in partial
        ? partial.expiresAt
        : "sessionExpiresAt" in partial
          ? partial.sessionExpiresAt
          : "expiry" in partial
            ? partial.expiry
            : undefined;
    if (expiryCandidate !== undefined) {
      const timestamp = toFiniteTimestamp(expiryCandidate);
      next.expiresAt = timestamp;
    }

    if ("ports" in partial) {
      if (partial.ports === null) {
        next.ports = [];
      } else if (Array.isArray(partial.ports)) {
        next.ports = normalisePortList(partial.ports);
      }
    }

    if (!next.npub) {
      next.method = "none";
      next.expiresAt = null;
      next.alias = null;
      next.picture = null;
      next.ports = [];
      next.balance = 0;
      next.botNpub = null;
      next.botPubkeyHex = null;
      next.botUnlocked = false;
    }

    const configuredAdminNpub = getConfiguredAdminNpub();
    const normalizedNextNpub = normaliseNpubValue(next.npub);
    next.isAdmin = Boolean(configuredAdminNpub && normalizedNextNpub && normalizedNextNpub === configuredAdminNpub);

    if ("alias" in partial) {
      if (typeof partial.alias === "string" && partial.alias.trim().length > 0) {
        next.alias = partial.alias.trim();
      } else if (partial.alias === null) {
        next.alias = null;
      }
    }

    if ("picture" in partial) {
      if (typeof partial.picture === "string" && partial.picture.trim().length > 0) {
        next.picture = partial.picture.trim();
      } else if (partial.picture === null) {
        next.picture = null;
      }
    }

    if ("balance" in partial) {
      const candidate = partial.balance;
      if (typeof candidate === "number" && Number.isFinite(candidate)) {
        next.balance = Math.max(0, Math.trunc(candidate));
      } else if (candidate === null) {
        next.balance = 0;
      }
    }

    if ("botNpub" in partial) {
      next.botNpub = typeof partial.botNpub === "string" ? partial.botNpub : null;
    }
    if ("botPubkeyHex" in partial) {
      next.botPubkeyHex = typeof partial.botPubkeyHex === "string" ? partial.botPubkeyHex : null;
    }
    if ("botUnlocked" in partial) {
      next.botUnlocked = Boolean(partial.botUnlocked);
    }

    next.authenticated = Boolean(next.npub);
    const becameAuthenticated = !current.authenticated && next.authenticated;
    const becameUnauthenticated = current.authenticated && !next.authenticated;

    const currentPorts = Array.isArray(current.ports) ? current.ports : [];
    const portsChanged =
      next.ports.length !== currentPorts.length || next.ports.some((value, index) => value !== currentPorts[index]);

    const changed =
      next.method !== current.method ||
      next.npub !== current.npub ||
      next.expiresAt !== current.expiresAt ||
      next.authenticated !== current.authenticated ||
      next.isAdmin !== current.isAdmin ||
      next.alias !== current.alias ||
      next.picture !== current.picture ||
      portsChanged ||
      next.balance !== (current.balance ?? 0) ||
      next.botNpub !== (current.botNpub ?? null) ||
      next.botPubkeyHex !== (current.botPubkeyHex ?? null) ||
      next.botUnlocked !== (current.botUnlocked ?? false);

    if (!changed) {
      return current;
    }

    state.identity = next;
    if (wasAdmin && !next.isAdmin) {
      state.adminUsers = createAdminUsersState();
    }

    if (next.authenticated && (!next.picture || becameAuthenticated)) {
      void refreshIdentityProfilePicture({ force: becameAuthenticated });
    }

    if (next.npub !== current.npub || next.isAdmin !== current.isAdmin) {
      const viewerNormalized = normaliseNpubValue(next.npub);
      const ss = sessionsStore();
      ss.filters.initialized = false;
      if (!next.isAdmin && viewerNormalized) {
        ss.filters.npub = viewerNormalized;
      } else if (!next.isAdmin && !viewerNormalized) {
        ss.filters.npub = "all";
      }
      const as = appsStore();
      as.filters.initialized = false;
      as.filters.options = [];
      as.filters.npub = viewerNormalized ?? "all";
    }

    if (persist) {
      persistIdentityState(next);
    }

    syncIdentityDisplay();

    if (emit && typeof window !== "undefined" && typeof window.dispatchEvent === "function") {
      try {
        window.dispatchEvent(new CustomEvent("wingman:identity-ui-state", { detail: { ...next } }));
        if (becameAuthenticated) {
          closeIdentityLoginDialog();
          const currentRoute = getCurrentRoute();
          if (currentRoute !== "home") {
            setCurrentRoute("home");
            if (window.location.pathname !== HOME_ROUTE) {
              window.history.pushState({ route: "home" }, "", HOME_ROUTE);
            }
          }
          render();
        }
      } catch {
        // ignore dispatch errors
      }
    }

    if (becameAuthenticated || becameUnauthenticated) {
      requestPostAuthConfigRefresh();
    }
    if (becameAuthenticated) {
      requestPostAuthSessionsFetch();
      if (next.npub) {
        startSigningListener(next.npub);
      }
      fetchBotIdentity();
    }
    if (becameUnauthenticated) {
      stopSigningListener();
    }

    return next;
  }

  // ── copy handlers ───────────────────────────────────────────────

  const handleIdentityCopy = async (event, entryOverride) => {
    if (event?.preventDefault) {
      event.preventDefault();
    }
    const entry = entryOverride ?? (event?.currentTarget ? identityDomEntryByNode.get(event.currentTarget) : null);
    const npub = state.identity.npub;
    if (!npub) {
      if (entry?.copyButton) {
        resetButtonState(entry.copyButton);
      }
      return;
    }
    if (entry?.copyButton) {
      setButtonState(entry.copyButton, { state: "loading", label: "Copying\u2026", disable: true });
    }
    try {
      if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
        await navigator.clipboard.writeText(npub);
        showIdentityCopyFeedback("Copied", { entry });
        return;
      }
    } catch (error) {
      console.warn("[identity] clipboard write failed", error);
    }

    try {
      const textarea = document.createElement("textarea");
      textarea.value = npub;
      textarea.setAttribute("readonly", "");
      textarea.style.position = "absolute";
      textarea.style.left = "-9999px";
      document.body.append(textarea);
      textarea.select();
      const success = document.execCommand("copy");
      textarea.remove();
      if (success) {
        showIdentityCopyFeedback("Copied", { entry });
        return;
      }
    } catch (error) {
      console.warn("[identity] fallback copy failed", error);
    }

    showIdentityCopyFeedback("Copy failed", { error: true, entry });
  };

  const handleCopyNostrUserId = async (event, entryOverride) => {
    if (event?.preventDefault) {
      event.preventDefault();
    }
    const entry = entryOverride ?? (event?.currentTarget ? identityDomEntryByNode.get(event.currentTarget) : null);
    const npub = state.identity.npub;
    if (!npub) {
      if (entry?.copyNpubButton) {
        resetButtonState(entry.copyNpubButton);
      }
      return;
    }
    if (entry?.copyNpubButton) {
      setButtonState(entry.copyNpubButton, { state: "loading", label: "Copying\u2026", disable: true });
    }
    try {
      if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
        await navigator.clipboard.writeText(npub);
        if (entry?.copyNpubButton) {
          setButtonState(entry.copyNpubButton, { state: "success", label: "Copied!", disable: false });
          setTimeout(() => {
            if (entry?.copyNpubButton) {
              resetButtonState(entry.copyNpubButton);
            }
          }, 2000);
        }
        return;
      }
    } catch (error) {
      console.warn("[identity] clipboard write failed", error);
    }

    try {
      const textarea = document.createElement("textarea");
      textarea.value = npub;
      textarea.setAttribute("readonly", "");
      textarea.style.position = "absolute";
      textarea.style.left = "-9999px";
      document.body.append(textarea);
      textarea.select();
      const success = document.execCommand("copy");
      textarea.remove();
      if (success) {
        if (entry?.copyNpubButton) {
          setButtonState(entry.copyNpubButton, { state: "success", label: "Copied!", disable: false });
          setTimeout(() => {
            if (entry?.copyNpubButton) {
              resetButtonState(entry.copyNpubButton);
            }
          }, 2000);
        }
        return;
      }
    } catch (error) {
      console.warn("[identity] fallback copy failed", error);
    }

    if (entry?.copyNpubButton) {
      setButtonState(entry.copyNpubButton, { state: "error", label: "Copy failed", disable: false });
      setTimeout(() => {
        if (entry?.copyNpubButton) {
          resetButtonState(entry.copyNpubButton);
        }
      }, 2000);
    }
  };

  const handleCopyNostrPassword = async (event, entryOverride) => {
    if (event?.preventDefault) {
      event.preventDefault();
    }
    const entry = entryOverride ?? (event?.currentTarget ? identityDomEntryByNode.get(event.currentTarget) : null);
    const method = state.identity.method;
    if (method !== "local_keys") {
      if (entry?.copyNsecButton) {
        resetButtonState(entry.copyNsecButton);
      }
      return;
    }
    if (entry?.copyNsecButton) {
      setButtonState(entry.copyNsecButton, { state: "loading", label: "Retrieving\u2026", disable: true });
    }

    try {
      const wingmanIdentity = globalThis.wingmanIdentity;
      if (!wingmanIdentity) {
        throw new Error("Identity API unavailable");
      }

      const session = wingmanIdentity.sessionCache?.load?.();
      if (!session || !session.encryptedNsec) {
        throw new Error("No encrypted key found");
      }

      if (entry?.copyNsecButton) {
        setButtonState(entry.copyNsecButton, { state: "loading", label: "Decrypting\u2026", disable: true });
      }

      const decryptPrivateKeyWithPrompt = wingmanIdentity.crypto?.decryptPrivateKeyWithPrompt;
      if (typeof decryptPrivateKeyWithPrompt !== "function") {
        throw new Error("Decryption unavailable");
      }

      const privateKeyBytes = await decryptPrivateKeyWithPrompt(session.encryptedNsec, {
        reason: "Enter your password to copy your Nostr private key."
      });

      const nip19Module = await import("/vendor/nostr-tools/index.js");
      const nsec = nip19Module.nip19.nsecEncode(privateKeyBytes);

      const wipeBytes = (bytes) => {
        if (!bytes) return;
        for (let i = 0; i < bytes.length; i += 1) {
          bytes[i] = 0;
        }
      };

      if (entry?.copyNsecButton) {
        setButtonState(entry.copyNsecButton, { state: "loading", label: "Copying\u2026", disable: true });
      }

      try {
        if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
          await navigator.clipboard.writeText(nsec);
          if (entry?.copyNsecButton) {
            setButtonState(entry.copyNsecButton, { state: "success", label: "Copied!", disable: false });
            setTimeout(() => {
              if (entry?.copyNsecButton) {
                resetButtonState(entry.copyNsecButton);
              }
            }, 2000);
          }
          wipeBytes(privateKeyBytes);
          return;
        }
      } catch (error) {
        console.warn("[identity] clipboard write failed", error);
      }

      try {
        const textarea = document.createElement("textarea");
        textarea.value = nsec;
        textarea.setAttribute("readonly", "");
        textarea.style.position = "absolute";
        textarea.style.left = "-9999px";
        document.body.append(textarea);
        textarea.select();
        const success = document.execCommand("copy");
        textarea.remove();
        if (success) {
          if (entry?.copyNsecButton) {
            setButtonState(entry.copyNsecButton, { state: "success", label: "Copied!", disable: false });
            setTimeout(() => {
              if (entry?.copyNsecButton) {
                resetButtonState(entry.copyNsecButton);
              }
            }, 2000);
          }
          wipeBytes(privateKeyBytes);
          return;
        }
      } catch (error) {
        console.warn("[identity] fallback copy failed", error);
      }

      wipeBytes(privateKeyBytes);

      if (entry?.copyNsecButton) {
        setButtonState(entry.copyNsecButton, { state: "error", label: "Copy failed", disable: false });
        setTimeout(() => {
          if (entry?.copyNsecButton) {
            resetButtonState(entry.copyNsecButton);
          }
        }, 2000);
      }
    } catch (error) {
      console.error("[identity] failed to copy nsec", error);
      if (entry?.copyNsecButton) {
        const errorMessage = error?.name === "PasswordPromptCancelledError" ? "Cancelled" : "Failed";
        setButtonState(entry.copyNsecButton, { state: "error", label: errorMessage, disable: false });
        setTimeout(() => {
          if (entry?.copyNsecButton) {
            resetButtonState(entry.copyNsecButton);
          }
        }, 2000);
      }
    }
  };

  // ── register / logout handlers ──────────────────────────────────

  const handleIdentityRegister = (event, entryOverride) => {
    if (event?.preventDefault) {
      event.preventDefault();
    }
    const entry = entryOverride ?? (event?.currentTarget ? identityDomEntryByNode.get(event.currentTarget) : null);
    const root = entry?.root ?? document;
    const generateBtn = root.querySelector('[data-action="generate-keys"]');
    if (!generateBtn) {
      window.alert("Registration is unavailable right now. Try an advanced option below.");
      return;
    }
    if (entry?.registerButton) {
      setButtonState(entry.registerButton, {
        state: "loading",
        label: "Registering\u2026",
        disable: true,
        restoreAfterMs: 4000,
      });
    }
    generateBtn.focus?.();
    generateBtn.click();
  };

  const clearCachedIdentity = () => {
    try {
      globalThis.wingmanIdentity?.sessionCache?.clear?.();
    } catch (error) {
      console.warn("[identity] failed to clear session cache", error);
    }
    try {
      globalThis.wingmanIdentity?.passwordMeta?.clear?.();
    } catch (error) {
      console.warn("[identity] failed to clear password metadata", error);
    }
  };

  const forceIdentityLogoutState = () => {
    clearCachedIdentity();
    updateIdentityState(
      { npub: null, method: "none", expiresAt: null, isAuthenticated: false, alias: null, balance: 0 },
      { persist: true, emit: true },
    );
    if (typeof window !== "undefined") {
      try {
        window.dispatchEvent(new CustomEvent("wingman:identity-logout"));
      } catch {
        // ignore dispatch failures
      }
    }
  };

  const handleUnauthorizedAccess = createUnauthorizedGuard({
    onLogout: () => {
      if (!state.identity.authenticated) {
        return;
      }
      showToast("Session expired. Please log in again.");
      forceIdentityLogoutState();
    },
  });

  const requestServerLogout = async () => {
    const response = await fetch("/api/auth/session", {
      method: "DELETE",
      credentials: "include",
      headers: { "cache-control": "no-store" },
    });
    if (!response.ok && response.status !== 204) {
      const data = await response.json().catch(() => ({}));
      const message =
        data && typeof data === "object" && typeof data.error === "string"
          ? data.error
          : `Failed to clear session (${response.status})`;
      throw new Error(message);
    }
  };

  const handleIdentityLogout = async (event, entryOverride) => {
    if (event?.preventDefault) {
      event.preventDefault();
    }
    identityDomEntries.forEach((entry) => {
      if (entry.logoutButton) {
        setButtonState(entry.logoutButton, { state: "loading", label: "Logging out\u2026", disable: true });
      }
    });
    let logoutSuccessful = false;
    const sources = [globalThis.wingmanIdentity, globalThis.identity];
    for (const source of sources) {
      if (source && typeof source.logoutIdentity === "function") {
        try {
          await source.logoutIdentity();
          logoutSuccessful = true;
          break;
        } catch (error) {
          console.error("[identity] logout failed", error);
          const message = error instanceof Error ? error.message : "Failed to sign out";
          window.alert(message);
        }
      }
    }

    if (!logoutSuccessful) {
      try {
        await requestServerLogout();
        logoutSuccessful = true;
      } catch (error) {
        console.error("[identity] server logout failed", error);
        const message = error instanceof Error ? error.message : "Failed to clear session on server.";
        window.alert(message);
      }
    }

    if (logoutSuccessful) {
      forceIdentityLogoutState();
      identityDomEntries.forEach((entry) => {
        if (entry.logoutButton) {
          setButtonState(entry.logoutButton, {
            state: "success",
            label: "Logged out",
            disable: true,
            restoreAfterMs: 1500,
          });
        }
      });
      navigateToHome({ replaceHistory: true, skipMenuClose: true });
    } else {
      identityDomEntries.forEach((entry) => {
        if (entry.logoutButton) {
          setButtonState(entry.logoutButton, {
            state: "error",
            label: "Retry logout",
            disable: false,
            restoreAfterMs: 2500,
          });
        }
      });
    }
  };

  // ── DOM registration ────────────────────────────────────────────

  function registerIdentityDom(root) {
    if (!root) return;
    pruneIdentityDomEntries();
    let existingEntry = null;
    identityDomEntries.forEach((entry) => {
      if (entry.root === root) {
        existingEntry = entry;
      }
    });
    if (existingEntry) {
      detachIdentityDomEntry(existingEntry);
      identityDomEntries.delete(existingEntry);
    }

    const entry = {
      root,
      alias: root.querySelector('[data-role="identity-alias"]'),
      npub: root.querySelector('[data-role="identity-npub"]'),
      details: root.querySelector('[data-role="identity-details"]'),
      registerSection: root.querySelector('[data-role="identity-register"]'),
      method: root.querySelector('[data-role="identity-method"]'),
      balance: root.querySelector('[data-role="identity-balance"]'),
      expiry: root.querySelector('[data-role="identity-expiry"]'),
      copyFeedback: root.querySelector('[data-role="identity-copy-feedback"]'),
      copyButton: root.querySelector('[data-action="copy-active-npub"]'),
      registerButton: root.querySelector('[data-action="identity-register"]'),
      copyNpubButton: root.querySelector('[data-action="copy-nostr-user-id"]'),
      copyNsecButton: root.querySelector('[data-action="copy-nostr-password"]'),
      logoutButton: root.querySelector('[data-action="identity-logout"]'),
      botHeader: root.querySelector('[data-role="identity-bot-header"]'),
      botNpub: root.querySelector('[data-role="identity-bot-npub"]'),
      botPubkey: root.querySelector('[data-role="identity-bot-pubkey"]'),
      botStatus: root.querySelector('[data-role="identity-bot-status"]'),
      botCopyButton: root.querySelector('[data-action="copy-bot-npub"]'),
      botCopyFeedback: root.querySelector('[data-role="identity-bot-copy-feedback"]'),
      botExportButton: root.querySelector('[data-action="export-bot-nsec"]'),
      botExportFeedback: root.querySelector('[data-role="identity-bot-export-feedback"]'),
      copyHandler: null,
      registerHandler: null,
      copyNpubHandler: null,
      copyNsecHandler: null,
      logoutHandler: null,
      botCopyHandler: null,
      botExportHandler: null,
    };

    if (entry.copyButton) {
      ensureButtonOriginalLabel(entry.copyButton);
      entry.copyHandler = (event) => {
        void handleIdentityCopy(event, entry);
      };
      entry.copyButton.addEventListener("click", entry.copyHandler);
      identityDomEntryByNode.set(entry.copyButton, entry);
    }

    if (entry.registerButton) {
      ensureButtonOriginalLabel(entry.registerButton);
      entry.registerHandler = (event) => {
        handleIdentityRegister(event, entry);
      };
      entry.registerButton.addEventListener("click", entry.registerHandler);
      identityDomEntryByNode.set(entry.registerButton, entry);
    }

    if (entry.copyNpubButton) {
      ensureButtonOriginalLabel(entry.copyNpubButton);
      entry.copyNpubHandler = (event) => {
        void handleCopyNostrUserId(event, entry);
      };
      entry.copyNpubButton.addEventListener("click", entry.copyNpubHandler);
      identityDomEntryByNode.set(entry.copyNpubButton, entry);
    }

    if (entry.copyNsecButton) {
      ensureButtonOriginalLabel(entry.copyNsecButton);
      entry.copyNsecHandler = (event) => {
        void handleCopyNostrPassword(event, entry);
      };
      entry.copyNsecButton.addEventListener("click", entry.copyNsecHandler);
      identityDomEntryByNode.set(entry.copyNsecButton, entry);
    }

    if (entry.logoutButton) {
      ensureButtonOriginalLabel(entry.logoutButton);
      entry.logoutHandler = (event) => {
        void handleIdentityLogout(event, entry);
      };
      entry.logoutButton.addEventListener("click", entry.logoutHandler);
      identityDomEntryByNode.set(entry.logoutButton, entry);
    }

    if (entry.botCopyButton) {
      ensureButtonOriginalLabel(entry.botCopyButton);
      entry.botCopyHandler = async () => {
        const botNpub = state.identity.botNpub;
        if (!botNpub) return;
        try {
          await navigator.clipboard.writeText(botNpub);
          showIdentityCopyFeedback(entry.botCopyFeedback, "Copied!");
        } catch {
          showIdentityCopyFeedback(entry.botCopyFeedback, "Failed");
        }
      };
      entry.botCopyButton.addEventListener("click", entry.botCopyHandler);
    }

    if (entry.botExportButton) {
      ensureButtonOriginalLabel(entry.botExportButton);
      entry.botExportHandler = async () => {
        await handleExportBotNsec(entry);
      };
      entry.botExportButton.addEventListener("click", entry.botExportHandler);
    }

    identityDomEntries.add(entry);
    syncIdentityDisplayForEntry(entry);
  }

  // ── wiring context ──────────────────────────────────────────────

  const callIdentityWire = (names, element, ...extraArgs) => {
    const nameList = Array.isArray(names) ? names : [names];
    if (!element || typeof element !== "object") return false;
    if (typeof globalThis === "undefined") return false;
    const sources = [globalThis.wingmanIdentity, globalThis.identity, globalThis];
    for (const name of nameList) {
      for (const source of sources) {
        if (!source || typeof source !== "object") continue;
        const candidate = source[name];
        if (typeof candidate === "function") {
          try {
            candidate(element, ...extraArgs);
            return true;
          } catch (error) {
            console.error(`[identity] Failed to wire ${name}:`, error);
            return true;
          }
        }
      }
    }
    return false;
  };

  let identityWiringContext = null;

  function getIdentityWiringContext() {
    if (identityWiringContext) {
      return identityWiringContext;
    }
    identityWiringContext = {
      updateIdentityState,
      getConfig: () => state.config,
      getIdentityState: () => ({ ...state.identity }),
      syncDisplay: syncIdentityDisplay,
      requestBinding: () => {
        pruneIdentityDomEntries();
        identityDomEntries.forEach((entry) => {
          if (entry.root && entry.root.isConnected) {
            bindIdentityFlows(entry.root);
          }
        });
      },
    };
    return identityWiringContext;
  }

  function bindIdentityFlows(root) {
    if (!root) return;
    const context = getIdentityWiringContext();
    const localPanel = root.querySelector('[data-identity-panel="local"]');
    if (localPanel) {
      callIdentityWire(["wireLocalIdentityPanel"], localPanel, context);
    }
    const nip07Panel = root.querySelector('[data-identity-panel="nip07"]');
    if (nip07Panel) {
      callIdentityWire(["wireNip07Login", "wireNip07Panel", "wireNip07"], nip07Panel, context);
    }
    const bunkerPanel = root.querySelector('[data-identity-panel="bunker"]');
    if (bunkerPanel) {
      callIdentityWire(["wireBunkerLogin"], bunkerPanel, context);
    }
  }

  const identityWireRequestHandler = () => {
    pruneIdentityDomEntries();
    identityDomEntries.forEach((entry) => {
      if (entry.root && entry.root.isConnected) {
        bindIdentityFlows(entry.root);
      }
    });
  };

  // ── event bridges ───────────────────────────────────────────────

  const handleIdentityEventPayload = (payload) => {
    if (!payload || typeof payload !== "object") {
      return;
    }
    const next = {};
    if ("npub" in payload) {
      next.npub = typeof payload.npub === "string" ? payload.npub : payload.npub === null ? null : undefined;
    } else if (typeof payload.pubkey === "string") {
      next.npub = payload.pubkey;
    }
    if (typeof payload.method === "string") {
      next.method = payload.method;
    }
    if ("expiresAt" in payload || "sessionExpiresAt" in payload || "expiry" in payload) {
      const timestamp = toFiniteTimestamp(
        "expiresAt" in payload
          ? payload.expiresAt
          : "sessionExpiresAt" in payload
            ? payload.sessionExpiresAt
            : payload.expiry,
      );
      next.expiresAt = timestamp;
    }
    if ("isAuthenticated" in payload) {
      next.isAuthenticated = payload.isAuthenticated;
    }
    updateIdentityState(next);
  };

  const handleIdentityEvent = (event) => {
    if (!event) return;
    if ("detail" in event && event.detail) {
      handleIdentityEventPayload(event.detail);
      return;
    }
    handleIdentityEventPayload(event);
  };

  // Set up event bridges immediately
  if (typeof window !== "undefined") {
    IDENTITY_EVENT_NAMES.forEach((name) => {
      window.addEventListener(name, handleIdentityEvent);
      document.addEventListener(name, handleIdentityEvent);
    });
    window.addEventListener("wingman:identity-refresh", () => {
      syncIdentityDisplay();
    });
    window.addEventListener("wingman:identity-wire-request", identityWireRequestHandler);
  }

  // ── persistence loading ─────────────────────────────────────────

  const loadPersistedIdentityState = () => {
    if (typeof window === "undefined" || !window.localStorage) {
      return;
    }
    try {
      const raw = window.localStorage.getItem(IDENTITY_STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      updateIdentityState(parsed, { persist: false, emit: false });
    } catch {
      // ignore parse errors
    }
  };

  // Load immediately
  loadPersistedIdentityState();

  // If already authenticated from cache, fetch fresh bot identity
  if (state.identity.authenticated) {
    fetchBotIdentity();
  }

  // Cross-tab sync
  const handleIdentityStorageEvent = (event) => {
    if (!event) return;
    if (event.key !== IDENTITY_STORAGE_KEY) return;
    if (event.newValue) {
      try {
        const parsed = JSON.parse(event.newValue);
        updateIdentityState(parsed, { persist: false, emit: false });
      } catch {
        // ignore parse errors
      }
    } else {
      updateIdentityState({ npub: null, method: "none", expiresAt: null, isAuthenticated: false, alias: null }, { persist: false, emit: false });
    }
  };

  if (typeof window !== "undefined") {
    window.addEventListener("storage", handleIdentityStorageEvent);
  }

  // ── global UI API ───────────────────────────────────────────────

  const attachIdentityUiApi = () => {
    if (typeof globalThis === "undefined") return;
    const existing =
      typeof globalThis.wingmanIdentityUI === "object" && globalThis.wingmanIdentityUI !== null
        ? globalThis.wingmanIdentityUI
        : {};
    const api = {
      ...existing,
      getState: () => ({ ...state.identity }),
      update: (partial, options) => updateIdentityState(partial, options),
      notify: (partial, options) => updateIdentityState(partial, options),
      bindPanels: () => {
        pruneIdentityDomEntries();
        identityDomEntries.forEach((entry) => {
          if (entry.root && entry.root.isConnected) {
            bindIdentityFlows(entry.root);
          }
        });
      },
      refreshDisplay: () => syncIdentityDisplay(),
    };
    globalThis.wingmanIdentityUI = api;
  };

  attachIdentityUiApi();

  // ── public API ──────────────────────────────────────────────────

  return {
    updateIdentityState,
    handleIdentityCopy,
    handleIdentityLogout,
    handleIdentityRegister,
    clearCachedIdentity,
    forceIdentityLogoutState,
    handleUnauthorizedAccess,
    registerIdentityDom,
    bindIdentityFlows,
    getIdentityWiringContext,
    navigateToHome,
  };
}
