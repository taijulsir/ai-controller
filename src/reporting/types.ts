import type { RuntimeHealthLevel } from "../diagnostics/types";

export interface RuntimeReportSection {
  title: string;
  lines: string[];
}

// An immutable, point-in-time presentation of already-computed runtime
// information — same convention as every other "report" type in this
// codebase. Transport-neutral: no Markdown, no HTML, no Telegram formatting,
// no emoji, no pagination, no truncation. Getting a fresher report means
// calling IRuntimeReportingEngine.buildReport() again with fresh inputs, not
// mutating or re-reading this object.
export interface RuntimeReport {
  title: string;
  health: RuntimeHealthLevel;
  summary: string;
  sections: RuntimeReportSection[];
  generatedAt: Date;
}
