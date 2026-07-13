import type { Repository } from "../domain/repository/Repository";

export interface IRepositoryRegistry {
  getAllRepositories(): Repository[];
  getRepository(id: string): Repository;
  getActiveRepository(): Repository | undefined;
  setActiveRepository(id: string): void;
  repositoryExists(id: string): boolean;
  refresh(): void;
}
