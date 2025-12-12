import { createHash } from "node:crypto";
import { chmod, mkdir, stat, writeFile, readFile, unlink } from "node:fs/promises";
import { dirname, join, normalize, relative } from "node:path";
import { arch, platform } from "node:os";

type PlatformDownload = {
  link: string;
  sha256: string;
};

type Release = {
  version: string;
  date: string;
  platforms: Record<string, PlatformDownload>;
};

type DownloadsConfig = {
  releases: Release[];
};

// Legacy format support for backwards compatibility
type LegacyDownloadEntry = {
  decscription?: string;
  description?: string;
  link: string;
  sha256: string;
};

export type EnsureAgentApiBinaryOptions = {
  agentApiBinaryPath: string;
  projectRootDirectory: string;
  downloadsJsonPath?: string;
};

const getVersionFilePath = (binaryPath: string): string => {
  return `${binaryPath}.version`;
};

const readInstalledVersion = async (binaryPath: string): Promise<string | null> => {
  const versionFile = getVersionFilePath(binaryPath);
  try {
    const content = await readFile(versionFile, "utf8");
    return content.trim();
  } catch {
    return null;
  }
};

const writeInstalledVersion = async (binaryPath: string, version: string): Promise<void> => {
  const versionFile = getVersionFilePath(binaryPath);
  await writeFile(versionFile, version, "utf8");
};

const getPlatformKey = (): string => {
  const currentPlatform = platform();
  const currentArch = arch();

  if (currentPlatform === "darwin") {
    return currentArch === "arm64" ? "Apple ARM" : "Apple Intel";
  } else if (currentPlatform === "linux") {
    return currentArch === "arm64" ? "Linux ARM" : "Linux Intel";
  }
  throw new Error(`[agentapi] Unsupported platform: ${currentPlatform}. Only macOS and Linux are supported.`);
};

const downloadAndInstall = async (
  binaryPath: string,
  download: PlatformDownload,
  projectRoot: string,
): Promise<void> => {
  console.log(`[agentapi] Downloading from: ${download.link}`);

  const response = await fetch(download.link);
  if (!response.ok) {
    throw new Error(`[agentapi] Download failed with status ${response.status} ${response.statusText}`);
  }

  const data = await response.arrayBuffer();

  const hash = createHash("sha256");
  hash.update(new Uint8Array(data));
  const computedHash = "sha256:" + hash.digest("hex");

  if (computedHash !== download.sha256) {
    throw new Error(
      `[agentapi] SHA256 verification failed. Expected: ${download.sha256}, Got: ${computedHash}`,
    );
  }

  console.log(`[agentapi] SHA256 verification passed`);

  await mkdir(dirname(binaryPath), { recursive: true });

  // Remove old binary if it exists
  try {
    await unlink(binaryPath);
  } catch {
    // Ignore if file doesn't exist
  }

  await writeFile(binaryPath, data);
  await chmod(binaryPath, 0o755);

  console.log(
    `[agentapi] Successfully downloaded and installed agentapi binary to ${relative(projectRoot, binaryPath)}`,
  );
};

const parseDownloadsConfig = (content: string): { release: Release; platformKey: string } => {
  const parsed = JSON.parse(content);
  const platformKey = getPlatformKey();

  // Check for new format
  if (parsed.releases && Array.isArray(parsed.releases)) {
    const config = parsed as DownloadsConfig;
    if (config.releases.length === 0) {
      throw new Error("[agentapi] No releases found in downloads.json");
    }
    // First release in array is the latest
    const latestRelease = config.releases[0];
    return { release: latestRelease, platformKey };
  }

  // Legacy format: array of entries with decscription/description field
  if (Array.isArray(parsed)) {
    const legacyEntries = parsed as LegacyDownloadEntry[];
    const entry = legacyEntries.find(
      (e) => e.decscription === platformKey || e.description === platformKey,
    );
    if (!entry) {
      throw new Error(`[agentapi] No download found for ${platformKey} in downloads.json (legacy format)`);
    }
    // Convert to new format
    const release: Release = {
      version: "legacy",
      date: "unknown",
      platforms: {
        [platformKey]: {
          link: entry.link,
          sha256: entry.sha256,
        },
      },
    };
    return { release, platformKey };
  }

  throw new Error("[agentapi] Invalid downloads.json format");
};

export const ensureAgentApiBinary = async ({
  agentApiBinaryPath,
  projectRootDirectory,
  downloadsJsonPath: downloadsJsonOverride,
}: EnsureAgentApiBinaryOptions) => {
  const currentPlatform = platform();
  const currentArch = arch();
  console.log(`[agentapi] Detected platform: ${currentPlatform}, architecture: ${currentArch}`);

  const downloadsJsonPath = normalize(
    downloadsJsonOverride ?? join(projectRootDirectory, "downloads.json"),
  );

  let downloadsContent: string;
  try {
    downloadsContent = await readFile(downloadsJsonPath, "utf8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`[agentapi] Failed to read ${relative(projectRootDirectory, downloadsJsonPath)}: ${message}`);
  }

  const { release, platformKey } = parseDownloadsConfig(downloadsContent);
  console.log(`[agentapi] Latest available version: ${release.version} (${release.date})`);
  console.log(`[agentapi] Selecting download for: ${platformKey}`);

  const platformDownload = release.platforms[platformKey];
  if (!platformDownload) {
    throw new Error(`[agentapi] No download found for ${platformKey} in version ${release.version}`);
  }

  // Check if binary exists
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

  // Check installed version
  const installedVersion = await readInstalledVersion(agentApiBinaryPath);

  if (binaryExists && installedVersion) {
    if (installedVersion === release.version) {
      console.log(`[agentapi] Already running latest version: ${installedVersion}`);
      return;
    }
    console.log(`[agentapi] Upgrade available: ${installedVersion} -> ${release.version}`);
  } else if (binaryExists && !installedVersion) {
    // Binary exists but no version file - could be legacy install
    // We'll upgrade to ensure we have the tracked version
    console.log(`[agentapi] Existing binary found without version tracking, upgrading to ${release.version}`);
  } else {
    console.log(`[agentapi] Binary not found, installing version ${release.version}`);
  }

  await downloadAndInstall(agentApiBinaryPath, platformDownload, projectRootDirectory);
  await writeInstalledVersion(agentApiBinaryPath, release.version);

  console.log(`[agentapi] Version ${release.version} installed successfully`);
};
