import { describe, expect, test } from "bun:test";

import { createFlightDeckConnectionsPanel } from "./flight-deck-section.js";

class FakeElement {
  constructor(tagName) {
    this.tagName = String(tagName || "").toLowerCase();
    this.className = "";
    this.dataset = {};
    this.attributes = {};
    this.style = {};
    this.children = [];
    this.listeners = new Map();
    this.textContent = "";
    this.title = "";
    this.type = "";
  }

  append(...children) {
    this.children.push(...children.filter(Boolean));
  }

  addEventListener(type, callback) {
    const existing = this.listeners.get(type) || [];
    existing.push(callback);
    this.listeners.set(type, existing);
  }

  setAttribute(name, value) {
    const normalized = String(name || "");
    const stringValue = String(value ?? "");
    this.attributes[normalized] = stringValue;
    if (normalized === "data-testid") {
      this.dataset.testid = stringValue;
    }
  }

  click() {
    const listeners = this.listeners.get("click") || [];
    listeners.forEach((listener) => listener({ currentTarget: this }));
  }
}

function withFakeDocument(run) {
  const originalDocument = globalThis.document;
  globalThis.document = {
    createElement(tagName) {
      return new FakeElement(tagName);
    },
  };

  try {
    return run();
  } finally {
    globalThis.document = originalDocument;
  }
}

function queryByTestId(node, testId) {
  if (!node) {
    return null;
  }
  if (node instanceof FakeElement && node.dataset?.testid === testId) {
    return node;
  }
  if (!Array.isArray(node.children)) {
    return null;
  }
  for (const child of node.children) {
    if (child instanceof FakeElement) {
      const match = queryByTestId(child, testId);
      if (match) {
        return match;
      }
    }
  }
  return null;
}

function collectText(node) {
  if (!node || !(node instanceof FakeElement)) {
    return "";
  }
  return [
    node.textContent,
    ...node.children.map((child) => collectText(child)),
  ].filter(Boolean).join(" ");
}

describe("flight deck settings panel", () => {
  test("renders workspace connection status and management action", () => {
    withFakeDocument(() => {
      let managedSubscriptionId = null;
      const panel = createFlightDeckConnectionsPanel({
        subscriptions: [
          {
            subscriptionId: "sub-flightdeck",
            backendConnectionId: "backend-flightdeck",
            backendBaseUrl: "https://tower.example",
            workspaceOwnerNpub: "npub1workspaceowner",
            sourceAppNpub: "npub1flightdeckapp",
            botNpub: "npub1agentbot",
            onboardingSource: "nostr_33357",
            healthStatus: "healthy",
            sseStatus: "connected",
            groupKeyStatus: "synced",
            profileWorkspace: {
              workspace: {
                workspaceTitle: "Swipeback",
                relayOnboardingStatus: "ready",
                yokeSyncStatus: "synced",
              },
              visibleContext: {
                scopes: [{ id: "scope-design", label: "Design" }],
                channels: [{ id: "channel-bugs", label: "Bugs" }],
              },
              appendedContexts: [{ contextKind: "workspace", contextText: "Repo path" }],
            },
          },
        ],
        backendConnections: [{ backendConnectionId: "backend-flightdeck" }],
        agents: [
          {
            agentId: "wm21",
            workspaceOwnerNpub: "npub1workspaceowner",
            botNpub: "npub1agentbot",
          },
        ],
        dispatchRoutes: [
          { routeId: "route-on", subscriptionId: "sub-flightdeck", enabled: true },
          { routeId: "route-off", subscriptionId: "sub-flightdeck", enabled: false },
        ],
        chatSessions: [{ id: "session-1" }],
        onManageDispatch: (subscription) => {
          managedSubscriptionId = subscription?.subscriptionId ?? "summary";
        },
      });

      const text = collectText(panel);
      expect(text).toContain("Flight Deck");
      expect(text).toContain("Swipeback");
      expect(text).toContain("Onboarding Ready");
      expect(text).toContain("Yoke Synced");
      expect(text).toContain("Default Dispatch Ready");
      expect(text).toContain("1/2 enabled");
      expect(text).toContain("Tower service");
      expect(text).toContain("Connection source");
      expect(text).toContain("kind 33357");
      expect(text).toContain("Visible scopes");
      expect(text).toContain("Visible channels");
      expect(text).toContain("Appended context");

      queryByTestId(panel, "flight-deck-manage-sub-flightdeck").click();
      expect(managedSubscriptionId).toBe("sub-flightdeck");
    });
  });

  test("hides manual and Agent Connect-only Tower subscriptions", () => {
    withFakeDocument(() => {
      const panel = createFlightDeckConnectionsPanel({
        subscriptions: [
          {
            subscriptionId: "sub-manual",
            backendBaseUrl: "https://manual.example",
            workspaceOwnerNpub: "npub1manualworkspace",
            sourceAppNpub: "npub1app",
            botNpub: "npub1bot",
            onboardingSource: "manual",
            healthStatus: "healthy",
            sseStatus: "connected",
          },
          {
            subscriptionId: "sub-agent-connect",
            backendBaseUrl: "https://agent-connect.example",
            workspaceOwnerNpub: "npub1agentconnectworkspace",
            sourceAppNpub: "npub1app",
            botNpub: "npub1bot",
            onboardingSource: "agent_connect_import",
            healthStatus: "healthy",
            sseStatus: "connected",
          },
        ],
      });

      const text = collectText(panel);
      expect(text).toContain("No Onboarded Workspaces");
      expect(text).toContain("No kind 33357 workspace onboarding events");
      expect(text).not.toContain("manual.example");
      expect(text).not.toContain("agent-connect.example");
    });
  });
});
