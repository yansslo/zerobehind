import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createGateway } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { afterEach, describe, expect, it } from "vitest";
import { gitOk, runCommand } from "../src/core/exec";
import { sync, type Outcome, type SyncOptions } from "../src/core/sync";

// Live fixtures call the real model: AI_GATEWAY_API_KEY=... [ZEROBEHIND_MODEL=openai/gpt-5] pnpm test
const apiKey = process.env.AI_GATEWAY_API_KEY;
const modelId = process.env.ZEROBEHIND_MODEL ?? "anthropic/claude-sonnet-5.5";
const liveModel = () => createGateway({ apiKey })(modelId);
const noModel = () =>
  new MockLanguageModelV4({
    doGenerate: async () => {
      throw new Error("model must not be called");
    },
  });

const TEST = "node test.js && node custom-check.js";
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true })));
});

type Files = Record<string, string>;

/** upstream (plain repo) → origin.git (the fork on "GitHub") → dev (where custom commits are made) and work (the Action's checkout). */
async function repos(initial: Files) {
  const root = await mkdtemp(path.join(tmpdir(), "zerobehind-"));
  roots.push(root);
  const up = path.join(root, "upstream"), origin = path.join(root, "origin.git"), dev = path.join(root, "dev"), work = path.join(root, "work");
  const commit = async (dir: string, files: Files, msg: string) => {
    for (const [f, text] of Object.entries(files)) {
      await mkdir(path.dirname(path.join(dir, f)), { recursive: true });
      await writeFile(path.join(dir, f), text);
    }
    await gitOk(dir, ["add", "-A"]);
    await gitOk(dir, ["commit", "-q", "-m", msg]);
  };
  await gitOk(root, ["init", "-q", "-b", "main", up]);
  await commit(up, initial, "Initial commit");
  await gitOk(root, ["clone", "-q", "--bare", up, origin]);
  await gitOk(root, ["clone", "-q", origin, dev]);
  return {
    upstream: (files: Files, msg: string) => commit(up, files, msg),
    fork: async (files: Files, msg: string) => {
      await commit(dev, files, msg);
      await gitOk(dev, ["push", "-q", "origin", "main"]);
    },
    run: async (o: Partial<SyncOptions>): Promise<Outcome> => {
      await gitOk(root, ["clone", "-q", "--depth", "1", origin, work]); // like actions/checkout
      const outcome = await sync({ cwd: work, upstream: up, test: TEST, maxConflictedFiles: 10, maxSteps: 30, maxTokens: 1_000_000, log: () => {}, ...o });
      console.log(`[${expect.getState().currentTestName}] ${outcome.kind}, ${outcome.tokens} tokens\n${outcome.summary}\n`);
      return outcome;
    },
    /** The pushed fork, checked out fresh. */
    pushed: async () => {
      const dir = path.join(root, `check-${Date.now()}`);
      await gitOk(root, ["clone", "-q", origin, dir]);
      return { dir, log: (fmt: string) => gitOk(dir, ["log", "-1", `--format=${fmt}`]), test: () => runCommand(dir, TEST) };
    },
    originHead: () => gitOk(origin, ["rev-parse", "main"]),
  };
}

// ---- 2: small conflict (imports + both sides add a function next to each other)
const greet = (imports: string, extra: string, exports: string) => `const { ${imports} } = require("./util");

function greet(name) {
  return "Hello, " + name;
}
${extra}
module.exports = { ${exports} };
`;
async function conflictRepos() {
  const r = await repos({
    "util.js": `exports.upper = (s) => s.toUpperCase();\nexports.trim = (s) => s.trim();\n`,
    "greet.js": greet("upper", "", "greet"),
    "test.js": `const assert = require("assert");\nconst g = require("./greet");\nassert.equal(g.greet("Ann"), "Hello, Ann");\n`,
    "custom-check.js": "",
  });
  await r.fork(
    {
      "greet.js": greet("upper", `\nfunction shout(name) {\n  return upper(greet(name)) + "!";\n}\n`, "greet, shout"),
      "custom-check.js": `const assert = require("assert");\nassert.equal(require("./greet").shout("Ann"), "HELLO, ANN!");\n`,
    },
    "Add shout(): loud greeting for the CLI banner",
  );
  await r.upstream(
    {
      "greet.js": greet("upper, trim", `\nfunction wave(name) {\n  return "👋 " + trim(name);\n}\n`, "greet, wave"),
      "test.js": `const assert = require("assert");\nconst g = require("./greet");\nassert.equal(g.greet("Ann"), "Hello, Ann");\nassert.equal(g.wave(" Ann "), "👋 Ann");\n`,
    },
    "Add wave()",
  );
  return r;
}

// ---- 4: fork and upstream both add slugify()
const UPSTREAM_UTIL = `exports.upper = (s) => s.toUpperCase();\n\nexports.slugify = (text) =>\n  text.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");\n`;
async function obsoleteRepos() {
  const r = await repos({ "util.js": `exports.upper = (s) => s.toUpperCase();\n`, "test.js": "", "custom-check.js": "" });
  await r.fork(
    {
      "util.js": `exports.upper = (s) => s.toUpperCase();\n\n// Turn a title into a URL slug\nexports.slugify = (s) => s.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-");\n`,
      "custom-check.js": `const assert = require("assert");\nassert.equal(require("./util").slugify("Hello World"), "hello-world");\n`,
    },
    "Add slugify() for post URLs",
  );
  await r.upstream(
    {
      "util.js": UPSTREAM_UTIL,
      "test.js": `const assert = require("assert");\nassert.equal(require("./util").slugify(" Hello World! "), "hello-world");\n`,
    },
    "Add slugify() helper",
  );
  return r;
}

