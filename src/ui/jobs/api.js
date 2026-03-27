/**
 * Autopilot Jobs API Client
 *
 * Frontend functions for communicating with the autopilot jobs backend.
 */

// ============================================================
// Job Definitions
// ============================================================

export async function fetchJobDefinitions() {
  const res = await fetch("/api/autopilot-jobs/definitions");
  if (!res.ok) throw new Error(`Failed to fetch job definitions: ${res.status}`);
  return res.json();
}

export async function fetchJobDefinition(id) {
  const res = await fetch(`/api/autopilot-jobs/definitions/${encodeURIComponent(id)}`);
  if (!res.ok) throw new Error(`Failed to fetch job: ${res.status}`);
  return res.json();
}

export async function createJobDefinition(data) {
  const res = await fetch("/api/autopilot-jobs/definitions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `Failed to create job: ${res.status}`);
  }
  return res.json();
}

export async function updateJobDefinition(id, data) {
  const res = await fetch(`/api/autopilot-jobs/definitions/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `Failed to update job: ${res.status}`);
  }
  return res.json();
}

export async function deleteJobDefinition(id) {
  const res = await fetch(`/api/autopilot-jobs/definitions/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
  if (!res.ok && res.status !== 204) {
    throw new Error(`Failed to delete job: ${res.status}`);
  }
  return true;
}

// ============================================================
// Job Runs
// ============================================================

export async function fetchJobRuns(jobId, status) {
  const params = new URLSearchParams();
  if (jobId) params.set("job_id", jobId);
  if (status) params.set("status", status);
  const qs = params.toString();
  const res = await fetch(`/api/autopilot-jobs/runs${qs ? "?" + qs : ""}`);
  if (!res.ok) throw new Error(`Failed to fetch runs: ${res.status}`);
  return res.json();
}

export async function dispatchJobRun(data) {
  const res = await fetch("/api/autopilot-jobs/runs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `Failed to launch job: ${res.status}`);
  }
  return res.json();
}

export async function fetchJobRun(id) {
  const res = await fetch(`/api/autopilot-jobs/runs/${encodeURIComponent(id)}`);
  if (!res.ok) throw new Error(`Failed to fetch run: ${res.status}`);
  return res.json();
}

export async function stopJobRun(id) {
  const res = await fetch(`/api/autopilot-jobs/runs/${encodeURIComponent(id)}/stop`, {
    method: "POST",
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `Failed to stop run: ${res.status}`);
  }
  return res.json();
}
