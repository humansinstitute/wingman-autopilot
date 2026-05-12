export async function syncAuthenticatedStartupStores({ Alpine = globalThis.Alpine } = {}) {
  if (!Alpine || typeof Alpine.store !== "function") return;

  const scheduler = Alpine.store("scheduler");
  const jobs = Alpine.store("autopilotJobs");
  const syncs = [];

  if (scheduler && typeof scheduler.sync === "function") {
    syncs.push(
      scheduler.sync().catch((error) => {
        console.warn("[scheduler-store] authenticated startup sync failed:", error);
      }),
    );
  }

  if (jobs && typeof jobs.syncDefinitions === "function") {
    syncs.push(
      jobs.syncDefinitions().catch((error) => {
        console.warn("[jobs-store] authenticated startup sync failed:", error);
      }),
    );
  }

  await Promise.all(syncs);
}
