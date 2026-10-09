import { readFile } from "node:fs/promises";
import { parseEnv } from "node:util";
import pg from "pg";

const env = parseEnv(await readFile(".env.db.local", "utf8"));
if (!env.POSTGRES_PASSWORD) throw new Error("Run npm run db:start first.");
const db = new pg.Client({ host: "127.0.0.1", port: Number(env.TORIS_DB_PORT ?? "54329"),
  user: "toris_owner", password: env.POSTGRES_PASSWORD, database: "toris_studio", connectionTimeoutMillis: 3000,
  statement_timeout: 10000, application_name: "toris-studio-migrate" });
try {
  await db.connect();
  await db.query("BEGIN");
  await db.query("SELECT pg_advisory_xact_lock(8740291)");
  await db.query(await readFile("db/migrations/001_social.sql", "utf8"));
  await db.query("COMMIT");
  console.log("Social schema 001 is ready; existing records preserved.");
} catch {
  await db.query("ROLLBACK").catch(() => undefined);
  console.error("DB migration failed. Check local PostgreSQL and ignored .env.db.local credentials.");
  process.exitCode = 1;
} finally { await db.end(); }
