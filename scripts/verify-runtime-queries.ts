import type { IEngineeringAssistanceEngine } from "../src/assistance/interfaces";
import type { RepositoryAssistanceReport } from "../src/assistance/types";
import type { IApplicationService } from "../src/application/interfaces";
import type { IRuntimeControlService } from "../src/control/interfaces";
import type { RepositoryInsightReport } from "../src/decisions/types";
import type { RuntimeDiagnosticsReport } from "../src/diagnostics/types";
import type { IExecutionPipeline } from "../src/pipeline/interfaces";
import type { PipelineRequest, PipelineResult } from "../src/pipeline/types";
import type { RepositorySnapshot } from "../src/intelligence/types";
import type { ProjectMemoryEvent } from "../src/memory/types";
import type { RepositoryRecommendationReport } from "../src/recommendations/types";
import type { RuntimeReport } from "../src/reporting/types";
import type { IRuntimeAdministrationService } from "../src/admin/interfaces";
import type { ClaudeSessionInfo } from "../src/session/types";
import type { RuntimeStatus } from "../src/status/types";
import type { EngineeringWorkspace } from "../src/workspace/types";
import { CommandParser } from "../src/telegram/CommandParser";
import { CommandParseError } from "../src/telegram/errors";
import type { ITelegramClient, ITelegramSecurity } from "../src/telegram/interfaces";
import { ResponseFormatter } from "../src/telegram/ResponseFormatter";
import { TelegramAdapter } from "../src/telegram/TelegramAdapter";
import type { OutgoingMessage, TelegramUpdate } from "../src/telegram/types";

function assert(condition: boolean, message: string): void {
  console.log(`${condition ? "PASS" : "FAIL"} - ${message}`);
}

const sampleReport: RuntimeReport = {
  title: "AI Controller Runtime Report",
  health: "degraded",
  summary: "Runtime operational with degraded monitoring.",
  sections: [
    { title: "Runtime", lines: ["Running: Yes", "Uptime: 1h 2m 3s"] },
    { title: "Workers", lines: ['Worker "monitoring-worker": running = Yes'] },
    { title: "Monitoring", lines: ["Last cycle: Never", "Repositories monitored (last cycle): 0", "Repositories skipped (last cycle): 0"] },
    {
      title: "Policy",
      lines: ["Maintenance mode: No", "Quiet hours active: No", "Repositories disabled: 0", "Repositories in cooldown: 0", "Notification budget: 0/5"],
    },
    { title: "Attention", lines: ["Last dispatch: Never", "Notifications delivered: 0", "Notifications suppressed: 0"] },
    { title: "Findings", lines: ["[warning] No monitoring cycle has completed since 2026-01-01T00:00:00.000Z, despite the runtime being active."] },
  ],
  generatedAt: new Date(2026, 0, 1),
};

class FakeApplicationService implements IApplicationService {
  getRuntimeReportCalls = 0;
  constructor(private readonly report: RuntimeReport) {}
  async getRepositoryStatus(): Promise<RepositorySnapshot> {
    throw new Error("not used");
  }
  async getRepositoryHistory(): Promise<ProjectMemoryEvent[]> {
    throw new Error("not used");
  }
  async getRepositoryInsights(): Promise<RepositoryInsightReport> {
    throw new Error("not used");
  }
  getSessionStatus(): ClaudeSessionInfo | undefined {
    throw new Error("not used");
  }
  async getRecommendations(): Promise<RepositoryRecommendationReport> {
    throw new Error("not used");
  }
  async getEngineeringAssistance(): Promise<RepositoryAssistanceReport> {
    throw new Error("not used");
  }
  async getEngineeringWorkspace(): Promise<EngineeringWorkspace> {
    throw new Error("not used");
  }
  getRuntimeStatus(): RuntimeStatus {
    throw new Error("not used");
  }
  getRuntimeControl(): IRuntimeControlService {
    throw new Error("not used");
  }
  getRuntimeAdministration(): IRuntimeAdministrationService {
    throw new Error("not used");
  }
  getRuntimeDiagnosis(): RuntimeDiagnosticsReport {
    throw new Error("not used, per requirement 1: runtime queries must use getRuntimeReport() only");
  }
  getRuntimeReport(): RuntimeReport {
    this.getRuntimeReportCalls += 1;
    return this.report;
  }
}

class FakeExecutionPipeline implements IExecutionPipeline {
  async run(_request: PipelineRequest): Promise<PipelineResult> {
    throw new Error("not used — no runtime query should ever reach ExecutionPipeline");
  }
}

