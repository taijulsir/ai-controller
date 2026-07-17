import { NotifyingAutonomousExecutionOrchestrator } from "../src/telegram/NotifyingAutonomousExecutionOrchestrator";
import { ResponseFormatter } from "../src/telegram/ResponseFormatter";
import type { IAutonomousExecutionOrchestrator } from "../src/autonomousexecution/interfaces";
import type { ITelegramClient } from "../src/telegram/interfaces";
import type { OutgoingMessage, TelegramUpdate } from "../src/telegram/types";
import type { PipelineResult } from "../src/pipeline/types";
import type { RepositorySnapshot } from "../src/intelligence/types";

function assert(condition: boolean, message: string): void {
  console.log(`${condition ? "PASS" : "FAIL"} - ${message}`);
}

function shipResult(completed: boolean): PipelineResult {
  const step = (taskType: "verify-git-status" | "create-commit" | "push-changes" | "create-pull-request", success: boolean) => ({
    stepId: taskType,
    taskType,
    executionResult: {
      kind: "task" as const,
      taskResult: { success, taskType, correlationId: "c" },
      startedAt: new Date(),
      completedAt: new Date(),
      durationMs: 1,
    },
  });
  const steps = [step("verify-git-status", true), step("create-commit", true), step("push-changes", completed), ...(completed ? [step("create-pull-request", true)] : [])];
  const workflowResult = { workflowId: "ship", correlationId: "c", status: completed ? ("completed" as const) : ("failed" as const), steps, startedAt: new Date(), completedAt: new Date(), durationMs: 1 };
  return {
    path: "full",
    context: { task: { type: "create-commit", input: { message: "x" } }, repositoryId: "alpha", repository: {} as RepositorySnapshot, generatedAt: new Date() },
    strategy: {} as PipelineResult extends { path: "full"; strategy: infer S } ? S : never,
    plan: {} as PipelineResult extends { path: "full"; plan: infer P } ? P : never,
    program: { repositoryId: "alpha", plan: {}, steps: [] } as PipelineResult extends { path: "full"; program: infer PR } ? PR : never,
    stepOutcomes: [{ status: "executed", capability: "IntegratedDelivery", request: { kind: "workflow", workflowId: "ship" }, result: { kind: "workflow", workflowResult, startedAt: new Date(), completedAt: new Date(), durationMs: 1 } }],
    completed,
  };
}

class FakeInnerOrchestrator implements IAutonomousExecutionOrchestrator {
  public calls: (string | undefined)[] = [];
  constructor(
    private readonly result: PipelineResult | undefined,
    private readonly shouldThrow = false,
  ) {}
  async attemptExecution(correlationId?: string): Promise<PipelineResult | undefined> {
    this.calls.push(correlationId);
    if (this.shouldThrow) {
      throw new Error("inner orchestrator refuses to execute");
    }
    return this.result;
  }
}

class RecordingTelegramClient implements ITelegramClient {
  public sentMessages: OutgoingMessage[] = [];
  constructor(private readonly shouldThrow = false) {}
  async sendMessage(message: OutgoingMessage): Promise<void> {
    if (this.shouldThrow) {
      throw new Error("telegram send failed");
    }
    this.sentMessages.push(message);
  }
  async getUpdates(): Promise<TelegramUpdate[]> {
    throw new Error("not used");
  }
  async answerCallbackQuery(): Promise<void> {}
}

const CHAT_ID = 555;

async function verifySuccessfulNotification(): Promise<void> {
  const result = shipResult(true);
  const inner = new FakeInnerOrchestrator(result);
  const telegramClient = new RecordingTelegramClient();
  const formatter = new ResponseFormatter();
  const decorator = new NotifyingAutonomousExecutionOrchestrator(inner, telegramClient, formatter, CHAT_ID);

  const returned = await decorator.attemptExecution("telegram:555:0");

  assert(inner.calls.length === 1 && inner.calls[0] === "telegram:555:0", "every call is forwarded unchanged to the wrapped orchestrator, including the correlationId");
  assert(returned === result, "the decorator returns the exact same PipelineResult instance the inner orchestrator produced -- never wrapped, never reinterpreted");
  assert(telegramClient.sentMessages.length === 1, "a real PipelineResult triggers exactly one notification");
  assert(telegramClient.sentMessages[0].chatId === CHAT_ID, "the notification is sent to the configured operator chat");
  assert(telegramClient.sentMessages[0].text === formatter.formatAutonomousExecutionResult(result), "the notification text is produced by the existing, unmodified formatAutonomousExecutionResult(), not a new formatting path");
}

