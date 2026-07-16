import type { RuntimeDiagnosticsReport } from "../diagnostics/types";
import type { WorkerStatus } from "../runtime/types";
import type { RuntimeStatus } from "../status/types";
import type { IRuntimeReportingEngine } from "./interfaces";
import type { RuntimeReport, RuntimeReportSection } from "./types";

const REPORT_TITLE = "AI Controller Runtime Report";

/**
 * Pure, dependency-free transform — no constructor dependencies, no I/O,
 * fully synchronous. It only ever reads the RuntimeStatus and
 * RuntimeDiagnosticsReport objects it's handed: it never calls
 * IRuntimeStatusService, IRuntimeDiagnosticsEngine, IRuntimeAdministrationService,
 * IRuntimeControlService, Telegram, any repository service, ControllerCore,
 * or Claude — there is no dependency here capable of any of that, by
 * construction, because this class holds no reference to any of them.
 *
 * Reporting never performs runtime analysis: it only reformats values,
 * groups information into sections, and converts values into readable text
 * (boolean -> "Yes"/"No", undefined date -> "Never", a duration in
 * milliseconds -> a human-readable "1h 2m 3s" string). It never determines
 * health, severity, staleness, or any policy interpretation — those are
 * read directly from the RuntimeDiagnosticsReport/RuntimeStatus it's handed,
 * never recomputed. health and summary are copied verbatim from
 * RuntimeDiagnosticsReport; every finding's message is rendered verbatim
 * (never regenerated from its kind) as "[severity] message".
 *
 * Transport-neutral by construction: no Markdown, no HTML, no Telegram
 * formatting, no emoji, no pagination, no truncation — any transport
 * (Telegram, a dashboard, a log line, a future UI) can render the sections/
 * lines this produces however it likes.
 */
export class RuntimeReportingEngine implements IRuntimeReportingEngine {
  buildReport(status: RuntimeStatus, diagnostics: RuntimeDiagnosticsReport): RuntimeReport {
    return {
      title: REPORT_TITLE,
      health: diagnostics.health,
      summary: diagnostics.summary,
      sections: [
        this.buildRuntimeSection(status),
        this.buildWorkersSection(status),
        this.buildMonitoringSection(status),
        this.buildPolicySection(status),
        this.buildAttentionSection(status),
        this.buildFindingsSection(diagnostics),
      ],
      generatedAt: new Date(),
    };
  }

  private buildRuntimeSection(status: RuntimeStatus): RuntimeReportSection {
    return {
      title: "Runtime",
      lines: [
        `Running: ${this.formatBoolean(status.runtime.running)}`,
        `Uptime: ${this.formatDuration(status.runtime.uptimeMs)}`,
      ],
    };
  }

  private buildWorkersSection(status: RuntimeStatus): RuntimeReportSection {
    if (status.workers.length === 0) {
      return { title: "Workers", lines: ["No workers registered."] };
    }
    return {
      title: "Workers",
      lines: status.workers.map((worker) => this.formatWorkerLine(worker)),
    };
  }

  private formatWorkerLine(worker: WorkerStatus): string {
    return `Worker "${worker.id}": running = ${this.formatBoolean(worker.running)}`;
  }

  private buildMonitoringSection(status: RuntimeStatus): RuntimeReportSection {
    return {
      title: "Monitoring",
      lines: [
        `Last cycle: ${this.formatDate(status.monitoring.lastCycleAt)}`,
        `Repositories monitored (last cycle): ${status.monitoring.repositoriesMonitoredLastCycle}`,
        `Repositories skipped (last cycle): ${status.monitoring.repositoriesSkippedLastCycle}`,
      ],
    };
  }

  private buildPolicySection(status: RuntimeStatus): RuntimeReportSection {
    const { policy } = status;
    return {
      title: "Policy",
      lines: [
        `Maintenance mode: ${this.formatBoolean(policy.maintenanceMode)}`,
        `Quiet hours active: ${this.formatBoolean(policy.quietHoursActive)}`,
        `Repositories disabled: ${policy.repositoriesDisabled}`,
        `Repositories in cooldown: ${policy.repositoriesInCooldown}`,
        `Notification budget: ${policy.globalNotificationBudget.used}/${policy.globalNotificationBudget.max}`,
      ],
    };
  }

  private buildAttentionSection(status: RuntimeStatus): RuntimeReportSection {
    return {
      title: "Attention",
      lines: [
        `Last dispatch: ${this.formatDate(status.attention.lastDispatchAt)}`,
        `Notifications delivered: ${status.attention.notificationsDelivered}`,
        `Notifications suppressed: ${status.attention.notificationsSuppressed}`,
      ],
    };
  }

  // Every finding is rendered, in the order RuntimeDiagnosticsReport already
  // produced them, with its message reused verbatim — never regenerated from
  // finding.kind, never filtered, never re-sorted.
  private buildFindingsSection(diagnostics: RuntimeDiagnosticsReport): RuntimeReportSection {
    if (diagnostics.findings.length === 0) {
      return { title: "Findings", lines: ["No findings."] };
    }
    return {
      title: "Findings",
      lines: diagnostics.findings.map((finding) => `[${finding.severity}] ${finding.message}`),
    };
  }

  private formatBoolean(value: boolean): string {
    return value ? "Yes" : "No";
  }

  private formatDate(date: Date | undefined): string {
    return date ? date.toISOString() : "Never";
  }

  private formatDuration(ms: number | undefined): string {
    if (ms === undefined) {
      return "Never";
    }
    const totalSeconds = Math.floor(ms / 1000);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;

    if (hours > 0) {
      return `${hours}h ${minutes}m ${seconds}s`;
    }
    if (minutes > 0) {
      return `${minutes}m ${seconds}s`;
    }
    return `${seconds}s`;
  }
}
