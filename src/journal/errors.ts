export class JournalEntryNotFoundError extends Error {
  constructor(id: string) {
    super(`No journal entry found with id "${id}".`);
    this.name = "JournalEntryNotFoundError";
  }
}
