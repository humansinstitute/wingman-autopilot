import { createHash } from 'node:crypto';

import { readLatestCodexUserVisibleActivity } from '../agents/codex-session-messages';
import type { ProcessManager } from '../agents/process-manager';
import { upsertFlightDeckPgAgentActivity } from './tower-client';
import type { RuntimeBotIdentity } from './types';

export type AgentActivityState = 'accepted' | 'working' | 'waiting' | 'completed' | 'failed' | 'cancelled';

export interface AgentActivityContext {
  backendBaseUrl: string;
  workspaceId: string;
  appNpub: string;
  botIdentity: RuntimeBotIdentity;
  channelId: string;
  threadId: string;
  triggerMessageId: string;
  sessionId: string;
  agentNpub: string;
  turnId: string;
}

export function buildAgentActivityId(context: Pick<AgentActivityContext, 'workspaceId' | 'turnId' | 'agentNpub'>): string {
  return createHash('sha256').update(`${context.workspaceId}:${context.turnId}:${context.agentNpub}`).digest('hex').slice(0, 32);
}

export function normalizeUserVisibleActivity(value: string, maxLength = 4_000): string | null {
  const clean = value.replace(/\u0000/g, '').trim();
  if (!clean) return null;
  return clean.length > maxLength ? `${clean.slice(0, maxLength - 1)}…` : clean;
}

export class AgentActivityPublisher {
  private sequence: number;
  private lastBody = '';
  private latestCommentaryAt = Number.NEGATIVE_INFINITY;
  private terminal = false;
  private publishQueue = Promise.resolve();

  constructor(
    private readonly context: AgentActivityContext,
    private readonly deliver: typeof upsertFlightDeckPgAgentActivity = upsertFlightDeckPgAgentActivity,
    sequenceBase = Date.now() * 1_000,
    private readonly readLatestActivity = readLatestCodexUserVisibleActivity,
  ) {
    this.sequence = sequenceBase;
  }

  async publish(state: AgentActivityState, body?: string): Promise<void> {
    return this.enqueuePublish(() => this.publishNow(state, body));
  }

  private enqueuePublish(operation: () => Promise<void>): Promise<void> {
    const queued = this.publishQueue.then(operation, operation);
    this.publishQueue = queued.catch(() => undefined);
    return queued;
  }

  private async publishNow(state: AgentActivityState, body?: string): Promise<void> {
    if (this.terminal) return;
    const normalized = body ? normalizeUserVisibleActivity(body) : null;
    if (state === 'working' && (!normalized || normalized === this.lastBody)) return;
    if (normalized) this.lastBody = normalized;
    const terminal = state === 'completed' || state === 'failed' || state === 'cancelled';
    const sequence = ++this.sequence;
    try {
      const request = {
        ...this.context,
        activityId: buildAgentActivityId(this.context),
        state,
        sequence,
        label: state === 'accepted' ? 'Thinking' : state === 'working' ? 'Working' : undefined,
        summary: normalized ? normalized.replace(/\s+/g, ' ').slice(0, 240) : undefined,
        body: normalized ?? undefined,
        expiresInSeconds: terminal ? 60 : 300,
      };
      let delivered = false;
      for (let attempt = 0; attempt < 2 && !delivered; attempt += 1) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 2_000);
        try {
          await this.deliver({ ...request, signal: controller.signal });
          delivered = true;
        } catch {
          if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 50));
        } finally {
          clearTimeout(timeout);
        }
      }
      if (!delivered) return;
      if (terminal) this.terminal = true;
    } catch {
      // Activity is advisory. Tower failures must never block the normal reply path.
    }
  }

  async publishLatestCommentary(manager: ProcessManager): Promise<void> {
    const session = manager.getSession(this.context.sessionId);
    const native = session?.metadata?.nativeAgentSession;
    if (session?.agent !== 'codex' || native?.agent !== 'codex' || !native.sessionId || !native.workingDirectory) return;
    const activity = await this.readLatestActivity({
      sessionId: native.sessionId,
      workingDirectory: native.workingDirectory,
    }).catch(() => null);
    if (!activity) return;
    const createdAt = Date.parse(activity.createdAt);
    await this.enqueuePublish(async () => {
      if (Number.isFinite(createdAt) && createdAt <= this.latestCommentaryAt) return;
      if (Number.isFinite(createdAt)) this.latestCommentaryAt = createdAt;
      await this.publishNow('working', activity.content);
    });
  }
}
