/**
 * Port availability checking utilities.
 */

/**
 * Check if a port is available by attempting to bind to it.
 * Returns true if the port is free, false if it's in use.
 */
export function isPortAvailable(port: number): boolean {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let server: any = null;
  try {
    server = Bun.listen({
      hostname: "127.0.0.1",
      port,
      socket: {
        data() {},
        close() {},
        open() {},
      },
    });
    return true;
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError?.code !== "EADDRINUSE") {
      console.warn(`[port-utils] failed to probe port ${port}: ${nodeError?.message ?? error}`);
    }
    return false;
  } finally {
    server?.stop(true);
  }
}

/**
 * Find the first available port from a list of candidates.
 * Checks both the provided exclusion set and actual system availability.
 * Returns undefined if no port is available.
 */
export function findAvailablePort(
  candidates: number[],
  exclude: Set<number> = new Set(),
): number | undefined {
  for (const port of candidates) {
    if (exclude.has(port)) {
      continue;
    }
    if (isPortAvailable(port)) {
      return port;
    }
  }
  return undefined;
}
