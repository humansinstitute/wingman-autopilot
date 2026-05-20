import { describe, expect, test } from "bun:test";

import {
  filterDispatchRoutesForSubscription,
  getAdditionalAgents,
  getAgentForSubscription,
  resolveSelectedSubscriptionId,
} from "./agent-chat-section-state.js";

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
});
