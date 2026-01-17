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

/**
 * Detect which port a process is listening on using `ss`.
 * Returns the first TCP listening port found for the given PID, or null if none.
 */
export async function getListeningPortForPid(pid: number): Promise<number | null> {
  try {
    const proc = Bun.spawn(["ss", "-tlnp"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const output = await new Response(proc.stdout).text();
    await proc.exited;

    // Parse ss output to find ports for this PID
    // Format: LISTEN 0 128 127.0.0.1:45063 0.0.0.0:* users:(("node",pid=2739695,fd=19))
    const pidPattern = new RegExp(`pid=${pid}\\b`);
    for (const line of output.split("\n")) {
      if (!pidPattern.test(line)) {
        continue;
      }
      // Extract port from local address (4th column)
      // Matches patterns like "127.0.0.1:45063" or "*:3000" or "[::]:3000"
      const match = line.match(/\s+[\w.:*\[\]]+:(\d+)\s+/);
      if (match && match[1]) {
        const port = parseInt(match[1], 10);
        if (Number.isFinite(port) && port > 0) {
          return port;
        }
      }
    }
    return null;
  } catch (error) {
    console.warn(`[port-utils] failed to detect port for PID ${pid}:`, error);
    return null;
  }
}

/**
 * Poll for a listening port for a PID with retries.
 * Useful after starting an app that may take time to bind to a port.
 */
export async function waitForListeningPort(
  pid: number,
  options: { maxAttempts?: number; delayMs?: number } = {},
): Promise<number | null> {
  const { maxAttempts = 5, delayMs = 500 } = options;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const port = await getListeningPortForPid(pid);
    if (port !== null) {
      return port;
    }
    if (attempt < maxAttempts) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  return null;
}
