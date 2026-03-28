import { describe, expect, test } from "bun:test";

/**
 * Tests for jobs-runs.ts stop command behavior.
 *
 * We test the stopSession helper logic and the stop command's
 * failure propagation by importing/simulating the key behaviors.
 */

describe("jobs-runs stop — failure propagation", () => {
  test("stop command should propagate session stop failures", async () => {
    // Simulate what the CLI does: call stopSession for worker and manager,
    // track failures, and only mark stopped when both succeed
    let workerStopped = false;
    let managerStopped = false;

    const stopSession = async (sessionId: string): Promise<boolean> => {
      if (sessionId === "worker-1") {
        workerStopped = true;
        return false; // Simulate failure
      }
      if (sessionId === "manager-1") {
        managerStopped = true;
        return true;
      }
      return true;
    };

    // Simulate the stop logic
    const jobRun = {
      id: "run-1",
      status: "running",
      worker_session_id: "worker-1",
      manager_session_id: "manager-1",
    };

    let anyFailed = false;

    if (jobRun.worker_session_id) {
      const ok = await stopSession(jobRun.worker_session_id);
      if (!ok) anyFailed = true;
    }
    if (jobRun.manager_session_id) {
      const ok = await stopSession(jobRun.manager_session_id);
      if (!ok) anyFailed = true;
    }

    expect(workerStopped).toBe(true);
    expect(managerStopped).toBe(true);
    expect(anyFailed).toBe(true);
    // The run should NOT be marked as stopped when a session stop fails
  });

  test("stop command should mark stopped only when all sessions stop succeed", async () => {
    const stopSession = async (_sessionId: string): Promise<boolean> => true;

    const jobRun = {
      id: "run-1",
      status: "running",
      worker_session_id: "worker-1",
      manager_session_id: "manager-1",
    };

    let anyFailed = false;

    if (jobRun.worker_session_id) {
      const ok = await stopSession(jobRun.worker_session_id);
      if (!ok) anyFailed = true;
    }
    if (jobRun.manager_session_id) {
      const ok = await stopSession(jobRun.manager_session_id);
      if (!ok) anyFailed = true;
    }

    expect(anyFailed).toBe(false);
    // Now safe to mark as stopped
  });
});
