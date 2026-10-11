# zerobehind — MVP design

## What it is

A GitHub Action that keeps a fork in sync with its upstream repo. It merges upstream into the fork on a schedule. If that causes conflicts or failing tests, an AI agent fixes them within strict limits. The tool then re-checks the result and pushes it. If it can't fix things safely, the run fails with a plain explanation and nothing is pushed.

Goal: the user never resolves a sync by hand unless the agent truly can't.

## Usage

```yaml
on:
  schedule: [{ cron: "0 6 * * *" }]
  workflow_dispatch:
concurrency: { group: zerobehind, cancel-in-progress: false }
jobs:
  sync:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6
        with: { persist-credentials: false }   # required, see below
      - uses: actions/checkout@v5
        with: { persist-credentials: false }
      - uses: actions/setup-node@v4        # user's own environment setup
        with: { node-version-file: .nvmrc }
      - uses: yansslo/zerobehind@v1
        with:
          upstream: owner/repo
          token: ${{ secrets.ZEROBEHIND_TOKEN }}
          ai-gateway-api-key: ${{ secrets.AI_GATEWAY_API_KEY }}
          post-merge: npm install          # optional
          test: npm test                   # optional
```

`actions/checkout` comes first so the user's setup steps can read repo files (`.nvmrc`, lockfiles for caching, etc.). zerobehind then works in that checkout (`$GITHUB_WORKSPACE`). It does its own fetching and pushing with `token`, so the checkout doesn't need `fetch-depth: 0` (zerobehind unshallows it). `persist-credentials: false` is required: otherwise checkout leaves its `GITHUB_TOKEN` in the git config, where the merged code could read it and where it would clash with our token on push. To sync more than one branch, add another step with a different `branch:`.

## Inputs (all config lives in `with:`)

| Input | Default | Notes |
|---|---|---|
| `upstream` | required | `owner/repo` or any git URL (private mirrors, non-GitHub hosts). GitHub upstreams are fetched with `token`, so private ones work if the token can read them. Other hosts need credentials in the URL. |
| `upstream-branch` | upstream default branch | |
| `branch` | fork default branch | |
| `token` | required | Fine-grained PAT (Contents + Workflows write) or a GitHub App token. `GITHUB_TOKEN` can't push workflow file changes. |
| `ai-gateway-api-key` | optional | Vercel AI Gateway key. Without it, any conflict means "stuck", so the tool works as a free auto-syncer. Users who want to pay their provider directly can add their own Anthropic/OpenAI/etc. key in the Gateway (BYOK). |
| `model` | `anthropic/claude-sonnet-5.5` | Any Gateway model ID in `provider/model` form, e.g. `openai/gpt-5`. Passed to the Gateway as-is. |
| `post-merge` | none | Runs after merging, e.g. `npm install` |
| `test` | none | Decides whether the result is good |
| `max-conflicted-files` | `10` | Above this, stop without calling the model |
| `max-steps` | `30` | Agent turn limit |
| `max-tokens` | `1000000` | Agent token limit per run (input + output, summed over all steps). Placeholder default, tune it from the evaluation runs. |

## Core decisions

- **Merge, not rebase.** Merge upstream into the fork branch and push normally (never force-push). Local clones just `git pull`. A messy history is accepted (`git log --first-parent` gives the clean view).
- **The user's custom changes** = `git log --no-merges upstream/<branch>..<branch>`. **Intent comes from commit messages.** We recommend squash-merging your own feature PRs so each feature is one clear commit.
- **No PRs and no issues.** The bot pushes directly. When it needs the user, it fails the run.
- **Merge commit format:** `Merge upstream owner/repo@<sha> (zerobehind)`. The body holds the agent's notes as a permanent record. The SHA is how the next run knows what was last merged.
- **Commit author:** `zerobehind[bot] <zerobehind[bot]@users.noreply.github.com>` for every commit the tool makes, so it's obvious a bot made them. (It shows as plain text, not a linked GitHub account, until there's a GitHub App.)
- **The agent's repair edits go in a separate commit** (`zerobehind: adapt custom code to upstream`), so the user can undo them with a plain `git revert <commit>`. Conflict resolutions have to live inside the merge commit, because git requires that.

## Flow