class FakeTelegramSecurity implements ITelegramSecurity {
  constructor(private readonly authorizedUserId: number) {}
  isAuthorized(userId: number): boolean {
    return userId === this.authorizedUserId;
  }
}

class FakeTelegramClient implements ITelegramClient {
  sentMessages: OutgoingMessage[] = [];
  async sendMessage(message: OutgoingMessage): Promise<void> {
    this.sentMessages.push(message);
  }
  async getUpdates(): Promise<TelegramUpdate[]> {
    throw new Error("not used");
  }
  async answerCallbackQuery(): Promise<void> {
    throw new Error("not used");
  }
}

const AUTHORIZED_USER_ID = 111;
const UNAUTHORIZED_USER_ID = 222;
const CHAT_ID = 999;

function buildUpdate(updateId: number, userId: number, text: string): TelegramUpdate {
  return { updateId, message: { chatId: CHAT_ID, userId, text } };
}

async function main(): Promise<void> {
  // --- CommandParser: every /runtime subcommand, plus the bare form and an
  // unknown subcommand ---
  {
    const parser = new CommandParser();

    const bare = parser.parse("/runtime");
    assert(bare.kind === "query" && bare.query.type === "runtime-report", `bare "/runtime" resolves to runtime-report (got ${JSON.stringify(bare)})`);

    const report = parser.parse("/runtime report");
    assert(report.kind === "query" && report.query.type === "runtime-report", '"/runtime report" resolves to runtime-report');
    assert(
      JSON.stringify(bare) === JSON.stringify(report),
      "bare \"/runtime\" and \"/runtime report\" parse to exactly the same ParsedCommand — behave identically, per requirement 3",
    );

    const status = parser.parse("/runtime status");
    assert(status.kind === "query" && status.query.type === "runtime-status", '"/runtime status" resolves to runtime-status');

    const diagnostics = parser.parse("/runtime diagnostics");
    assert(diagnostics.kind === "query" && diagnostics.query.type === "runtime-diagnostics", '"/runtime diagnostics" resolves to runtime-diagnostics');

    const monitoring = parser.parse("/runtime monitoring");
    assert(monitoring.kind === "query" && monitoring.query.type === "runtime-monitoring", '"/runtime monitoring" resolves to runtime-monitoring');

    const policy = parser.parse("/runtime policy");
    assert(policy.kind === "query" && policy.query.type === "runtime-policy", '"/runtime policy" resolves to runtime-policy');

    let threw = false;
    try {
      parser.parse("/runtime foo");
    } catch (error) {
      threw = error instanceof CommandParseError && /runtime command "foo"/.test(error.message);
    }
    assert(threw, "\"/runtime foo\" throws CommandParseError naming the unrecognized subcommand");

    // Case-insensitivity, consistent with every other command.
    const upper = parser.parse("/RUNTIME Status");
    assert(upper.kind === "query" && upper.query.type === "runtime-status", '"/RUNTIME Status" is parsed case-insensitively, same as every other command');
  }

  // --- ResponseFormatter: section selection/joining against the sample report ---
  {
    const formatter = new ResponseFormatter();

    const full = formatter.formatRuntimeReport(sampleReport);
    assert(full.includes(sampleReport.title), "formatRuntimeReport() includes the report title verbatim");
    assert(full.includes(sampleReport.health), "formatRuntimeReport() includes health verbatim");
    assert(full.includes(sampleReport.summary), "formatRuntimeReport() includes summary verbatim");
    for (const section of sampleReport.sections) {
      assert(full.includes(section.title), `formatRuntimeReport() includes the "${section.title}" section title`);
      for (const line of section.lines) {
        assert(full.includes(line), `formatRuntimeReport() includes the exact line "${line}" verbatim`);
      }
    }

    const status = formatter.formatRuntimeStatus(sampleReport);
    assert(!status.includes(sampleReport.health) && !status.includes(sampleReport.summary), "formatRuntimeStatus() excludes health/summary — raw facts only");
    assert(!status.includes("Findings"), "formatRuntimeStatus() excludes the Findings section");
    for (const title of ["Runtime", "Workers", "Monitoring", "Policy", "Attention"]) {
      assert(status.includes(title), `formatRuntimeStatus() includes the "${title}" section`);
    }

    const diagnostics = formatter.formatRuntimeDiagnostics(sampleReport);
    assert(diagnostics.includes(sampleReport.health) && diagnostics.includes(sampleReport.summary), "formatRuntimeDiagnostics() includes health and summary");
    assert(diagnostics.includes("Findings") && diagnostics.includes(sampleReport.sections[5]!.lines[0]!), "formatRuntimeDiagnostics() includes the Findings section, verbatim");
    assert(!diagnostics.includes("Repositories disabled"), "formatRuntimeDiagnostics() excludes the raw-facts Policy section content");

    const monitoring = formatter.formatRuntimeMonitoring(sampleReport);
    assert(monitoring.includes("Last cycle: Never"), "formatRuntimeMonitoring() includes the Monitoring section's lines verbatim");
    assert(!monitoring.includes("Notification budget"), "formatRuntimeMonitoring() excludes every other section");

    const policy = formatter.formatRuntimePolicy(sampleReport);
    assert(policy.includes("Notification budget: 0/5"), "formatRuntimePolicy() includes the Policy section's lines verbatim");
    assert(!policy.includes("Last cycle"), "formatRuntimePolicy() excludes every other section");

    // Determinism at the formatter level: same input, same output.
    assert(formatter.formatRuntimeReport(sampleReport) === full, "formatRuntimeReport() is deterministic for the same input");
    assert(formatter.formatRuntimeStatus(sampleReport) === status, "formatRuntimeStatus() is deterministic for the same input");
  }

  // --- TelegramAdapter end-to-end: real CommandParser + real ResponseFormatter
  // (default-constructed), fakes only at the true I/O/service boundary ---

  // /runtime (bare) behaves exactly like /runtime report, end to end.
  {
    const applicationService = new FakeApplicationService(sampleReport);
    const client = new FakeTelegramClient();
    const adapter = new TelegramAdapter(new FakeExecutionPipeline(), applicationService, new FakeTelegramSecurity(AUTHORIZED_USER_ID), client);

    await adapter.handleUpdate(buildUpdate(1, AUTHORIZED_USER_ID, "/runtime"));
    const bareText = client.sentMessages[0]?.text;

    await adapter.handleUpdate(buildUpdate(2, AUTHORIZED_USER_ID, "/runtime report"));
    const reportText = client.sentMessages[1]?.text;

    assert(bareText === reportText, "/runtime (bare) produces byte-for-byte the same message as /runtime report");
    assert(applicationService.getRuntimeReportCalls === 2, "two runtime queries so far -> getRuntimeReport() called exactly twice, once each");
  }

  // /runtime status
  {
    const applicationService = new FakeApplicationService(sampleReport);
    const client = new FakeTelegramClient();
    const adapter = new TelegramAdapter(new FakeExecutionPipeline(), applicationService, new FakeTelegramSecurity(AUTHORIZED_USER_ID), client);

    await adapter.handleUpdate(buildUpdate(1, AUTHORIZED_USER_ID, "/runtime status"));
    assert(applicationService.getRuntimeReportCalls === 1, "/runtime status -> getRuntimeReport() called exactly once");
    const text = client.sentMessages[0]?.text ?? "";
    assert(text.includes("Monitoring") && !text.includes("Findings"), "/runtime status end-to-end shows raw-facts sections, not Findings");
  }

  // /runtime diagnostics
  {
    const applicationService = new FakeApplicationService(sampleReport);
    const client = new FakeTelegramClient();
    const adapter = new TelegramAdapter(new FakeExecutionPipeline(), applicationService, new FakeTelegramSecurity(AUTHORIZED_USER_ID), client);

    await adapter.handleUpdate(buildUpdate(1, AUTHORIZED_USER_ID, "/runtime diagnostics"));
    assert(applicationService.getRuntimeReportCalls === 1, "/runtime diagnostics -> getRuntimeReport() called exactly once");
    const text = client.sentMessages[0]?.text ?? "";
    assert(text.includes(sampleReport.summary) && text.includes("Findings"), "/runtime diagnostics end-to-end shows the summary and Findings");
  }

  // /runtime monitoring
  {
    const applicationService = new FakeApplicationService(sampleReport);
    const client = new FakeTelegramClient();
    const adapter = new TelegramAdapter(new FakeExecutionPipeline(), applicationService, new FakeTelegramSecurity(AUTHORIZED_USER_ID), client);

    await adapter.handleUpdate(buildUpdate(1, AUTHORIZED_USER_ID, "/runtime monitoring"));
    assert(applicationService.getRuntimeReportCalls === 1, "/runtime monitoring -> getRuntimeReport() called exactly once");
    const text = client.sentMessages[0]?.text ?? "";
    assert(text.includes("Repositories monitored (last cycle): 0") && !text.includes("Notification budget"), "/runtime monitoring end-to-end shows only the Monitoring section");
  }

  // /runtime policy
  {
    const applicationService = new FakeApplicationService(sampleReport);
    const client = new FakeTelegramClient();
    const adapter = new TelegramAdapter(new FakeExecutionPipeline(), applicationService, new FakeTelegramSecurity(AUTHORIZED_USER_ID), client);

    await adapter.handleUpdate(buildUpdate(1, AUTHORIZED_USER_ID, "/runtime policy"));
    assert(applicationService.getRuntimeReportCalls === 1, "/runtime policy -> getRuntimeReport() called exactly once");
    const text = client.sentMessages[0]?.text ?? "";
    assert(text.includes("Notification budget: 0/5") && !text.includes("Last cycle"), "/runtime policy end-to-end shows only the Policy section");
  }

  // Unknown runtime subcommand end-to-end: same unknown-command mechanism as
  // any other unrecognized command — a plain reply, not "Something went wrong".
  {
    const applicationService = new FakeApplicationService(sampleReport);
    const client = new FakeTelegramClient();
    const adapter = new TelegramAdapter(new FakeExecutionPipeline(), applicationService, new FakeTelegramSecurity(AUTHORIZED_USER_ID), client);

    await adapter.handleUpdate(buildUpdate(1, AUTHORIZED_USER_ID, "/runtime foo"));
    await adapter.handleUpdate(buildUpdate(2, AUTHORIZED_USER_ID, "/totally-bogus-command"));

    const runtimeUnknownText = client.sentMessages[0]?.text ?? "";
    const genericUnknownText = client.sentMessages[1]?.text ?? "";

    assert(applicationService.getRuntimeReportCalls === 0, "an unrecognized runtime subcommand never reaches ApplicationService.getRuntimeReport()");
    assert(!runtimeUnknownText.startsWith("Something went wrong"), "an unrecognized runtime subcommand is reported as a plain parse error, not a runtime failure");
    assert(runtimeUnknownText.includes('"foo"'), "the unrecognized-subcommand message names the actual unrecognized subcommand");
    assert(
      runtimeUnknownText.startsWith("Sorry, I don't recognize") && genericUnknownText.startsWith("Sorry, I don't recognize"),
      "an unrecognized runtime subcommand and a wholly unrecognized top-level command both go through the exact same 'Sorry, I don't recognize...' mechanism",
    );
  }

  // Authorization unchanged: an unauthorized user is rejected before parsing
  // ever happens, exactly as for any other command — no runtime information
  // leaks to an unauthorized caller.
  {
    const applicationService = new FakeApplicationService(sampleReport);
    const client = new FakeTelegramClient();
    const adapter = new TelegramAdapter(new FakeExecutionPipeline(), applicationService, new FakeTelegramSecurity(AUTHORIZED_USER_ID), client);

    await adapter.handleUpdate(buildUpdate(1, UNAUTHORIZED_USER_ID, "/runtime report"));

    assert(client.sentMessages[0]?.text === "You are not authorized to use this bot.", "an unauthorized user receives the existing, unchanged rejection message");
    assert(applicationService.getRuntimeReportCalls === 0, "an unauthorized user's runtime query never reaches ApplicationService.getRuntimeReport()");
  }

  // Deterministic output end-to-end: the same command, issued twice against
  // the same underlying RuntimeReport, produces identical text both times.
  {
    const applicationService = new FakeApplicationService(sampleReport);
    const client = new FakeTelegramClient();
    const adapter = new TelegramAdapter(new FakeExecutionPipeline(), applicationService, new FakeTelegramSecurity(AUTHORIZED_USER_ID), client);

    await adapter.handleUpdate(buildUpdate(1, AUTHORIZED_USER_ID, "/runtime report"));
    await adapter.handleUpdate(buildUpdate(2, AUTHORIZED_USER_ID, "/runtime report"));

    assert(client.sentMessages[0]?.text === client.sentMessages[1]?.text, "/runtime report issued twice against the same RuntimeReport produces identical output both times");
    assert(applicationService.getRuntimeReportCalls === 2, "two identical requests -> getRuntimeReport() called exactly twice, once per request");
  }
}

main();
