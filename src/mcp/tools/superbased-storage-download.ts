/**
 * MCP Tool: superbased_storage_download_url
 *
 * Get a presigned download URL for a storage object.
 * Proxies through the Wingman server for NIP-98 authentication.
 */

import { z } from "zod";

export const superbasedStorageDownloadSchema = {
  object_id: z
    .string()
    .describe("UUID of the storage object to download."),
  base_url: z
    .string()
    .optional()
    .describe("SuperBased API base URL. Uses SUPERBASED_URL env var if omitted."),
};

export const superbasedStorageDownloadDescription =
  "Get a presigned download URL for a storage object from SuperBased / Flux Adaptor. " +
  "Returns a temporary URL (with expiry) that can be used to download the file directly. " +
  "Authenticates via NIP-98 using the user's bot key.";

interface SuperbasedStorageDownloadParams {
  object_id: string;
  base_url?: string;
}

export async function handleSuperbasedStorageDownload(
  params: SuperbasedStorageDownloadParams,
  wingmanUrl: string,
  _sessionId: string,
) {
  try {
    const query = new URLSearchParams();
    if (params.base_url) {
      query.set("base_url", params.base_url);
    }
    const userNpub = process.env.USER_NPUB;
    if (userNpub) query.set("user_npub", userNpub);

    const qs = query.toString();
    const url = `${wingmanUrl}/api/superbased/storage/${encodeURIComponent(params.object_id)}/download-url${qs ? `?${qs}` : ""}`;
    const response = await fetch(url);

    if (!response.ok) {
      const error = await response.text();
      return {
        isError: true,
        content: [
          {
            type: "text" as const,
            text: `Storage download URL failed (${response.status}): ${error}`,
          },
        ],
      };
    }

    const result = await response.json() as { download_url: string; expires_in_seconds: number };

    return {
      content: [
        {
          type: "text" as const,
          text: `Download URL (expires in ${result.expires_in_seconds}s):\n${result.download_url}`,
        },
      ],
    };
  } catch (err) {
    return {
      isError: true,
      content: [
        {
          type: "text" as const,
          text: `Failed to get storage download URL: ${(err as Error).message}`,
        },
      ],
    };
  }
}
