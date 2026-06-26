import type { ProcessManager, SessionSnapshot } from "../agents/process-manager";
import type { ReplaceMessageInput, messageStore as MessageStoreInstance } from "../storage/message-store";
import { fetchAgentMessages } from "../agents/agent-client";
import { readCodexSessionMessages } from "../agents/codex-session-messages";

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
    const liveMessages = adapter
      ? await adapter.fetchMessages()
      : await fetchAgentMessages(agentHost, session.port);
    const messages = await selectBestSessionMessages(session, liveMessages);
    if (messages.length > 0 || !hadMessages) {
      messageStore.replaceMessages(sessionId, messages);
    }
  } catch (error) {
    console.error(`Failed to synchronise messages for session ${sessionId}:`, error);
  }

  return messageStore.listSessionMessages(sessionId);
}

async function selectBestSessionMessages(
  session: SessionSnapshot,
  liveMessages: ReplaceMessageInput[],
): Promise<ReplaceMessageInput[]> {
  const nativeSession = session.metadata?.nativeAgentSession;
  if (
    session.agent !== "codex" ||
    nativeSession?.agent !== "codex" ||
    !nativeSession.sessionId ||
    !nativeSession.workingDirectory
  ) {
    return liveMessages;
  }

  const nativeMessages = await readCodexSessionMessages({
    sessionId: nativeSession.sessionId,
    workingDirectory: nativeSession.workingDirectory,
  }).catch(() => []);
  return nativeMessages.length >= liveMessages.length ? nativeMessages : liveMessages;
}
