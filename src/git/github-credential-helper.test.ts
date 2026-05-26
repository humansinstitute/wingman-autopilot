import { describe, expect, test } from "bun:test";

import { buildGitHubGitEnv } from "./github-credential-helper";

describe("buildGitHubGitEnv", () => {
  test("injects GitHub credentials and commit identity", () => {
    const env = buildGitHubGitEnv(
      {
        username: "mini",
        token: "ghp_secret",
        authorName: "Mini User",
        authorEmail: "mini@users.noreply.github.com",
      },
      "/tmp/github-helper.sh",
    );

    expect(env.WINGMAN_GITHUB_USERNAME).toBe("mini");
    expect(env.WINGMAN_GITHUB_TOKEN).toBe("ghp_secret");
    expect(env.GIT_CONFIG_KEY_0).toBe("credential.https://github.com.helper");
    expect(env.GIT_CONFIG_VALUE_0).toBe("/tmp/github-helper.sh");
    expect(env.GIT_AUTHOR_NAME).toBe("Mini User");
    expect(env.GIT_AUTHOR_EMAIL).toBe("mini@users.noreply.github.com");
    expect(env.GIT_COMMITTER_NAME).toBe("Mini User");
    expect(env.GIT_COMMITTER_EMAIL).toBe("mini@users.noreply.github.com");
  });

  test("does not override git identity without a commit email", () => {
    const env = buildGitHubGitEnv(
      {
        username: "mini",
        token: "ghp_secret",
        authorName: "Mini User",
        authorEmail: null,
      },
      "/tmp/github-helper.sh",
    );

    expect(env.GIT_AUTHOR_NAME).toBeUndefined();
    expect(env.GIT_AUTHOR_EMAIL).toBeUndefined();
    expect(env.GIT_COMMITTER_NAME).toBeUndefined();
    expect(env.GIT_COMMITTER_EMAIL).toBeUndefined();
  });
});
