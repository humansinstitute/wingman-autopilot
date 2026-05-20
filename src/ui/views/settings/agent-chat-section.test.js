import { describe, expect, test } from "bun:test";

import {
  filterDispatchRoutesForSubscription,
  getAdditionalAgents,
  getAgentForSubscription,
  resolveSelectedSubscriptionId,
} from "./agent-chat-section-state.js";
import { createAgentDispatchSetupCards } from "./agent-chat-setup-cards.js";

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
    this.disabled = false;
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

describe("agent chat settings subscription selection", () => {
  const subscriptions = [
    {
      subscriptionId: "sub-primary",
      workspaceOwnerNpub: "npub1workspace",
      botNpub: "npub1bot",
    },
    {
      subscriptionId: "sub-secondary",
      workspaceOwnerNpub: "npub1workspace2",
      botNpub: "npub1bot2",
    },
  ];

  test("keeps an explicit selected subscription instead of falling back to the first row", () => {
    expect(resolveSelectedSubscriptionId(subscriptions, "sub-secondary")).toBe("sub-secondary");
    expect(resolveSelectedSubscriptionId(subscriptions, "missing")).toBe("sub-primary");
    expect(resolveSelectedSubscriptionId([], "sub-secondary")).toBeNull();
  });

  test("scopes local agent selection by the selected workspace and bot", () => {
    const agents = [
      {
        agentId: "agent-primary",
        workspaceOwnerNpub: "npub1workspace",
        botNpub: "npub1bot",
      },
      {
        agentId: "agent-secondary",
        workspaceOwnerNpub: "npub1workspace2",
        botNpub: "npub1bot2",
      },
    ];

    expect(getAgentForSubscription(agents, subscriptions[1])?.agentId).toBe("agent-secondary");
    expect(getAgentForSubscription(agents, null)).toBeNull();
    expect(getAdditionalAgents(agents, agents[1]).map((agent) => agent.agentId)).toEqual(["agent-primary"]);
  });

  test("filters dispatch routes to the selected subscription", () => {
    const routes = [
      { routeId: "route-primary", subscriptionId: "sub-primary" },
      { routeId: "route-secondary", subscriptionId: "sub-secondary" },
    ];

    expect(filterDispatchRoutesForSubscription(routes, "sub-secondary")).toEqual([
      { routeId: "route-secondary", subscriptionId: "sub-secondary" },
    ]);
    expect(filterDispatchRoutesForSubscription(routes, null)).toEqual([]);
  });

  test("renders setup-ready backend choices for a secondary subscription", () => {
    withFakeDocument(() => {
      let selectedBackendConnection = null;
      const panel = createAgentDispatchSetupCards({
        subscription: {
          subscriptionId: "sub-primary",
          backendConnectionId: "backend-primary",
          backendBaseUrl: "https://primary.example",
          workspaceOwnerNpub: "npub1workspace",
          sourceAppNpub: "npub1source",
          botNpub: "npub1bot",
        },
        primaryAgent: {
          agentId: "agent-primary",
          capabilities: ["chat_intercept"],
        },
        availableBackendConnections: [
          {
            backendConnectionId: "backend-primary",
            backendBaseUrl: "https://primary.example",
            setupWorkspaceOwnerNpub: "npub1workspace",
            setupSourceAppNpub: "npub1source",
            healthStatus: "healthy",
          },
          {
            backendConnectionId: "backend-secondary",
            backendBaseUrl: "https://secondary.example",
            setupWorkspaceOwnerNpub: "npub1workspace2",
            setupSourceAppNpub: "npub1source2",
            healthStatus: "healthy",
          },
        ],
        onUseBackendConnection: (backendConnection) => {
          selectedBackendConnection = backendConnection;
        },
      });

      expect(queryByTestId(panel, "agent-chat-available-backend-backend-primary")).toBeNull();
      expect(queryByTestId(panel, "agent-chat-available-backend-backend-secondary")).not.toBeNull();

      queryByTestId(panel, "agent-chat-use-backend-backend-secondary").click();
      expect(selectedBackendConnection?.backendConnectionId).toBe("backend-secondary");
    });
  });
});
