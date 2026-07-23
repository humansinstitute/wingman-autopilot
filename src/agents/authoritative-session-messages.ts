import type { ReplaceMessageInput } from '../storage/message-store';
import type { SessionSnapshot } from './process-manager';
import { readClaudeSessionMessages } from './claude-session-messages';
import { readCodexSessionMessages } from './codex-session-messages';

export async function resolveAuthoritativeSessionMessages(
  session: SessionSnapshot,
  liveMessages: ReplaceMessageInput[],
  options: { requireNative?: boolean } = {},
): Promise<ReplaceMessageInput[]> {
  const nativeSession = session.metadata?.nativeAgentSession;
  if (!nativeSession?.sessionId || !nativeSession.workingDirectory) return liveMessages;

  let nativeMessages: ReplaceMessageInput[] = [];
  if (session.agent === 'codex' && nativeSession.agent === 'codex') {
    nativeMessages = await readCodexSessionMessages({
      sessionId: nativeSession.sessionId,
      workingDirectory: nativeSession.workingDirectory,
    }).catch(() => []);
    if (nativeMessages.length > 0) return nativeMessages;
    return options.requireNative ? [] : liveMessages;
  }
  if (session.agent === 'claude' && nativeSession.agent === 'claude') {
    nativeMessages = await readClaudeSessionMessages({
      sessionId: nativeSession.sessionId,
      workingDirectory: nativeSession.workingDirectory,
    }).catch(() => []);
  }
  return nativeMessages.length >= liveMessages.length ? nativeMessages : liveMessages;
}
