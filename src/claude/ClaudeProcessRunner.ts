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

    const exitCode = new Promise<number | null>((resolve) => {
      child.on("close", (code) => resolve(code));
    });

    async function* stdoutChunks(): AsyncIterable<string> {
      for await (const chunk of child.stdout) {
        yield chunk.toString();
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
