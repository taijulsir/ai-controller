import { spawn } from "node:child_process";

export interface ClaudeProcessHandle {
  readonly stdout: AsyncIterable<string>;
  readonly exitCode: Promise<number | null>;
  getStderr(): string;
  kill(): void;
}

export class ClaudeProcessRunner {
  spawn(executable: string, args: string[], cwd: string): ClaudeProcessHandle {
    const child = spawn(executable, args, { cwd });

    let stderrOutput = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderrOutput += chunk.toString();
    });

    // Without a listener, Node treats an unhandled "error" event (e.g. the
    // configured executable doesn't exist / isn't on PATH) as an uncaught
    // exception and crashes the whole process. Capturing it here and
    // rejecting `exitCode` turns that into a normal rejected promise that
    // flows through ClaudeAdapter.stream()'s existing try/catch instead.
    let spawnError: Error | undefined;
    const exitCode = new Promise<number | null>((resolve, reject) => {
      child.on("error", (error) => {
        spawnError = error;
        reject(error);
      });
      child.on("close", (code) => resolve(code));
    });
    // A caller may drain `stdout` without ever awaiting `exitCode` (or await
    // it only after `stdout` already threw) — this keeps that path from
    // also triggering Node's unhandled-rejection warning for the same error.
    exitCode.catch(() => {});

    async function* stdoutChunks(): AsyncIterable<string> {
      for await (const chunk of child.stdout) {
        yield chunk.toString();
      }
      // On a spawn failure, `stdout` ends with zero data before `exitCode`
      // settles — surface the error here too, so a consumer that only
      // iterates `stdout` (as ClaudeAdapter.stream() does, before it ever
      // reaches `await handle.exitCode`) still observes the failure instead
      // of silently seeing an empty, successful-looking stream.
      if (spawnError) {
        throw spawnError;
      }
    }

    return {
      stdout: stdoutChunks(),
      exitCode,
      getStderr: () => stderrOutput,
      kill: () => child.kill(),
    };
  }
}