1. **Prepare the checkout.** If git config (including files it pulls in with `include`/`includeIf`) has a stored `http.*.extraheader` or credential helper → error: "set `persist-credentials: false` on actions/checkout." Then fetch the fork branch and upstream with `token` passed per command (`git -c http.extraheader=…`), unshallow if needed, and check out `branch`.
2. **Sanity checks.** If the fork and upstream share no history, error: "this tool can no longer help, here's why." If there's an earlier zerobehind merge commit and its upstream SHA is no longer in upstream's history (force-push, or a squashed sync), same error. On the first run there's no earlier merge commit, so only the shared-history check applies.
3. If upstream has nothing new, exit successfully.
4. **Failure cache.** If cache key `zerobehind-fail-<upstreamSHA>-<forkSHA>` exists, fail fast with the saved summary and no model call. Manual (`workflow_dispatch`) runs skip this check.
5. **Baseline.** If `test` is set, run `post-merge` then `test` on the fork as it is, before merging. If tests already fail → stop with "your fork's tests already fail; fix them first." This keeps the agent from chasing failures the merge didn't cause.
6. `git merge upstream/<branch>`.
7. Lockfile conflicts (`package-lock.json`, `yarn.lock`, `pnpm-lock.yaml`, `bun.lock`, `Cargo.lock`, `poetry.lock`, `Gemfile.lock`, `go.sum`): take upstream's version, and `post-merge` regenerates it. If there's no `post-merge`, the run is stuck with a one-command fix.
8. **Pre-check.** More than `max-conflicted-files` conflicted files, binary or submodule conflicts, or no `ai-gateway-api-key` with conflicts present → stuck, with no model call.
9. **Stage 1, conflicts.** If any exist, the agent resolves them. The harness checks for leftover conflict markers and scope violations, then creates the merge commit. (A clean merge gets its merge commit straight away.)
10. Run `post-merge`, then `test`.
11. **Stage 2, repair.** If tests fail, the agent fixes things. If Stage 1 ran, it continues that session (same budget). Otherwise it starts a new one. Its edits become the repair commit.
12. The harness re-runs `test` itself, outside the agent. Pass → push. Fail → stuck.
13. Push without force. If the push is rejected (someone pushed meanwhile), fail, and the next run retries.

Any failure: write the explanation to `$GITHUB_STEP_SUMMARY` and the log, save the failure cache entry, and exit 1. Nothing is pushed.

**Exception:** Gateway errors (budget used up, network failures, outages) fail the run with a clear message but **don't** save a failure cache entry, so the next scheduled run tries again.

**Commands** (`post-merge`, `test`) are always run by the harness or by the agent's tools with a fixed 15-minute time limit, and with secrets stripped from the environment (see Agent rules).

## Outcomes

| Outcome | What happens |
|---|---|
| Clean | Push silently |
| Adapted (agent fixed conflicts/tests) | Push automatically, with notes in the merge commit and job summary |
| Obsolete (upstream shipped the same feature) | Never auto-drop. Fail with steps to remove the custom version. |
| Stuck | Fail, nothing pushed. The fork stays frozen until the user fixes it. |

## Agent rules (Vercel AI SDK `ToolLoopAgent`, enforced by our own tools)

- **Tools are ours, and that's the whole sandbox.** The agent gets only: read a file, list/search files, edit a file, run `test`, run `post-merge`, and `finish(verdict, notes)`. Each tool checks the rules below before doing anything. A tool we don't write can't be misused.
- **Scope: "adapt your code to upstream; don't rewrite upstream's code."** The agent may only edit conflicted files and files the fork already changes relative to upstream. It can never edit upstream's own tests.
- **Commands:** only the exact `test` and `post-merge` commands. No other shell access. The tool returns the exit code and the last ~200 lines of output, so long logs don't eat the token budget.
- **Never edit** `.github/workflows/**`.
- **Secrets are removed** from the environment of every `post-merge`/`test` run: all `INPUT_*` variables (this covers `token` and `ai-gateway-api-key`), `GITHUB_TOKEN`, `AI_GATEWAY_API_KEY`, `ACTIONS_RUNTIME_TOKEN`, and `ACTIONS_ID_TOKEN_REQUEST_*`.
- **Budgets:** `max-steps` and `max-tokens`. The loop stops on `stopWhen: [isStepCount(max-steps), hasToolCall('finish'), <token check>]`. The token check adds up the `usage` the AI SDK reports for each step, so it works the same for every model and needs no price table. The docs tell users to also set a dollar budget on their Gateway key, because tokens only cap a single run. Note that Gateway budgets don't count BYOK spend by default, so BYOK users should set a limit with their provider instead.
- **Verdict:** the agent ends by calling `finish` with `resolved`, `obsolete`, or `stuck`. Running out of budget counts as `stuck`.
- **Guards beat the verdict.** Leftover conflict markers, out-of-scope edits, or failing tests mean stuck, whatever the agent says.
- **Test files** = paths matching `test/`, `tests/`, `__tests__/`, `*.test.*`, `*.spec.*`, or `*_test.*`.
- **Test edits:** the prompt says "if the only way to pass is changing what a test expects, finish as stuck." If the agent edits a test file anyway, the change still lands, but `⚠️ agent changed these tests: …` goes at the top of the job summary and in the commit message.
- No automatic retries.

