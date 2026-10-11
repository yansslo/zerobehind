# zerobehind

Keeps your fork in sync with its upstream. On a schedule it merges upstream into your fork. If that causes conflicts or failing tests, an AI agent fixes them within strict limits. The result is re-checked, then pushed. If it can't be fixed safely, the run fails with a plain explanation and nothing is pushed.

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
      - uses: actions/checkout@v5
        with: { persist-credentials: false }   # required: zerobehind never stores credentials
      - uses: actions/setup-node@v4
        with: { node-version-file: .nvmrc }
      - uses: yansslo/zerobehind@v1
        with:
          upstream: owner/repo
          token: ${{ secrets.ZEROBEHIND_TOKEN }}
          ai-gateway-api-key: ${{ secrets.AI_GATEWAY_API_KEY }}
          post-merge: npm install   # optional
          test: npm test            # optional
```

To sync more than one branch, add another step with a different `branch:`.

| Input | Default | Notes |
|---|---|---|
| `upstream` | required | `owner/repo` or any git URL. GitHub upstreams are fetched with `token`. Other hosts need credentials in the URL. |
| `upstream-branch` | upstream's default branch | |
| `branch` | fork's default branch | |
| `token` | required | Fine-grained PAT (Contents + Workflows write) or a GitHub App token. `GITHUB_TOKEN` can't push workflow file changes. |
| `ai-gateway-api-key` | none | Vercel AI Gateway key. Without it, zerobehind is a free auto-syncer: any conflict or failing test stops the run. |
| `model` | `anthropic/claude-sonnet-5.5` | Any Gateway model ID, e.g. `openai/gpt-5`. |
| `post-merge` | none | Runs after merging, e.g. `npm install`. Also regenerates conflicted lockfiles. |
| `test` | none | Decides whether the result is good. |
| `max-conflicted-files` | `10` | Above this, stop without calling the model. |
| `max-steps` | `30` | Agent step limit per run. |
| `max-tokens` | `1000000` | Agent token limit per run (input + output). |

**Set a dollar budget on your Gateway key.** `max-tokens` only caps a single run. Gateway budgets don't count BYOK spend by default, so if you bring your own provider key, set a limit with that provider too.

## How it works

- **Merge, not rebase.** Upstream is merged into your branch and pushed normally, never force-pushed. `git log --first-parent` gives the clean view.
- **Your custom changes** are `git log --no-merges upstream..yours`. The agent reads their commit messages to understand what each change is for, so squash-merge your feature PRs into one clear commit each.
- **Commits:** `Merge upstream owner/repo@<sha> (zerobehind)`, with the agent's notes in the body. If the agent had to change your code to make tests pass, that is a separate commit, `zerobehind: adapt custom code to upstream`, which you can undo with `git revert`.
- **What the agent may do:** read and search files, edit conflicted files and files your fork already changes, run your `test` and `post-merge` commands, and finish. Nothing else. It never edits `.github/workflows/**` or upstream's own code. If it edits a test file, the job summary and commit message say so.
- **When it gives up**, the run fails, nothing is pushed, and the job summary explains why. The same failure isn't retried until upstream or your fork changes (run the workflow manually to force a retry). If upstream ships a feature you built yourself, zerobehind never drops your version; it asks you to.

## Security: you are trusting upstream

- With a PAT, upstream's workflow files get pushed to your fork and run there **with your fork's secrets**. Upstream's deploy or CI workflows may run in your fork after each sync.
- `post-merge` and `test` run upstream's code (install scripts, tests) on the runner.

zerobehind removes secrets from the environment of every command it runs and never writes credentials to disk. That stops accidental leaks, like a test that prints its environment. It is **not** a sandbox: GitHub runners give any code passwordless `sudo`, so a malicious upstream could still reach your token or Gateway key. Use a token scoped to just the fork and a Gateway key with a budget.

## Development

```sh
pnpm install
pnpm test        # offline fixtures; live ones run when AI_GATEWAY_API_KEY is set
pnpm build       # bundles dist/index.mjs and dist/licenses.txt; commit dist/ for releases
```

Live fixtures on another model: `ZEROBEHIND_MODEL=openai/gpt-5 AI_GATEWAY_API_KEY=... pnpm test`.
