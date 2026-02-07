/**
 * MCP Tool: deploy_caprover_app
 *
 * Deploy a CapRover app using a Docker image.
 */

import { z } from "zod";

export const deployCaproverAppSchema = {
  app_id: z
    .string()
    .describe("The CapRover app tracking ID (from list_caprover_apps)"),
  docker_image: z
    .string()
    .describe("Docker image to deploy (e.g. 'myregistry/myapp:latest')"),
  git_hash: z
    .string()
    .optional()
    .describe("Git commit hash to associate with this deployment"),
};

export const deployCaproverAppDescription =
  "Deploy a CapRover app from a Docker image. Use list_caprover_apps " +
  "first to find the app tracking ID. Returns the deployment result " +
  "including the new version number.";

interface DeployCaproverAppParams {
  app_id: string;
  docker_image: string;
  git_hash?: string;
}

export async function handleDeployCaproverApp(
  params: DeployCaproverAppParams,
  wingmanUrl: string,
  sessionId: string,
) {
  const { app_id, docker_image, git_hash } = params;

  try {
    const response = await fetch(
      `${wingmanUrl}/api/mcp/wingman/caprover/deploy`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId,
          appId: app_id,
          dockerImage: docker_image,
          gitHash: git_hash,
        }),
      },
    );

    if (!response.ok) {
      const error = await response.text();
      return {
        isError: true,
        content: [
          {
            type: "text" as const,
            text: `Deployment failed (${response.status}): ${error}`,
          },
        ],
      };
    }

    const result = await response.json();
    return {
      content: [
        {
          type: "text" as const,
          text: [
            `Deployment successful`,
            `  App: ${result.caproverName}`,
            `  Image: ${result.dockerImage}`,
            `  Version: ${result.deployedVersion ?? "unknown"}`,
          ].join("\n"),
        },
      ],
    };
  } catch (err) {
    return {
      isError: true,
      content: [
        {
          type: "text" as const,
          text: `Failed to reach Wingman server: ${(err as Error).message}`,
        },
      ],
    };
  }
}
