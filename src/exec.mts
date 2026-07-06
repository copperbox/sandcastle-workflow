// Host-side process helpers. Everything in this package's git/gh layer runs on
// the HOST (never inside a docker sandbox) so it can use the host's existing
// `gh`/git credentials to push branches and open PRs.

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface ExecResult {
  stdout: string;
  stderr: string;
  code: number;
}

export async function run(cmd: string, args: string[]): Promise<ExecResult> {
  try {
    const { stdout, stderr } = await execFileAsync(cmd, args, {
      encoding: "utf8",
      // Bodies + comments for 100 issues can be large; give the buffer headroom.
      maxBuffer: 32 * 1024 * 1024,
    });
    return { stdout, stderr, code: 0 };
  } catch (err: unknown) {
    // execFile rejects on non-zero exit; surface code/stderr instead of throwing
    // so callers can decide what is fatal (a push failure) vs. expected (a label
    // that already exists).
    const e = err as { code?: number; stdout?: string; stderr?: string };
    return {
      stdout: e.stdout ?? "",
      stderr: e.stderr ?? String(err),
      code: typeof e.code === "number" ? e.code : 1,
    };
  }
}

export const git = (args: string[]): Promise<ExecResult> => run("git", args);

export const gh = (args: string[]): Promise<ExecResult> => run("gh", args);

export const errMsg = (e: unknown): string =>
  e instanceof Error ? e.message : String(e);
