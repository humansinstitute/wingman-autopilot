import { createHash } from "node:crypto";
import { chmod, mkdir, stat, writeFile, readFile } from "node:fs/promises";
import { dirname, join, normalize, relative } from "node:path";
import { arch, platform } from "node:os";

type DownloadEntry = {
  decscription: string;
  link: string;
  sha256: string;
};

export type EnsureAgentApiBinaryOptions = {
  agentApiBinaryPath: string;
  projectRootDirectory: string;
  downloadsJsonPath?: string;
};

export const ensureAgentApiBinary = async ({
  agentApiBinaryPath,
  projectRootDirectory,
  downloadsJsonPath: downloadsJsonOverride,
}: EnsureAgentApiBinaryOptions) => {
  let binaryExists = false;
  try {
    const binaryStats = await stat(agentApiBinaryPath);
    binaryExists = binaryStats.isFile();
    if (!binaryExists) {
      console.warn(
        `[agentapi] Expected file at ${relative(projectRootDirectory, agentApiBinaryPath)} but found different type.`,
      );
    }
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError?.code && nodeError.code !== "ENOENT") {
      console.warn(`[agentapi] Failed to read existing binary: ${nodeError.message}`);
    }
  }

  if (binaryExists) {
    return;
  }

  const currentPlatform = platform();
  const currentArch = arch();

  console.log(`[agentapi] Detected platform: ${currentPlatform}, architecture: ${currentArch}`);

  let platformKey: string;
  if (currentPlatform === "darwin") {
    platformKey = currentArch === "arm64" ? "Apple ARM" : "Apple Intel";
  } else if (currentPlatform === "linux") {
    platformKey = currentArch === "arm64" ? "Liunx ARM" : "Linux Intel";
  } else {
    throw new Error(`[agentapi] Unsupported platform: ${currentPlatform}. Only macOS and Linux are supported.`);
  }

  console.log(`[agentapi] Selecting download for: ${platformKey}`);

  const downloadsJsonPath = normalize(
    downloadsJsonOverride ?? join(projectRootDirectory, "downloads.json"),
  );
  let downloadsData: DownloadEntry[];
  try {
    const downloadsContent = await readFile(downloadsJsonPath, "utf8");
    downloadsData = JSON.parse(downloadsContent);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`[agentapi] Failed to read ${relative(projectRootDirectory, downloadsJsonPath)}: ${message}`);
  }

  const downloadEntry = downloadsData.find((entry) => entry.decscription === platformKey);
  if (!downloadEntry) {
    throw new Error(`[agentapi] No download found for ${platformKey} in downloads.json`);
  }

  console.log(`[agentapi] Downloading from: ${downloadEntry.link}`);

  const response = await fetch(downloadEntry.link);
  if (!response.ok) {
    throw new Error(`[agentapi] Download failed with status ${response.status} ${response.statusText}`);
  }

  const data = await response.arrayBuffer();

  const hash = createHash("sha256");
  hash.update(new Uint8Array(data));
  const computedHash = "sha256:" + hash.digest("hex");

  if (computedHash !== downloadEntry.sha256) {
    throw new Error(
      `[agentapi] SHA256 verification failed. Expected: ${downloadEntry.sha256}, Got: ${computedHash}`,
    );
  }

  console.log(`[agentapi] SHA256 verification passed`);

  await mkdir(dirname(agentApiBinaryPath), { recursive: true });
  await writeFile(agentApiBinaryPath, data);
  await chmod(agentApiBinaryPath, 0o755);

  console.log(
    `[agentapi] Successfully downloaded and installed agentapi binary to ${relative(projectRootDirectory, agentApiBinaryPath)}`,
  );
};
