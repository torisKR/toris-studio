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
  const schemas = await Promise.all(["001_social", "007_publications", "008_publication_handoffs"].map(name => readFile(resolve(`db/migrations/${name}.sql`), "utf8")));
  for (const schema of schemas) await client.query(schema);
  const publicationIds = [randomUUID(), randomUUID()];
  const jobIds = [randomUUID(), randomUUID()];
  for (const [index, mode] of ["manual", "manual_handoff"].entries()) {
    await client.query("INSERT INTO publications(id,payload) VALUES ($1,$2)", [publicationIds[index], { fixture: index === 0 ? "legacy_video" : "manual_article" }]);
    await client.query("INSERT INTO publication_jobs(id,publication_id,revision,target_id,approval_hash,snapshot,mode,status) VALUES ($1,$2,1,$3,$4,$5,$6,$7)", [jobIds[index], publicationIds[index], randomUUID(), "a".repeat(64), { fixture: true, platform: index === 0 ? "youtube" : "naver_blog" }, mode, index === 0 ? "queued" : "needs_human_publish"]);
  }
  const before = (await client.query("SELECT * FROM publication_jobs ORDER BY id")).rows;
  const versions=["004_opal_research","005_opal_result_shape","006_keyword_explorer","007_publications","008_publication_handoffs","009_oauth_connections","010_analytics","011_sns_workspace"];
  async function upgrade(){
    await client.query("BEGIN");
    try{
      await client.query("SELECT pg_advisory_xact_lock(8740291)");
      await client.query(schemas[0]);
      for(const version of versions){const applied=await client.query("SELECT 1 FROM social_schema_migrations WHERE version=$1",[version]);if(!applied.rowCount||(version==="011_sns_workspace"&&(await client.query("SELECT to_regclass('public.analytics_report_owners') IS NULL AS missing")).rows[0].missing))await client.query(await readFile(resolve(`db/migrations/${version}.sql`),"utf8"));}
      await client.query("COMMIT");
    }catch(error){await client.query("ROLLBACK");throw error;}
  }
  await upgrade();
  const upgraded=(await client.query("SELECT * FROM publication_jobs ORDER BY id")).rows;
  const legacy=upgraded.find(row=>row.id===jobIds[0]);
  assert.equal(legacy.status,"needs_confirmation");
  assert.deepEqual(legacy.snapshot,before.find(row=>row.id===jobIds[0]).snapshot);
  assert.equal(upgraded.find(row=>row.id===jobIds[1]).status,"needs_human_publish");
  const channelIds=[randomUUID(),randomUUID()];
  for(const [i,platform] of ["x","naver_clip"].entries())await client.query("INSERT INTO social_channels(id,platform,name,handle,url) VALUES($1,$2,'manual fixture','fixture',$3)",[channelIds[i],platform,platform==="x"?"https://x.com/fixture":"https://clip.naver.com/fixture"]);
  // The ledger prevents historical six-platform constraints and legacy job
  // mutation from running again after X/Clip channels have been stored.
  // Repair an early workspace ledger without its additive report-owner table.
  await client.query("DROP TABLE analytics_report_owners");
  await client.query("REVOKE ALL ON analytics_settings,analytics_sources,analytics_previews,analytics_observations,analytics_jobs FROM toris_app");
  await upgrade();
  assert.equal((await client.query("SELECT has_table_privilege('toris_app','analytics_sources','SELECT') AS allowed")).rows[0].allowed,true);
  assert.equal((await client.query("SELECT count(*)::int AS n FROM social_schema_migrations")).rows[0].n,9);
  assert.deepEqual((await client.query("SELECT * FROM publication_jobs ORDER BY id")).rows,upgraded);
  assert.equal((await client.query("SELECT count(*)::int AS n FROM social_channels WHERE id=ANY($1::uuid[])",[channelIds])).rows[0].n,2);
  await assert.rejects(client.query("UPDATE publication_jobs SET status='queued' WHERE id=$1", [jobIds[1]]), { code: "23514" });
  await assert.rejects(client.query("UPDATE publication_jobs SET status='needs_human_publish' WHERE id=$1", [jobIds[0]]), { code: "23514" });
  await assert.rejects(client.query("UPDATE publication_jobs SET scheduled_at=now() WHERE id=$1", [jobIds[1]]), { code: "23514" });
  await client.query("DELETE FROM publications WHERE id=ANY($1::uuid[])", [publicationIds]);
  await client.end(); client = null;
  console.log("Isolated PostgreSQL migrations applied twice; running real queue tests (no SNS calls).");
  run("cargo", ["test", "--manifest-path", "desktop/src-tauri/Cargo.toml", "--no-default-features", "--lib", "publications::tests", "--", "--ignored", "--test-threads=1"], {
    ...process.env,
    // The application deliberately rejects password-less URLs even for trust fixtures.
    TORIS_PUBLICATIONS_TEST_DB: `postgresql://toris_app:fixture-only@127.0.0.1:${port}/${name}`,
    TORIS_PUBLICATIONS_TEST_STATE_ROOT: state,
    TMPDIR: scratch,
  }, true);
  const analyticsName = `studio_analytics_test_${Date.now()}`;
  client = new pg.Client({host:"127.0.0.1",port,user:"toris_owner",database:"postgres"});
  await client.connect();await client.query(`CREATE DATABASE ${analyticsName}`);await client.end();
  client = new pg.Client({host:"127.0.0.1",port,user:"toris_owner",database:analyticsName});await client.connect();
  for(const version of ["001_social",...versions])await client.query(await readFile(resolve(`db/migrations/${version}.sql`),"utf8"));
  await client.end();client=null;
  const appClient=new pg.Client({host:"127.0.0.1",port,user:"toris_app",database:analyticsName});
  await appClient.connect();
  try{await assert.rejects(appClient.query("CREATE TABLE forbidden_app_ddl(id int)"),{code:"42501"});}
  finally{await appClient.end();}
  run("cargo",["test","--locked","--manifest-path","desktop/src-tauri/Cargo.toml","--no-default-features","--test","analytics_contract","--","--ignored","--test-threads=1"],{
    ...process.env,TORIS_STUDIO_TEST_DATABASE_URL:`postgresql://toris_app:fixture-only@127.0.0.1:${port}/${analyticsName}`,TMPDIR:scratch
  },true);
  console.log("PASS: isolated migrations preserve legacy snapshots, hold unbound approvals once, retain X/Clip across reruns, and preserve handoff SQL constraints, manual handoff, user confirmation, queue recovery and competing claims; six real analytics persistence/expiry/backoff contracts also pass.");
} finally {
  if (client) await client.end().catch(() => {});
  if (started) run(join(bin, "pg_ctl"), ["-D", data, "-m", "immediate", "-w", "stop"]);
  await rm(root, { recursive: true, force: true });
}
