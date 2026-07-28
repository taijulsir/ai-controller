import { describe, expect, it } from "vitest";
import { buildGithubCommitUrl, buildGithubTreeUrl, parseGithubRemote } from "../GithubUrl";

describe("parseGithubRemote", () => {
  it("parses an SSH github.com remote", () => {
    expect(parseGithubRemote("git@github.com:taijulsir/ai-controller.git")).toEqual({ owner: "taijulsir", repo: "ai-controller" });
  });

  it("parses an HTTPS github.com remote", () => {
    expect(parseGithubRemote("https://github.com/taijulsir/ai-controller.git")).toEqual({ owner: "taijulsir", repo: "ai-controller" });
  });

  it("parses an HTTPS github.com remote with no .git suffix", () => {
    expect(parseGithubRemote("https://github.com/taijulsir/ai-controller")).toEqual({ owner: "taijulsir", repo: "ai-controller" });
  });

  it("returns undefined for a non-github.com remote", () => {
    expect(parseGithubRemote("git@gitlab.com:taijulsir/ai-controller.git")).toBeUndefined();
  });

  it("returns undefined for a local filesystem remote", () => {
    expect(parseGithubRemote("/tmp/some-bare-repo.git")).toBeUndefined();
  });
});

describe("buildGithubCommitUrl", () => {
  it("builds a commit URL for a recognized remote", () => {
    expect(buildGithubCommitUrl("git@github.com:taijulsir/ai-controller.git", "abc123")).toBe(
      "https://github.com/taijulsir/ai-controller/commit/abc123",
    );
  });

  it("returns undefined for an unrecognized remote", () => {
    expect(buildGithubCommitUrl("git@bitbucket.org:taijulsir/ai-controller.git", "abc123")).toBeUndefined();
  });
});

describe("buildGithubTreeUrl", () => {
  it("builds a tree URL for a recognized remote", () => {
    expect(buildGithubTreeUrl("https://github.com/taijulsir/ai-controller.git", "main")).toBe(
      "https://github.com/taijulsir/ai-controller/tree/main",
    );
  });

  it("URL-encodes a branch name with special characters", () => {
    expect(buildGithubTreeUrl("https://github.com/taijulsir/ai-controller.git", "feature/my branch")).toBe(
      "https://github.com/taijulsir/ai-controller/tree/feature%2Fmy%20branch",
    );
  });

  it("returns undefined for an unrecognized remote", () => {
    expect(buildGithubTreeUrl("git@gitlab.com:taijulsir/ai-controller.git", "main")).toBeUndefined();
  });
});
