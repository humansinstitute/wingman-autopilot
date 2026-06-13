import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, normalize, sep } from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { createStaticAssetService } from "./static-assets";
import { createStaticRouteHandler } from "./static-routes";

const tempRoots: string[] = [];

const withBoundary = (path: string) => path.endsWith(sep) ? path : `${path}${sep}`;

async function createTempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "wingman-static-routes-"));
  tempRoots.push(root);
  return root;
}

async function createHandler(publicFiles: Record<string, string> = {}) {
  const root = await createTempRoot();
  const publicRoot = join(root, "public");
  const aceRoot = join(root, "ace-builds");
  await mkdir(publicRoot, { recursive: true });
  await mkdir(aceRoot, { recursive: true });

  for (const [relativePath, contents] of Object.entries(publicFiles)) {
    const target = join(publicRoot, relativePath);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, contents);
  }

  const assetService = createStaticAssetService({
    publicRoot: normalize(publicRoot),
    publicRootBoundary: withBoundary(normalize(publicRoot)),
    aceRoot: normalize(aceRoot),
    aceRootBoundary: withBoundary(normalize(aceRoot)),
    vendorPackages: {},
  });

  return createStaticRouteHandler({ assetService, assetVersion: "test" });
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("createStaticRouteHandler", () => {
  test("serves UI JavaScript modules with application/javascript", async () => {
    const handler = await createHandler();
    const request = new Request("http://localhost/app.js");
    const response = await handler.serveBeforeApi(request, "/app.js");

    expect(response?.status).toBe(200);
    expect(response?.headers.get("content-type")).toBe("application/javascript; charset=utf-8");
    expect(response?.headers.get("cache-control")).toBe("no-cache");
  });

  test("serves public CSS assets with text/css", async () => {
    const handler = await createHandler({
      "theme.css": "body { color: black; }",
    });
    const request = new Request("http://localhost/theme.css");
    const response = await handler.serveAfterApi(request, "/theme.css");

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/css;charset=utf-8");
    expect(response.headers.get("cache-control")).toBe("public, max-age=3600");
  });

  test("serves SPA fallback HTML for app routes", async () => {
    const handler = await createHandler();
    const request = new Request("http://localhost/home");
    const response = await handler.serveBeforeApi(request, "/home");
    const html = await response?.text();

    expect(response?.status).toBe(200);
    expect(response?.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(html).toContain('href="/styles.css?v=test"');
    expect(html).toContain('src="/app.js?v=test"');
  });

  test("returns 404 for missing static files", async () => {
    const handler = await createHandler();
    const request = new Request("http://localhost/missing.js");
    const response = await handler.serveAfterApi(request, "/missing.js");

    expect(response.status).toBe(404);
    expect(await response.text()).toBe("Not Found");
  });
});
