import { spawn } from "node:child_process";

export type ExecResult = { code: number; stdout: string; stderr: string; all: string };

const BOT = "zerobehind[bot]";
const BOT_EMAIL = "zerobehind[bot]@users.noreply.github.com";
const COMMAND_TIMEOUT_MS = 15 * 60 * 1000;

export function exec(
  file: string,
  args: string[],
  o: { cwd: string; env?: NodeJS.ProcessEnv; timeoutMs?: number },
): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    // detached = own process group, so a timeout kills the whole tree (npm → node → ...)
    const child = spawn(file, args, { cwd: o.cwd, env: o.env ?? process.env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "", all = "";
    child.stdout.on("data", (d) => { stdout += d; all += d; });
    child.stderr.on("data", (d) => { stderr += d; all += d; });
    const timer = o.timeoutMs
      ? setTimeout(() => {
          all += `\n[zerobehind] killed after ${o.timeoutMs! / 60000} minutes\n`;
          try { process.kill(-child.pid!, "SIGKILL"); } catch {}
        }, o.timeoutMs)
      : undefined;
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr, all });
    });
  });
}

export async function git(cwd: string, args: string[], env: Record<string, string> = {}): Promise<ExecResult> {
  return exec("git", args, {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: BOT, GIT_AUTHOR_EMAIL: BOT_EMAIL,
      GIT_COMMITTER_NAME: BOT, GIT_COMMITTER_EMAIL: BOT_EMAIL,
      GIT_TERMINAL_PROMPT: "0",
      ...env,
    },
  });
}

/** git that throws on non-zero exit and returns trimmed stdout. */
export async function gitOk(cwd: string, args: string[], env?: Record<string, string>): Promise<string> {
  const r = await git(cwd, args, env);
  if (r.code !== 0) throw new Error(`git ${args[0]} failed (${r.code}): ${r.stderr.trim() || r.stdout.trim()}`);
  return r.stdout.trim();
}

/** Env for user commands: everything except secrets. */
export function safeEnv(): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      ([k]) =>
        !k.startsWith("INPUT_") &&
        !k.startsWith("ACTIONS_ID_TOKEN_REQUEST_") &&
        !["GITHUB_TOKEN", "AI_GATEWAY_API_KEY", "ACTIONS_RUNTIME_TOKEN"].includes(k),
    ),
  );
}

export function tail(text: string, lines = 200): string {
  const all = text.trimEnd().split("\n");
  return all.length <= lines ? all.join("\n") : `[... ${all.length - lines} lines cut]\n` + all.slice(-lines).join("\n");
}

/** Runs a user command (`post-merge` / `test`) with secrets stripped and a fixed time limit. */
export async function runCommand(cwd: string, command: string): Promise<{ ok: boolean; code: number; output: string }> {
  const r = await exec("bash", ["-c", command], { cwd, env: safeEnv(), timeoutMs: COMMAND_TIMEOUT_MS });
  return { ok: r.code === 0, code: r.code, output: tail(r.all) };
}
