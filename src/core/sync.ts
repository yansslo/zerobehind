import path from "node:path";
import type { LanguageModel } from "ai";
import { findMarkers, newSession, runAgent, type AgentConfig } from "./agent";
import { git, gitOk, runCommand } from "./exec";

export type SyncOptions = {
  /** A checkout of the fork with `origin` pointing at it. */
  cwd: string;
  /** `owner/repo` or any git URL. */
  upstream: string;
  upstreamBranch?: string;
  branch?: string;
  /** Extra env for git fetch/push (credentials via GIT_CONFIG_*), never written to disk. */
  authEnv?: Record<string, string>;
  /** Without a model, any conflict or failing test means stuck. */
  model?: LanguageModel;
  postMerge?: string;
  test?: string;
  maxConflictedFiles: number;
  maxSteps: number;
  maxTokens: number;
  /** Returns the saved summary if this exact upstream/fork pair already failed. */
  cachedFailure?: (key: string) => Promise<string | undefined>;
  log: (msg: string) => void;
};

export type Outcome = {
  kind: "clean" | "adapted" | "obsolete" | "stuck";
  /** Markdown for the job summary. */
  summary: string;
  /** Set when this failure should be saved to the failure cache. */
  failureCacheKey?: string;
  tokens: number;
};

const UP = "refs/zerobehind/upstream";
const MERGE_RE = /^Merge upstream .+@([0-9a-f]{40}) \(zerobehind\)$/;
const REPAIR_SUBJECT = "zerobehind: adapt custom code to upstream";

const LOCKFILES: Record<string, string> = {
  "package-lock.json": "npm install",
  "yarn.lock": "yarn install",
  "pnpm-lock.yaml": "pnpm install",
  "bun.lock": "bun install",
  "Cargo.lock": "cargo generate-lockfile",
  "poetry.lock": "poetry lock",
  "Gemfile.lock": "bundle install",
  "go.sum": "go mod tidy",
};

const paths = (s: string) => s.split("\0").filter(Boolean);
const list = (files: string[]) => files.map((f) => `- \`${f}\``).join("\n");
const block = (output: string) => "```\n" + output + "\n```";
const testWarning = (files: Iterable<string>) => {
  const f = [...files];
  return f.length ? `⚠️ agent changed these tests: ${f.join(", ")}` : "";
};

