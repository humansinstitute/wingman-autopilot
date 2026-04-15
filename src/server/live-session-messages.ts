import type { ProcessManager } from "../agents/process-manager";
import type { messageStore as MessageStoreInstance } from "../storage/message-store";
import { fetchAgentMessages } from "../agents/agent-client";

interface SyncLiveSessionMessagesInput {
  sessionId: string;
  force?: boolean;
  manager: ProcessManager;
  messageStore: typeof MessageStoreInstance;
  agentHost: string;
}

export async function syncLiveSessionMessages(input: SyncLiveSessionMessagesInput): Promise<unknown[]> {
  const { sessionId, force = false, manager, messageStore, agentHost } = input;

  if (!force && messageStore.hasMessages(sessionId)) {
    return messageStore.listSessionMessages(sessionId);
  }

  const session = manager.getSession(sessionId);
  if (!session || session.status !== "running") {
    return messageStore.listSessionMessages(sessionId);
  }

  try {
    const hadMessages = messageStore.hasMessages(sessionId);
    const adapter = manager.getAdapter(sessionId);
    const messages =
      session.agent === "pi" && adapter
        ? await adapter.fetchMessages()
        : await fetchAgentMessages(agentHost, session.port);
    if (messages.length > 0 || !hadMessages) {
      messageStore.replaceMessages(sessionId, messages);
    }
  } catch (error) {
    console.error(`Failed to synchronise messages for session ${sessionId}:`, error);
  }

  return messageStore.listSessionMessages(sessionId);
}
