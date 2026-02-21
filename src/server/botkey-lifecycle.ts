import type { SchedulerStore } from "../scheduler/scheduler-store";

export function shouldKeepBotKeyForNostrTriggers(
  schedulerStore: SchedulerStore,
  userNpub: string,
): boolean {
  return schedulerStore
    .listEnabledJobs()
    .some((job) => job.userNpub === userNpub && job.triggerType === "nostr");
}
