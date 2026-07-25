import type { Transaction, TransactionOptions } from "./types";

export interface IGitTransactionManager {
  begin(options: TransactionOptions): Promise<Transaction>;
}
