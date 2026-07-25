import { FilesystemJournalStorage } from "./FilesystemJournalStorage";
import { OperationJournal } from "./OperationJournal";
import type { IOperationJournal } from "./interfaces";

export * from "./errors";
export * from "./interfaces";
export * from "./types";
export { OperationJournal } from "./OperationJournal";
export { FilesystemJournalStorage } from "./FilesystemJournalStorage";

// Mirrors src/artifacts' createArtifactModule() convention -- the module's
// real construction entry point. Unlike artifacts, there is no in-memory
// index to rebuild: every query reads directly from disk, so this factory
// has nothing to await beyond returning the wired service.
export function createOperationJournal(directory: string): IOperationJournal {
  return new OperationJournal(new FilesystemJournalStorage(directory));
}
