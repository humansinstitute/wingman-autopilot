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
            workspaceServiceNpub: "npub1workspaceservice",
            workspaceId: "workspace-swipeback",
            sourceAppNpub: "npub1flightdeckapp",
            botNpub: "npub1agentbot",
            onboardingSource: "nostr_33357",
            healthStatus: "healthy",
            sseStatus: "connected",
            groupKeyStatus: "synced",
            recentSseEvents: [
              {
                at: "2026-06-10T06:00:00.000Z",
                eventType: "flightdeck_pg.message.created",
                eventId: "event-message-1234567890",
                payload: {
                  entity_type: "message",
                  channel_id: "channel-bugs",
                },
              },
            ],
            recentDispatches: [
              {
                at: "2026-06-10T06:00:01.000Z",
                kind: "chat",
                action: "chat_pipeline_dispatch",
                sessionId: "session-dispatch-123456",
                details: {
                  channel_id: "channel-bugs",
                  pipeline_run_id: "run-1",
                },
              },
            ],
            lastRoutingResult: {
              ok: true,
              code: "chat_pipeline_dispatched",
              message: "Chat event dispatched.",
              at: "2026-06-10T06:00:02.000Z",
              details: {
                message_id: "message-1",
              },
            },
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
            workspaceOwnerNpub: "npub1workspaceservice",
            botNpub: "npub1agentbot",
          },
        ],
        dispatchRoutes: [
          {
            routeId: "route-chat",
            subscriptionId: "sub-flightdeck",
            triggerKind: "chat",
            capability: "chat_intercept",
            pipelineDefinitionId: "fd-agent-dispatch-chat",
            enabled: true,
          },
          {
            routeId: "route-docs",
            subscriptionId: "sub-flightdeck",
            triggerKind: "comment",
            capability: "comment_dispatch",
            pipelineDefinitionId: "fd-agent-dispatch-comment-response",
            enabled: true,
          },
          {
            routeId: "route-task",
            subscriptionId: "sub-flightdeck",
            triggerKind: "task",
            capability: "task_dispatch",
            pipelineDefinitionId: "fd-agent-dispatch-task-response",
            enabled: false,
          },
          {
            routeId: "route-flow",
            subscriptionId: "sub-flightdeck",
            triggerKind: "flow",
            capability: "flow_dispatch",
            pipelineDefinitionId: "legacy-flow-pipeline",
            enabled: true,
          },
        ],
        chatSessions: [{ id: "session-1" }],
        onManageDispatch: (subscription) => {
          managedSubscriptionId = subscription?.subscriptionId ?? "summary";
        },
      });

      const text = collectText(panel);
      expect(text).toContain("Flight Deck");
      expect(text).toContain("Swipeback");
      expect(text).toContain("Events Connected");
      expect(text).not.toContain("SSE Connected");
      expect(text).toContain("Onboarding Ready");
      expect(text).toContain("Yoke Synced");
      expect(text).toContain("Default Dispatch Ready");
      expect(text).toContain("2/3 enabled");
      expect(text).toContain("Workspace id");
      expect(text).toContain("workspace-swipeback");
      expect(text).toContain("Workspace service");
      expect(text).toContain("Workspace member owner");
      expect(text).toContain("Tower service");
      expect(text).toContain("Connection source");
      expect(text).toContain("kind 33357");
      expect(text).toContain("Visible scopes");
      expect(text).toContain("Visible channels");
      expect(text).toContain("Appended context");
      expect(text).toContain("Default Dispatch");
      expect(text).toContain("Selected workspace: Swipeback");
      expect(text).toContain("Chat");
      expect(text).toContain("Docs");
      expect(text).toContain("Tasks");
      expect(text).toContain("Chat messages");
      expect(text).toContain("Document comments");
      expect(text).toContain("Task assignments and comments");
      expect(text).toContain("fd-agent-dispatch-chat");
      expect(text).toContain("fd-agent-dispatch-comment-response");
      expect(text).toContain("fd-agent-dispatch-task-response");
      expect(text).not.toContain("legacy-flow-pipeline");
      expect(queryByTestId(panel, "flight-deck-dispatch-row-chat")).not.toBeNull();
      expect(queryByTestId(panel, "flight-deck-dispatch-row-docs")).not.toBeNull();
      expect(queryByTestId(panel, "flight-deck-dispatch-row-tasks")).not.toBeNull();
      expect(queryByTestId(panel, "flight-deck-default-dispatch-card")).not.toBeNull();
      expect(text).not.toContain("SSE Events");
      expect(text).not.toContain("flightdeck_pg.message.created");
      expect(text).not.toContain("Dispatches");
      expect(text).not.toContain("chat_pipeline_dispatch");
      expect(text).not.toContain("Last Routing Result");
      expect(text).not.toContain("chat_pipeline_dispatched");
      expect(queryByTestId(panel, "flight-deck-sse-events-sub-flightdeck-row-0")).toBeNull();
      expect(queryByTestId(panel, "flight-deck-dispatch-events-sub-flightdeck-row-0")).toBeNull();
      expect(queryByTestId(panel, "flight-deck-routing-result-sub-flightdeck-row-0")).toBeNull();

      queryByTestId(panel, "flight-deck-manage-sub-flightdeck").click();
      expect(managedSubscriptionId).toBe("sub-flightdeck");
    });
  });

  test("keeps the selected workspace dispatch table visible without configured routes", () => {
    withFakeDocument(() => {
      const panel = createFlightDeckConnectionsPanel({
        subscriptions: [
          {
            subscriptionId: "sub-empty-routes",
            backendBaseUrl: "https://tower.example",
            workspaceOwnerNpub: "npub1workspaceowner",
            workspaceServiceNpub: "npub1workspaceservice",
            workspaceId: "workspace-empty",
            sourceAppNpub: "npub1flightdeckapp",
            botNpub: "npub1agentbot",
            onboardingSource: "nostr_33357",
            healthStatus: "healthy",
            sseStatus: "connected",
            profileWorkspace: {
              workspace: {
                workspaceTitle: "Empty Routes",
                relayOnboardingStatus: "ready",
              },
            },
          },
        ],
        dispatchRoutes: [],
      });

      const text = collectText(panel);
      expect(queryByTestId(panel, "flight-deck-default-dispatch-card")).not.toBeNull();
      expect(queryByTestId(panel, "flight-deck-dispatch-row-chat")).not.toBeNull();
      expect(queryByTestId(panel, "flight-deck-dispatch-row-docs")).not.toBeNull();
      expect(queryByTestId(panel, "flight-deck-dispatch-row-tasks")).not.toBeNull();
      expect(text).toContain("Selected workspace: Empty Routes");
      expect(text).toContain("Not configured");
      expect(text).toContain("Dispatch Setup Pending");
    });
  });

  test("matches selected workspace dispatch routes with snake case fields", () => {
    withFakeDocument(() => {
      const panel = createFlightDeckConnectionsPanel({
        subscriptions: [
          {
            subscriptionId: "sub-snake-routes",
            backendBaseUrl: "https://tower.example",
            workspaceOwnerNpub: "npub1workspaceowner",
            workspaceServiceNpub: "npub1workspaceservice",
            workspaceId: "workspace-snake",
            sourceAppNpub: "npub1flightdeckapp",
            botNpub: "npub1agentbot",
            onboardingSource: "nostr_33357",
            healthStatus: "healthy",
            sseStatus: "connected",
            profileWorkspace: {
              workspace: {
                workspaceTitle: "Snake Routes",
                relayOnboardingStatus: "ready",
              },
            },
          },
        ],
        dispatchRoutes: [
          {
            route_id: "route-chat",
            subscriptionId: "sub-snake-routes",
            trigger_kind: "chat",
            capability: "chat_intercept",
            pipeline_definition_id: "snake-chat-pipeline",
            enabled: true,
          },
        ],
      });

      const text = collectText(panel);
      expect(queryByTestId(panel, "flight-deck-default-dispatch-card")).not.toBeNull();
      expect(text).toContain("snake-chat-pipeline");
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

  test("tabs multiple onboarded workspaces and renders only the selected one", () => {
    withFakeDocument(() => {
      let selectedSubscriptionId = null;
      const panel = createFlightDeckConnectionsPanel({
        selectedSubscriptionId: "sub-wingmen",
        subscriptions: [
          {
            subscriptionId: "sub-thisworks",
            backendBaseUrl: "https://tower.example",
            workspaceOwnerNpub: "npub1thisworks",
            sourceAppNpub: "npub1flightdeckapp",
            botNpub: "npub1agentbot",
            onboardingSource: "nostr_33357",
            healthStatus: "healthy",
            sseStatus: "connected",
            profileWorkspace: {
              workspace: {
                workspaceTitle: "This Works",
                relayOnboardingStatus: "ready",
              },
            },
          },
          {
            subscriptionId: "sub-wingmen",
            backendBaseUrl: "https://tower.example",
            workspaceOwnerNpub: "npub1wingmen",
            sourceAppNpub: "npub1flightdeckapp",
            botNpub: "npub1agentbot",
            onboardingSource: "nostr_33357",
            healthStatus: "healthy",
            sseStatus: "connected",
            profileWorkspace: {
              workspace: {
                workspaceTitle: "Wingmen",
                relayOnboardingStatus: "ready",
              },
            },
          },
        ],
        dispatchRoutes: [
          {
            routeId: "route-thisworks-chat",
            subscriptionId: "sub-thisworks",
            triggerKind: "chat",
            capability: "chat_intercept",
            pipelineDefinitionId: "thisworks-chat-pipeline",
            enabled: true,
          },
          {
            routeId: "route-wingmen-chat",
            subscriptionId: "sub-wingmen",
            triggerKind: "chat",
            capability: "chat_intercept",
            pipelineDefinitionId: "wingmen-chat-pipeline",
            enabled: true,
          },
        ],
        onSelectWorkspace: (subscription) => {
          selectedSubscriptionId = subscription?.subscriptionId ?? null;
        },
      });

      const text = collectText(panel);
      expect(queryByTestId(panel, "flight-deck-workspace-tab-sub-thisworks")).not.toBeNull();
      expect(queryByTestId(panel, "flight-deck-workspace-tab-sub-wingmen")).not.toBeNull();
      expect(queryByTestId(panel, "flight-deck-connection-sub-thisworks")).toBeNull();
      expect(queryByTestId(panel, "flight-deck-connection-sub-wingmen")).not.toBeNull();
      expect(text).toContain("This Works");
      expect(text).toContain("Wingmen");
      expect(text).toContain("wingmen-chat-pipeline");
      expect(text).not.toContain("thisworks-chat-pipeline");

      queryByTestId(panel, "flight-deck-workspace-tab-sub-thisworks").click();
      expect(selectedSubscriptionId).toBe("sub-thisworks");
    });
  });

  test("keeps revoked onboarding out of the active list and shows diagnostics", () => {
    withFakeDocument(() => {
      const panel = createFlightDeckConnectionsPanel({
        subscriptions: [
          {
            subscriptionId: "sub-revoked",
            backendBaseUrl: "https://tower.example",
            workspaceOwnerNpub: "npub1workspaceowner",
            sourceAppNpub: "npub1flightdeckapp",
            botNpub: "npub1agentbot",
            onboardingSource: "nostr_33357",
            healthStatus: "unhealthy",
            sseStatus: "disabled",
            wsKeyStatus: "revoked",
            groupKeyStatus: "revoked",
            lastErrorCode: "workspace_access_revoked",
            lastAuthResult: {
              message: "Tower confirmed revoked workspace access.",
              details: {
                source_33357_event_id: "event-revoked-1234567890",
                tower_result: "workspace_deleted",
              },
            },
            profileWorkspace: {
              workspace: {
                workspaceTitle: "Old Workspace",
                relayOnboardingStatus: "deleted",
              },
            },
          },
        ],
      });

      const text = collectText(panel);
      expect(text).toContain("No Onboarded Workspaces");
      expect(text).toContain("Diagnostics");
      expect(text).toContain("Old Workspace");
      expect(text).toContain("Onboarding Deleted");
      expect(text).toContain("Tower confirmed revoked workspace access.");
      expect(queryByTestId(panel, "flight-deck-connection-sub-revoked")).toBeNull();
      expect(queryByTestId(panel, "flight-deck-diagnostic-sub-revoked")).not.toBeNull();
    });
  });
});
