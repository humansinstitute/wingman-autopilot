import { describe, expect, test } from "bun:test";

import { buildUserAppSpawnPlan } from "./app-runner";

describe("buildUserAppSpawnPlan", () => {
  test("overlays managed app env after .env and before Wingman runtime values", async () => {
    const plan = await buildUserAppSpawnPlan(
      {
        appId: "app-1",
        appLabel: "Demo App",
        appRoot: "/tmp/demo-app",
        startScript: "bun run start",
        userAlias: "owner",
        port: "4100",
      },
      {
        hostEnv: {
          API_TOKEN: "from-host",
          HOST_ONLY: "yes",
          PORT: "3000",
        },
        envFileReader: async () => ({
          API_TOKEN: "from-dotenv",
          DOTENV_ONLY: "yes",
        }),
        appEnvReader: async () => ({
          API_TOKEN: "from-card",
          APP_ID: "ignored-by-runtime",
        }),
        redshiftDetector: async () => false,
      },
    );

    expect(plan.env.API_TOKEN).toBe("from-card");
    expect(plan.env.HOST_ONLY).toBe("yes");
    expect(plan.env.DOTENV_ONLY).toBe("yes");
    expect(plan.env.APP_ID).toBe("app-1");
    expect(plan.env.PORT).toBe("4100");
  });
});
