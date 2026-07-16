import type { Repository } from "../src/domain/repository/Repository";
import type {
  ClaudeConfig,
  ControllerConfig,
  GithubConfig,
  TelegramConfig,
} from "../src/config/types";
import type { IConfigService } from "../src/config/interfaces";
import type { AttentionEvent } from "../src/monitoring/types";
import { AttentionDispatcher } from "../src/attention/AttentionDispatcher";
import type { IAttentionTransport } from "../src/attention/interfaces";
import type { IRuntimePolicyEngine } from "../src/policy/interfaces";
import type { RuntimePolicyDecision, RuntimePolicyStatus } from "../src/policy/types";
import { NoNotificationRecipientConfiguredError } from "../src/telegram/errors";
import type { ITelegramClient } from "../src/telegram/interfaces";
import { TelegramAttentionTransport } from "../src/telegram/TelegramAttentionTransport";
import type { OutgoingMessage, TelegramUpdate } from "../src/telegram/types";

function assert(condition: boolean, message: string): void {
  console.log(`${condition ? "PASS" : "FAIL"} - ${message}`);
}

function attentionEvent(repositoryId: string, overrides: Partial<AttentionEvent> = {}): AttentionEvent {
  return {
    repositoryId,
    trigger: "new-urgent-recommendation",
    recommendationKind: "PullRequired",
    category: "blocking",
    priority: "high",
    reason: "test reason",
    generatedAt: new Date(),
    ...overrides,
  };
}

class RecordingTransport implements IAttentionTransport {
  deliverCalls: AttentionEvent[][] = [];
  constructor(private readonly shouldThrow = false) {}
  async deliver(events: AttentionEvent[]): Promise<void> {
    this.deliverCalls.push(events);
    if (this.shouldThrow) {
      throw new Error("transport refuses to deliver");
    }
  }
}

class FakeTelegramClient implements ITelegramClient {
  sendMessageCalls: OutgoingMessage[] = [];
  async sendMessage(message: OutgoingMessage): Promise<void> {
    this.sendMessageCalls.push(message);
  }
  async getUpdates(): Promise<TelegramUpdate[]> {
    throw new Error("not used");
  }
  async answerCallbackQuery(): Promise<void> {
    throw new Error("not used");
  }
}

// Allows every repository by default — only the "policy gating" tests below
// override notificationDecisionFor to deny a specific repository.
class FakeRuntimePolicyEngine implements IRuntimePolicyEngine {
  notificationDecisionFor: (repositoryId: string) => RuntimePolicyDecision = () => ({ allowed: true });
  recordNotificationSentCalls: string[] = [];

  evaluateMonitoring(): RuntimePolicyDecision {
    return { allowed: true };
  }
  evaluateNotification(repositoryId: string): RuntimePolicyDecision {
    return this.notificationDecisionFor(repositoryId);
  }
  recordNotificationSent(repositoryId: string): void {
    this.recordNotificationSentCalls.push(repositoryId);
  }
  setMaintenanceMode(): void {}
  setRepositoryMonitoringEnabled(): void {}
  getStatus(): RuntimePolicyStatus {
    return {
      maintenanceMode: false,
      quietHoursActive: false,
      repositoriesDisabled: 0,
      repositoriesInCooldown: 0,
      globalNotificationBudget: { used: 0, max: 0, windowMs: 0 },
    };
  }
}

class FakeConfigService implements IConfigService {
  constructor(private readonly allowedUsers: string[]) {}
  getControllerConfig(): ControllerConfig {
    throw new Error("not used");
  }
  getClaudeConfig(): ClaudeConfig {
    throw new Error("not used");
  }
  getGithubConfig(): GithubConfig {
    throw new Error("not used");
  }
  getTelegramConfig(): TelegramConfig {
    return {
      telegram: { enabled: true },
      bot: { token: "test-token" },
      security: { allowed_users: this.allowedUsers },
      notifications: { task_started: true, task_completed: true, task_failed: true },
    };
  }
  getRepositories(): Repository[] {
    throw new Error("not used");
  }
  reload(): void {
    throw new Error("not used");
  }
}

