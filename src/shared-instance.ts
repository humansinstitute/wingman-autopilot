type EnvLike = Record<string, string | undefined>;

const TRUE_VALUES = new Set(['1', 'true', 'yes', 'on']);

export function isSharedInstanceAccessEnabled(env: EnvLike = Bun.env): boolean {
  const value = env.WINGMAN_SHARED_INSTANCE?.trim().toLowerCase() ?? '';
  return TRUE_VALUES.has(value);
}
