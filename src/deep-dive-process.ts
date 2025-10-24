import { spawn, type Subprocess } from "bun";

type DeepDiveProcessState = {
  process: Subprocess;
  port: number;
};

let desiredPort: number | null = null;
let deepDiveState: DeepDiveProcessState | null = null;
let cleanupRegistered = false;

const sanitizePort = (value: string | undefined, fallback: number): number => {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed >= 65535) {
    return fallback;
  }
  return parsed;
};

const pickDeepDivePort = (basePort: number): number => {
  const fallback = basePort + 1;
  return sanitizePort(Bun.env.DEEP_DIVE_PORT, fallback);
};

const registerCleanup = () => {
  if (cleanupRegistered) return;
  cleanupRegistered = true;

  const shutdown = () => {
    if (!deepDiveState) return;
    try {
      deepDiveState.process.kill();
    } catch {
      // ignore
    } finally {
      deepDiveState = null;
    }
  };

  for (const signal of ["SIGINT", "SIGTERM", "SIGQUIT"] as const) {
    process.on(signal, shutdown);
  }

  process.on("exit", shutdown);
};

export const ensureDeepDiveProcess = (basePort: number) => {
  if (deepDiveState) {
    return deepDiveState.port;
  }

  const port = desiredPort ?? pickDeepDivePort(basePort);
  desiredPort = port;

  const scriptUrl = new URL("../scripts/deep-dive-terminal-server.js", import.meta.url);

  try {
    const processEnv = {
      ...process.env,
      PORT: String(port),
      DEEP_DIVE_PORT: String(port),
    };

    const subprocess = spawn(["node", scriptUrl.pathname], {
      stdin: "ignore",
      stdout: "inherit",
      stderr: "inherit",
      env: processEnv,
    });

    deepDiveState = {
      process: subprocess,
      port,
    };

    subprocess.exited.then((exitCode) => {
      const code = exitCode ?? -1;
      console.error(`[deep-dive] terminal server exited with code ${code}`);
      deepDiveState = null;
    });

    registerCleanup();
  } catch (error) {
    console.error("[deep-dive] failed to spawn terminal server", error);
    deepDiveState = null;
  }

  return desiredPort;
};

export const getDeepDivePort = () => {
  if (deepDiveState) {
    return deepDiveState.port;
  }
  return desiredPort;
};

export const isDeepDiveProcessRunning = () => deepDiveState !== null;
