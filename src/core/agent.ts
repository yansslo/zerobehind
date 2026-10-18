import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { ToolLoopAgent, hasToolCall, isStepCount, tool, type LanguageModel, type LanguageModelUsage, type ModelMessage, type StepResult } from "ai";
import { z } from "zod";
import { git, runCommand, tail } from "./exec";

export type Verdict = "resolved" | "obsolete" | "stuck";
type Finish = { verdict: Verdict; notes: string };

export type AgentConfig = {
  cwd: string;
  model: LanguageModel;
  /** Files the agent may edit: conflicted files + files the fork changes relative to upstream. */
  editable: Set<string>;
  /** Files that had merge conflicts; "resolved" is refused while these (or any edited file) still have markers. */
  conflicted: string[];
  test?: string;
  postMerge?: string;
  maxSteps: number;
  maxTokens: number;
  log: (msg: string) => void;
};

/** One agent session; Stage 2 continues Stage 1's session with the same budget. */
export type Session = {
  messages: ModelMessage[];
  steps: number;
  tokens: number;
  edited: Set<string>;
  testEdits: Set<string>;
};

export const newSession = (): Session => ({ messages: [], steps: 0, tokens: 0, edited: new Set(), testEdits: new Set() });

const INSTRUCTIONS = `You keep a fork in sync with its upstream repository. Upstream has just been merged into the fork.
Your job is to adapt the fork's custom code to upstream. Do not rewrite upstream's code.

Rules:
- You can only edit the files listed as editable. Other edits are refused.
- Keep both sides' intent: upstream's changes and the fork's custom features. The fork's commit messages describe what each custom change is for.
- In conflicted files, remove every conflict marker (<<<<<<<, =======, >>>>>>>) and produce the correct combined code.
- Never change what a test expects just to make it pass. If the only way to pass is changing a test's expectations, finish with verdict "stuck".
- If upstream now ships the same feature as one of the fork's custom changes (the custom version is redundant), finish with verdict "obsolete" and name the custom commit. Do not remove the custom code yourself.
- Never delete the fork's custom code or replace it with upstream's version, even when they look equivalent. That is the "obsolete" case: finish with "obsolete" instead.
- If both sides add the same feature, finish with "obsolete". Merging the two versions into one (for example, keeping the fork's comment or names around upstream's logic) counts as dropping the fork's code.
- If you can't finish safely, finish with verdict "stuck" and explain what a human needs to decide.
- If a run_test tool exists, run it before finishing with "resolved".
- Always end by calling finish. Its notes go into the commit message: a few short plain-language lines on what you changed and why.`;

export const isTestFile = (p: string) =>
  /(^|\/)(test|tests|__tests__)\//.test(p) || /\.(test|spec)\.[^/]+$/.test(p) || /_test\.[^/]+$/.test(p);

const isWorkflow = (p: string) => p.startsWith(".github/workflows/");

const usageTokens = (u: LanguageModelUsage) => (u.inputTokens ?? 0) + (u.outputTokens ?? 0);

const MAX_READ = 60_000;

/** Files that still contain conflict markers, with the 1-based marker line numbers. */
export async function findMarkers(cwd: string, files: Iterable<string>): Promise<[string, number[]][]> {
  const out: [string, number[]][] = [];
  for (const f of files) {
    const text = await readFile(path.join(cwd, f), "utf8").catch(() => "");
    const lines = text.split("\n").flatMap((l, i) => (/^(<{7}|>{7})( |$)|^={7}$/.test(l) ? [i + 1] : []));
    if (lines.length) out.push([f, lines]);
  }
  return out;
}

const markerList = (m: [string, number[]][]) => m.map(([f, lines]) => `- \`${f}\`: line${lines.length > 1 ? "s" : ""} ${lines.join(", ")}`).join("\n");

/**
 * Runs rounds of the tool loop until the agent calls finish with an acceptable verdict or the budget runs out.
 * Tool calls aren't forced (many models reject toolChoice "required"), so a round can end with a plain-text
 * reply or a premature "resolved"; either way we tell the agent what's wrong and run another round.
 */
