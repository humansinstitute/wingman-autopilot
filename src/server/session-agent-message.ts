import { waitForAgentReady } from "../agents/agent-client";
import { getProcessByName, restartProcess } from "../agents/pm2-wrapper";
import type { AgentType } from "../config";

export interface SessionAgentMessageInput {
  agentHost: string;
  buildAgentUrl: (host: string, port: number, path: string) => string | URL;
  agent: AgentType;
  port: number;
  content: string;
  type: "user" | "raw";
  pm2Name?: string;
}

export interface SessionAgentMessageResult {
  ok: boolean;
  status: number;
  message: string;
}

const RECOVERABLE_STATUS_CODES = new Set([404, 408, 429, 500, 502, 503, 504]);

const parseErrorMessage = async (response: Response): Promise<string> => {
  const errorPayload = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  const payloadMessage = errorPayload && typeof errorPayload.error === "string" ? errorPayload.error : null;
  return payloadMessage ?? response.statusText ?? "Agent request failed";
};

async function postMessage(input: SessionAgentMessageInput): Promise<Response> {
  const agentUrl = input.buildAgentUrl(input.agentHost, input.port, "/message");
  return fetch(agentUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: input.type, content: input.content }),
  });
}

const shouldAttemptPm2Recovery = (statusCode: number, pm2Name?: string): boolean => {
  return Boolean(pm2Name && RECOVERABLE_STATUS_CODES.has(statusCode));
};

async function recoverPm2Session(input: SessionAgentMessageInput): Promise<boolean> {
  const pm2Name = input.pm2Name;
  if (!pm2Name) {
    return false;
  }

  const processInfo = await getProcessByName(pm2Name).catch(() => null);
  if (!processInfo) {
    return false;
  }

  const status = processInfo.pm2_env?.status;
  if (status !== "online") {
    await restartProcess(pm2Name);
  }

  await waitForAgentReady(input.agentHost, input.port, input.agent, {
    timeoutMs: 8000,
    pollIntervalMs: 250,
  });

  return true;
}

export async function deliverSessionAgentMessage(
  input: SessionAgentMessageInput,
): Promise<SessionAgentMessageResult> {
  try {
    const initialResponse = await postMessage(input);
    if (initialResponse.ok) {
      return { ok: true, status: initialResponse.status, message: "" };
    }

    const initialMessage = await parseErrorMessage(initialResponse);
    if (!shouldAttemptPm2Recovery(initialResponse.status, input.pm2Name)) {
      return { ok: false, status: initialResponse.status, message: initialMessage };
    }

    const recovered = await recoverPm2Session(input).catch(() => false);
    if (!recovered) {
      return { ok: false, status: initialResponse.status, message: initialMessage };
    }

    const retryResponse = await postMessage(input);
    if (retryResponse.ok) {
      return { ok: true, status: retryResponse.status, message: "" };
    }

    const retryMessage = await parseErrorMessage(retryResponse);
    return { ok: false, status: retryResponse.status, message: retryMessage };
  } catch (error) {
    const recovered = await recoverPm2Session(input).catch(() => false);
    if (!recovered) {
      return {
        ok: false,
        status: 502,
        message: `Failed to contact agent: ${(error as Error).message ?? "unknown error"}`,
      };
    }

    try {
      const retryResponse = await postMessage(input);
      if (retryResponse.ok) {
        return { ok: true, status: retryResponse.status, message: "" };
      }
      const retryMessage = await parseErrorMessage(retryResponse);
      return { ok: false, status: retryResponse.status, message: retryMessage };
    } catch (retryError) {
      return {
        ok: false,
        status: 502,
        message: `Failed to contact agent: ${(retryError as Error).message ?? "unknown error"}`,
      };
    }
  }
}
