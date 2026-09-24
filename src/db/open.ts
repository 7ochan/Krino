import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as schema from "./schema.js";

export interface KrinoDatabase {
  raw: Database.Database;
  orm: BetterSQLite3Database<typeof schema>;
  databasePath: string;
  artifactsDirectory: string;
  close(): void;
}

export interface OpenDatabaseOptions {
  dataDirectory?: string;
  databasePath?: string;
}

export function openDatabase(options: OpenDatabaseOptions = {}): KrinoDatabase {
  const dataDirectory = resolve(options.dataDirectory ?? process.env.KRINO_DATA_DIR ?? ".krino");
  const databasePath = resolve(options.databasePath ?? process.env.KRINO_DB_PATH ?? `${dataDirectory}/krino.sqlite`);
  const artifactsDirectory = resolve(dataDirectory, "artifacts");
  mkdirSync(dirname(databasePath), { recursive: true });
  mkdirSync(artifactsDirectory, { recursive: true });

  const raw = new Database(databasePath);
  raw.pragma("foreign_keys = ON");
  raw.pragma("journal_mode = WAL");
  raw.pragma("busy_timeout = 5000");
  const orm = drizzle(raw, { schema });
  const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
  try {
    migrate(orm, { migrationsFolder: resolve(projectRoot, "drizzle") });
  } catch (error) {
    raw.close();
    throw error;
  }
  return { raw, orm, databasePath, artifactsDirectory, close: () => raw.close() };
}
