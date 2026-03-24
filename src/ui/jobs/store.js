/**
 * Autopilot Jobs Alpine Store
 *
 * Registers Alpine.store("autopilotJobs") for managing job definitions and runs.
 * Follows the same pattern as scheduler/store.js.
 */

import Alpine from "/vendor/alpinejs/module.esm.js";
import {
  fetchJobDefinitions,
  createJobDefinition,
  updateJobDefinition,
  deleteJobDefinition,
  fetchJobRuns,
  stopJobRun,
} from "./api.js";

/**
 * Initialize the Autopilot Jobs Alpine store.
 * Call once during app bootstrap (before Alpine.start).
 */
export function initJobsStore({ showToast }) {
  Alpine.store("autopilotJobs", {
    // ----- State -----
    definitions: [],
    runs: [],
    loading: false,
    initialized: false,
    runsLoading: false,

    // ----- Lifecycle -----

    async init() {
      if (this.initialized) return;
      this.loading = true;
      try {
        await this.syncDefinitions();
        this.initialized = true;
      } catch (err) {
        console.error("[jobs-store] init failed:", err);
      }
      this.loading = false;
    },

    // ----- Server sync -----

    async syncDefinitions() {
      try {
        const data = await fetchJobDefinitions();
        this.definitions = data.jobs || [];
      } catch (err) {
        console.warn("[jobs-store] sync definitions failed:", err);
      }
    },

    async syncRuns(jobId, status) {
      this.runsLoading = true;
      try {
        const data = await fetchJobRuns(jobId, status);
        this.runs = data.runs || [];
      } catch (err) {
        console.warn("[jobs-store] sync runs failed:", err);
      }
      this.runsLoading = false;
    },

    // ----- Definition Actions -----

    async create(data) {
      try {
        const result = await createJobDefinition(data);
        if (result.job) {
          this.definitions = [result.job, ...this.definitions];
        }
        showToast("Job created");
        return result.job;
      } catch (err) {
        showToast(`Failed to create job: ${err.message}`, { type: "error" });
        throw err;
      }
    },

    async update(id, data) {
      try {
        const result = await updateJobDefinition(id, data);
        if (result.job) {
          this.definitions = this.definitions.map((d) =>
            d.id === id ? result.job : d,
          );
        }
        showToast("Job updated");
        return result.job;
      } catch (err) {
        showToast(`Failed to update job: ${err.message}`, { type: "error" });
        throw err;
      }
    },

    async remove(id) {
      try {
        await deleteJobDefinition(id);
        this.definitions = this.definitions.filter((d) => d.id !== id);
        showToast("Job deleted");
      } catch (err) {
        showToast(`Failed to delete job: ${err.message}`, { type: "error" });
      }
    },

    async toggleEnabled(id, enabled) {
      return this.update(id, { enabled });
    },

    // ----- Run Actions -----

    async stop(runId) {
      try {
        const result = await stopJobRun(runId);
        if (result.run) {
          this.runs = this.runs.map((r) =>
            r.id === runId ? result.run : r,
          );
        }
        showToast("Run stopped");
        return result.run;
      } catch (err) {
        showToast(`Failed to stop run: ${err.message}`, { type: "error" });
        throw err;
      }
    },

    // ----- Helpers -----

    formatTime(iso) {
      if (!iso) return "--";
      try {
        return new Date(iso).toLocaleString(undefined, {
          month: "short",
          day: "numeric",
          hour: "2-digit",
          minute: "2-digit",
        });
      } catch {
        return iso;
      }
    },

    formatDuration(created, updated) {
      if (!created || !updated) return "--";
      try {
        const ms = new Date(updated).getTime() - new Date(created).getTime();
        if (ms < 0) return "--";
        const secs = Math.floor(ms / 1000);
        if (secs < 60) return `${secs}s`;
        const mins = Math.floor(secs / 60);
        const remSecs = secs % 60;
        if (mins < 60) return `${mins}m ${remSecs}s`;
        const hrs = Math.floor(mins / 60);
        const remMins = mins % 60;
        return `${hrs}h ${remMins}m`;
      } catch {
        return "--";
      }
    },
  });
}

export { Alpine };
