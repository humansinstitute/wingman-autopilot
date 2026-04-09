import { normaliseNpub } from '../identity/npub-utils';

export function resolveTaskExecutorOwnerNpub(
  adminNpub: string | null | undefined,
  taskListenerNpub: string | null | undefined,
): string | undefined {
  return normaliseNpub(adminNpub ?? null) ?? normaliseNpub(taskListenerNpub ?? null) ?? undefined;
}
