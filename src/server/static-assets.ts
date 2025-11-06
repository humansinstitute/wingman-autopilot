import { extname, join, normalize } from "node:path";

const uiAssetMap: Record<string, { url: URL; type: string }> = {
  "/app.js": { url: new URL("../ui/app.js", import.meta.url), type: "application/javascript; charset=utf-8" },
  "/styles.css": { url: new URL("../ui/styles.css", import.meta.url), type: "text/css; charset=utf-8" },
  "/identity/index.js": {
    url: new URL("../ui/identity/index.js", import.meta.url),
    type: "application/javascript; charset=utf-8",
  },
  "/todos/index.js": {
    url: new URL("../ui/todos/index.js", import.meta.url),
    type: "application/javascript; charset=utf-8",
  },
  "/logging/browser.js": {
    url: new URL("../ui/logging/browser.js", import.meta.url),
    type: "application/javascript; charset=utf-8",
  },
};

export interface VendorPackageDescriptor {
  root: string;
  boundary: string;
  entry: string;
}

export interface StaticAssetServiceOptions {
  publicRoot: string;
  publicRootBoundary: string;
  aceRoot: string;
  aceRootBoundary: string;
  vendorPackages: Record<string, VendorPackageDescriptor>;
}

const resolveUiAsset = (pathname: string): Response | undefined => {
  const asset = uiAssetMap[pathname];
  if (!asset) return undefined;
  const file = Bun.file(asset.url);
  if (!file.size) return undefined;
  return new Response(file, {
    headers: {
      "content-type": asset.type,
      "cache-control": "public, max-age=60",
    },
  });
};

export const createStaticAssetService = (options: StaticAssetServiceOptions) => {
  const { publicRoot, publicRootBoundary, aceRoot, aceRootBoundary, vendorPackages } = options;
  const uiAssetPaths = new Set(Object.keys(uiAssetMap));
  const vendorPackageNames = Object.keys(vendorPackages);

  const rewriteVendorModuleSpecifiers = (source: string) => {
    if (vendorPackageNames.length === 0) {
      return source;
    }
    let updated = source;
    for (const packageName of vendorPackageNames) {
      if (!updated.includes(packageName)) continue;
      const vendorPrefix = `/vendor/${packageName}`;
      updated = updated.replaceAll(`'${packageName}`, `'${vendorPrefix}`);
      updated = updated.replaceAll(`"${packageName}`, `"${vendorPrefix}`);
      updated = updated.replaceAll(`\`${packageName}`, `\`${vendorPrefix}`);
    }
    return updated;
  };

  const servePublicAsset = (pathname: string): Response | undefined => {
    const normalized = pathname.startsWith("/") ? pathname.slice(1) : pathname;
    if (!normalized) return undefined;
    const candidate = normalize(join(publicRoot, normalized));
    if (!candidate.startsWith(publicRootBoundary)) {
      console.warn(`[static] rejected public asset outside boundary: ${pathname}`);
      return undefined;
    }
    const file = Bun.file(candidate);
    if (!file.size) return undefined;

    const type = file.type || undefined;
    return new Response(file, {
      headers: {
        ...(type ? { "content-type": type } : {}),
        "cache-control": "public, max-age=3600",
      },
    });
  };

  const serveAceBuildsAsset = (pathname: string): Response | undefined => {
    if (!pathname.startsWith("/ace-builds/")) return undefined;
    const suffix = pathname.slice("/ace-builds/".length);
    if (suffix.length === 0) return undefined;
    const candidate = normalize(join(aceRoot, suffix));
    if (!candidate.startsWith(aceRootBoundary)) {
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

  const serveVendorModule = async (pathname: string): Promise<Response | undefined> => {
    if (!pathname.startsWith("/vendor/")) return undefined;
    const suffix = pathname.slice("/vendor/".length);
    if (!suffix) return undefined;

    const segments = suffix.split("/").filter((segment) => segment.length > 0);
    if (segments.length === 0) return undefined;
    if (segments.some((segment) => segment === "." || segment === "..")) return undefined;

    let packageName: string;
    let relativeSegments: string[];
    if (segments[0].startsWith("@")) {
      if (segments.length < 2) return undefined;
      packageName = `${segments[0]}/${segments[1]}`;
      relativeSegments = segments.slice(2);
    } else {
      packageName = segments[0];
      relativeSegments = segments.slice(1);
    }
    if (relativeSegments.some((segment) => segment === "." || segment === "..")) return undefined;

    const vendor = vendorPackages[packageName];
    if (!vendor) return undefined;
    const relativePath = relativeSegments.length > 0 ? join(...relativeSegments) : vendor.entry;
    const resolveCandidate = (basePath: string) => {
      const normalized = normalize(join(vendor.root, basePath));
      if (!normalized.startsWith(vendor.boundary)) {
        return undefined;
      }
      const attemptPaths: string[] = [];
      const extension = extname(normalized);
      if (extension) {
        attemptPaths.push(normalized);
      } else {
        attemptPaths.push(`${normalized}.js`, join(normalized, "index.js"));
        if (vendor.entry && vendor.entry !== "index.js") {
          attemptPaths.push(join(normalized, vendor.entry));
        }
      }
      for (const attempt of attemptPaths) {
        const attemptFile = Bun.file(attempt);
        if (attemptFile.size) {
          return { file: attemptFile, path: attempt };
        }
      }
      return undefined;
    };

    const resolved = resolveCandidate(relativePath);
    if (!resolved) {
      console.warn(`[static] failed to resolve vendor asset: ${pathname}`);
      return undefined;
    }

    const { file, path: resolvedPath } = resolved;
    const extension = extname(resolvedPath).toLowerCase();
    const type =
      extension === ".js"
        ? "application/javascript; charset=utf-8"
        : extension === ".json" || extension === ".map"
          ? "application/json; charset=utf-8"
          : file.type || undefined;

    const headers: Record<string, string> = {
      ...(type ? { "content-type": type } : {}),
      "cache-control": "public, max-age=86400",
    };

    if (extension === ".js") {
      const source = await file.text();
      const rewritten = rewriteVendorModuleSpecifiers(source);
      return new Response(rewritten, { headers });
    }

    return new Response(file, { headers });
  };

  return {
    resolveUiAsset,
    servePublicAsset,
    serveAceBuildsAsset,
    serveVendorModule,
    isUiAssetPath: (pathname: string) => uiAssetPaths.has(pathname),
  };
};
