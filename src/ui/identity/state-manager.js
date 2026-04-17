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
import { openConfirmDialog } from "../common/dialog-prompts.js";
import { fetchNpubProjects } from "../npub-projects/index.js";
import { publishDelegateRegistryForCurrentUser } from "./bot-delegate-publisher.js";
import { normaliseNpubValue, isFiniteNumber, toFiniteTimestamp } from "./dom.js";
import {
  createWorkspaceDelegation,
  listWorkspaceDelegations,
  renderWorkspaceDelegationList,
  revokeWorkspaceDelegation,
} from "./workspace-delegations.js";
import * as deviceKeystore from "./device-keystore.js";

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
          botDisplayName: data.displayName ?? null,
          botPubkeyHex: data.botPubkeyHex ?? null,
          botUnlocked: Boolean(data.unlocked),
        }, { persist: true, emit: true });
      }
    } catch (error) {
      console.warn("[identity] failed to fetch bot identity:", error);
    }
  };

  const forceSyncBotLifecycle = async () => {
    const response = await fetch("/api/bot-keys/force-sync", {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const message = payload && typeof payload.error === "string"
        ? payload.error
        : `Failed to force bot sync (${response.status})`;
      throw new Error(message);
    }
    return payload;
  };

  const workspaceDelegationsState = {
    loading: false,
    ownerNpub: null,
    items: [],
    error: null,
  };

  function setWorkspaceDelegationFeedback(entry, message, state = "info") {
    const feedback = entry?.workspaceDelegationFeedback;
    if (!feedback) {
      return;
    }
    if (!message) {
      feedback.hidden = true;
      feedback.textContent = "";
      delete feedback.dataset.state;
      return;
    }
    feedback.hidden = false;
    feedback.textContent = message;
    feedback.dataset.state = state;
  }

  function syncWorkspaceDelegationEntry(entry) {
    if (!entry?.workspaceDelegationsSection) {
      return;
    }
    const authenticated = Boolean(state.identity.authenticated && state.identity.npub);
    entry.workspaceDelegationsSection.hidden = !authenticated;

    if (!authenticated) {
      if (entry.workspaceDelegationsList) {
        entry.workspaceDelegationsList.replaceChildren();
      }
      setWorkspaceDelegationFeedback(entry, "");
      return;
    }

    if (entry.workspaceDelegationUseBotButton) {
      entry.workspaceDelegationUseBotButton.disabled = !state.identity.botNpub;
    }
    if (entry.workspaceDelegationCreateButton) {
      if (entry.workspaceDelegationCreateButton.getAttribute("aria-busy") !== "true") {
        entry.workspaceDelegationCreateButton.disabled = false;
      }
    }
    if (entry.workspaceDelegationRefreshButton) {
      if (entry.workspaceDelegationRefreshButton.getAttribute("aria-busy") !== "true") {
        entry.workspaceDelegationRefreshButton.disabled = false;
      }
    }
    if (entry.workspaceDelegationBotHint) {
      entry.workspaceDelegationBotHint.textContent = state.identity.botNpub
        ? `Tip: your current bot npub is ${state.identity.botNpub}. Use "Use my bot" to delegate directly to it.`
        : "Tip: generate or unlock a bot key first if you want to grant access to your own agent.";
    }

    if (!entry.workspaceDelegationsList) {
      return;
    }
    if (workspaceDelegationsState.loading) {
      const loading = document.createElement("p");
      loading.className = "wm-identity-delegations__empty";
      loading.textContent = "Loading delegations…";
      entry.workspaceDelegationsList.replaceChildren(loading);
      return;
    }
    if (workspaceDelegationsState.error) {
      const error = document.createElement("p");
      error.className = "wm-identity-delegations__empty";
      error.dataset.state = "error";
      error.textContent = workspaceDelegationsState.error;
      entry.workspaceDelegationsList.replaceChildren(error);
      return;
    }
    renderWorkspaceDelegationList(entry.workspaceDelegationsList, workspaceDelegationsState.items);
  }

  function syncWorkspaceDelegationEntries() {
    identityDomEntries.forEach((entry) => {
      syncWorkspaceDelegationEntry(entry);
    });
  }

  function resetWorkspaceDelegationsState() {
    workspaceDelegationsState.loading = false;
    workspaceDelegationsState.ownerNpub = null;
    workspaceDelegationsState.items = [];
    workspaceDelegationsState.error = null;
    syncWorkspaceDelegationEntries();
  }

  async function loadWorkspaceDelegations({ silent = false } = {}) {
    const ownerNpub = normaliseNpubValue(state.identity.npub);
    if (!state.identity.authenticated || !ownerNpub) {
      resetWorkspaceDelegationsState();
      return [];
    }

    workspaceDelegationsState.loading = true;
    workspaceDelegationsState.ownerNpub = ownerNpub;
    workspaceDelegationsState.error = null;
    syncWorkspaceDelegationEntries();

    try {
      const payload = await listWorkspaceDelegations({
        ownerNpub,
        onUnauthorized: () => handleUnauthorizedAccess(),
      });
      workspaceDelegationsState.items =
        payload && typeof payload === "object" && Array.isArray(payload.delegations)
          ? payload.delegations
          : [];
      workspaceDelegationsState.error = null;
      return workspaceDelegationsState.items;
    } catch (error) {
      workspaceDelegationsState.error =
        error instanceof Error ? error.message : "Failed to load workspace delegations";
      if (!silent) {
        showToast(workspaceDelegationsState.error);
      }
      return [];
    } finally {
      workspaceDelegationsState.loading = false;
      syncWorkspaceDelegationEntries();
    }
  }

  function collectWorkspaceDelegationInput(entry) {
    const ownerNpub = normaliseNpubValue(state.identity.npub);
    if (!ownerNpub) {
      throw new Error("Sign in before creating delegations");
    }
    const scopes = Array.from(entry.workspaceDelegationScopeInputs ?? [])
      .filter((input) => input instanceof HTMLInputElement && input.checked)
      .map((input) => input.value);

    return {
      ownerNpub,
      delegateNpub: entry.workspaceDelegationDelegateInput?.value ?? "",
      scopes,
      duration: entry.workspaceDelegationDurationSelect?.value ?? "none",
      billingMode: entry.workspaceDelegationBillingSelect?.value ?? "delegate",
      spendLimitSats: entry.workspaceDelegationSpendLimitInput?.value ?? "",
      pathPrefixes: entry.workspaceDelegationPathPrefixesInput?.value ?? "",
      appIds: entry.workspaceDelegationAppIdsInput?.value ?? "",
      appRoots: entry.workspaceDelegationAppRootsInput?.value ?? "",
      projectRoots: entry.workspaceDelegationProjectRootsInput?.value ?? "",
    };
  }

  async function handleWorkspaceDelegationUseBot(entry) {
    if (!state.identity.botNpub) {
      setWorkspaceDelegationFeedback(entry, "No bot npub is available yet.", "warning");
      return;
    }
    if (entry.workspaceDelegationDelegateInput) {
      entry.workspaceDelegationDelegateInput.value = state.identity.botNpub;
      entry.workspaceDelegationDelegateInput.focus();
      setWorkspaceDelegationFeedback(entry, "Delegate npub set to your current bot.", "success");
    }
  }

  async function handleWorkspaceDelegationSubmit(entry) {
    const createButton = entry.workspaceDelegationCreateButton;
    if (createButton) {
      setButtonState(createButton, { state: "loading", label: "Creating…", disable: true });
    }
    setWorkspaceDelegationFeedback(entry, "Signing delegation…", "info");

    try {
      const payload = collectWorkspaceDelegationInput(entry);
      const result = await createWorkspaceDelegation(payload, {
        onUnauthorized: () => handleUnauthorizedAccess(),
      });
      const delegateNpub =
        result && typeof result === "object" && result.delegation && typeof result.delegation.delegateNpub === "string"
          ? result.delegation.delegateNpub
          : payload.delegateNpub;
      setWorkspaceDelegationFeedback(entry, `Delegation created for ${delegateNpub}.`, "success");
      showToast(`Delegation created for ${delegateNpub}`);
      await loadWorkspaceDelegations({ silent: true });
      if (createButton) {
        setButtonState(createButton, { state: "success", label: "Created", disable: false, restoreAfterMs: 2500 });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to create delegation";
      setWorkspaceDelegationFeedback(entry, message, "error");
      if (createButton) {
        setButtonState(createButton, { state: "error", label: "Failed", disable: false, restoreAfterMs: 2500 });
      }
    }
  }

  async function handleWorkspaceDelegationRefresh(entry) {
    const refreshButton = entry.workspaceDelegationRefreshButton;
    if (refreshButton) {
      setButtonState(refreshButton, { state: "loading", label: "Refreshing…", disable: true });
    }
    try {
      await loadWorkspaceDelegations({ silent: true });
      if (workspaceDelegationsState.error) {
        throw new Error(workspaceDelegationsState.error);
      }
      setWorkspaceDelegationFeedback(entry, "Delegations refreshed.", "success");
      if (refreshButton) {
        setButtonState(refreshButton, { state: "success", label: "Refreshed", disable: false, restoreAfterMs: 2000 });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to refresh delegations";
      setWorkspaceDelegationFeedback(entry, message, "error");
      if (refreshButton) {
        setButtonState(refreshButton, { state: "error", label: "Failed", disable: false, restoreAfterMs: 2000 });
      }
    }
  }

  async function handleWorkspaceDelegationListClick(event, entry) {
    const target = event.target instanceof Element
      ? event.target.closest('[data-action="workspace-delegation-revoke"]')
      : null;
    if (!(target instanceof HTMLButtonElement)) {
      return;
    }
    const delegationId = target.dataset.delegationId;
    if (!delegationId) {
      return;
    }
    const confirmed = await openConfirmDialog({
      title: "Revoke Delegation",
      description: "Revoke this delegation?",
      confirmLabel: "Revoke",
      testId: "revoke-workspace-delegation-dialog",
    });
    if (!confirmed) {
      return;
    }

    setButtonState(target, { state: "loading", label: "Revoking…", disable: true });
    try {
      await revokeWorkspaceDelegation(delegationId, {
        onUnauthorized: () => handleUnauthorizedAccess(),
      });
      setWorkspaceDelegationFeedback(entry, "Delegation revoked.", "success");
      showToast("Delegation revoked");
      await loadWorkspaceDelegations({ silent: true });
      setButtonState(target, { state: "success", label: "Revoked", disable: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to revoke delegation";
      setWorkspaceDelegationFeedback(entry, message, "error");
      setButtonState(target, { state: "error", label: "Failed", disable: false, restoreAfterMs: 2500 });
    }
  }

  // ── export bot nsec ──────────────────────────────────────────────

  async function handleExportBotNsec(entry) {
    const btn = entry.botExportButton;
    const feedback = entry.botExportFeedback;
    if (!btn) return;

    // Warn the user before proceeding
    const confirmed = await openConfirmDialog({
      title: "Export Bot Private Key",
      description:
        "You are about to copy your bot's private key (nsec) to the clipboard. " +
        "Anyone with this key can sign events as your bot identity. Only continue if you understand the risk.",
      confirmLabel: "Continue",
      testId: "export-bot-nsec-dialog",
    });
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

      // 2. Decrypt using NIP-07 (preferred) or local device keystore (Key Teleport)
      setButtonState(btn, { state: "loading", label: "Decrypting\u2026", disable: true });

      let nsecHex = null;
      if (typeof window.nostr?.nip44?.decrypt === "function") {
        nsecHex = await window.nostr.nip44.decrypt(senderPubkey, encryptedToUser);
      } else if (deviceKeystore.isAvailable()) {
        const stored = await deviceKeystore.retrieveNsec();
        if (!stored?.nsec || !(stored.nsec instanceof Uint8Array) || stored.nsec.length !== 32) {
          throw new Error("No local key available to decrypt bot nsec export");
        }
        const { nip44 } = await import("/vendor/nostr-tools/index.js");
        let userSecretHex = "";
        for (const byte of stored.nsec) userSecretHex += byte.toString(16).padStart(2, "0");
        const conversationKey = nip44.v2.utils.getConversationKey(userSecretHex, senderPubkey);
        nsecHex = nip44.v2.decrypt(encryptedToUser, conversationKey);
      } else {
        throw new Error("No NIP-44 decryption method available to export bot nsec");
      }

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

  async function handlePublishBotDelegateKind(entry) {
    const btn = entry.botPublishDelegateButton;
    const feedback = entry.botPublishDelegateFeedback;
    if (!btn) return;

    setButtonState(btn, { state: "loading", label: "Signing\u2026", disable: true });

    try {
      const result = await publishDelegateRegistryForCurrentUser(state.config);
      if (result?.botProfileSignedEvent) {
        if (typeof window !== "undefined") {
          window.wingmanLastBotKind0Tx = result.botProfileSignedEvent;
        }
        console.log("[identity] bot profile tx (kind 0):", result.botProfileSignedEvent);
      }
      if (typeof window !== "undefined") {
        window.wingmanLastDelegateRegistryTx = result?.signedEvent ?? null;
      }
      console.log("[identity] delegate registry tx (kind 30078):", result?.signedEvent ?? null);
      const relayCount = Array.isArray(result?.results) ? result.results.length : 0;
      const successCount = Number.isFinite(result?.successes) ? Number(result.successes) : 0;
      setButtonState(btn, { state: "success", label: "Published", disable: false });
      if (feedback) {
        feedback.textContent = relayCount > 0 ? `${successCount}/${relayCount} relays` : "Published";
        feedback.hidden = false;
        feedback.dataset.state = successCount > 0 ? "success" : "error";
      }
      setTimeout(() => {
        resetButtonState(btn);
        if (feedback) {
          feedback.hidden = true;
          delete feedback.dataset.state;
        }
      }, 4000);
    } catch (err) {
      console.error("[identity] delegate registry publish failed:", err);
      const message = err instanceof Error ? err.message : "Publish failed";
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
      }, 5000);
    }
  }

  async function handleForceBotSetup(entry, { silent = false } = {}) {
    const btn = entry?.botForceSetupButton;
    const feedback = entry?.botPublishDelegateFeedback;

    if (btn) {
      setButtonState(btn, { state: "loading", label: "Syncing…", disable: true });
    }

    try {
      await forceSyncBotLifecycle();
      await fetchBotIdentity();
      const result = await publishDelegateRegistryForCurrentUser(state.config);
      const relayCount = Array.isArray(result?.results) ? result.results.length : 0;
      const successCount = Number.isFinite(result?.successes) ? Number(result.successes) : 0;
      if (btn) {
        setButtonState(btn, { state: "success", label: "Synced", disable: false });
      }
      if (feedback) {
        feedback.textContent = relayCount > 0 ? `${successCount}/${relayCount} relays` : "Synced";
        feedback.hidden = false;
        feedback.dataset.state = successCount > 0 ? "success" : "error";
      }
      setTimeout(() => {
        if (btn) resetButtonState(btn);
        if (feedback) {
          feedback.hidden = true;
          delete feedback.dataset.state;
        }
      }, 4000);
    } catch (error) {
      if (!silent) {
        console.error("[identity] force bot setup failed:", error);
      }
      if (btn) {
        setButtonState(btn, { state: "error", label: "Failed", disable: false });
      }
      if (feedback && !silent) {
        const message = error instanceof Error ? error.message : "Bot setup failed";
        feedback.textContent = message;
        feedback.hidden = false;
        feedback.dataset.state = "error";
      }
      setTimeout(() => {
        if (btn) resetButtonState(btn);
        if (feedback && !silent) {
          feedback.hidden = true;
          delete feedback.dataset.state;
        }
      }, 5000);
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
      botDisplayName: current.botDisplayName ?? null,
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
      next.botDisplayName = null;
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
    if ("botDisplayName" in partial) {
      next.botDisplayName = typeof partial.botDisplayName === "string" ? partial.botDisplayName : null;
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
      next.botDisplayName !== (current.botDisplayName ?? null) ||
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
    syncWorkspaceDelegationEntries();

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
      loadWorkspaceDelegations({ silent: true }).catch(() => {});
      Promise.resolve().then(() => handleForceBotSetup(null, { silent: true }));
    }
    if (becameUnauthenticated) {
      stopSigningListener();
      resetWorkspaceDelegationsState();
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
      showToast("Registration is unavailable right now. Try an advanced option below.", {
        type: "warning",
      });
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
          showToast(message, { type: "error" });
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
        showToast(message, { type: "error" });
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
      botName: root.querySelector('[data-role="identity-bot-name"]'),
      botPubkey: root.querySelector('[data-role="identity-bot-pubkey"]'),
      botStatus: root.querySelector('[data-role="identity-bot-status"]'),
      botCopyButton: root.querySelector('[data-action="copy-bot-npub"]'),
      botCopyFeedback: root.querySelector('[data-role="identity-bot-copy-feedback"]'),
      botExportButton: root.querySelector('[data-action="export-bot-nsec"]'),
      botExportFeedback: root.querySelector('[data-role="identity-bot-export-feedback"]'),
      botPublishDelegateButton: root.querySelector('[data-action="publish-bot-delegate-kind"]'),
      botForceSetupButton: root.querySelector('[data-action="force-bot-setup"]'),
      botPublishDelegateFeedback: root.querySelector('[data-role="identity-bot-delegate-publish-feedback"]'),
      workspaceDelegationsSection: root.querySelector('[data-role="workspace-delegations-section"]'),
      workspaceDelegationBotHint: root.querySelector('[data-role="workspace-delegation-bot-hint"]'),
      workspaceDelegationForm: root.querySelector('[data-form="workspace-delegation"]'),
      workspaceDelegationDelegateInput: root.querySelector('[data-role="workspace-delegation-delegate"]'),
      workspaceDelegationDurationSelect: root.querySelector('[data-role="workspace-delegation-duration"]'),
      workspaceDelegationBillingSelect: root.querySelector('[data-role="workspace-delegation-billing"]'),
      workspaceDelegationSpendLimitInput: root.querySelector('[data-role="workspace-delegation-spend-limit"]'),
      workspaceDelegationPathPrefixesInput: root.querySelector('[data-role="workspace-delegation-path-prefixes"]'),
      workspaceDelegationAppIdsInput: root.querySelector('[data-role="workspace-delegation-app-ids"]'),
      workspaceDelegationAppRootsInput: root.querySelector('[data-role="workspace-delegation-app-roots"]'),
      workspaceDelegationProjectRootsInput: root.querySelector('[data-role="workspace-delegation-project-roots"]'),
      workspaceDelegationFeedback: root.querySelector('[data-role="workspace-delegation-feedback"]'),
      workspaceDelegationUseBotButton: root.querySelector('[data-action="workspace-delegation-use-bot"]'),
      workspaceDelegationCreateButton: root.querySelector('[data-action="workspace-delegation-create"]'),
      workspaceDelegationRefreshButton: root.querySelector('[data-action="workspace-delegation-refresh"]'),
      workspaceDelegationsList: root.querySelector('[data-role="workspace-delegations-list"]'),
      workspaceDelegationScopeInputs: Array.from(root.querySelectorAll('[data-role="workspace-delegation-scope"]')),
      copyHandler: null,
      registerHandler: null,
      copyNpubHandler: null,
      copyNsecHandler: null,
      logoutHandler: null,
      botCopyHandler: null,
      botExportHandler: null,
      botPublishDelegateHandler: null,
      botForceSetupHandler: null,
      workspaceDelegationSubmitHandler: null,
      workspaceDelegationUseBotHandler: null,
      workspaceDelegationRefreshHandler: null,
      workspaceDelegationListHandler: null,
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
      identityDomEntryByNode.set(entry.botCopyButton, entry);
    }

    if (entry.botExportButton) {
      ensureButtonOriginalLabel(entry.botExportButton);
      entry.botExportHandler = async () => {
        await handleExportBotNsec(entry);
      };
      entry.botExportButton.addEventListener("click", entry.botExportHandler);
      identityDomEntryByNode.set(entry.botExportButton, entry);
    }

    if (entry.botPublishDelegateButton) {
      ensureButtonOriginalLabel(entry.botPublishDelegateButton);
      entry.botPublishDelegateHandler = async () => {
        await handlePublishBotDelegateKind(entry);
      };
      entry.botPublishDelegateButton.addEventListener("click", entry.botPublishDelegateHandler);
      identityDomEntryByNode.set(entry.botPublishDelegateButton, entry);
    }

    if (entry.botForceSetupButton) {
      ensureButtonOriginalLabel(entry.botForceSetupButton);
      entry.botForceSetupHandler = async () => {
        await handleForceBotSetup(entry);
      };
      entry.botForceSetupButton.addEventListener("click", entry.botForceSetupHandler);
      identityDomEntryByNode.set(entry.botForceSetupButton, entry);
    }

    if (entry.workspaceDelegationUseBotButton) {
      ensureButtonOriginalLabel(entry.workspaceDelegationUseBotButton);
      entry.workspaceDelegationUseBotHandler = (event) => {
        event.preventDefault();
        void handleWorkspaceDelegationUseBot(entry);
      };
      entry.workspaceDelegationUseBotButton.addEventListener("click", entry.workspaceDelegationUseBotHandler);
    }

    if (entry.workspaceDelegationRefreshButton) {
      ensureButtonOriginalLabel(entry.workspaceDelegationRefreshButton);
      entry.workspaceDelegationRefreshHandler = (event) => {
        event.preventDefault();
        void handleWorkspaceDelegationRefresh(entry);
      };
      entry.workspaceDelegationRefreshButton.addEventListener("click", entry.workspaceDelegationRefreshHandler);
    }

    if (entry.workspaceDelegationForm) {
      entry.workspaceDelegationSubmitHandler = (event) => {
        event.preventDefault();
        void handleWorkspaceDelegationSubmit(entry);
      };
      entry.workspaceDelegationForm.addEventListener("submit", entry.workspaceDelegationSubmitHandler);
    }

    if (entry.workspaceDelegationsList) {
      entry.workspaceDelegationListHandler = (event) => {
        void handleWorkspaceDelegationListClick(event, entry);
      };
      entry.workspaceDelegationsList.addEventListener("click", entry.workspaceDelegationListHandler);
    }

    identityDomEntries.add(entry);
    syncIdentityDisplayForEntry(entry);
    syncWorkspaceDelegationEntry(entry);
    if (state.identity.authenticated && state.identity.npub && workspaceDelegationsState.ownerNpub !== state.identity.npub) {
      loadWorkspaceDelegations({ silent: true }).catch(() => {});
    }
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