/** A model that plays back fixed tool calls, one per step. */
const scripted = (...calls: [string, object][]) =>
  new MockLanguageModelV4({
    doGenerate: calls.map(([toolName, input], i) => ({
      content: [{ type: "tool-call" as const, toolCallId: `call-${i}`, toolName, input: JSON.stringify(input) }],
      finishReason: { unified: "tool-calls" as const, raw: undefined },
      usage: { inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 5, text: 5, reasoning: 0 } },
      warnings: [],
    })),
  });

describe("fixtures", { timeout: 120_000 }, () => {
  it("1. clean merge pushes without calling the model", async () => {
    const r = await repos({ "util.js": "exports.one = 1;\n", "test.js": `require("./util");\n`, "custom-check.js": "" });
    await r.fork({ "custom.js": "exports.mine = true;\n", "custom-check.js": `require("./custom");\n` }, "Add custom module");
    await r.upstream({ "new.js": "exports.two = 2;\n" }, "Add new module");
    const o = await r.run({ model: noModel() });
    expect(o.kind).toBe("clean");
    const p = await r.pushed();
    expect(await p.log("%s")).toMatch(/^Merge upstream .+@[0-9a-f]{40} \(zerobehind\)$/);
    expect(await p.log("%an")).toBe("zerobehind[bot]");
    expect((await p.log("%p")).split(" ")).toHaveLength(2);

    // A second run with nothing new is a no-op.
    const head = await r.originHead();
    await rm(path.join(path.dirname(p.dir), "work"), { recursive: true });
    expect((await r.run({})).kind).toBe("clean");
    expect(await r.originHead()).toBe(head);
  });

  it("5. huge conflict is stuck before the model is called", async () => {
    const files = (v: string) => Object.fromEntries(Array.from({ length: 11 }, (_, i) => [`f${i}.js`, `exports.v = "${v}";\n`]));
    const r = await repos({ ...files("base"), "test.js": "", "custom-check.js": "" });
    await r.fork(files("fork"), "Fork values");
    await r.upstream(files("upstream"), "Upstream values");
    const before = await r.originHead();
    const o = await r.run({ model: noModel() });
    expect(o.kind).toBe("stuck");
    expect(o.summary).toContain("11 files conflict");
    expect(o.failureCacheKey).toMatch(/^zerobehind-fail-[0-9a-f]{40}-[0-9a-f]{40}$/);
    expect(await r.originHead()).toBe(before);
  });

  it("guard: a resolution that keeps only upstream's file never lands, whatever the verdict", async () => {
    const r = await obsoleteRepos();
    const before = await r.originHead();
    const o = await r.run({ model: scripted(["edit_file", { path: "util.js", new_string: UPSTREAM_UTIL }], ["finish", { verdict: "resolved", notes: "Took upstream's slugify." }]) });
    expect(o.kind).toBe("obsolete");
    expect(o.summary).toContain("keeping only upstream's version");
    expect(await r.originHead()).toBe(before);
  });

  it("conflict without an API key is stuck", async () => {
    const r = await conflictRepos();
    const before = await r.originHead();
    const o = await r.run({});
    expect(o.kind).toBe("stuck");
    expect(o.summary).toContain("ai-gateway-api-key");
    expect(await r.originHead()).toBe(before);
  });
});

describe.skipIf(!apiKey)(`live fixtures (${modelId})`, { timeout: 15 * 60_000 }, () => {
  it("2. small conflict is resolved and pushed", async () => {
    const r = await conflictRepos();
    const o = await r.run({ model: liveModel() });
    expect(o.kind).toBe("adapted");
    const p = await r.pushed();
    expect(await p.log("%s")).toMatch(/\(zerobehind\)$/);
    expect((await p.test()).ok).toBe(true); // no false land
  });

  it("3. upstream behavior change is adapted in a repair commit", async () => {
    const r = await repos({
      "util.js": `exports.format = (u) => u.first + " " + u.last;\n`,
      "card.js": `const { format } = require("./util");\nexports.card = (u) => "Name: " + format(u);\n`,
      "test.js": `const assert = require("assert");\nassert.equal(require("./card").card({ first: "A", last: "B" }), "Name: A B");\n`,
      "custom-check.js": "",
    });
    await r.fork(
      {
        "badge.js": `const { format } = require("./util");\nexports.badge = (u) => "[" + format(u) + "]";\n`,
        "custom-check.js": `const assert = require("assert");\nassert.equal(require("./badge").badge({ first: "A", last: "B" }), "[A B]");\n`,
      },
      "Add badge(): bracketed user name for the header",
    );
    await r.upstream(
      {
        "util.js": `exports.fullName = (u) => u.first + " " + u.last;\n`,
        "card.js": `const { fullName } = require("./util");\nexports.card = (u) => "Name: " + fullName(u);\n`,
      },
      "Rename format() to fullName()",
    );
    const o = await r.run({ model: liveModel() });
    expect(o.kind).toBe("adapted");
    const p = await r.pushed();
    expect(await p.log("%s")).toBe("zerobehind: adapt custom code to upstream");
    expect(await gitOk(p.dir, ["log", "-1", "--format=%s", "HEAD^"])).toMatch(/\(zerobehind\)$/);
    expect((await p.test()).ok).toBe(true);
  });

  it("4. upstream ships the same feature: obsolete, nothing pushed", async () => {
    const r = await obsoleteRepos();
    const before = await r.originHead();
    const o = await r.run({ model: liveModel() });
    expect(o.kind).toBe("obsolete");
    expect(await r.originHead()).toBe(before);
  });
});
