if (!Bun.env.IDENTITY_SESSION_SECRET) {
  Bun.env.IDENTITY_SESSION_SECRET = "TestSecretValue_With-Numbers123!AndSymbols@2026";
}

import { describe, expect, test } from "bun:test";

import {
  hydrateAppEnv,
  parseAppEnvInput,
  redactAppEnv,
  serialiseAppEnvForStorage,
} from "./app-env";

describe("app env helpers", () => {
  test("parses retained and changed entries without exposing values", () => {
    const parsed = parseAppEnvInput(
      [
        { key: "OPENAI_API_KEY", retain: true },
        { key: "APP_MODE", value: "demo" },
      ],
      { OPENAI_API_KEY: "sk-existing" },
    );

    expect(parsed).toEqual({
      APP_MODE: "demo",
      OPENAI_API_KEY: "sk-existing",
    });
    expect(redactAppEnv(parsed)).toEqual([
      { key: "APP_MODE", hasValue: true },
      { key: "OPENAI_API_KEY", hasValue: true },
    ]);
  });

  test("encrypts values for storage and hydrates them for runtime use", () => {
    const stored = serialiseAppEnvForStorage({ API_TOKEN: "secret-token" });

    expect(stored?.API_TOKEN).toStartWith("enc::");
    expect(stored?.API_TOKEN).not.toContain("secret-token");
    expect(hydrateAppEnv(stored)).toEqual({ API_TOKEN: "secret-token" });
  });

  test("rejects reserved runtime keys", () => {
    expect(() => parseAppEnvInput([{ key: "APP_ID", value: "override" }])).toThrow(
      "managed by Wingman",
    );
  });
});
