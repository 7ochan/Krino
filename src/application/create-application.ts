import { openDatabase } from "../db/open.js";
import { SqliteRunRepository } from "../db/run-repository.js";
import { SqliteTestRepository } from "../db/test-repository.js";
import { ExecutionService } from "./execution-service.js";
import { TestService } from "./test-service.js";
import type { TestDefinition } from "../definition.js";
import type { WorkerMessage } from "../protocol.js";

export interface CreateApplicationOptions {
  dataDirectory?: string;
  databasePath?: string;
  artifactsDirectory?: string;
  onRunCreated?: (runId: string, definition: TestDefinition, artifactsDirectory: string) => void;
  onWorkerMessage?: (message: WorkerMessage) => void;
}

export function createApplication(options: CreateApplicationOptions = {}) {
  const database = openDatabase(options);
  const artifactsDirectory = options.artifactsDirectory ?? database.artifactsDirectory;
  const testRepository = new SqliteTestRepository(database);
  const runRepository = new SqliteRunRepository(database);
  const tests = new TestService(testRepository);
  const execution = new ExecutionService({
    tests: testRepository,
    runs: runRepository,
    artifactsDirectory,
    ...(options.onRunCreated ? { onRunCreated: options.onRunCreated } : {}),
    ...(options.onWorkerMessage ? { onWorkerMessage: options.onWorkerMessage } : {}),
  });
  return {
    database,
    tests,
    execution,
    runs: {
      get(id: string) { return runRepository.get(id); },
      listForTest(testId: string) {
        tests.get(testId);
        return runRepository.listForTest(testId);
      },
    },
    close: database.close,
  };
}
