import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { randomUUID } from "node:crypto";

import { handleDocsApi, type DocsApiContext } from "./docs-routes";
import type { RequestAuthContext } from "../auth/request-context";
import type { WorkspaceScope } from "../workspaces/workspace-scope";

const authContext: RequestAuthContext = {
  npub: "npub1viewer",
  actorNpub: "npub1viewer",
  session: null,
  delegatedByBot: false,
};

function createDocsApiContext(rootDir: string): DocsApiContext {
  const scope: WorkspaceScope = {
    allowedDirectories: [rootDir],
    defaultDirectory: rootDir,
    aliasDirectory: null,
    docsRoot: rootDir,
    docsRootBoundary: rootDir.endsWith(sep) ? rootDir : `${rootDir}${sep}`,
    isAdmin: false,
  };

  return {
    resolveWorkspace: () => scope,
    ensureApiAccess: async () => null,
    AccessActions: {
      FilesRead: "files:read" as any,
      FilesWrite: "files:write" as any,
    },
    ensureDirectory: async () => rootDir,
    createGitWorktree: async () => ({ branch: "main", path: rootDir, repository: null }),
    executeGitCommand: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
    describeGitRepository: async () => null,
  };
}

async function callDocsApi(ctx: DocsApiContext, path: string) {
  const url = new URL(`http://localhost${path}`);
  const request = new Request(url.toString(), { method: "GET" });
  return handleDocsApi(request, url, "GET", authContext, ctx);
}

describe("handleDocsApi file images", () => {
  let rootDir: string;
  let ctx: DocsApiContext;

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), `wingmen-docs-routes-${randomUUID()}-`));
    ctx = createDocsApiContext(rootDir);
  });

  afterEach(async () => {
    await rm(rootDir, { recursive: true, force: true });
  });

  test("previews image files without the text preview size limit", async () => {
    const imagePath = join(rootDir, "large.png");
    const bytes = new Uint8Array(3 * 1024 * 1024);
    await writeFile(imagePath, bytes);

    const response = await callDocsApi(ctx, "/api/docs/file?path=large.png");
    const body = await response!.json() as {
      content: string | null;
      format: string;
      label: string;
      mimeType: string;
      size: number;
    };

    expect(response!.status).toBe(200);
    expect(body.content).toBeNull();
    expect(body.format).toBe("image");
    expect(body.label).toBe("Image");
    expect(body.mimeType).toBe("image/png");
    expect(body.size).toBe(bytes.length);
  });

  test("downloads large images as streamed file responses", async () => {
    const imagePath = join(rootDir, "large.png");
    const bytes = new Uint8Array(3 * 1024 * 1024);
    bytes[0] = 137;
    bytes[1] = 80;
    bytes[2] = 78;
    bytes[3] = 71;
    await writeFile(imagePath, bytes);

    const response = await callDocsApi(ctx, "/api/docs/file/download?path=large.png");
    const downloaded = await response!.arrayBuffer();

    expect(response!.status).toBe(200);
    expect(response!.headers.get("content-disposition")).toBe('attachment; filename="large.png"');
    expect(response!.headers.get("content-type")).toBe("image/png");
    expect(response!.headers.get("content-length")).toBe(String(bytes.length));
    expect(downloaded.byteLength).toBe(bytes.length);
  });

  test("marks json, csv, and pdf files as previewable formats", async () => {
    await writeFile(join(rootDir, "data.json"), '{"name":"Ada","skills":["math"]}');
    await writeFile(join(rootDir, "people.csv"), "name,count\nAda,2\nGrace,3");
    await writeFile(join(rootDir, "paper.pdf"), "%PDF-1.7\n");

    const response = await callDocsApi(ctx, "/api/docs/tree");
    const body = await response!.json() as {
      entries: Array<{ name: string; previewable: boolean; previewFormat: string; previewLabel: string }>;
    };
    const entries = new Map(body.entries.map((entry) => [entry.name, entry]));

    expect(response!.status).toBe(200);
    expect(entries.get("data.json")).toMatchObject({
      previewable: true,
      previewFormat: "json",
      previewLabel: "JSON",
    });
    expect(entries.get("people.csv")).toMatchObject({
      previewable: true,
      previewFormat: "csv",
      previewLabel: "CSV",
    });
    expect(entries.get("paper.pdf")).toMatchObject({
      previewable: true,
      previewFormat: "pdf",
      previewLabel: "PDF",
    });
  });

  test("loads pdf preview metadata without reading file content", async () => {
    const pdfContent = "%PDF-1.7\n";
    await writeFile(join(rootDir, "paper.pdf"), pdfContent);

    const response = await callDocsApi(ctx, "/api/docs/file?path=paper.pdf");
    const body = await response!.json() as {
      content: string | null;
      format: string;
      mimeType: string;
      size: number;
    };

    expect(response!.status).toBe(200);
    expect(body.content).toBeNull();
    expect(body.format).toBe("pdf");
    expect(body.mimeType).toBe("application/pdf");
    expect(body.size).toBe(pdfContent.length);
  });
});