export async function runAgent(cfg: AgentConfig, s: Session, prompt: string): Promise<Finish> {
  if (s.steps >= cfg.maxSteps || s.tokens >= cfg.maxTokens) return { verdict: "stuck", notes: "The agent's budget was used up." };

  let finished: Finish | undefined;

  const resolvePath = (p: string): string | undefined => {
    const rel = path.posix.normalize(p.replace(/^(\.\/)+/, ""));
    if (rel.startsWith("..") || path.isAbsolute(rel) || rel === ".git" || rel.startsWith(".git/")) return undefined;
    return rel;
  };

  const command = (name: string, cmd: string) =>
    tool({
      description: `Run the \`${name}\` command (\`${cmd}\`). Returns the exit code and the last 200 lines of output.`,
      inputSchema: z.object({}),
      execute: async () => {
        cfg.log(`agent: running ${name}`);
        const r = await runCommand(cfg.cwd, cmd);
        return `exit code ${r.code}\n${r.output}`;
      },
    });

  const tools = {
    read_file: tool({
      description: "Read a file in the repository. Optionally pass a 1-based line range.",
      inputSchema: z.object({ path: z.string(), start_line: z.number().int().optional(), end_line: z.number().int().optional() }),
      execute: async ({ path: p, start_line, end_line }) => {
        const rel = resolvePath(p);
        if (!rel) return "Error: path is outside the repository.";
        try {
          let text = await readFile(path.join(cfg.cwd, rel), "utf8");
          if (start_line || end_line) text = text.split("\n").slice((start_line ?? 1) - 1, end_line).join("\n");
          return text.length > MAX_READ ? text.slice(0, MAX_READ) + "\n[... cut; read a line range for the rest]" : text;
        } catch (e) {
          return `Error: ${(e as Error).message}`;
        }
      },
    }),
    list_files: tool({
      description: "List tracked files, optionally under a directory.",
      inputSchema: z.object({ dir: z.string().optional() }),
      execute: async ({ dir }) => {
        const rel = dir ? resolvePath(dir) : ".";
        if (!rel) return "Error: path is outside the repository.";
        const r = await git(cfg.cwd, ["ls-files", "--", rel]);
        return tail(r.stdout, 500) || "(no files)";
      },
    }),
    search: tool({
      description: "Search tracked files with an extended regular expression (git grep). Returns matching lines with file:line.",
      inputSchema: z.object({ pattern: z.string(), path: z.string().optional() }),
      execute: async ({ pattern, path: p }) => {
        const rel = p ? resolvePath(p) : ".";
        if (!rel) return "Error: path is outside the repository.";
        const r = await git(cfg.cwd, ["grep", "-n", "-I", "-E", "-e", pattern, "--", rel]);
        if (r.code === 1) return "No matches.";
        if (r.code !== 0) return `Error: ${r.stderr.trim()}`;
        return tail(r.stdout, 200);
      },
    }),
    edit_file: tool({
      description:
        "Edit an editable file. With old_string: replace that exact text (it must appear exactly once) with new_string. Without old_string: replace the whole file with new_string.",
      inputSchema: z.object({ path: z.string(), old_string: z.string().optional(), new_string: z.string() }),
      execute: async ({ path: p, old_string, new_string }) => {
        const rel = resolvePath(p);
        if (!rel) return "Error: path is outside the repository.";
        if (isWorkflow(rel)) return "Refused: files under .github/workflows/ can never be edited.";
        if (!cfg.editable.has(rel)) return "Refused: you may only edit conflicted files and files the fork already changes. Upstream's own code is off limits.";
        const file = path.join(cfg.cwd, rel);
        let text = new_string;
        if (old_string !== undefined) {
          let current: string;
          try { current = await readFile(file, "utf8"); } catch (e) { return `Error: ${(e as Error).message}`; }
          const count = current.split(old_string).length - 1;
          if (count !== 1) return `Error: old_string appears ${count} times; it must appear exactly once.`;
          text = current.replace(old_string, () => new_string);
        }
        await writeFile(file, text);
        s.edited.add(rel);
        if (isTestFile(rel)) s.testEdits.add(rel);
        cfg.log(`agent: edited ${rel}`);
        return "OK";
      },
    }),
    ...(cfg.test ? { run_test: command("test", cfg.test) } : {}),
    ...(cfg.postMerge ? { run_post_merge: command("post-merge", cfg.postMerge) } : {}),
    finish: tool({
      description: "End the session with a verdict and short notes for the commit message.",
      inputSchema: z.object({ verdict: z.enum(["resolved", "obsolete", "stuck"]), notes: z.string() }),
      execute: async (v) => {
        finished = v;
        return "OK";
      },
    }),
  };

  const overTokens = ({ steps }: { steps: StepResult<any, any>[] }) =>
    s.tokens + steps.reduce((n, st) => n + usageTokens(st.usage), 0) >= cfg.maxTokens;

  s.messages.push({ role: "user", content: prompt });
  let rounds = 0;
  let last = "The agent never called finish.";
  let lastText = "";
  // Each round takes at least one step, so the step budget always ends the loop.
  while (s.steps < cfg.maxSteps && s.tokens < cfg.maxTokens) {
    rounds++;
    finished = undefined;
    const agent = new ToolLoopAgent({
      model: cfg.model,
      instructions: INSTRUCTIONS,
      tools,
      stopWhen: [isStepCount(cfg.maxSteps - s.steps), hasToolCall("finish"), overTokens],
    });
    let result;
    try {
      result = await agent.generate({ messages: s.messages });
    } catch (e) {
      throw new Error(`AI Gateway error: ${(e as Error).message}`);
    }
    s.messages.push(...result.response.messages);
    s.steps += result.steps.length;
    s.tokens += result.steps.reduce((n, st) => n + usageTokens(st.usage), 0);
    lastText = result.text;
    cfg.log(`agent: round ${rounds}, ${s.steps} steps, ${s.tokens} tokens so far`);

    const done = finished as Finish | undefined; // set by the finish tool during generate()
    if (!done) {
      s.messages.push({ role: "user", content: "You stopped without calling finish. If work remains, keep editing; then call finish with a verdict." });
      continue;
    }
    last = `The agent's last finish verdict was "${done.verdict}".`;
    if (done.verdict !== "resolved") return done;
    const markers = await findMarkers(cfg.cwd, new Set([...cfg.conflicted, ...s.edited]));
    if (!markers.length) return done;
    last = `The agent's last finish verdict was "resolved", but conflict markers remained:\n\n${markerList(markers)}`;
    cfg.log(`agent: finished "resolved" but markers remain in ${markers.map(([f]) => f).join(", ")}`);
    s.messages.push({ role: "user", content: `You called finish with "resolved", but conflict markers are still in these files:\n\n${markerList(markers)}\n\nRemove them, then call finish again.` });
  }

  return {
    verdict: "stuck",
    notes: `The agent ran out of budget after ${rounds} round${rounds === 1 ? "" : "s"} (${s.steps}/${cfg.maxSteps} steps, ${s.tokens}/${cfg.maxTokens} tokens). ${last}${lastText ? `\n\nIts last message:\n\n${lastText}` : ""}`,
  };
}
