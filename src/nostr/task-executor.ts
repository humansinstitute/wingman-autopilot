/**
 * Task Executor
 *
 * Orchestrates the lifecycle of an MG task assignment:
 * 1. Fetch full task details from MG API (NIP-98 authenticated)
 * 2. Move task to in_progress
 * 3. Create an agent session with the task as initial prompt
 * 4. Enable Night Watchman on the session
 * 5. Track task↔session link for completion callback
 */

import type { AgentType } from "../config";
import type { SessionSnapshot, SessionOrigin } from "../agents/process-manager";
import type { TaskAssignment } from "./task-listener";

// ============================================================
// Types
// ============================================================

export interface TaskExecutorDeps {
  signNip98: (url: string, method: string, bodyHash?: string) => Promise<string>;
  createSession: (agent: AgentType, dir: string, name: string, origin?: SessionOrigin) => Promise<SessionSnapshot>;
  enableNightwatch: (sessionId: string) => void;
  addPrompt: (sessionId: string, content: string) => void;
  dispatchPrompt: (session: SessionSnapshot) => void;
  getSession: (sessionId: string) => SessionSnapshot | null;
  trackTaskSession: (params: {
    sessionId: string;
    taskId: number;
    teamSlug: string;
    taskUrl: string;
    mgBaseUrl: string;
  }) => void;
  mgBaseUrl: string;
  workingDirectory: string;
}

// ============================================================
// Helpers
// ============================================================

async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const hash = new Bun.CryptoHasher("sha256").update(data).digest("hex");
  return hash;
}

// ============================================================
// Main
// ============================================================

export function createTaskExecutor(deps: TaskExecutorDeps): (task: TaskAssignment) => Promise<void> {
  return async (task: TaskAssignment) => {
    const { mgBaseUrl, signNip98 } = deps;

    console.log(`[task-executor] Processing task assignment: "${task.title}" (task ${task.taskId})`);

    // 1. Fetch full task details from MG API
    let fullDescription = task.description;
    try {
      const taskApiUrl = `${mgBaseUrl}/t/${task.teamSlug}/api/todos/${task.taskId}`;
      const authHeader = await signNip98(taskApiUrl, "GET");
      const resp = await fetch(taskApiUrl, {
        headers: { Authorization: authHeader },
      });
      if (resp.ok) {
        const data = await resp.json() as { todo?: { description?: string; title?: string } };
        if (data.todo?.description) {
          fullDescription = data.todo.description;
        }
        console.log(`[task-executor] Fetched task details from MG API`);
      } else {
        console.warn(`[task-executor] Failed to fetch task details: ${resp.status} ${resp.statusText}`);
      }
    } catch (err) {
      console.warn("[task-executor] Could not fetch task details from MG API:", err);
    }

    // 2. Move task to in_progress
    try {
      const stateUrl = `${mgBaseUrl}/t/${task.teamSlug}/api/todos/${task.taskId}/state`;
      const body = JSON.stringify({ state: "in_progress" });
      const bodyHash = await sha256Hex(body);
      const authHeader = await signNip98(stateUrl, "POST", bodyHash);
      const resp = await fetch(stateUrl, {
        method: "POST",
        headers: {
          Authorization: authHeader,
          "Content-Type": "application/json",
        },
        body,
      });
      if (resp.ok) {
        console.log(`[task-executor] Moved task ${task.taskId} to in_progress`);
      } else {
        console.warn(`[task-executor] Failed to move task to in_progress: ${resp.status}`);
      }
    } catch (err) {
      console.warn("[task-executor] Failed to move task to in_progress:", err);
    }

    // 3. Create agent session
    const origin: SessionOrigin = {
      type: "mg-task",
      id: String(task.taskId),
      url: task.taskUrl,
      label: task.title,
    };

    const workDir = task.workingDirectory || deps.workingDirectory;

    const session = await deps.createSession(
      "claude",
      workDir,
      `Task: ${task.title.slice(0, 60)}`,
      origin,
    );

    console.log(`[task-executor] Created session ${session.id} for task ${task.taskId}`);

    // 4. Send initial prompt
    const prompt = [
      `Implement the following task:`,
      ``,
      `Title: ${task.title}`,
      `Description: ${fullDescription}`,
      `Task URL: ${task.taskUrl}`,
      ``,
      `Read the CLAUDE.md for project conventions. Implement the task and commit when done.`,
    ].join("\n");

    deps.addPrompt(session.id, prompt);

    // Dispatch the prompt to the session
    const currentSession = deps.getSession(session.id);
    if (currentSession) {
      deps.dispatchPrompt(currentSession);
    }

    // 5. Enable Night Watchman
    deps.enableNightwatch(session.id);

    // 6. Track task↔session link
    deps.trackTaskSession({
      sessionId: session.id,
      taskId: task.taskId,
      teamSlug: task.teamSlug,
      taskUrl: task.taskUrl,
      mgBaseUrl,
    });

    console.log(`[task-executor] Task ${task.taskId} fully set up: session=${session.id}, nightwatch enabled`);
  };
}