export async function sync(o: SyncOptions): Promise<Outcome> {
  const { cwd, log } = o;
  const auth = o.authEnv ?? {};
  const url = /^[\w.-]+\/[\w.-]+$/.test(o.upstream) ? `https://github.com/${o.upstream}.git` : o.upstream;
  const noCreds = (u: string) => u.replace(/\/\/[^/@]*@/, "//"); // never put URL credentials in commits or logs
  const name = noCreds(o.upstream);
  const session = newSession();

  // 1. Fetch
  const branch = o.branch || (await defaultBranch(cwd, "origin", auth));
  const upBranch = o.upstreamBranch || (await defaultBranch(cwd, url, auth));
  const shallow = (await gitOk(cwd, ["rev-parse", "--is-shallow-repository"])) === "true";
  log(`Fetching ${branch} and ${name} ${upBranch}`);
  await gitOk(cwd, ["fetch", "-q", "--no-tags", ...(shallow ? ["--unshallow"] : []), "origin", `+refs/heads/${branch}:refs/remotes/origin/${branch}`], auth);
  await gitOk(cwd, ["fetch", "-q", "--no-tags", url, `+refs/heads/${upBranch}:${UP}`], auth);
  await gitOk(cwd, ["checkout", "-q", "-f", "-B", branch, `refs/remotes/origin/${branch}`]);
  const forkSha = await gitOk(cwd, ["rev-parse", "HEAD"]);
  const upSha = await gitOk(cwd, ["rev-parse", UP]);
  const label = `${name}@${upSha}`;
  const failKey = `zerobehind-fail-${upSha}-${forkSha}`;

  const manual = `To sync by hand: \`git pull ${noCreds(url)} ${upBranch}\`, fix what's broken, and push. The next run continues from there.`;
  const stuck = (why: string): Outcome => ({
    kind: "stuck",
    summary: `${testWarning(session.testEdits)}\n\n**zerobehind couldn't sync with \`${label}\`, so nothing was pushed.**\n\n${why}\n\n${manual}`.trim(),
    failureCacheKey: failKey,
    tokens: session.tokens,
  });
  const cantHelp = (why: string) => stuck(`This tool can no longer help with this fork: ${why} Bring the fork back in line with upstream by hand (or re-fork) to use zerobehind again.`);

  // 2. Sanity checks
  const baseR = await git(cwd, ["merge-base", "HEAD", UP]);
  if (baseR.code !== 0) return cantHelp("the fork and upstream share no history.");
  const base = baseR.stdout.trim();
  const lastSubject = await gitOk(cwd, ["log", "-1", "--first-parent", "--merges", "-F", "--grep=(zerobehind)", "--format=%s", "HEAD"]);
  const lastSynced = lastSubject.match(MERGE_RE)?.[1];
  if (lastSynced && (await git(cwd, ["merge-base", "--is-ancestor", lastSynced, UP])).code !== 0)
    return cantHelp(`the last synced upstream commit ${lastSynced} is no longer in upstream's history (upstream was force-pushed or squashed).`);

  // 3. Nothing new
  if ((await git(cwd, ["merge-base", "--is-ancestor", UP, "HEAD"])).code === 0)
    return { kind: "clean", summary: `Already up to date with \`${label}\`.`, tokens: 0 };

  // 4. Failure cache
  const cached = await o.cachedFailure?.(failKey);
  if (cached) return { kind: "stuck", summary: `${cached}\n\n_Saved result from an earlier run with the same commits. Run the workflow manually to retry._`, tokens: 0 };

  // 5. Baseline
  if (o.test) {
    if (o.postMerge) {
      log("Baseline: running post-merge on the fork as it is");
      const r = await runCommand(cwd, o.postMerge);
      if (!r.ok) return stuck(`\`post-merge\` already fails on your fork before merging; fix it first.\n\n${block(r.output)}`);
    }
    log("Baseline: running test on the fork as it is");
    const r = await runCommand(cwd, o.test);
    if (!r.ok) return stuck(`Your fork's tests already fail before merging upstream; fix them first.\n\n${block(r.output)}`);
    await gitOk(cwd, ["reset", "-q", "--hard"]);
  }

  // 6. Merge
  log(`Merging ${label}`);
  const merge = await git(cwd, ["merge", "-q", "--no-ff", "--no-commit", UP]);
  let conflicted = paths(await gitOk(cwd, ["diff", "-z", "--name-only", "--diff-filter=U"]));
  if (merge.code !== 0 && !conflicted.length) throw new Error(`git merge failed: ${merge.stderr.trim() || merge.stdout.trim()}`);

  // 7. Lockfiles: take upstream's, post-merge regenerates
  const locks = conflicted.filter((f) => path.posix.basename(f) in LOCKFILES);
  if (locks.length) {
    const cmd = LOCKFILES[path.posix.basename(locks[0])];
    if (!o.postMerge)
      return stuck(`Lockfile conflict in ${locks.map((f) => `\`${f}\``).join(", ")}. Add \`post-merge: ${cmd}\` to the workflow so zerobehind can regenerate it, or merge by hand, take upstream's lockfile, and run \`${cmd}\`.`);
    for (const f of locks) {
      if ((await git(cwd, ["checkout", "--theirs", "--", f])).code === 0) await gitOk(cwd, ["add", "--", f]);
      else await gitOk(cwd, ["rm", "-q", "--", f]); // upstream deleted it
    }
    conflicted = conflicted.filter((f) => !locks.includes(f));
  }

  // 8. Pre-check
  if (conflicted.length > o.maxConflictedFiles)
    return stuck(`${conflicted.length} files conflict, more than the limit of ${o.maxConflictedFiles} (\`max-conflicted-files\`):\n\n${list(conflicted)}`);
  const unmergeable = await binaryOrSubmoduleConflicts(cwd);
  if (unmergeable.length) return stuck(`Binary or submodule conflicts can't be resolved automatically:\n\n${list(unmergeable)}`);
  const workflows = conflicted.filter((f) => f.startsWith(".github/workflows/"));
  if (workflows.length) return stuck(`Workflow files conflict, and zerobehind never edits workflows:\n\n${list(workflows)}`);
  if (conflicted.length && !o.model)
    return stuck(`Merge conflicts in:\n\n${list(conflicted)}\n\nAdd an \`ai-gateway-api-key\` to let zerobehind resolve conflicts.`);

  // Context for the agent
  const forkChanged = paths(await gitOk(cwd, ["diff", "-z", "--name-only", base, forkSha]));
  const editable = new Set([...conflicted, ...forkChanged].filter((f) => !f.startsWith(".github/workflows/")));
  const agentCfg: AgentConfig | undefined = o.model && {
    cwd, model: o.model, editable, conflicted, test: o.test, postMerge: o.postMerge, maxSteps: o.maxSteps, maxTokens: o.maxTokens, log,
  };
  const context = await agentContext(cwd, name, upSha, [...editable]);

  // 9. Stage 1: conflicts
  let mergeNotes = "";
  if (conflicted.length) {
    log(`Stage 1: the agent resolves conflicts in ${conflicted.join(", ")}`);
    const v = await runAgent(agentCfg!, session, `${context}\n\n## Conflicted files\n${list(conflicted)}\n\nResolve the merge conflicts.`);
    if (v.verdict === "obsolete") return obsolete(label, upBranch, manual, v.notes, failKey, session.tokens);
    if (v.verdict === "stuck") return stuck(`The agent couldn't resolve the conflicts:\n\n${v.notes}`);
    const leftover = await filesWithMarkers(cwd, conflicted);
    if (leftover.length) return stuck(`Conflict markers are still in:\n\n${list(leftover)}`);
    const dropped = await keptOnlyUpstream(cwd, conflicted);
    if (dropped.length)
      return obsolete(label, upBranch, manual, `The agent resolved these files by keeping only upstream's version, which would drop your custom changes in them:\n\n${list(dropped)}\n\n${v.notes}`, failKey, session.tokens);
    mergeNotes = v.notes;
  }
  const stage1TestEdits = new Set(session.testEdits);
  const resolved = [...new Set([...conflicted, ...session.edited])];
  if (resolved.length) await gitOk(cwd, ["add", "--", ...resolved]);
  await gitOk(cwd, ["commit", "-q", "--no-verify", "-m", [`Merge upstream ${label} (zerobehind)`, testWarning(stage1TestEdits), mergeNotes].filter(Boolean).join("\n\n")]);
  await gitOk(cwd, ["reset", "-q", "--hard"]); // drop side effects of the agent's commands; only scoped edits were committed

  // 10. post-merge (its changes, e.g. a regenerated lockfile, belong to the merge) and test
  if (o.postMerge) {
    log("Running post-merge");
    const r = await runCommand(cwd, o.postMerge);
    if (!r.ok) return stuck(`\`post-merge\` failed after merging:\n\n${block(r.output)}`);
    if (await stageTracked(cwd)) await gitOk(cwd, ["commit", "-q", "--no-verify", "--amend", "--no-edit"]);
  }
  let repairNotes = "";
  if (o.test) {
    log("Running test");
    const r = await runCommand(cwd, o.test);
    if (!r.ok) {
      // 11. Stage 2: repair
      if (!agentCfg) return stuck(`Tests fail after merging upstream:\n\n${block(r.output)}\n\nAdd an \`ai-gateway-api-key\` to let zerobehind adapt your code.`);
      log("Stage 2: the agent adapts custom code so tests pass");
      const prompt = `${conflicted.length ? "" : context + "\n\n"}The merge is committed, but \`test\` fails. Adapt the fork's custom code to upstream so it passes.\n\n${block(r.output)}`;
      const v = await runAgent(agentCfg, session, prompt);
      if (v.verdict === "obsolete") return obsolete(label, upBranch, manual, v.notes, failKey, session.tokens);
      if (v.verdict === "stuck") return stuck(`Tests fail after merging upstream and the agent couldn't fix them:\n\n${v.notes}\n\n${block(r.output)}`);
      repairNotes = v.notes;

      // 12. Re-check outside the agent: only scoped edits count, then post-merge + test
      const edited = [...session.edited];
      if (edited.length) await gitOk(cwd, ["add", "--", ...edited]);
      await gitOk(cwd, ["checkout", "-q", "--", "."]);
      const leftover = await filesWithMarkers(cwd, edited);
      if (leftover.length) return stuck(`The agent left conflict markers in:\n\n${list(leftover)}`);
      if (o.postMerge) {
        const pm = await runCommand(cwd, o.postMerge);
        if (!pm.ok) return stuck(`\`post-merge\` fails after the agent's repair:\n\n${block(pm.output)}`);
        await stageTracked(cwd);
      }
      const t = await runCommand(cwd, o.test);
      if (!t.ok) return stuck(`Tests still fail after the agent's repair:\n\n${block(t.output)}\n\nAgent notes:\n\n${repairNotes}`);
      const repairTestEdits = [...session.testEdits].filter((f) => !stage1TestEdits.has(f));
      if ((await git(cwd, ["diff", "--cached", "--quiet"])).code !== 0)
        await gitOk(cwd, ["commit", "-q", "--no-verify", "-m", [REPAIR_SUBJECT, testWarning(repairTestEdits), repairNotes].filter(Boolean).join("\n\n")]);
    }
  }

  // 13. Push, never forced
  log(`Pushing to ${branch}`);
  const push = await git(cwd, ["push", "-q", "origin", `HEAD:refs/heads/${branch}`], auth);
  if (push.code !== 0) throw new Error(`Push rejected (did someone push to ${branch} during the run?). The next run will retry.\n${push.stderr.trim()}`);

  const adapted = session.steps > 0;
  const notes = [mergeNotes && `**Conflict resolution:**\n\n${mergeNotes}`, repairNotes && `**Repair** (separate commit, undo with \`git revert\`):\n\n${repairNotes}`].filter(Boolean).join("\n\n");
  return {
    kind: adapted ? "adapted" : "clean",
    summary: [testWarning(session.testEdits), `**Synced with \`${label}\`**${adapted ? ", with the agent adapting your code." : "."}`, notes, adapted ? `Tokens used: ${session.tokens}` : ""].filter(Boolean).join("\n\n"),
    tokens: session.tokens,
  };
}

