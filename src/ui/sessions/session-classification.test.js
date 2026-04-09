import { describe, expect, test } from "bun:test";
import {
  countSessionsByLiveTabGroup,
  filterSessionsForLiveTabGroup,
  getLiveSessionTabGroup,
  isAgentChatSession,
  resolveLiveTabGroup,
} from "./session-classification.js";

describe("session-classification", () => {
  const standardSession = {
    id: "standard-1",
    metadata: { role: "user" },
    origin: { type: "cli" },
  };

  const wingmanSession = {
    id: "wingman-1",
    metadata: { role: "agent-chat", agentChatAgentId: "agent_wm21" },
    origin: { type: "agent-chat" },
  };

  test("identifies agent-chat sessions from metadata", () => {
    expect(isAgentChatSession(wingmanSession)).toBe(true);
    expect(isAgentChatSession(standardSession)).toBe(false);
  });

  test("maps sessions into standard and wingman live groups", () => {
    expect(getLiveSessionTabGroup(wingmanSession)).toBe("wingman");
    expect(getLiveSessionTabGroup(standardSession)).toBe("standard");
  });

  test("filters sessions for the selected live tab group", () => {
    const sessions = [standardSession, wingmanSession];
    expect(filterSessionsForLiveTabGroup(sessions, "all")).toEqual(sessions);
    expect(filterSessionsForLiveTabGroup(sessions, "standard")).toEqual([standardSession]);
    expect(filterSessionsForLiveTabGroup(sessions, "wingman")).toEqual([wingmanSession]);
  });

  test("counts sessions for the live tab group badges", () => {
    expect(countSessionsByLiveTabGroup([standardSession, wingmanSession, wingmanSession])).toEqual({
      all: 3,
      standard: 1,
      wingman: 2,
    });
  });

  test("falls back to the active session group when none is selected yet", () => {
    expect(resolveLiveTabGroup(null, [standardSession, wingmanSession], wingmanSession)).toBe("wingman");
    expect(resolveLiveTabGroup(undefined, [standardSession], null)).toBe("standard");
  });
});
