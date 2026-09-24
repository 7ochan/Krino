import { parseTestDefinition } from "../definition.js";
import type { TestDefinition } from "../definition.js";
import type { StoredTest, TestRepository, TestSummary } from "./models.js";
import { ConflictError, NotFoundError } from "./errors.js";

export class TestService {
  constructor(private readonly repository: TestRepository) {}

  create(input: unknown): StoredTest {
    const definition = parseTestDefinition(input);
    try {
      return this.repository.create(definition);
    } catch (error) {
      if (error instanceof Error && /unique|primary key/i.test(error.message)) throw new ConflictError(`Test "${definition.id}" already exists`);
      throw error;
    }
  }

  upsert(definition: TestDefinition): StoredTest { return this.repository.upsert(parseTestDefinition(definition)); }

  get(id: string): StoredTest {
    const test = this.repository.get(id);
    if (!test) throw new NotFoundError(`Test "${id}" was not found`);
    return test;
  }

  list(): TestSummary[] { return this.repository.list(); }

  update(id: string, input: unknown): StoredTest {
    const definition = parseTestDefinition(input);
    if (definition.id !== id) throw new Error("Test ID in definition must match the route ID");
    const test = this.repository.update(id, definition);
    if (!test) throw new NotFoundError(`Test "${id}" was not found`);
    return test;
  }

  delete(id: string): void {
    if (!this.repository.delete(id)) throw new NotFoundError(`Test "${id}" was not found`);
  }
}