function obsolete(label: string, upBranch: string, manual: string, notes: string, failureCacheKey: string, tokens: number): Outcome {
  return {
    kind: "obsolete",
    summary: `**Upstream \`${label}\` seems to ship the same feature as one of your custom changes, so nothing was pushed.** zerobehind never drops your code on its own.\n\nAgent notes:\n\n${notes}\n\nTo finish: merge upstream \`${upBranch}\` by hand, remove your custom version, check that tests pass, and push.\n\n${manual}`,
    failureCacheKey,
    tokens,
  };
}

async function defaultBranch(cwd: string, remote: string, auth: Record<string, string>): Promise<string> {
  const out = await gitOk(cwd, ["ls-remote", "--symref", remote, "HEAD"], auth);
  const m = out.match(/^ref: refs\/heads\/(\S+)\tHEAD/m);
  if (!m) throw new Error(`Couldn't find the default branch of ${remote === "origin" ? "the fork" : "upstream"}; set it explicitly.`);
  return m[1];
}

/** Stages changes to tracked files. Returns true if anything is staged. */
async function stageTracked(cwd: string): Promise<boolean> {
  await gitOk(cwd, ["add", "-u"]);
  return (await git(cwd, ["diff", "--cached", "--quiet"])).code !== 0;
}

async function binaryOrSubmoduleConflicts(cwd: string): Promise<string[]> {
  const bad = new Set<string>();
  for (const entry of paths(await gitOk(cwd, ["ls-files", "-u", "-z"]))) {
    const [meta, file] = entry.split("\t");
    const [mode, sha] = meta.split(" ");
    if (mode === "160000" || (await git(cwd, ["cat-file", "blob", sha])).stdout.slice(0, 8000).includes("\0")) bad.add(file);
  }
  return [...bad];
}

