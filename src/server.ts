import { randomUUID } from "node:crypto";
import { cp, mkdir, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, normalize, relative, resolve as resolvePath, sep } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

import type { AgentType } from "./config";
import { loadConfig } from "./config";
import { ProcessManager } from "./agents/process-manager";
import type { SessionSnapshot } from "./agents/process-manager";
import { messageStore } from "./storage/message-store";
import type { ReplaceMessageInput } from "./storage/message-store";
import { orchestratorPresetStore } from "./storage/orchestrator-presets";
import type { OrchestratorPresetRecord } from "./storage/orchestrator-presets";

const TMUX_SESSION_NAME = "wingman-agents";

const readStreamToString = async (stream: ReadableStream<Uint8Array> | null | undefined) => {
  if (!stream) return "";
  return new Response(stream).text();
};

const runTmuxCommand = async (args: string[]) => {
  const subprocess = Bun.spawn(["tmux", ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stdout, stderr, exited] = await Promise.all([
    readStreamToString(subprocess.stdout),
    readStreamToString(subprocess.stderr),
    subprocess.exited,
  ]);

  return {
    exitCode: exited ?? 0,
    stdout: stdout.trim(),
    stderr: stderr.trim(),
  };
};

const ensureWingmanAgentsSessionClean = async () => {
  try {
    const hasSession = await runTmuxCommand(["has-session", "-t", TMUX_SESSION_NAME]);
    if (hasSession.exitCode === 1) {
      return;
    }

    if (hasSession.exitCode !== 0) {
      if (hasSession.stderr) {
        console.warn(`[tmux] failed to check ${TMUX_SESSION_NAME} session: ${hasSession.stderr}`);
      }
      return;
    }

    const listWindows = await runTmuxCommand(["list-windows", "-t", TMUX_SESSION_NAME, "-F", "#{window_id}"]);
    if (listWindows.exitCode !== 0) {
      if (listWindows.stderr) {
        console.warn(`[tmux] failed to list ${TMUX_SESSION_NAME} windows: ${listWindows.stderr}`);
      }
      return;
    }

    const windowIds = listWindows.stdout
      .split(/\r?\n/)
      .map((id) => id.trim())
      .filter((id) => id.length > 0);

    if (windowIds.length === 0) {
      return;
    }

    let closed = 0;
    for (const windowId of windowIds) {
      const killWindow = await runTmuxCommand(["kill-window", "-t", windowId]);
      if (killWindow.exitCode === 0) {
        closed += 1;
        continue;
      }
      if (killWindow.stderr) {
        console.warn(`[tmux] failed to close window ${windowId}: ${killWindow.stderr}`);
      } else {
        console.warn(`[tmux] failed to close window ${windowId}`);
      }
    }

    if (closed > 0) {
      console.log(
        `[tmux] closed ${closed} existing ${TMUX_SESSION_NAME} window${closed === 1 ? "" : "s"} before startup`,
      );
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[tmux] skipping ${TMUX_SESSION_NAME} cleanup: ${message}`);
  }
};

const config = loadConfig();
await ensureWingmanAgentsSessionClean();
const manager = new ProcessManager(config);

const srcRoot = fileURLToPath(new URL(".", import.meta.url));
const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const tmpRoot = normalize(join(srcRoot, "../tmp"));
const imageRoot = join(tmpRoot, "images");
const determineHomeDirectory = (): string => {
  const fromEnv = Bun.env.HOME?.trim();
  if (fromEnv) {
    return fromEnv;
  }
  try {
    return homedir();
  } catch {
    return projectRoot;
  }
};

const rawHomeDirectory = determineHomeDirectory();
const homeDirectory = normalize(await realpath(rawHomeDirectory).catch(() => rawHomeDirectory));
const documentsDirectory = join(homeDirectory, "Documents");
const userDataRoot = join(documentsDirectory, "Wingman");
const docsRoot = homeDirectory;
const docsRootBoundary = docsRoot.endsWith(sep) ? docsRoot : `${docsRoot}${sep}`;
const nodeModulesRoot = normalize(join(projectRoot, "node_modules"));
const aceBuildsRoot = normalize(join(nodeModulesRoot, "ace-builds"));
const aceBuildsRootBoundary = aceBuildsRoot.endsWith(sep) ? aceBuildsRoot : `${aceBuildsRoot}${sep}`;
await mkdir(documentsDirectory, { recursive: true }).catch(() => undefined);
await mkdir(userDataRoot, { recursive: true }).catch(() => undefined);
const orchestratorRoot = join(projectRoot, "orchestrator");
const orchestratorTemplatesRoot = join(orchestratorRoot, "templates");
const orchestratorActiveRootBase = join(userDataRoot, "orchestrator", "active");
const maxImageSizeBytes = 10 * 1024 * 1024; // 10MB
const imageTtlMs = 24 * 60 * 60 * 1000;
const imageCleanupIntervalMs = 24 * 60 * 60 * 1000;

const ensureImageDirectory = async (agent: AgentType) => {
  await mkdir(imageRoot, { recursive: true });
  const directory = join(imageRoot, agent);
  await mkdir(directory, { recursive: true });
  return directory;
};

const defaultSecurityReviewIntro =
  "Pleaese review the 01_process.md for your instructions.\n\nYou will read the process instructions in: <active_dir>\nThe sessionID you are operating in is: <sessionID>";

const defaultHighlightReportIntro =
  "Pleaese review the 01_process.md for your instructions.\n\nYou will read the process instructions in: <active_dir>\nThe sessionID you are operating in is: <sessionID>";

orchestratorPresetStore.ensurePreset({
  id: "security-review",
  label: "Security Review",
  agent: "codex",
  templateDir: "orchestrator/templates/0001_Review_Code",
  activeRoot: orchestratorActiveRootBase,
  directoryPrefix: "Security_Review",
  introMessage: defaultSecurityReviewIntro,
  pollTimeoutMs: 30000,
  pollIntervalMs: 250,
  retryAttempts: 10,
  retryDelayMs: 1000,
});

orchestratorPresetStore.ensurePreset({
  id: "highlight-report",
  label: "Highlight Report",
  agent: "codex",
  templateDir: "orchestrator/templates/0002_Highglight_Report",
  activeRoot: orchestratorActiveRootBase,
  directoryPrefix: "Highlight_Report",
  introMessage: defaultHighlightReportIntro,
  pollTimeoutMs: 60000,
  pollIntervalMs: 250,
  retryAttempts: 10,
  retryDelayMs: 1000,
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const createImageFilename = (name: string, mime: string): string => {
  const originalExt = extname(name) || "";
  if (originalExt) {
    return `${randomUUID()}${originalExt.toLowerCase()}`;
  }
  const inferred = (() => {
    if (!mime) return ".bin";
    const subtype = mime.split("/")[1];
    if (!subtype) return ".bin";
    if (subtype === "jpeg") return ".jpg";
    if (/^[a-z0-9]+$/i.test(subtype)) {
      return `.${subtype.toLowerCase()}`;
    }
    return ".bin";
  })();
  return `${randomUUID()}${inferred}`;
};

const buildAgentImagePlaceholder = (agent: AgentType, absolutePath: string, publicPath: string) => {
  const fileUrl = pathToFileURL(absolutePath).toString();
  switch (agent) {
    case "codex":
    case "claude":
      return `![uploaded image](${fileUrl})`;
    case "goose":
      return `![uploaded image](${publicPath})`;
    default:
      return publicPath;
  }
};

const resolveTempImage = (pathname: string) => {
  if (!pathname.startsWith("/uploads/images/")) return undefined;
  const relative = pathname.replace("/uploads/images/", "");
  if (!relative) return undefined;
  const normalized = normalize(relative);
  const fullPath = join(imageRoot, normalized);
  if (!fullPath.startsWith(imageRoot)) {
    return undefined;
  }
  const file = Bun.file(fullPath);
  if (file.size === 0) return undefined;
  return new Response(file, {
    headers: {
      ...(file.type ? { "content-type": file.type } : {}),
      "cache-control": "no-store",
    },
  });
};

const runImageCleanup = async () => {
  let directories: Awaited<ReturnType<typeof readdir>>;
  try {
    directories = await readdir(imageRoot, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }
    console.error("[uploads] failed to list image directory", error);
    return;
  }

  const threshold = Date.now() - imageTtlMs;

  await Promise.all(
    directories
      .filter((entry) => entry.isDirectory())
      .map(async (dir) => {
        const dirPath = join(imageRoot, dir.name);
        let files: Awaited<ReturnType<typeof readdir>>;
        try {
          files = await readdir(dirPath, { withFileTypes: true });
        } catch (error) {
          console.error(`[uploads] failed to list directory ${dir.name}`, error);
          return;
        }

        await Promise.all(
          files
            .filter((entry) => entry.isFile())
            .map(async (file) => {
              const filePath = join(dirPath, file.name);
              try {
                const stats = await stat(filePath);
                if (stats.mtimeMs < threshold) {
                  await rm(filePath, { force: true });
                  console.log(`[uploads] removed expired image ${filePath}`);
                }
              } catch (error) {
                console.error(`[uploads] failed to cleanup ${filePath}`, error);
              }
            }),
        );
      }),
  );
};

const scheduleImageCleanup = () => {
  // Fire-and-forget; best-effort cleanup
  runImageCleanup().catch((error) => console.error("[uploads] initial cleanup failed", error));
  setInterval(() => {
    runImageCleanup().catch((error) => console.error("[uploads] scheduled cleanup failed", error));
  }, imageCleanupIntervalMs).unref?.();
};

scheduleImageCleanup();

manager.on((event) => {
  if (event.type === "session-started") {
    messageStore.recordSession(event.session.id, event.session.agent, event.session.startedAt, event.session.name);
    messageStore.replaceMessages(event.session.id, []);
  }
});

const MAX_DIRECTORY_RESULTS = 50;

const expandHomeDirectory = (input: string): string => {
  if (!input.startsWith("~")) {
    return input;
  }
  const home = Bun.env.HOME ?? "";
  return home ? input.replace("~", home) : input;
};

const toAbsoluteDirectory = (input: string): string => {
  const expanded = expandHomeDirectory(input);
  const candidate = isAbsolute(expanded)
    ? expanded
    : resolvePath(config.defaultWorkingDirectory, expanded);
  return normalize(candidate);
};

const ensureDirectory = async (input: string | null | undefined): Promise<string> => {
  const source = input?.trim();
  const candidate = source && source.length > 0 ? source : config.defaultWorkingDirectory;
  const absolute = toAbsoluteDirectory(candidate);
  let resolved = absolute;

  try {
    resolved = await realpath(absolute);
  } catch {
    // realpath fails when the directory does not exist; keep the normalized path.
    resolved = absolute;
  }

  let stats: Awaited<ReturnType<typeof stat>>;
  try {
    stats = await stat(resolved);
  } catch {
    throw new Error(`Directory not found: ${resolved}`);
  }

  if (!stats.isDirectory()) {
    throw new Error(`Path is not a directory: ${resolved}`);
  }

  return resolved;
};

const isWithinDocsRoot = (target: string): boolean => {
  if (!target) return false;
  const normalized = normalize(target);
  return normalized === docsRoot || normalized.startsWith(docsRootBoundary);
};

const toDocsRelativePath = (target: string): string => {
  if (!target) return "";
  if (!isWithinDocsRoot(target)) {
    return "";
  }
  const relativePath = relative(docsRoot, target);
  return relativePath && relativePath.length > 0 ? relativePath : "";
};

const toDocsDisplayPath = (target: string): string => {
  const relativePath = toDocsRelativePath(target);
  return relativePath ? `~/${relativePath}` : "~";
};

const resolveDocsPath = (input: string | null | undefined): string => {
  const value = input?.trim();
  const candidate = value && value.length > 0 ? value : docsRoot;
  const absolute = isAbsolute(candidate) ? candidate : join(docsRoot, candidate);
  const normalized = normalize(absolute);
  if (!isWithinDocsRoot(normalized)) {
    throw new Error("Access outside the home directory is not permitted");
  }
  return normalized;
};

const MARKDOWN_EXTENSIONS = new Set([".md", ".markdown"]);
const MAX_DOCS_ENTRIES = 500;
const MAX_DOCS_FILE_SIZE = 2 * 1024 * 1024; // 2MB

interface DocsPreviewType {
  format: "markdown" | "code";
  language: string;
  label: string;
}

const TEXT_PREVIEW_TYPES = new Map<string, DocsPreviewType>([
  [".md", { format: "markdown", language: "markdown", label: "Markdown" }],
  [".markdown", { format: "markdown", language: "markdown", label: "Markdown" }],
  [".mdx", { format: "markdown", language: "markdown", label: "Markdown" }],
  [".txt", { format: "code", language: "plaintext", label: "Text" }],
  [".log", { format: "code", language: "plaintext", label: "Log" }],
  [".json", { format: "code", language: "json", label: "JSON" }],
  [".jsonc", { format: "code", language: "json", label: "JSON" }],
  [".yaml", { format: "code", language: "yaml", label: "YAML" }],
  [".yml", { format: "code", language: "yaml", label: "YAML" }],
  [".js", { format: "code", language: "javascript", label: "JavaScript" }],
  [".mjs", { format: "code", language: "javascript", label: "JavaScript" }],
  [".cjs", { format: "code", language: "javascript", label: "JavaScript" }],
  [".ts", { format: "code", language: "typescript", label: "TypeScript" }],
  [".tsx", { format: "code", language: "typescript", label: "TypeScript" }],
  [".jsx", { format: "code", language: "javascript", label: "JavaScript" }],
  [".go", { format: "code", language: "go", label: "Go" }],
  [".rs", { format: "code", language: "rust", label: "Rust" }],
  [".py", { format: "code", language: "python", label: "Python" }],
  [".sh", { format: "code", language: "shell", label: "Shell" }],
  [".bash", { format: "code", language: "shell", label: "Shell" }],
  [".zsh", { format: "code", language: "shell", label: "Shell" }],
  [".ini", { format: "code", language: "ini", label: "Config" }],
  [".conf", { format: "code", language: "ini", label: "Config" }],
  [".toml", { format: "code", language: "toml", label: "TOML" }],
  [".env", { format: "code", language: "ini", label: "Config" }],
  [".css", { format: "code", language: "css", label: "CSS" }],
  [".html", { format: "code", language: "html", label: "HTML" }],
]);

const listDocsDirectory = async (input: string | null | undefined) => {
  const directory = resolveDocsPath(input);
  let stats: Awaited<ReturnType<typeof stat>>;
  try {
    stats = await stat(directory);
  } catch {
    throw new Error("Directory not found");
  }

  if (!stats.isDirectory()) {
    throw new Error("Requested path is not a directory");
  }

  let entries: Awaited<ReturnType<typeof readdir>>;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    throw new Error(`Failed to read directory: ${(error as Error).message ?? "unknown error"}`);
  }

  const directories: Array<{
    name: string;
    path: string;
    relativePath: string;
    displayPath: string;
    type: "directory";
  }> = [];
  const files: Array<{
    name: string;
    path: string;
    relativePath: string;
    displayPath: string;
    type: "file";
    previewable: boolean;
    previewFormat: DocsPreviewType["format"] | null;
    previewLanguage: string | null;
    previewLabel: string | null;
  }> = [];

  for (const entry of entries) {
    if (entry.isSymbolicLink()) {
      continue;
    }

    if (entry.name.startsWith(".")) {
      continue;
    }

    const entryPath = normalize(join(directory, entry.name));
    if (!isWithinDocsRoot(entryPath)) {
      continue;
    }

    if (entry.isDirectory()) {
      const relativePath = toDocsRelativePath(entryPath);
      directories.push({
        name: entry.name,
        path: entryPath,
        relativePath,
        displayPath: toDocsDisplayPath(entryPath),
        type: "directory",
      });
      continue;
    }

    if (entry.isFile()) {
      const relativePath = toDocsRelativePath(entryPath);
      const extension = extname(entry.name).toLowerCase();
      const preview = TEXT_PREVIEW_TYPES.get(extension) ?? null;
      files.push({
        name: entry.name,
        path: entryPath,
        relativePath,
        displayPath: toDocsDisplayPath(entryPath),
        type: "file",
        previewable: preview !== null,
        previewFormat: preview?.format ?? null,
        previewLanguage: preview?.language ?? null,
        previewLabel: preview?.label ?? null,
      });
    }

    if (directories.length + files.length >= MAX_DOCS_ENTRIES) {
      break;
    }
  }

  directories.sort((a, b) => a.name.localeCompare(b.name));
  files.sort((a, b) => a.name.localeCompare(b.name));

  const parentPath = (() => {
    if (directory === docsRoot) {
      return null;
    }
    const candidate = dirname(directory);
    if (!isWithinDocsRoot(candidate)) {
      return null;
    }
    return candidate;
  })();

  return {
    path: directory,
    relativePath: toDocsRelativePath(directory),
    displayPath: toDocsDisplayPath(directory),
    parent: parentPath
      ? {
          path: parentPath,
          relativePath: toDocsRelativePath(parentPath),
          displayPath: toDocsDisplayPath(parentPath),
        }
      : null,
    entries: [...directories, ...files],
  };
};

const resolvePreviewType = (filePath: string): DocsPreviewType => {
  const extension = extname(filePath).toLowerCase();
  const preview = TEXT_PREVIEW_TYPES.get(extension);
  if (!preview) {
    throw new Error("Preview for this file type is not supported");
  }
  return preview;
};

const loadDocsFile = async (input: string | null | undefined) => {
  if (!input) {
    throw new Error("File path is required");
  }

  const filePath = resolveDocsPath(input);
  let stats: Awaited<ReturnType<typeof stat>>;
  try {
    stats = await stat(filePath);
  } catch {
    throw new Error("File not found");
  }

  if (!stats.isFile()) {
    throw new Error("Requested path is not a file");
  }

  if (stats.size > MAX_DOCS_FILE_SIZE) {
    throw new Error("File is too large to preview");
  }

  const preview = resolvePreviewType(filePath);

  if (preview.format === "markdown" && !MARKDOWN_EXTENSIONS.has(extname(filePath).toLowerCase())) {
    throw new Error("Unsupported Markdown extension");
  }

  const extension = extname(filePath).toLowerCase();

  let content: string;
  try {
    content = await readFile(filePath, "utf-8");
  } catch (error) {
    throw new Error(`Failed to read file: ${(error as Error).message ?? "unknown error"}`);
  }

  return {
    path: filePath,
    relativePath: toDocsRelativePath(filePath),
    displayPath: toDocsDisplayPath(filePath),
    name: basename(filePath),
    content,
    format: preview.format,
    language: preview.language,
    label: preview.label,
  };
};

const loadDocsFileRaw = async (input: string | null | undefined) => {
  if (!input) {
    throw new Error("File path is required");
  }

  const filePath = resolveDocsPath(input);
  let stats: Awaited<ReturnType<typeof stat>>;
  try {
    stats = await stat(filePath);
  } catch {
    throw new Error("File not found");
  }

  if (!stats.isFile()) {
    throw new Error("Requested path is not a file");
  }

  if (stats.size > MAX_DOCS_FILE_SIZE) {
    throw new Error("File is too large to load");
  }

  let data: Uint8Array;
  try {
    data = await readFile(filePath);
  } catch (error) {
    throw new Error(`Failed to read file: ${(error as Error).message ?? "unknown error"}`);
  }

  const base64 = Buffer.from(data).toString("base64");

  return {
    path: filePath,
    relativePath: toDocsRelativePath(filePath),
    displayPath: toDocsDisplayPath(filePath),
    name: basename(filePath),
    base64,
    size: stats.size,
    mtimeMs: stats.mtimeMs,
  };
};

const updateDocsFile = async (pathInput: string | null | undefined, base64Input: string | null | undefined, expectedMtime: number | null | undefined) => {
  if (!pathInput) {
    throw new Error("File path is required");
  }

  const filePath = resolveDocsPath(pathInput);

  let stats: Awaited<ReturnType<typeof stat>>;
  try {
    stats = await stat(filePath);
  } catch {
    throw new Error("File not found");
  }

  if (!stats.isFile()) {
    throw new Error("Requested path is not a file");
  }

  if (typeof expectedMtime === "number" && Math.abs(stats.mtimeMs - expectedMtime) > 1) {
    throw new Error("File has changed since it was loaded");
  }

  if (base64Input === null || base64Input === undefined) {
    throw new Error("File contents are required");
  }

  let bytes: Buffer;
  try {
    bytes = Buffer.from(base64Input, "base64");
  } catch {
    throw new Error("Invalid base64 payload");
  }

  if (bytes.length > MAX_DOCS_FILE_SIZE) {
    throw new Error("File is too large to save");
  }

  try {
    await writeFile(filePath, bytes);
  } catch (error) {
    throw new Error(`Failed to write file: ${(error as Error).message ?? "unknown error"}`);
  }

  const nextStats = await stat(filePath);

  return {
    path: filePath,
    relativePath: toDocsRelativePath(filePath),
    displayPath: toDocsDisplayPath(filePath),
    name: basename(filePath),
    size: nextStats.size,
    mtimeMs: nextStats.mtimeMs,
  };
};

const directoryExists = async (path: string): Promise<boolean> => {
  try {
    const stats = await stat(path);
    return stats.isDirectory();
  } catch {
    return false;
  }
};

const formatDateYYMMDD = (date: Date): string => {
  const year = date.getFullYear() % 100;
  const month = date.getMonth() + 1;
  const day = date.getDate();
  return `${year.toString().padStart(2, "0")}${month.toString().padStart(2, "0")}${day
    .toString()
    .padStart(2, "0")}`;
};

const resolveProjectPath = (input: string | null | undefined): string | null => {
  const value = input?.trim();
  if (!value) {
    return null;
  }
  if (isAbsolute(value)) {
    return normalize(value);
  }
  return normalize(join(projectRoot, value));
};

const sanitiseDirectoryPrefix = (value: string | null | undefined): string => {
  const candidate = value?.trim();
  if (!candidate) {
    return "Preset";
  }
  return candidate
    .replace(/[^a-zA-Z0-9/_-]+/g, "_")
    .replace(/\s+/g, "_")
    .replace(/_{2,}/g, "_")
    .replace(/^_+|_+$/g, "") || "Preset";
};

const normaliseOptionalString = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const SESSION_NAME_MAX_LENGTH = 120;

const normaliseSessionNameInput = (value: unknown): string | null => {
  const text = normaliseOptionalString(value);
  if (!text) {
    return null;
  }
  return text.length > SESSION_NAME_MAX_LENGTH ? text.slice(0, SESSION_NAME_MAX_LENGTH) : text;
};

const parsePresetInteger = (value: unknown, fallback: number, minimum?: number): number => {
  const numeric =
    typeof value === "number"
      ? Number.isFinite(value)
        ? Math.trunc(value)
        : NaN
      : typeof value === "string" && value.trim().length > 0
        ? Number.parseInt(value, 10)
        : NaN;
  if (!Number.isFinite(numeric)) {
    return fallback;
  }
  if (typeof minimum === "number" && numeric < minimum) {
    return fallback;
  }
  return numeric;
};

const toProjectRelativePath = (absolute: string): string => {
  const normalized = normalize(absolute);
  if (!normalized.startsWith(projectRoot)) {
    return normalized;
  }
  if (normalized === projectRoot) {
    return ".";
  }
  const offset = projectRoot.endsWith("/") ? projectRoot.length : projectRoot.length + 1;
  return normalized.slice(offset);
};

const ensureWithinBase = (absolute: string, base: string) => {
  const normalized = normalize(absolute);
  const normalizedBase = normalize(base);
  if (!normalized.startsWith(normalizedBase)) {
    throw new Error("Invalid directory path");
  }
  return normalized;
};

const listOrchestratorDirectories = async (target: "templates" | "active", relativeInput: string | null) => {
  const base = target === "templates" ? orchestratorTemplatesRoot : orchestratorActiveRootBase;
  await mkdir(base, { recursive: true });

  let resolved = base;
  if (relativeInput) {
    const candidate = join(projectRoot, relativeInput);
    resolved = ensureWithinBase(candidate, base);
  }

  let stats: Awaited<ReturnType<typeof stat>>;
  try {
    stats = await stat(resolved);
  } catch (error) {
    throw new Error(`Directory not found: ${toProjectRelativePath(resolved)}`);
  }

  if (!stats.isDirectory()) {
    throw new Error(`Path is not a directory: ${toProjectRelativePath(resolved)}`);
  }

  const entriesRaw = await readdir(resolved, { withFileTypes: true });
  const entries = entriesRaw
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const absolutePath = join(resolved, entry.name);
      return {
        name: entry.name,
        path: toProjectRelativePath(absolutePath),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  const parent = resolved === base ? null : toProjectRelativePath(dirname(resolved));

  return {
    target,
    path: toProjectRelativePath(resolved),
    parent,
    entries,
  };
};

const generatePresetDirectory = async (preset: OrchestratorPresetRecord): Promise<string> => {
  const templateDir = resolveProjectPath(preset.templateDir);
  if (!templateDir) {
    throw new Error(`Template directory not configured for preset ${preset.id}`);
  }

  const templateStats = await stat(templateDir).catch(() => null);
  if (!templateStats || !templateStats.isDirectory()) {
    throw new Error(`Template directory not found for preset ${preset.id}: ${templateDir}`);
  }

  const activeRoot = resolveProjectPath(preset.activeRoot);
  if (!activeRoot) {
    throw new Error(`Active root not configured for preset ${preset.id}`);
  }

  await mkdir(activeRoot, { recursive: true });

  const now = new Date();
  const dateSegment = formatDateYYMMDD(now);
  const prefix = sanitiseDirectoryPrefix(preset.directoryPrefix);

  for (let attempt = 0; attempt < 10; attempt += 1) {
    const idSegment = Math.floor(Math.random() * 100_000_000)
      .toString()
      .padStart(8, "0");
    const directoryName = `${dateSegment}_${prefix}_${idSegment}`;
    const target = join(activeRoot, directoryName);
    if (await directoryExists(target)) {
      continue;
    }
    await cp(templateDir, target, { recursive: true, force: false });
    return target;
  }

  throw new Error(`Unable to allocate unique directory for preset ${preset.id}`);
};

const preparePresetWorkingDirectory = async (preset: OrchestratorPresetRecord): Promise<string> => {
  if (preset.templateDir) {
    return generatePresetDirectory(preset);
  }

  const directoryInput = preset.workingDirectory ?? null;
  return ensureDirectory(directoryInput);
};

const waitForAgentReady = async (
  session: SessionSnapshot,
  timeoutMs: number | null | undefined,
  pollIntervalMs: number | null | undefined,
) => {
  const effectiveTimeout = typeof timeoutMs === "number" && timeoutMs > 0 ? timeoutMs : 30000;
  const interval = typeof pollIntervalMs === "number" && pollIntervalMs > 0 ? pollIntervalMs : 250;
  const deadline = Date.now() + effectiveTimeout;
  const statusUrl = buildAgentUrl(session.port, "/status");
  while (Date.now() < deadline) {
    try {
      const response = await fetch(statusUrl);
      if (response.ok) {
        const payload = await response.json().catch(() => null);
        const data = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : null;
        const agentType = data && typeof data.agent_type === "string" ? data.agent_type.toLowerCase() : "";
        const status = data && typeof data.status === "string" ? data.status : "";
        if (agentType === session.agent && (status === "running" || status === "stable")) {
          return;
        }
      }
    } catch {
      // Ignore transient failures while waiting for the agent to boot.
    }
    await sleep(interval);
  }
  throw new Error(`Timed out waiting for ${session.agent} agent to become ready`);
};

const renderPresetMessage = (template: string, session: SessionSnapshot): string => {
  const replacements: Array<{ regex: RegExp; value: string }> = [
    { regex: /<working_dir>/gi, value: session.workingDirectory },
    { regex: /{{\s*working_dir\s*}}/gi, value: session.workingDirectory },
    { regex: /<active_dir>/gi, value: session.workingDirectory },
    { regex: /{{\s*active_dir\s*}}/gi, value: session.workingDirectory },
    { regex: /<session[_]?id>/gi, value: session.id },
    { regex: /{{\s*session[_]?id\s*}}/gi, value: session.id },
  ];

  return replacements.reduce((content, { regex, value }) => content.replace(regex, value), template);
};

const sendPresetIntroMessage = async (
  session: SessionSnapshot,
  message: string | null | undefined,
  retryAttempts: number | null | undefined,
  retryDelayMs: number | null | undefined,
) => {
  const contentTemplate = message?.trim();
  if (!contentTemplate) {
    return false;
  }

  const attempts = typeof retryAttempts === "number" && retryAttempts > 0 ? retryAttempts : 10;
  const delay = typeof retryDelayMs === "number" && retryDelayMs >= 0 ? retryDelayMs : 1000;

  const content = renderPresetMessage(contentTemplate, session);
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const agentUrl = buildAgentUrl(session.port, "/message");
      const response = await fetch(agentUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "user", content }),
      }).catch((error: unknown) => {
        throw new Error(`Failed to contact agent: ${(error as Error).message}`);
      });

      if (!response.ok) {
        let message = response.statusText || "Agent request failed";
        try {
          const payload = await response.json();
          const data = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : null;
          if (data && typeof data.error === "string") {
            message = data.error;
          }
        } catch {
          // ignore json errors, keep fallback message
        }
        throw new Error(message);
      }

      await syncSessionMessages(session.id, true);
      return true;
    } catch (error) {
      lastError = error;
      if (attempt < attempts) {
        await sleep(delay);
      }
    }
  }

  if (lastError instanceof Error) {
    throw new Error(`Failed to deliver introductory message: ${lastError.message}`);
  }
  throw new Error("Failed to deliver introductory message");
};

const initialisePresetSession = async (preset: OrchestratorPresetRecord, session: SessionSnapshot) => {
  try {
    await waitForAgentReady(session, preset.pollTimeoutMs, preset.pollIntervalMs);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[orchestrator] failed to wait for agent readiness for preset ${preset.id}: ${message}`);
    return;
  }

  try {
    const sent = await sendPresetIntroMessage(
      session,
      preset.introMessage,
      preset.retryAttempts,
      preset.retryDelayMs,
    );
    if (!sent) {
      await syncSessionMessages(session.id, true);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[orchestrator] failed to deliver intro message for preset ${preset.id}: ${message}`);
    await syncSessionMessages(session.id, true).catch(() => undefined);
  }
};

const launchOrchestratorPreset = async (presetId: string) => {
  const preset = orchestratorPresetStore.getPreset(presetId);
  if (!preset) {
    throw new Error(`Preset not found: ${presetId}`);
  }

  if (!isAgentType(preset.agent)) {
    throw new Error(`Invalid agent configured for preset ${preset.id}: ${preset.agent}`);
  }

  const workingDirectory = await preparePresetWorkingDirectory(preset);
  const sessionName = normaliseSessionNameInput(preset.label);
  const session = await manager.createSession(
    preset.agent as AgentType,
    workingDirectory,
    sessionName ?? undefined,
  );
  messageStore.recordSession(session.id, session.agent, session.startedAt, session.name);
  void initialisePresetSession(preset, session);
  return { directory: workingDirectory, session };
};

const stopAndRemoveSession = async (sessionId: string) => {
  const existing = manager.getSession(sessionId);
  if (!existing) {
    messageStore.removeSession(sessionId);
    return false;
  }

  if (existing.status === "starting" || existing.status === "running") {
    try {
      await manager.stopSession(sessionId);
    } catch (error) {
      throw new Error(`Failed to stop session ${sessionId}: ${(error as Error).message}`);
    }
  }

  try {
    manager.deleteSession(sessionId);
  } catch (error) {
    throw new Error(`Failed to delete session ${sessionId}: ${(error as Error).message}`);
  }

  messageStore.removeSession(sessionId);
  return true;
};

const handleWebhookRequest = async (request: Request, url: URL): Promise<Response | null> => {
  const pathname = url.pathname;
  if (pathname === "/v1/api/webhook/off" && request.method === "POST") {
    let payload: unknown;
    try {
      payload = await request.json();
    } catch {
      return Response.json({ error: "Invalid JSON payload" }, { status: 400 });
    }

    if (!payload || typeof payload !== "object") {
      return Response.json({ error: "Invalid JSON payload" }, { status: 400 });
    }

    const data = payload as Record<string, unknown>;
    const sessionId =
      normaliseOptionalString(data["session-id"]) ??
      normaliseOptionalString(data.sessionId) ??
      normaliseOptionalString(data.session_id);

    if (!sessionId) {
      return Response.json({ error: "session-id is required" }, { status: 400 });
    }

    const state = normaliseOptionalString(data.state);
    if (state && state.toLowerCase() !== "off") {
      return Response.json({ error: "Unsupported state. Only 'off' is accepted." }, { status: 400 });
    }

    try {
      const removed = await stopAndRemoveSession(sessionId);
      if (!removed) {
        return Response.json({ status: "ignored", reason: "session-not-found" }, { status: 404 });
      }
      return Response.json({ status: "ok", sessionId }, { status: 200 });
    } catch (error) {
      return Response.json({ error: (error as Error).message }, { status: 500 });
    }
  }

  return null;
};

const listDirectories = async (input: string | null | undefined, query?: string) => {
  const directory = await ensureDirectory(input);
  const entries = await readdir(directory, { withFileTypes: true });
  const term = query?.toLowerCase().trim();

  const directories = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({
      name: entry.name,
      path: normalize(join(directory, entry.name)),
    }))
    .sort((a, b) => a.name.localeCompare(b.name))
    .filter((entry) => {
      if (!term) return true;
      return entry.name.toLowerCase().includes(term);
    })
    .slice(0, MAX_DIRECTORY_RESULTS);

  const parent = (() => {
    const candidate = dirname(directory);
    return candidate === directory ? null : candidate;
  })();

  return {
    path: directory,
    parent,
    entries: directories,
  };
};

type HttpMethod = "GET" | "POST" | "DELETE";

const assetMap: Record<string, { path: string; type: string }> = {
  "/app.js": { path: "./ui/app.js", type: "application/javascript; charset=utf-8" },
  "/styles.css": { path: "./ui/styles.css", type: "text/css; charset=utf-8" },
};

const resolveAsset = (pathname: string) => {
  const asset = assetMap[pathname];
  if (!asset) return undefined;
  const url = new URL(asset.path, import.meta.url);
  const file = Bun.file(url);
  if (!file.size) return undefined;
  return new Response(file, {
    headers: {
      "content-type": asset.type,
      "cache-control": "public, max-age=60",
    },
  });
};

const servePublicAsset = (pathname: string) => {
  const normalized = pathname.startsWith("/") ? pathname.slice(1) : pathname;
  if (!normalized) return undefined;
  const url = new URL(`../public/${normalized}`, import.meta.url);
  const file = Bun.file(url);
  if (!file.size) return undefined;

  const type = file.type || undefined;
  return new Response(file, {
    headers: {
      ...(type ? { "content-type": type } : {}),
      "cache-control": "public, max-age=3600",
    },
  });
};

const serveAceBuildsAsset = (pathname: string) => {
  if (!pathname.startsWith("/ace-builds/")) return undefined;
  const suffix = pathname.slice("/ace-builds/".length);
  if (suffix.length === 0) return undefined;
  const candidate = normalize(join(aceBuildsRoot, suffix));
  if (!candidate.startsWith(aceBuildsRootBoundary)) {
    return undefined;
  }
  const file = Bun.file(candidate);
  if (!file.size) return undefined;
  const ext = extname(candidate).toLowerCase();
  const type =
    ext === ".js"
      ? "application/javascript; charset=utf-8"
      : ext === ".css"
        ? "text/css; charset=utf-8"
        : file.type || undefined;
  return new Response(file, {
    headers: {
      ...(type ? { "content-type": type } : {}),
      "cache-control": "public, max-age=86400",
    },
  });
};

const serveIndex = () => {
  const url = new URL("./ui/index.html", import.meta.url);
  return new Response(Bun.file(url), {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-cache",
    },
  });
};

const isAgentType = (value: string): value is AgentType => {
  return ["codex", "claude", "goose", "opencode"].includes(value);
};

const parseAllowedHosts = (value: string): string[] => {
  return value
    .split(/[,\s]+/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
};

const pickAgentHost = (hosts: string[]): string => {
  const ipv4Hosts = hosts.filter((host) => host === "localhost" || /^\d+\.\d+\.\d+\.\d+$/.test(host));
  if (ipv4Hosts.length > 0) {
    return ipv4Hosts[0];
  }

  // Fallback to localhost if no IPv4 entry is provided.
  return "localhost";
};

const normaliseHostForUrl = (host: string): string => host;

const agentHosts = parseAllowedHosts(config.allowedHosts);
const agentHost = normaliseHostForUrl(pickAgentHost(agentHosts));

const buildAgentUrl = (port: number, path: string): URL => {
  return new URL(path, `http://${agentHost}:${port}/`);
};

const normaliseAgentMessages = (items: unknown[]): ReplaceMessageInput[] => {
  const base = Date.now();
  return items
    .map((item, index) => {
      if (!item || typeof item !== "object") {
        return undefined;
      }
      const value = item as Record<string, unknown>;
      const role =
        typeof value.type === "string" && value.type.length > 0
          ? value.type
          : typeof value.role === "string" && value.role.length > 0
            ? value.role
            : "assistant";

      const contentRaw =
        typeof value.content === "string" && value.content.length > 0
          ? value.content
          : typeof value.message === "string" && value.message.length > 0
            ? value.message
            : "";

      if (!contentRaw) {
        return undefined;
      }

      const createdAtCandidate =
        typeof value.createdAt === "string"
          ? value.createdAt
          : typeof value.created_at === "string"
            ? value.created_at
            : typeof value.timestamp === "string"
              ? value.timestamp
              : undefined;

      const createdAt = createdAtCandidate ?? new Date(base + index).toISOString();

      return {
        role,
        content: contentRaw,
        createdAt,
      };
    })
    .filter((item): item is ReplaceMessageInput => Boolean(item));
};

const syncSessionMessages = async (sessionId: string, force = false) => {
  if (!force && messageStore.hasMessages(sessionId)) {
    return messageStore.listSessionMessages(sessionId);
  }

  const session = manager.getSession(sessionId);
  if (!session) {
    return messageStore.listSessionMessages(sessionId);
  }

  try {
    const agentUrl = buildAgentUrl(session.port, "/messages");
    const response = await fetch(agentUrl);
    if (!response.ok) {
      return messageStore.listSessionMessages(sessionId);
    }
    const payload = await response.json();
    const items = Array.isArray(payload) ? payload : Array.isArray(payload?.messages) ? payload.messages : [];
    const messages = normaliseAgentMessages(items);
    messageStore.replaceMessages(sessionId, messages);
  } catch (error) {
    console.error(`Failed to synchronise messages for session ${sessionId}:`, error);
  }

  return messageStore.listSessionMessages(sessionId);
};

const handleApi = async (request: Request, url: URL, method: HttpMethod): Promise<Response> => {
  const pathname = url.pathname;
  if (pathname === "/api/config" && method === "GET") {
    return Response.json({
      port: config.port,
      agentPortStart: config.agentPortStart,
      agentPortMax: config.agentPortMax,
      defaultDirectory: config.defaultWorkingDirectory,
      agents: Object.entries(config.agents).map(([key, definition]) => ({
        id: key,
        label: definition.label,
      })),
    });
  }

  if (pathname === "/api/orchestrators" && method === "GET") {
    const presets = orchestratorPresetStore.listPresets();
    return Response.json({ presets });
  }

  if (pathname === "/api/docs/tree" && method === "GET") {
    try {
      const pathParam = url.searchParams.get("path");
      const data = await listDocsDirectory(pathParam);
      return Response.json(data);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return Response.json({ error: message }, { status: 400 });
    }
  }

  if (pathname === "/api/docs/file" && method === "GET") {
    const pathParam = url.searchParams.get("path");
    if (!pathParam) {
      return Response.json({ error: "File path is required" }, { status: 400 });
    }
    try {
      const data = await loadDocsFile(pathParam);
      return Response.json(data);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return Response.json({ error: message }, { status: 400 });
    }
  }

  if (pathname === "/api/docs/file/raw" && method === "GET") {
    const pathParam = url.searchParams.get("path");
    if (!pathParam) {
      return Response.json({ error: "File path is required" }, { status: 400 });
    }
    try {
      const data = await loadDocsFileRaw(pathParam);
      return Response.json(data);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return Response.json({ error: message }, { status: 400 });
    }
  }

  if (pathname === "/api/docs/file" && method === "PUT") {
    let payload: unknown;
    try {
      payload = await request.json();
    } catch {
      return Response.json({ error: "Invalid JSON payload" }, { status: 400 });
    }

    if (!payload || typeof payload !== "object") {
      return Response.json({ error: "Invalid JSON payload" }, { status: 400 });
    }

    const pathValue = (payload as Record<string, unknown>).path;
    const base64Value = (payload as Record<string, unknown>).base64;
    const expectedMtimeValue = (payload as Record<string, unknown>).expectedMtimeMs;

    const pathParam = typeof pathValue === "string" ? pathValue : null;
    const base64Param = typeof base64Value === "string" ? base64Value : null;
    const expectedMtime =
      typeof expectedMtimeValue === "number" && Number.isFinite(expectedMtimeValue) ? expectedMtimeValue : null;

    try {
      const data = await updateDocsFile(pathParam, base64Param, expectedMtime);
      return Response.json(data, { status: 200 });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return Response.json({ error: message }, { status: 400 });
    }
  }

  if (pathname === "/api/orchestrators/directories" && method === "GET") {
    const targetParam = url.searchParams.get("target") ?? "";
    const target = targetParam === "templates" ? "templates" : targetParam === "active" ? "active" : null;
    if (!target) {
      return Response.json({ error: "Invalid target" }, { status: 400 });
    }
    const pathParam = url.searchParams.get("path");
    try {
      const data = await listOrchestratorDirectories(target, pathParam);
      return Response.json(data);
    } catch (error) {
      return Response.json({ error: (error as Error).message }, { status: 400 });
    }
  }

  if (pathname === "/api/orchestrators" && method === "POST") {
    let payload: unknown;
    try {
      payload = await request.json();
    } catch {
      return Response.json({ error: "Invalid JSON payload" }, { status: 400 });
    }

    if (!payload || typeof payload !== "object") {
      return Response.json({ error: "Invalid JSON payload" }, { status: 400 });
    }

    const label = normaliseOptionalString((payload as Record<string, unknown>).label);
    if (!label) {
      return Response.json({ error: "Preset label is required" }, { status: 400 });
    }

    const agentInput = normaliseOptionalString((payload as Record<string, unknown>).agent);
    const agent = agentInput?.toLowerCase() ?? "";
    if (!isAgentType(agent)) {
      return Response.json({ error: "Invalid agent selection" }, { status: 400 });
    }

    const templateDir = normaliseOptionalString(
      (payload as Record<string, unknown>).templateDir ?? (payload as Record<string, unknown>).template,
    );
    const workingDirectory = normaliseOptionalString(
      (payload as Record<string, unknown>).workingDirectory ?? (payload as Record<string, unknown>).directory,
    );

    if (templateDir && workingDirectory) {
      return Response.json({ error: "Specify either a template directory or a working directory, not both" }, { status: 400 });
    }

    if (!templateDir && !workingDirectory) {
      return Response.json({ error: "Provide either a template directory or a working directory" }, { status: 400 });
    }

    const activeRoot = templateDir
      ? normaliseOptionalString(
          (payload as Record<string, unknown>).activeRoot ?? (payload as Record<string, unknown>).activeDirectory,
        ) ?? "orchestrator/active"
      : null;

    const directoryPrefixInput = normaliseOptionalString(
      (payload as Record<string, unknown>).directoryPrefix ?? (payload as Record<string, unknown>).prefix,
    );
    const directoryPrefix = templateDir
      ? directoryPrefixInput ?? sanitiseDirectoryPrefix(label)
      : directoryPrefixInput ?? null;

    const introMessage = normaliseOptionalString((payload as Record<string, unknown>).introMessage);

    const pollTimeoutMs = parsePresetInteger((payload as Record<string, unknown>).pollTimeoutMs, 30000, 1000);
    const pollIntervalMs = parsePresetInteger((payload as Record<string, unknown>).pollIntervalMs, 250, 50);
    const retryAttempts = parsePresetInteger((payload as Record<string, unknown>).retryAttempts, 10, 1);
    const retryDelayMs = parsePresetInteger((payload as Record<string, unknown>).retryDelayMs, 1000, 0);

    try {
      const preset = orchestratorPresetStore.createPreset({
        label,
        agent,
        templateDir,
        activeRoot,
        directoryPrefix,
        workingDirectory: templateDir ? null : workingDirectory,
        introMessage,
        pollTimeoutMs,
        pollIntervalMs,
        retryAttempts,
        retryDelayMs,
      });
      return Response.json({ preset }, { status: 201 });
    } catch (error) {
      return Response.json({ error: (error as Error).message }, { status: 500 });
    }
  }

  if (pathname === "/api/directories" && method === "GET") {
    try {
      const data = await listDirectories(url.searchParams.get("path"), url.searchParams.get("query") ?? undefined);
      return Response.json(data);
    } catch (error) {
      return Response.json({ error: (error as Error).message }, { status: 400 });
    }
  }

  if (pathname === "/api/uploads/images" && method === "POST") {
    let form: FormData;
    try {
      form = await request.formData();
    } catch {
      return Response.json({ error: "Invalid form data" }, { status: 400 });
    }

    const agentInput = form.get("agent");
    const agent = typeof agentInput === "string" ? agentInput.toLowerCase() : "";
    if (!isAgentType(agent)) {
      return Response.json({ error: "Unsupported agent target" }, { status: 400 });
    }

    const fileEntry = form.get("image");
    if (!fileEntry || typeof (fileEntry as Blob).arrayBuffer !== "function") {
      return Response.json({ error: "Image file is required" }, { status: 400 });
    }

    const file = fileEntry as Blob & { name?: string; size: number; type?: string };

    if (file.size === 0) {
      return Response.json({ error: "Empty files are not allowed" }, { status: 400 });
    }

    if (file.size > maxImageSizeBytes) {
      return Response.json({ error: "Image exceeds 10MB limit" }, { status: 413 });
    }

    if (!file.type?.startsWith("image/")) {
      return Response.json({ error: "Only image uploads are supported" }, { status: 400 });
    }

    let directory: string;
    try {
      directory = await ensureImageDirectory(agent);
    } catch (error) {
      console.error("[uploads] failed to ensure directory", error);
      return Response.json({ error: "Failed to prepare image storage" }, { status: 500 });
    }

    const filename = createImageFilename(file.name ?? "upload", file.type ?? "");
    const diskPath = join(directory, filename);
    try {
      const buffer = Buffer.from(await file.arrayBuffer());
      await writeFile(diskPath, buffer);
    } catch (error) {
      console.error("[uploads] failed to persist image", error);
      return Response.json({ error: "Failed to store image" }, { status: 500 });
    }

    const relativePath = normalize(join(agent, filename)).replace(/\\/g, "/");
    const publicPath = `/uploads/images/${relativePath}`;
    const placeholder = buildAgentImagePlaceholder(agent, diskPath, `${publicPath}`);

    return Response.json({
      agent,
      name: file.name,
      publicPath,
      relativePath,
      placeholder,
    });
  }

  if (pathname === "/api/sessions" && method === "GET") {
    const sessions = manager.listSessions();
    return Response.json({ sessions });
  }

  if (pathname.startsWith("/api/orchestrators/")) {
    const parts = pathname.split("/");
    const id = parts[3];
    if (!id) {
      return Response.json({ error: "Preset id required" }, { status: 400 });
    }

    if (method === "GET" && parts.length === 4) {
      const preset = orchestratorPresetStore.getPreset(id);
      if (!preset) {
        return Response.json({ error: "Not found" }, { status: 404 });
      }
      return Response.json({
        preset: {
          id: preset.id,
          label: preset.label,
          agent: preset.agent,
          templateDir: preset.templateDir,
          activeRoot: preset.activeRoot,
          directoryPrefix: preset.directoryPrefix,
          workingDirectory: preset.workingDirectory,
          introMessage: preset.introMessage,
          pollTimeoutMs: preset.pollTimeoutMs,
          pollIntervalMs: preset.pollIntervalMs,
          retryAttempts: preset.retryAttempts,
          retryDelayMs: preset.retryDelayMs,
        },
      });
    }

    if (method === "POST" && parts[4] === "launch") {
      try {
        const { directory, session } = await launchOrchestratorPreset(id);
        return Response.json({ directory, session }, { status: 201 });
      } catch (error) {
        return Response.json({ error: (error as Error).message }, { status: 500 });
      }
    }

    return Response.json({ error: "Not found" }, { status: 404 });
  }

  if (pathname === "/api/sessions" && method === "POST") {
    try {
      const payload = await request.json();
      const agent = typeof payload?.agent === "string" ? payload.agent.toLowerCase() : "";
      if (!isAgentType(agent)) {
        return Response.json({ error: "Invalid agent selection" }, { status: 400 });
      }
      const directoryInput = typeof payload?.directory === "string" ? payload.directory : undefined;
      const rawName =
        payload && typeof payload === "object" && payload !== null
          ? (payload as Record<string, unknown>).name
          : null;
      const sessionName = normaliseSessionNameInput(rawName);
      let workingDirectory: string;
      try {
        workingDirectory = await ensureDirectory(directoryInput);
      } catch (error) {
        return Response.json({ error: (error as Error).message }, { status: 400 });
      }
      const session = await manager.createSession(agent, workingDirectory, sessionName ?? undefined);
      messageStore.recordSession(session.id, session.agent, session.startedAt, session.name);
      await syncSessionMessages(session.id, true);
      return Response.json(session, { status: 201 });
    } catch (error) {
      return Response.json({ error: (error as Error).message }, { status: 500 });
    }
  }

  if (pathname.startsWith("/api/sessions/")) {
    const parts = pathname.split("/");
    const id = parts[3];
    if (!id) {
      return Response.json({ error: "Session id required" }, { status: 400 });
    }

    if (method === "GET" && parts.length === 4) {
      const session = manager.getSession(id);
      if (!session) return Response.json({ error: "Not found" }, { status: 404 });
      return Response.json(session);
    }

    if (method === "DELETE" && parts.length === 4) {
      const session = await manager.stopSession(id);
      if (!session) return Response.json({ error: "Not found" }, { status: 404 });
      return Response.json(session);
    }

    if (method === "DELETE" && parts[4] === "storage") {
      const session = manager.getSession(id);
      if (session && (session.status === "starting" || session.status === "running")) {
        return Response.json({ error: "Stop the session before deleting it" }, { status: 409 });
      }
      try {
        manager.deleteSession(id);
      } catch (error) {
        return Response.json({ error: (error as Error).message }, { status: 400 });
      }
      messageStore.removeSession(id);
      return Response.json({ id, deleted: true });
    }

    if (method === "GET" && parts[4] === "logs") {
      const logs = manager.getLogs(id);
      if (!logs) return Response.json({ error: "Not found" }, { status: 404 });
      return Response.json({ id, logs });
    }

    if (parts[4] === "messages") {
      if (method === "GET") {
        const refresh = url.searchParams.get("refresh") === "true";
        const messages = await (refresh ? syncSessionMessages(id, true) : messageStore.listSessionMessages(id));
        return Response.json({ id, messages });
      }

      if (method === "POST") {
        const session = manager.getSession(id);
        if (!session) {
          return Response.json({ error: "Not found" }, { status: 404 });
        }

        let payload: unknown;
        try {
          payload = await request.json();
        } catch (error) {
          return Response.json({ error: "Invalid JSON payload" }, { status: 400 });
        }

        const content =
          typeof (payload as Record<string, unknown>)?.content === "string"
            ? (payload as Record<string, unknown>).content.trim()
            : "";

        if (!content) {
          return Response.json({ error: "Message content is required" }, { status: 400 });
        }

        try {
          const agentUrl = buildAgentUrl(session.port, "/message");
          const agentResponse = await fetch(agentUrl, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ type: "user", content }),
          });
          if (!agentResponse.ok) {
            const errorPayload = await agentResponse.json().catch(() => ({}));
            const message = (errorPayload?.error as string) ?? agentResponse.statusText ?? "Agent request failed";
            return Response.json({ error: message }, { status: agentResponse.status });
          }
        } catch (error) {
          return Response.json({ error: `Failed to contact agent: ${(error as Error).message}` }, { status: 502 });
        }

        const messages = await syncSessionMessages(id, true);
        return Response.json({ id, messages });
      }
    }
  }

  return Response.json({ error: "Not found" }, { status: 404 });
};

