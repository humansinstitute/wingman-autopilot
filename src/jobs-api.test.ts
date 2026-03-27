import { describe, expect, test } from "bun:test";

import { createAutopilotJobsApiHandler } from "./jobs-api";
import type { RequestAuthContext } from "./auth/request-context";
import type { JobDefinition, JobRun } from "./jobs-db";

const makeAuth = (overrides?: Partial<RequestAuthContext>): RequestAuthContext => ({
  npub: "npub1owner",
  actorNpub: null,
  session: { id: "browser-session" } as any,
  authMethod: "session",
  delegatedByBot: false,
  ...overrides,
});

const baseJob: JobDefinition = {
  id: "software-dev",
  name: "Software Dev",
  worker_prompt: "Implement the requested change.",
  manager_prompt: "Review the implementation.",
  manager_goal: "Keep quality high.",
  manager_dir: "/tmp/project",
  check_interval: 180,
  enabled: true,
  created_at: "2026-03-26T00:00:00.000Z",
  updated_at: "2026-03-26T00:00:00.000Z",
};

const baseRun: JobRun = {
  id: "run-1",
  job_id: "software-dev",
  goal: "Ship it",
  manager_goal: "Keep quality high.",
  worker_session_id: "worker-1",
  manager_session_id: "manager-1",
  worker_prompt: "Implement the requested change.",
  manager_context: "Review the implementation.",
  worker_dir: "/tmp/project",
  manager_dir: "/tmp/project",
  refs_json: '["task:123"]',
  status: "running",
  output_summary: null,
  created_at: "2026-03-26T00:00:00.000Z",
  updated_at: "2026-03-26T00:00:00.000Z",
};

const createStore = (job: JobDefinition = baseJob) => ({
  listJobs: () => [job],
  getJob: (id: string) => (id === job.id ? job : undefined),
  createJob: () => job,
  updateJob: () => job,
  deleteJob: () => true,
  listRuns: () => [baseRun],
  getRun: (id: string) => (id === baseRun.id ? baseRun : undefined),
  createRun: () => baseRun,
  updateRun: () => true,
  updateRunStatus: () => true,
});

describe("createAutopilotJobsApiHandler", () => {
  test("POST /api/autopilot-jobs/runs dispatches a manual job launch", async () => {
    let dispatchedPayload: Record<string, unknown> | null = null;
    const handler = createAutopilotJobsApiHandler({
      store: createStore(),
      sessionApiContext: {
        serializeSession: (session: { id: string }) => ({ id: session.id }),
      } as any,
      dispatchRun: async (input) => {
        dispatchedPayload = input as Record<string, unknown>;
        return {
          run: baseRun,
          workerSession: { id: "worker-1" } as any,
          managerSession: { id: "manager-1" } as any,
        };
      },
    });

    const url = new URL("http://localhost:3000/api/autopilot-jobs/runs");
    const request = new Request(url.toString(), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        job_id: "software-dev",
        goal: "Ship it",
        worker_goal: "Write the code",
        manager_goal: "Review the branch",
        prompt: "Focus on tests",
        refs: ["task:123", "doc:abc"],
        worker_dir: "/tmp/project",
        manager_dir: "/tmp/review",
      }),
    });

    const response = await handler(request, url, "POST", makeAuth());
    expect(response).not.toBeNull();
    expect(response!.status).toBe(201);
    expect(dispatchedPayload).toMatchObject({
      authContext: { npub: "npub1owner" },
      goal: "Ship it",
      workerGoal: "Write the code",
      managerGoal: "Review the branch",
      prompt: "Focus on tests",
      refs: ["task:123", "doc:abc"],
      workerDir: "/tmp/project",
      managerDir: "/tmp/review",
    });
    await expect(response!.json()).resolves.toEqual({
      run: baseRun,
      worker_session: { id: "worker-1" },
      manager_session: { id: "manager-1" },
    });
  });

  test("POST /api/autopilot-jobs/runs rejects disabled jobs", async () => {
    const handler = createAutopilotJobsApiHandler({
      store: createStore({ ...baseJob, enabled: false }),
    });
    const url = new URL("http://localhost:3000/api/autopilot-jobs/runs");
    const request = new Request(url.toString(), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ job_id: "software-dev" }),
    });

    const response = await handler(request, url, "POST", makeAuth());
    expect(response).not.toBeNull();
    expect(response!.status).toBe(400);
    await expect(response!.json()).resolves.toEqual({ error: "Job is disabled" });
  });

  test("GET /api/autopilot-jobs/definitions normalizes enabled flags", async () => {
    const handler = createAutopilotJobsApiHandler({
      store: createStore({ ...baseJob, enabled: 0 as unknown as boolean }),
    });
    const url = new URL("http://localhost:3000/api/autopilot-jobs/definitions");
    const request = new Request(url.toString(), { method: "GET" });

    const response = await handler(request, url, "GET", makeAuth());
    expect(response).not.toBeNull();
    expect(response!.status).toBe(200);
    await expect(response!.json()).resolves.toEqual({
      jobs: [
        {
          ...baseJob,
          enabled: false,
        },
      ],
    });
  });
});