/** Conflicted files whose resolution is exactly upstream's side: the fork's change there was thrown away. */
async function keptOnlyUpstream(cwd: string, files: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const f of files) {
    const theirs = await git(cwd, ["rev-parse", "-q", "--verify", `:3:${f}`]);
    const resolved = await git(cwd, ["hash-object", "--", f]);
    if (theirs.code === 0 && resolved.code === 0 && theirs.stdout.trim() === resolved.stdout.trim()) out.push(f);
  }
  return out;
}

const filesWithMarkers = async (cwd: string, files: string[]) => (await findMarkers(cwd, files)).map(([f]) => f);

async function agentContext(cwd: string, name: string, upSha: string, editable: string[]): Promise<string> {
  // During the merge HEAD is still the fork, so this is `git log --no-merges upstream..fork`.
  const custom = await gitOk(cwd, ["log", "--no-merges", "-n", "50", "--format=- %h %s%n%w(0,2,2)%b", `${UP}..HEAD`]);
  const incoming = await gitOk(cwd, ["log", "--no-merges", "-n", "50", "--format=- %h %s", `HEAD..${UP}`]);
  return `Upstream \`${name}@${upSha}\` has been merged into this fork.

## The fork's custom commits (newest first; their messages describe the intent)
${custom || "(none)"}

## Upstream commits being merged (newest first, up to 50)
${incoming}

## Files you may edit
${list(editable)}`;
}
