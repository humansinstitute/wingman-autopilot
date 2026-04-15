import { AGENT_TYPES, DEFAULT_AGENT_TYPE, type AgentType } from "../agent-types";

export type JobRole = "worker" | "manager";

export const JOB_AGENT_TYPES: AgentType[] = [...AGENT_TYPES];
export const DEFAULT_JOB_AGENT: AgentType = DEFAULT_AGENT_TYPE;

type JobAgentSource = {
  worker_agent?: string | null;
  manager_agent?: string | null;
};

type JobAgentOverrides = {
  workerAgent?: string | null;
  managerAgent?: string | null;
};

export function isJobAgentType(value: string): value is AgentType {
  return JOB_AGENT_TYPES.includes(value as AgentType);
}

export function normalizeJobAgent(value: unknown): AgentType | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  if (!normalized) return null;
  return isJobAgentType(normalized) ? normalized : null;
}

export function resolveJobAgent(value: unknown, fallback: AgentType = DEFAULT_JOB_AGENT): AgentType {
  return normalizeJobAgent(value) ?? fallback;
}

export function resolveJobAgents(
  source: JobAgentSource,
  overrides: JobAgentOverrides = {},
): { workerAgent: AgentType; managerAgent: AgentType } {
  const workerAgent = resolveJobAgent(overrides.workerAgent, resolveJobAgent(source.worker_agent));
  const managerAgent = resolveJobAgent(overrides.managerAgent, resolveJobAgent(source.manager_agent));
  return { workerAgent, managerAgent };
}

export function listUniqueJobAgents(agents: { workerAgent: AgentType; managerAgent: AgentType }): AgentType[] {
  return Array.from(new Set([agents.workerAgent, agents.managerAgent]));
}

export function buildDefaultJobSessionName(
  jobId: string,
  role: JobRole,
  agent: AgentType,
  runId: string,
): string {
  return `job:${jobId}:${role}:${agent}:${runId.slice(0, 8)}`;
}