## Security model

Using this tool means trusting upstream, and the docs must say so plainly:

- Pushing upstream's workflow files with a PAT means they run in the fork with the fork's secrets. Upstream's deploy/CI workflows may run on the fork after each sync.
- `post-merge` and `test` run upstream's code (install scripts, tests) on the runner.

What the tool does: it strips secrets from the environment of every command it runs and never writes credentials to disk (no `.git/config`, no credential helper). This stops accidental leaks, such as a test that prints its environment. It is **not** a sandbox: GitHub's runners give any code passwordless `sudo`, so a malicious upstream could still reach the token or Gateway key. The docs should recommend a token scoped to just the fork and a Gateway key with a budget.

## Tech choices

- **Runtime:** TypeScript, `runs.using: node24`, bundled with `tsdown` into `dist/index.mjs`.
- **Agent library: Vercel AI SDK (`ai`), calling every model through the Vercel AI Gateway.** In the AI SDK, a plain model string like `"openai/gpt-5"` goes to the Gateway by default. So supporting any model is just the `model` input, with no per-provider code or packages.
- **Why not the Claude Agent SDK:** it's a wrapper that starts a separate ~250 MB `claude` program (too big for `dist/`), it comes under proprietary product terms, and we'd have to switch off most of its built-in tools to meet our rules.
- **License:** `ai` and its `@ai-sdk/*` dependencies are Apache-2.0 with no NOTICE file. Bundling into `dist/` is fine as long as their license text ships with it: the `tsdown.config.ts` plugin writes `dist/licenses.txt` from the packages that actually end up in the bundle. (Checked `ai` 7.0.137 on 2026-10-11.)
- **Code layout: core logic stays separate from GitHub code**, so the fixtures (and a future CLI) can run it.
  - `src/core/` holds the sync flow, git calls, pre-checks, the agent, and the guards. It takes plain options plus a `log`/`summary` callback and returns an outcome (`clean | adapted | obsolete | stuck`, plus notes). It has no `@actions/*` imports.
  - `src/action.ts` is the only GitHub glue: it reads `with:` inputs, handles the token, failure cache, `$GITHUB_STEP_SUMMARY`, and exit code, then calls core.
  - `test/fixtures/` builds the practice repos with plain `git` in temp folders and calls core directly, with no GitHub involved.

## Evaluation

A set of small practice repos (fixtures) that run the core logic locally, with no GitHub involved. Start with:

1. Clean merge → pushes, no model call.
2. Small conflict (imports or a moved method) → resolved and pushed.
3. Upstream changes a behavior your code depends on → adapted in a repair commit.
4. Upstream ships the same feature → obsolete, nothing pushed.
5. Huge conflict → stuck before the model is called.

Run them on the default model and at least one model from another provider. The prompt and tools are written once, but models follow them differently.

The most important number: **false lands** (results that were pushed but are actually wrong). Also track how often a fixable case ends up stuck, plus tokens per run.

## Not in the MVP

- Calling providers directly without the Gateway (would need an `@ai-sdk/<provider>` package and a key input per provider)
- Staging PRs gated on upstream CI
- Custom prompt instructions (e.g. `.github/zerobehind.md`)
- Pinning to the last good upstream commit while stuck
- Merging big upstream jumps in chunks
- Review/approval options
- Local CLI
- Hosted GitHub App (possibly on Vercel eve)
