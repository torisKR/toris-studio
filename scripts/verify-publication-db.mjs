#!/usr/bin/env node
// Bounded fixture runner: never reads application credentials or an existing DB.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:net";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import pg from "pg";

const bin = process.env.TORIS_TEST_PG_BIN || "/opt/homebrew/opt/postgresql@17/bin";
const scratch = process.env.TORIS_TEST_SCRATCH || join(homedir(), ".hermes/cache/scratch");
await mkdir(scratch, { recursive: true });
const root = await mkdtemp(join(scratch, "studio-publications-pg-"));
const data = join(root, "data"), state = join(root, "state");
await mkdir(state);
const listener = createServer();
await new Promise((resolve, reject) => { listener.once("error", reject); listener.listen(0, "127.0.0.1", resolve); });
const port = listener.address().port;
await new Promise(resolve => listener.close(resolve));
function run(file, args, env = process.env, inherit = false) {
  const result = spawnSync(file, args, { env, encoding: "utf8", stdio: inherit ? "inherit" : "pipe", timeout: 240_000 });
  if (result.error || result.status !== 0) throw new Error(`${file} failed (${result.status}): ${result.error?.message || result.stderr || result.stdout || "see test output"}`);
}
let started = false, client;
try {
  run(join(bin, "initdb"), ["-D", data, "-U", "toris_owner", "--auth-local=trust", "--auth-host=trust", "--encoding=UTF8", "--locale=C"]);
  run(join(bin, "pg_ctl"), ["-D", data, "-l", join(root, "server.log"), "-o", `-h 127.0.0.1 -p ${port} -c unix_socket_directories=''`, "-w", "-t", "20", "start"]);
  started = true;
  const name = `toris_publications_test_${Date.now()}`;
  client = new pg.Client({ host: "127.0.0.1", port, user: "toris_owner", database: "postgres", connectionTimeoutMillis: 3000 });
  await client.connect();
  await client.query("CREATE ROLE toris_app LOGIN");
  await client.query(`CREATE DATABASE ${name}`);
  await client.end();
  client = new pg.Client({ host: "127.0.0.1", port, user: "toris_owner", database: name });
  await client.connect();
  const schemas = await Promise.all(["001_social", "007_publications", "008_publication_handoffs", "009_planner", "010_ops_status"].map(name => readFile(resolve(`db/migrations/${name}.sql`), "utf8")));
  for (const schema of schemas) await client.query(schema);
  const publicationIds = [randomUUID(), randomUUID()];
  const jobIds = [randomUUID(), randomUUID()];
  for (const [index, mode] of ["manual", "manual_handoff"].entries()) {
    await client.query("INSERT INTO publications(id,payload) VALUES ($1,$2)", [publicationIds[index], { fixture: index === 0 ? "legacy_video" : "manual_article" }]);
    await client.query("INSERT INTO publication_jobs(id,publication_id,revision,target_id,approval_hash,snapshot,mode,status) VALUES ($1,$2,1,$3,$4,$5,$6,$7)", [jobIds[index], publicationIds[index], randomUUID(), "a".repeat(64), { fixture: true, platform: index === 0 ? "youtube" : "naver_blog" }, mode, index === 0 ? "queued" : "needs_human_publish"]);
  }
  const before = (await client.query("SELECT * FROM publication_jobs ORDER BY id")).rows;
  // Reapplication must preserve already-created rows and constraints.
  for (const schema of schemas) await client.query(schema);
  assert.equal((await client.query("SELECT count(*)::int AS n FROM social_schema_migrations")).rows[0].n, 5);
  assert.deepEqual((await client.query("SELECT * FROM publication_jobs ORDER BY id")).rows, before);
  // Planner and ops constraints: a link needs an id, ends follow starts, Google ids are unique, states are closed.
  const eventId = randomUUID();
  await client.query("INSERT INTO calendar_events(id,title,starts_at,ends_at,google_id) VALUES ($1,'회의',now(),now()+interval '1 hour','g1')", [eventId]);
  await assert.rejects(client.query("INSERT INTO calendar_events(id,title,starts_at,ends_at,google_id) VALUES ($1,'중복',now(),now(),'g1')", [randomUUID()]), { code: "23505" });
  await assert.rejects(client.query("INSERT INTO calendar_events(id,title,starts_at,ends_at) VALUES ($1,'거꾸로',now(),now()-interval '1 hour')", [randomUUID()]), { code: "23514" });
  await assert.rejects(client.query("INSERT INTO calendar_events(id,title,starts_at,ends_at,link_kind) VALUES ($1,'고아',now(),now(),'publication_job')", [randomUUID()]), { code: "23514" });
  assert.equal((await client.query("SELECT count(*)::int AS n FROM calendar_sync_state")).rows[0].n, 1, "sync state is a single row, kept on reapply");
  await assert.rejects(client.query("INSERT INTO calendar_sync_state(id) VALUES (2)"), { code: "23514" });
  const productId = randomUUID();
  await client.query("INSERT INTO products(id,name,kind,github_repo,health_url,play_package) VALUES ($1,'앱','app','torisKR/toris_app','https://toris.kr/health','com.toris.app')", [productId]);
  await assert.rejects(client.query("INSERT INTO products(id,name,kind,health_url) VALUES ($1,'평문','web','http://example.com')", [randomUUID()]), { code: "23514" });
  await assert.rejects(client.query("INSERT INTO products(id,name,kind,github_repo) VALUES ($1,'경로','web','../../etc')", [randomUUID()]), { code: "23514" });
  await assert.rejects(client.query("INSERT INTO product_status_snapshots(id,product_id,source,state) VALUES ($1,$2,'play','published')", [randomUUID(), productId]), { code: "23514" });
  for (const schema of schemas.slice(3)) await client.query(schema);
  assert.equal((await client.query("SELECT count(*)::int AS n FROM calendar_events")).rows[0].n, 1, "reapplying 009 keeps events");
  await client.query("DELETE FROM calendar_events; DELETE FROM products;");
  await assert.rejects(client.query("UPDATE publication_jobs SET status='queued' WHERE id=$1", [jobIds[1]]), { code: "23514" });
  await assert.rejects(client.query("UPDATE publication_jobs SET status='needs_human_publish' WHERE id=$1", [jobIds[0]]), { code: "23514" });
  await assert.rejects(client.query("UPDATE publication_jobs SET scheduled_at=now() WHERE id=$1", [jobIds[1]]), { code: "23514" });
  await client.query("DELETE FROM publications WHERE id=ANY($1::uuid[])", [publicationIds]);
  await client.end(); client = null;
  console.log("Isolated PostgreSQL migrations applied twice; running real queue tests (no SNS calls).");
  run("cargo", ["test", "--manifest-path", "desktop/src-tauri/Cargo.toml", "--no-default-features", "--lib", "--", "--ignored", "--test-threads=1", "publications::tests", "planner::tests::postgres", "ops_status::tests::postgres"], {
    ...process.env,
    // The application deliberately rejects password-less URLs even for trust fixtures.
    TORIS_PUBLICATIONS_TEST_DB: `postgresql://toris_app:fixture-only@127.0.0.1:${port}/${name}`,
    TORIS_PUBLICATIONS_TEST_STATE_ROOT: state,
    TMPDIR: scratch,
  }, true);
  console.log("PASS: isolated migrations preserve existing rows, handoff SQL constraints, manual handoff, user confirmation, queue recovery and competing claims.");
} finally {
  if (client) await client.end().catch(() => {});
  if (started) run(join(bin, "pg_ctl"), ["-D", data, "-m", "immediate", "-w", "stop"]);
  await rm(root, { recursive: true, force: true });
}