const server = Bun.serve({
  port: config.port,
  async fetch(request: Request) {
    const url = new URL(request.url);
    const pathname = url.pathname;
    const method = request.method as HttpMethod;

    const webhookResponse = await handleWebhookRequest(request, url);
    if (webhookResponse) {
      return webhookResponse;
    }

    if (pathname === "/" && method === "GET") {
      return Response.redirect(`${url.origin}/home`, 302);
    }

    if (
      pathname === "/home" ||
      pathname === "/docs" ||
      pathname.startsWith("/docs/") ||
      pathname === "/files" ||
      pathname.startsWith("/files/") ||
      pathname === "/live" ||
      pathname.startsWith("/live/")
    ) {
      return serveIndex();
    }

    if (pathname.startsWith("/api/")) {
      return handleApi(request, url, method);
    }

    const tempImage = resolveTempImage(pathname);
    if (tempImage) {
      return tempImage;
    }

    const aceAsset = serveAceBuildsAsset(pathname);
    if (aceAsset) {
      return aceAsset;
    }

    const assetResponse = resolveAsset(pathname);
    if (assetResponse) {
      return assetResponse;
    }

    const publicAsset = servePublicAsset(pathname);
    if (publicAsset) {
      return publicAsset;
    }

    return new Response("Not Found", { status: 404 });
  },
});

console.log(
  `Wingman V2 orchestrator listening on http://localhost:${config.port} (agents ${config.agentPortStart} - ${config.agentPortStart + config.agentPortMax - 1})`,
);

export { server, manager, config };
