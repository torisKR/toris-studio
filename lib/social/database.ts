import pg from "pg";

export class DatabaseUnavailableError extends Error {
  readonly code = "DATABASE_UNAVAILABLE";
  constructor() { super("로컬 DB에 연결할 수 없습니다. npm run db:start로 PostgreSQL을 시작하세요."); }
}

export interface SqlResult<T> { rows: T[]; rowCount: number | null; }
export interface SqlExecutor {
  query<T extends pg.QueryResultRow = pg.QueryResultRow>(sql: string, values?: unknown[]): Promise<SqlResult<T>>;
}

declare global { var torisSocialPool: pg.Pool | undefined; }

function configuredUrl() {
  const raw = process.env.DATABASE_URL;
  if (!raw) throw new DatabaseUnavailableError();
  try {
    const url = new URL(raw);
    if (!["postgres:", "postgresql:"].includes(url.protocol) ||
        !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || !url.password) {
      throw new Error("Local authenticated PostgreSQL required");
    }
  } catch { throw new DatabaseUnavailableError(); }
  return raw;
}

export function getDatabase(): SqlExecutor {
  if (!globalThis.torisSocialPool) {
    globalThis.torisSocialPool = new pg.Pool({
      connectionString: configuredUrl(),
      max: 8,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 3000,
      query_timeout: 5000,
      statement_timeout: 5000,
      application_name: "toris-studio-local",
    });
    // pg emits background idle client errors. Prevent a process crash and never log credentials.
    globalThis.torisSocialPool.on("error", () => {
      console.error(JSON.stringify({ event: "social.database.idle_error", code: "DATABASE_UNAVAILABLE" }));
    });
  }
  return globalThis.torisSocialPool;
}

export async function closeDatabase() {
  const pool = globalThis.torisSocialPool;
  globalThis.torisSocialPool = undefined;
  if (pool) await pool.end();
}