async function main(): Promise<void> {
  // dispatch() with zero registered transports is a safe no-op.
  {
    const policy = new FakeRuntimePolicyEngine();
    const dispatcher = new AttentionDispatcher(policy);
    let threw = false;
    try {
      await dispatcher.dispatch([attentionEvent("alpha")]);
    } catch {
      threw = true;
    }
    assert(!threw, "dispatch() with zero registered transports does not throw");
  }

  // dispatch() with an empty events array never calls any transport.
  {
    const policy = new FakeRuntimePolicyEngine();
    const dispatcher = new AttentionDispatcher(policy);
    const transport = new RecordingTransport();
    dispatcher.addTransport(transport);

    await dispatcher.dispatch([]);
    assert(transport.deliverCalls.length === 0, "dispatch() with an empty events array does not call any transport");
  }

  // dispatch() forwards the exact events array to a registered transport.
  {
    const policy = new FakeRuntimePolicyEngine();
    const dispatcher = new AttentionDispatcher(policy);
    const transport = new RecordingTransport();
    dispatcher.addTransport(transport);
    const events = [attentionEvent("alpha"), attentionEvent("alpha", { recommendationKind: "RepeatedFailures" })];

    await dispatcher.dispatch(events);
    assert(transport.deliverCalls.length === 1, "dispatch() calls deliver() exactly once per dispatch() call");
    assert(
      transport.deliverCalls[0]?.length === events.length && transport.deliverCalls[0]?.every((event, index) => event === events[index]),
      "dispatch() forwards every event unchanged (grouping repackages the array, not the event objects themselves)",
    );
  }

  // dispatch() fans out to every registered transport.
  {
    const policy = new FakeRuntimePolicyEngine();
    const dispatcher = new AttentionDispatcher(policy);
    const first = new RecordingTransport();
    const second = new RecordingTransport();
    dispatcher.addTransport(first);
    dispatcher.addTransport(second);

    await dispatcher.dispatch([attentionEvent("alpha")]);
    assert(first.deliverCalls.length === 1 && second.deliverCalls.length === 1, "dispatch() calls every registered transport");
  }

  // A failing transport is isolated: dispatch() itself never throws, and a
  // sibling transport still gets called.
  {
    const policy = new FakeRuntimePolicyEngine();
    const dispatcher = new AttentionDispatcher(policy);
    const failing = new RecordingTransport(true);
    const healthy = new RecordingTransport();
    dispatcher.addTransport(failing);
    dispatcher.addTransport(healthy);

    let threw = false;
    try {
      await dispatcher.dispatch([attentionEvent("alpha")]);
    } catch {
      threw = true;
    }
    assert(!threw, "dispatch() does not propagate a single transport's delivery failure");
    assert(healthy.deliverCalls.length === 1, "a sibling transport still receives the events after another transport's delivery fails");
  }

  // Phase 8.4: events for different repositories in one dispatch() call are
  // grouped and policy-evaluated separately — the dispatcher does not assume
  // a batch is already scoped to one repository (events[0] is never relied
  // upon).
  {
    const policy = new FakeRuntimePolicyEngine();
    const dispatcher = new AttentionDispatcher(policy);
    const transport = new RecordingTransport();
    dispatcher.addTransport(transport);

    await dispatcher.dispatch([attentionEvent("alpha"), attentionEvent("beta"), attentionEvent("alpha")]);

    assert(transport.deliverCalls.length === 2, "a batch spanning two repositories produces two separate deliver() calls, one per repository group");
    const repositoryIdsDelivered = transport.deliverCalls.map((events) => events[0]?.repositoryId).sort();
    assert(repositoryIdsDelivered.join(",") === "alpha,beta", "each deliver() call receives only the events for its own repository");
    const alphaGroup = transport.deliverCalls.find((events) => events[0]?.repositoryId === "alpha");
    assert(alphaGroup?.length === 2, "both of alpha's events are grouped into the same deliver() call, not split across two");
  }

  // Phase 8.4: RuntimePolicy.evaluateNotification() denying one repository in
  // a multi-repository batch does not affect delivery for another repository
  // in the same batch.
  {
    const policy = new FakeRuntimePolicyEngine();
    policy.notificationDecisionFor = (repositoryId) => (repositoryId === "alpha" ? { allowed: false, reason: "cooldown" } : { allowed: true });
    const dispatcher = new AttentionDispatcher(policy);
    const transport = new RecordingTransport();
    dispatcher.addTransport(transport);

    await dispatcher.dispatch([attentionEvent("alpha"), attentionEvent("beta")]);

    assert(transport.deliverCalls.length === 1, "a denied repository's group is never delivered");
    assert(transport.deliverCalls[0]?.[0]?.repositoryId === "beta", "an allowed sibling repository is still delivered in the same dispatch() call");
  }

  // Phase 8.4: recordNotificationSent() is called once per repository group,
  // only after a genuine delivery attempt — never when policy denied the
  // group, and never when there were zero transports to attempt delivery to.
  {
    const policy = new FakeRuntimePolicyEngine();
    const dispatcherWithNoTransports = new AttentionDispatcher(policy);
    await dispatcherWithNoTransports.dispatch([attentionEvent("alpha")]);
    assert(policy.recordNotificationSentCalls.length === 0, "recordNotificationSent() is never called when zero transports are registered — there was no attempt to record");
  }
  {
    const policy = new FakeRuntimePolicyEngine();
    policy.notificationDecisionFor = () => ({ allowed: false, reason: "cooldown" });
    const dispatcher = new AttentionDispatcher(policy);
    dispatcher.addTransport(new RecordingTransport());

    await dispatcher.dispatch([attentionEvent("alpha")]);
    assert(policy.recordNotificationSentCalls.length === 0, "recordNotificationSent() is never called for a repository policy denied");
  }
  {
    const policy = new FakeRuntimePolicyEngine();
    const dispatcher = new AttentionDispatcher(policy);
    dispatcher.addTransport(new RecordingTransport());

    await dispatcher.dispatch([attentionEvent("alpha")]);
    assert(
      policy.recordNotificationSentCalls.length === 1 && policy.recordNotificationSentCalls[0] === "alpha",
      "recordNotificationSent() is called exactly once, for the repository, after an allowed delivery attempt",
    );
  }

  // Phase 8.4: recordNotificationSent() still fires even if every registered
  // transport fails — cooldown/rate-limiting tracks that an attempt was
  // made, not that it succeeded, so a persistently-failing transport can
  // never defeat rate-limiting by silently never starting the cooldown.
  {
    const policy = new FakeRuntimePolicyEngine();
    const dispatcher = new AttentionDispatcher(policy);
    dispatcher.addTransport(new RecordingTransport(true));

    await dispatcher.dispatch([attentionEvent("alpha")]);
    assert(
      policy.recordNotificationSentCalls.length === 1,
      "recordNotificationSent() is called even when the only registered transport's delivery fails",
    );
  }

  // Phase 8.5: getStatus() reflects real dispatch activity — lastDispatchAt
  // and delivered/suppressed counts — not a placeholder or independently
  // tracked duplicate of the dispatch logic above.
  {
    const policy = new FakeRuntimePolicyEngine();
    const dispatcher = new AttentionDispatcher(policy);
    const beforeAnyDispatch = dispatcher.getStatus();
    assert(
      beforeAnyDispatch.lastDispatchAt === undefined && beforeAnyDispatch.notificationsDelivered === 0 && beforeAnyDispatch.notificationsSuppressed === 0,
      "getStatus() before any dispatch() call reports no activity",
    );

    dispatcher.addTransport(new RecordingTransport());
    await dispatcher.dispatch([attentionEvent("alpha")]);
    const afterDelivery = dispatcher.getStatus();
    assert(afterDelivery.lastDispatchAt instanceof Date, "getStatus() reports lastDispatchAt once dispatch() has been called with events");
    assert(afterDelivery.notificationsDelivered === 1 && afterDelivery.notificationsSuppressed === 0, "getStatus() counts a successful delivery attempt");

    policy.notificationDecisionFor = () => ({ allowed: false, reason: "cooldown" });
    await dispatcher.dispatch([attentionEvent("beta")]);
    const afterSuppression = dispatcher.getStatus();
    assert(
      afterSuppression.notificationsDelivered === 1 && afterSuppression.notificationsSuppressed === 1,
      "getStatus() counts a policy-suppressed repository separately from delivered ones, without resetting the delivered count",
    );
  }

  // Phase 8.6: resetStatistics() only resets dispatcher statistics — it
  // clears lastDispatchAt/delivered/suppressed, but must not affect
  // dispatch()'s actual behavior (registered transports still get called,
  // RuntimePolicy is still consulted normally) afterward.
  {
    const policy = new FakeRuntimePolicyEngine();
    const dispatcher = new AttentionDispatcher(policy);
    const transport = new RecordingTransport();
    dispatcher.addTransport(transport);

    await dispatcher.dispatch([attentionEvent("alpha")]);
    assert(dispatcher.getStatus().notificationsDelivered === 1, "one delivery recorded before resetStatistics()");

    dispatcher.resetStatistics();
    const afterReset = dispatcher.getStatus();
    assert(
      afterReset.lastDispatchAt === undefined && afterReset.notificationsDelivered === 0 && afterReset.notificationsSuppressed === 0,
      "resetStatistics() clears lastDispatchAt and both counters back to their initial values",
    );

    await dispatcher.dispatch([attentionEvent("beta")]);
    assert(transport.deliverCalls.length === 2, "dispatch() still calls registered transports normally after resetStatistics() — behavior is unaffected");
    assert(policy.recordNotificationSentCalls.includes("beta"), "dispatch() still consults and reports to RuntimePolicy normally after resetStatistics()");
    assert(dispatcher.getStatus().notificationsDelivered === 1, "the counter resumes counting from zero after the reset, not from the pre-reset total");
  }

  // TelegramAttentionTransport resolves the destination chat from the
  // existing security.allowed_users configuration — no new config field.
  {
    const client = new FakeTelegramClient();
    const configService = new FakeConfigService(["123456"]);
    const transport = new TelegramAttentionTransport(client, configService);

    await transport.deliver([attentionEvent("alpha", { reason: "3 unpushed commits" })]);
    assert(client.sendMessageCalls.length === 1, "TelegramAttentionTransport.deliver() sends exactly one message per call");
    assert(client.sendMessageCalls[0]?.chatId === 123456, "the destination chatId is the first configured allowed user, reused rather than newly configured");
    assert(client.sendMessageCalls[0]?.text.includes("alpha") && client.sendMessageCalls[0]?.text.includes("3 unpushed commits"), "the message text includes the repository id and reason");
  }

  // Multiple events in one dispatch become one message, not one per event.
  {
    const client = new FakeTelegramClient();
    const configService = new FakeConfigService(["123456"]);
    const transport = new TelegramAttentionTransport(client, configService);

    await transport.deliver([attentionEvent("alpha"), attentionEvent("beta")]);
    assert(client.sendMessageCalls.length === 1, "a batch of multiple events is delivered as a single message");
    assert(
      client.sendMessageCalls[0]?.text.includes("alpha") && client.sendMessageCalls[0]?.text.includes("beta"),
      "the single message mentions every event in the batch",
    );
  }

  // No allowed users configured -> a clear, typed error, not a silent no-op
  // or a raw Telegram API failure.
  {
    const client = new FakeTelegramClient();
    const configService = new FakeConfigService([]);
    const transport = new TelegramAttentionTransport(client, configService);

    let threw = false;
    try {
      await transport.deliver([attentionEvent("alpha")]);
    } catch (error) {
      threw = error instanceof NoNotificationRecipientConfiguredError;
    }
    assert(threw, "deliver() throws NoNotificationRecipientConfiguredError when security.allowed_users is empty");
    assert(client.sendMessageCalls.length === 0, "no message is sent when there is no configured recipient");
  }
}

main();
