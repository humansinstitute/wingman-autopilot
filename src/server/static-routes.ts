import {
  compressResponse,
  type StaticAssetService,
} from "./static-assets";

export const STATIC_ASSET_VERSION = "54";

const SPA_ROUTE_PREFIXES = [
  "/apps",
  "/projects",
  "/todos",
  "/docs",
  "/files",
  "/live",
  "/chat",
  "/settings",
  "/nightwatch",
  "/scheduler",
  "/triggers",
  "/pipelines",
  "/terminal",
];

const SPA_ROUTE_PATHS = new Set([
  "/home",
  "/privacy",
  ...SPA_ROUTE_PREFIXES,
]);

export function isSpaRoutePath(pathname: string): boolean {
  if (SPA_ROUTE_PATHS.has(pathname)) return true;
  return SPA_ROUTE_PREFIXES.some((prefix) => pathname.startsWith(`${prefix}/`));
}

export async function serveIndex(assetVersion = STATIC_ASSET_VERSION): Promise<Response> {
  const url = new URL("../ui/index.html", import.meta.url);
  let html = await Bun.file(url).text();
  html = html.replace(
    /href="\/styles\.css"/,
    `href="/styles.css?v=${assetVersion}"`,
  );
  html = html.replace(
    /src="\/app\.js"/,
    `src="/app.js?v=${assetVersion}"`,
  );
  return new Response(html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-cache",
    },
  });
}

export interface StaticRouteHandlerOptions {
  assetService: StaticAssetService;
  assetVersion?: string;
}

export interface StaticRouteHandler {
  serveBeforeApi: (request: Request, pathname: string) => Promise<Response | undefined>;
  serveAfterApi: (request: Request, pathname: string) => Promise<Response>;
}

export function createStaticRouteHandler(options: StaticRouteHandlerOptions): StaticRouteHandler {
  const { assetService, assetVersion = STATIC_ASSET_VERSION } = options;

  const serveBeforeApi = async (request: Request, pathname: string): Promise<Response | undefined> => {
    if (isSpaRoutePath(pathname) && !assetService.isUiAssetPath(pathname)) {
      return compressResponse(request, await serveIndex(assetVersion));
    }

    const earlyUiAsset = assetService.resolveUiAsset(pathname);
    if (earlyUiAsset) {
      return compressResponse(request, earlyUiAsset);
    }

    return undefined;
  };

  const serveAfterApi = async (request: Request, pathname: string): Promise<Response> => {
    const aceAsset = assetService.serveAceBuildsAsset(pathname);
    if (aceAsset) {
      return compressResponse(request, aceAsset);
    }

    const vendorAsset = await assetService.serveVendorModule(pathname);
    if (vendorAsset) {
      return vendorAsset;
    }

    const assetResponse = assetService.resolveUiAsset(pathname);
    if (assetResponse) {
      return compressResponse(request, assetResponse);
    }

    const publicAsset = assetService.servePublicAsset(pathname);
    if (publicAsset) {
      return compressResponse(request, publicAsset);
    }

    return new Response("Not Found", { status: 404 });
  };

  return {
    serveBeforeApi,
    serveAfterApi,
  };
}
