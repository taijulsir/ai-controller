import type { IConfigService } from "../config/interfaces";
import type { Repository } from "../domain/repository/Repository";
import type { IRepositoryRegistry } from "../repositories/interfaces";
import { ClaudeProcessRunner, type ClaudeProcessHandle } from "./ClaudeProcessRunner";
import {
  ClaudeAlreadyRunningError,
  ClaudeCommandError,
  ClaudeExecutionTimeoutError,
  NoActiveRepositoryError,
} from "./errors";
import type { ClaudeExecuteOptions, IClaudeAdapter } from "./interfaces";
import type { ClaudeExecutionResult, ClaudeRunState, ClaudeRunStatus } from "./types";

// Only the fields this adapter reads from a stream-json NDJSON line; the CLI emits more.
interface ClaudeStreamEvent {
  type: string;
  event?: {
    type: string;
    delta?: {
      type: string;
      text?: string;
    };
  };
  is_error?: boolean;
  subtype?: string;
}

export class ClaudeAdapter implements IClaudeAdapter {
  private activeProcess?: ClaudeProcessHandle;
  private status: ClaudeRunStatus = "idle";
  private lastExitCode: number | null = null;

  constructor(
    private readonly configService: IConfigService,
    private readonly repositoryRegistry: IRepositoryRegistry,
    private readonly repositoryId?: string,
    private readonly processRunner: ClaudeProcessRunner = new ClaudeProcessRunner(),
  ) {}

  async execute(prompt: string, options?: ClaudeExecuteOptions): Promise<ClaudeExecutionResult> {
    let output = "";
    for await (const chunk of this.stream(prompt, options)) {
      output += chunk;
    }
    return { output, exitCode: this.lastExitCode };
  }

  async *stream(prompt: string, options: ClaudeExecuteOptions = {}): AsyncIterable<string> {
    if (this.activeProcess) {
      throw new ClaudeAlreadyRunningError();
    }

    const repository = this.resolveRepository();
    const claudeConfig = this.configService.getClaudeConfig();
    const shouldContinue = options.continue ?? claudeConfig.session.resume_previous;
    const args = [
      "--print",
      "--output-format",
      "stream-json",
      "--verbose",
      "--include-partial-messages",
      "--permission-mode",
      claudeConfig.execution.approval_mode,
      ...(shouldContinue ? ["--continue"] : []),
      prompt,
    ];

    this.status = "running";
    const handle = this.processRunner.spawn(claudeConfig.cli.executable, args, repository.path);
    this.activeProcess = handle;

    const timeoutMinutes = claudeConfig.execution.max_execution_minutes;
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      handle.kill();
    }, timeoutMinutes * 60_000);

    let resultIsError = false;
    let resultErrorSubtype = "";

    try {
      let buffer = "";
      for await (const chunk of handle.stdout) {
        buffer += chunk;
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;

          const event = this.parseEvent(trimmed);
          if (!event) continue;

          if (event.type === "stream_event" && event.event?.type === "content_block_delta" && event.event.delta?.type === "text_delta") {
            const text = event.event.delta.text;
            if (typeof text === "string" && text.length > 0) {
              yield text;
            }
          } else if (event.type === "result") {
            resultIsError = Boolean(event.is_error);
            resultErrorSubtype = typeof event.subtype === "string" ? event.subtype : "";
          }
        }
      }

      const exitCode = await handle.exitCode;
      this.lastExitCode = exitCode;

      if (timedOut) {
        throw new ClaudeExecutionTimeoutError(timeoutMinutes);
      }
      if (exitCode !== 0) {
        throw new ClaudeCommandError(args, exitCode, handle.getStderr());
      }
      if (resultIsError) {
        throw new ClaudeCommandError(args, exitCode, resultErrorSubtype || "Claude reported an error result");
      }

      this.status = "completed";
    } catch (error) {
      this.status = "error";
      throw error;
    } finally {
      clearTimeout(timeout);
      this.activeProcess = undefined;
    }
  }

  private parseEvent(line: string): ClaudeStreamEvent | undefined {
    try {
      return JSON.parse(line) as ClaudeStreamEvent;
    } catch {
      return undefined;
    }
  }

  async stopSession(): Promise<void> {
    if (this.activeProcess) {
      this.activeProcess.kill();
      this.status = "stopped";
    }
  }

  getStatus(): ClaudeRunState {
    return { status: this.status, lastExitCode: this.lastExitCode };
  }

  isRunning(): boolean {
    return this.activeProcess !== undefined;
  }

  private resolveRepository(): Repository {
    if (this.repositoryId) {
      return this.repositoryRegistry.getRepository(this.repositoryId);
    }

    const activeRepository = this.repositoryRegistry.getActiveRepository();
    if (!activeRepository) {
      throw new NoActiveRepositoryError();
    }
    return activeRepository;
  }
}
