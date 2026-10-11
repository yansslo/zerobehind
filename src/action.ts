import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import * as cache from "@actions/cache";
import * as core from "@actions/core";
import { createGateway } from "ai";
import { git } from "./core/exec";
import { sync } from "./core/sync";

async function main() {
  const cwd = process.env.GITHUB_WORKSPACE || process.cwd();
  const upstream = core.getInput("upstream", { required: true });
  const token = core.getInput("token", { required: true });
  const apiKey = core.getInput("ai-gateway-api-key");
  const num = (name: string) => {
    const n = Number(core.getInput(name));
    if (!Number.isInteger(n) || n < 0) throw new Error(`\`${name}\` must be a whole number.`);
    return n;
  };

  if (/\/\/[^/]*@/.test(upstream)) core.setSecret(upstream);
  if ((await git(cwd, ["rev-parse", "--git-dir"])).code !== 0)
    throw new Error("No repository found. Add `actions/checkout` with `persist-credentials: false` before zerobehind.");
  if ((await git(cwd, ["config", "--get-regexp", "extraheader"])).code === 0)
    throw new Error("The checkout saved credentials into git config. Set `persist-credentials: false` on `actions/checkout`.");

  // Credentials only live in the env of the git fetch/push calls, never on disk.
  const basic = Buffer.from(`x-access-token:${token}`).toString("base64");
  core.setSecret(basic);
  const authEnv = {
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${basic}`,
  };

  const cacheDir = path.join(process.env.RUNNER_TEMP || "/tmp", "zerobehind-fail");
  const cacheFile = path.join(cacheDir, "summary.md");
  const manualRun = process.env.GITHUB_EVENT_NAME === "workflow_dispatch";

  const outcome = await sync({
    cwd,
    upstream,
    upstreamBranch: core.getInput("upstream-branch") || undefined,
    branch: core.getInput("branch") || undefined,
    authEnv,
    model: apiKey ? createGateway({ apiKey })(core.getInput("model")) : undefined,
    postMerge: core.getInput("post-merge") || undefined,
    test: core.getInput("test") || undefined,
    maxConflictedFiles: num("max-conflicted-files"),
    maxSteps: num("max-steps"),
    maxTokens: num("max-tokens"),
    cachedFailure: manualRun
      ? undefined
      : async (key) => ((await cache.restoreCache([cacheFile], key)) ? readFile(cacheFile, "utf8") : undefined),
    log: core.info,
  });

  core.info(outcome.summary);
  await core.summary.addRaw(outcome.summary).write();
  if (outcome.kind === "clean" || outcome.kind === "adapted") return;

  if (outcome.failureCacheKey) {
    await mkdir(cacheDir, { recursive: true });
    await writeFile(cacheFile, outcome.summary);
    await cache.saveCache([cacheFile], outcome.failureCacheKey).catch((e) => core.warning(`Couldn't save failure cache: ${e.message}`));
  }
  core.setFailed(outcome.kind === "obsolete" ? "Upstream ships the same feature as your custom change. See the job summary." : "Stuck. See the job summary.");
}

// Thrown errors (Gateway outages, push races, network) fail the run without a cache entry, so the next run retries.
main().catch(async (e: Error) => {
  await core.summary.addRaw(`**zerobehind failed:** ${e.message}\n\nNothing was pushed. The next run will try again.`).write().catch(() => {});
  core.setFailed(e.message);
});
