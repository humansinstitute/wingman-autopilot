import { describe, expect, test } from "bun:test";

import { CloudflareTunnelClient, createCloudflareTunnelClientFromEnv } from "./tunnel-hostnames";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("createCloudflareTunnelClientFromEnv", () => {
  test("requires all Cloudflare tunnel settings", () => {
    expect(createCloudflareTunnelClientFromEnv({})).toBeNull();
    expect(createCloudflareTunnelClientFromEnv({
      CLOUDFLARE_API_TOKEN: "token",
      CLOUDFLARE_ACCOUNT_ID: "account",
      CLOUDFLARE_TUNNEL_ID: "tunnel",
      CLOUDFLARE_ZONE_ID: "zone",
    })).toBeInstanceOf(CloudflareTunnelClient);
  });
});

describe("CloudflareTunnelClient", () => {
  test("upserts ingress before catch-all and creates a proxied CNAME", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = async (url: string | URL | Request, init?: RequestInit) => {
      const href = String(url);
      calls.push({ url: href, init: init ?? {} });
      if (href.includes("/configurations") && init?.method === "GET") {
        return jsonResponse({
          success: true,
          result: {
            config: {
              ingress: [
                { hostname: "rick.runwingman.com", service: "http://localhost:3600" },
                { service: "http_status:404" },
              ],
            },
          },
        });
      }
      if (href.includes("/configurations") && init?.method === "PUT") {
        return jsonResponse({ success: true, result: {} });
      }
      if (href.includes("/dns_records?")) {
        return jsonResponse({ success: true, result: [] });
      }
      if (href.endsWith("/dns_records") && init?.method === "POST") {
        return jsonResponse({
          success: true,
          result: {
            id: "dns-1",
            type: "CNAME",
            name: "brandname.com",
            content: "tunnel-1.cfargotunnel.com",
            proxied: true,
          },
        });
      }
      throw new Error(`unexpected request: ${href}`);
    };

    const client = new CloudflareTunnelClient({
      apiToken: "token",
      accountId: "account",
      tunnelId: "tunnel-1",
      zoneId: "zone",
      fetchImpl: fetchImpl as typeof fetch,
    });
    const result = await client.upsertPublicHostname({
      hostname: "BrandName.com",
      serviceUrl: "http://localhost:3600",
    });

    expect(result).toMatchObject({
      hostname: "brandname.com",
      serviceUrl: "http://localhost:3600",
      cnameTarget: "tunnel-1.cfargotunnel.com",
      dnsRecordId: "dns-1",
    });
    const putCall = calls.find((call) => call.init.method === "PUT");
    expect(JSON.parse(String(putCall?.init.body))).toEqual({
      config: {
        ingress: [
          { hostname: "rick.runwingman.com", service: "http://localhost:3600" },
          { hostname: "brandname.com", service: "http://localhost:3600" },
          { service: "http_status:404" },
        ],
      },
    });
    const dnsCall = calls.find((call) => call.init.method === "POST");
    expect(JSON.parse(String(dnsCall?.init.body))).toMatchObject({
      type: "CNAME",
      name: "brandname.com",
      content: "tunnel-1.cfargotunnel.com",
      proxied: true,
    });
  });

  test("verification fails when httpHostHeader is overridden", async () => {
    const fetchImpl = async (url: string | URL | Request, init?: RequestInit) => {
      const href = String(url);
      if (href.includes("/configurations") && init?.method === "GET") {
        return jsonResponse({
          success: true,
          result: {
            config: {
              ingress: [
                {
                  hostname: "brandname.com",
                  service: "http://localhost:3600",
                  originRequest: { httpHostHeader: "rick.runwingman.com" },
                },
                { service: "http_status:404" },
              ],
            },
          },
        });
      }
      if (href.includes("/dns_records?")) {
        return jsonResponse({
          success: true,
          result: [
            {
              id: "dns-1",
              type: "CNAME",
              name: "brandname.com",
              content: "tunnel-1.cfargotunnel.com",
              proxied: true,
            },
          ],
        });
      }
      throw new Error(`unexpected request: ${href}`);
    };

    const client = new CloudflareTunnelClient({
      apiToken: "token",
      accountId: "account",
      tunnelId: "tunnel-1",
      zoneId: "zone",
      fetchImpl: fetchImpl as typeof fetch,
    });

    const result = await client.verifyPublicHostname({
      hostname: "brandname.com",
      serviceUrl: "http://localhost:3600",
    });

    expect(result).toMatchObject({
      hasIngress: true,
      hasDnsRecord: true,
      httpHostHeaderOverridden: true,
      active: false,
    });
  });
});