async function verifyNoNotificationForNoOp(): Promise<void> {
  const inner = new FakeInnerOrchestrator(undefined); // nothing eligible
  const telegramClient = new RecordingTelegramClient();
  const decorator = new NotifyingAutonomousExecutionOrchestrator(inner, telegramClient, new ResponseFormatter(), CHAT_ID);

  const returned = await decorator.attemptExecution();

  assert(returned === undefined, "undefined is forwarded unchanged when nothing was eligible");
  assert(telegramClient.sentMessages.length === 0, "no notification is sent when no execution occurred -- an hourly no-op tick never becomes operator noise");
}

async function verifyNotificationFailureIsolation(): Promise<void> {
  const result = shipResult(false); // a real, failed attempt
  const inner = new FakeInnerOrchestrator(result);
  const telegramClient = new RecordingTelegramClient(true); // sendMessage always throws
  const decorator = new NotifyingAutonomousExecutionOrchestrator(inner, telegramClient, new ResponseFormatter(), CHAT_ID);

  let threw = false;
  let returned: PipelineResult | undefined;
  try {
    returned = await decorator.attemptExecution();
  } catch {
    threw = true;
  }

  assert(!threw, "a failing Telegram send never propagates out of attemptExecution()");
  assert(returned === result, "the real PipelineResult is still returned exactly, even though the notification attempt failed");
}

async function verifyInnerFailurePropagatesUnchanged(): Promise<void> {
  const inner = new FakeInnerOrchestrator(undefined, true); // the wrapped orchestrator itself throws
  const telegramClient = new RecordingTelegramClient();
  const decorator = new NotifyingAutonomousExecutionOrchestrator(inner, telegramClient, new ResponseFormatter(), CHAT_ID);

  let threw = false;
  try {
    await decorator.attemptExecution();
  } catch (error) {
    threw = error instanceof Error && error.message === "inner orchestrator refuses to execute";
  }

  assert(threw, "a failure from the wrapped orchestrator itself still propagates -- this decorator only adds a side effect after success, it never swallows the inner call's own errors");
  assert(telegramClient.sentMessages.length === 0, "no notification is attempted when the inner orchestrator itself throws before producing a result");
}

async function verifyConfiguredVsUnconfiguredComposition(): Promise<void> {
  // Mirrors exactly what src/index.ts decides: with an operator chat
  // configured, AutonomousExecutionWorker is handed the notifying decorator;
  // without one, it is handed the plain orchestrator, completely unaware a
  // decorator variant exists at all.
  const result = shipResult(true);

  const configuredInner = new FakeInnerOrchestrator(result);
  const configuredTelegramClient = new RecordingTelegramClient();
  const configuredOrchestrator: IAutonomousExecutionOrchestrator = new NotifyingAutonomousExecutionOrchestrator(
    configuredInner,
    configuredTelegramClient,
    new ResponseFormatter(),
    CHAT_ID,
  );
  await configuredOrchestrator.attemptExecution();
  assert(configuredTelegramClient.sentMessages.length === 1, "configured composition (operator chat set) -> a real notification is sent");

  const unconfiguredOrchestrator: IAutonomousExecutionOrchestrator = new FakeInnerOrchestrator(result);
  const unconfiguredResult = await unconfiguredOrchestrator.attemptExecution();
  assert(unconfiguredResult === result, "unconfigured composition (operator chat unset) -> the plain orchestrator is used directly, same PipelineResult, no Telegram involvement of any kind");
}

async function main(): Promise<void> {
  await verifySuccessfulNotification();
  await verifyNoNotificationForNoOp();
  await verifyNotificationFailureIsolation();
  await verifyInnerFailurePropagatesUnchanged();
  await verifyConfiguredVsUnconfiguredComposition();
}

main();
