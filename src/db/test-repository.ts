import { eq, asc } from "drizzle-orm";
import { parseTestDefinition, type TestDefinition } from "../definition.js";
import type { StoredTest, TestRepository, TestSummary } from "../application/models.js";
import type { KrinoDatabase } from "./open.js";
import { tests } from "./schema.js";

function toStored(row: typeof tests.$inferSelect): StoredTest {
  const definition = parseTestDefinition(JSON.parse(row.definition) as unknown);
  if (definition.id !== row.id || definition.name !== row.name || definition.schemaVersion !== row.schemaVersion) {
    throw new Error(`Stored test metadata does not match its validated definition (test ${row.id})`);
  }
  return { id: row.id, name: row.name, schemaVersion: row.schemaVersion, createdAt: row.createdAt, updatedAt: row.updatedAt, definition };
}

function toSummary(row: typeof tests.$inferSelect): TestSummary {
  return { id: row.id, name: row.name, schemaVersion: row.schemaVersion, createdAt: row.createdAt, updatedAt: row.updatedAt };
}

export class SqliteTestRepository implements TestRepository {
  constructor(private readonly database: KrinoDatabase) {}

  create(definition: TestDefinition): StoredTest {
    const now = new Date().toISOString();
    this.database.orm.insert(tests).values({
      id: definition.id,
      name: definition.name,
      schemaVersion: definition.schemaVersion,
      definition: JSON.stringify(definition),
      createdAt: now,
      updatedAt: now,
    }).run();
    return this.get(definition.id)!;
  }

  upsert(definition: TestDefinition): StoredTest {
    const existing = this.get(definition.id);
    if (!existing) return this.create(definition);
    return this.update(definition.id, definition)!;
  }

  get(id: string): StoredTest | null {
    const row = this.database.orm.select().from(tests).where(eq(tests.id, id)).get();
    return row ? toStored(row) : null;
  }

  list(): TestSummary[] {
    return this.database.orm.select().from(tests).orderBy(asc(tests.name), asc(tests.id)).all().map(toSummary);
  }

  update(id: string, definition: TestDefinition): StoredTest | null {
    if (definition.id !== id) throw new Error("Test ID in definition must match the route ID");
    const existing = this.get(id);
    if (!existing) return null;
    this.database.orm.update(tests).set({
      name: definition.name,
      schemaVersion: definition.schemaVersion,
      definition: JSON.stringify(definition),
      updatedAt: new Date().toISOString(),
    }).where(eq(tests.id, id)).run();
    return this.get(id);
  }

  delete(id: string): boolean {
    return this.database.orm.delete(tests).where(eq(tests.id, id)).run().changes > 0;
  }
}
