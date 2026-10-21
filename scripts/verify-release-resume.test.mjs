import assert from 'node:assert/strict';
import {mkdtemp, mkdir, readFile, readdir, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {CONFIG_PATH, RELEASE_ARTIFACTS, REPOSITORY, REQUIRED_JOBS, WORKFLOW, flattenPages, parseRunId, validateResume, verifyReleaseResume} from './verify-release-resume.mjs';

const RUN_ID = 39615374493, SOURCE = 'c020165d3f5ff6b4f9429f9d34f480c83283553b';
function fixture() {
  const config = JSON.stringify({version:'0.3.1',bundle:{createUpdaterArtifacts:true},plugins:{updater:{pubkey:'fixture-public-key',requireSignedVersion:true,allowDowngrades:false,endpoints:[`https://github.com/${REPOSITORY}/releases/latest/download/latest.json`]}}});
  const run = {id:RUN_ID,path:WORKFLOW,event:'workflow_dispatch',head_branch:'main',head_sha:SOURCE,run_attempt:2,repository:{id:42,full_name:REPOSITORY},head_repository:{id:42,full_name:REPOSITORY}};
  const jobs = [...REQUIRED_JOBS,'publish'].flatMap((name,index) => [1,2].map(attempt => ({id:100+index*10+attempt,name,run_id:RUN_ID,run_attempt:attempt,head_sha:SOURCE,head_branch:'main',status:'completed',conclusion:name==='publish'?'failure':'success'})));
  const artifacts = RELEASE_ARTIFACTS.map((name,index) => ({id:1000+index,name,digest:`sha256:${String(index+1).repeat(64)}`,size_in_bytes:100000,expired:false,expires_at:'2099-01-01T00:00:00Z',workflow_run:{id:RUN_ID,head_sha:SOURCE,head_branch:'main',repository_id:42,head_repository_id:42}}));
  return {runId:RUN_ID,run,jobs,artifacts,originalConfig:config,currentConfig:config,sourceIsAncestor:true,now:Date.parse('2026-10-21T15:00:00Z')};
}
const reject = (mutate, pattern) => {const value=fixture();mutate(value);assert.throws(()=>validateResume(value),pattern);};

test('accepts completed signed native provenance and selects latest job attempts', () => {
  const input=fixture();
  input.run.status='in_progress'; // Run-level status can lag completed job status.
  input.jobs.find(job=>job.name==='prepare'&&job.run_attempt===1).conclusion='failure';
  input.artifacts.push({name:'publication-ui-unrelated'});
  const result=validateResume(input);
  assert.deepEqual(result,{runId:RUN_ID,source:SOURCE,version:'0.3.1',artifacts:input.artifacts.slice(0,3).map(value=>({id:value.id,name:value.name,digest:value.digest,sizeInBytes:value.size_in_bytes}))});
});

test('run IDs cannot inject flags, paths or unsafe numeric values', () => {
  assert.equal(parseRunId(String(RUN_ID)),RUN_ID);
  for(const input of ['','0','-1','1.5',' 123','123\n','--method=POST','9007199254740992','../123',123])assert.throws(()=>parseRunId(input),/Source run ID/);
});

test('rejects a wrong source, workflow, branch, trigger or fork', () => {
  for(const mutate of [
    value=>{value.run.id++;},value=>{value.run.path='.github/workflows/other.yml';},
    value=>{value.run.event='pull_request';},value=>{value.run.head_branch='feature';},
    value=>{value.run.head_sha='C'.repeat(40);},value=>{value.run.head_sha='abc';},
    value=>{value.run.repository.full_name='attacker/toris-studio';},
    value=>{value.run.head_repository.full_name='attacker/toris-studio';},
    value=>{value.run.head_repository.id=43;},value=>{value.sourceIsAncestor=false;},
  ])reject(mutate,/Source|source|repository|ancestor/);
});

test('latest required native and safety jobs must pass; only failed publication is resumable', () => {
  for(const name of REQUIRED_JOBS){
    reject(value=>{value.jobs.find(job=>job.name===name&&job.run_attempt===2).conclusion='failure';},/Every required/);
    reject(value=>{value.jobs=value.jobs.filter(job=>job.name!==name);},/Every required/);
  }
  for(const conclusion of ['success','cancelled','timed_out',null])reject(value=>{value.jobs.find(job=>job.name==='publish'&&job.run_attempt===2).conclusion=conclusion;},/failed publish/);
  reject(value=>{value.jobs.find(job=>job.name==='publish'&&job.run_attempt===2).status='in_progress';},/failed publish/);
  reject(value=>{value.jobs[0].run_id++;},/Job identity/);
  reject(value=>{value.jobs[0].head_sha='a'.repeat(40);},/Job identity/);
  reject(value=>{value.jobs[0].run_attempt=3;},/Job identity/);
  reject(value=>{value.jobs.push({...value.jobs[0],id:999});},/ambiguous/);
  reject(value=>{value.jobs.push({...value.jobs[0],id:999,name:'native (foreign platform)'});},/Unexpected job/);
});

test('requires exactly the original three unique release artifacts', () => {
  reject(value=>{value.artifacts.pop();},/Exactly three/);
  reject(value=>{value.artifacts.push({...value.artifacts[0],id:999,name:'release-foreign'});},/Exactly three/);
  reject(value=>{value.artifacts[0].name='release-foreign';},/identities/);
  reject(value=>{value.artifacts[1].name=value.artifacts[0].name;},/identities/);
  reject(value=>{value.artifacts[1].id=value.artifacts[0].id;},/identities/);
  for(const key of ['id','head_sha','head_branch','repository_id','head_repository_id'])reject(value=>{value.artifacts[0].workflow_run[key]=key==='head_sha'?'a'.repeat(40):key==='head_branch'?'fork':999;},/different run/);
});

test('rejects expired archives, missing or duplicate SHA256 digests and excessive sizes', () => {
  reject(value=>{value.artifacts[0].expired=true;},/unexpired/);
  reject(value=>{value.artifacts[0].expires_at='2026-10-21T15:00:00Z';},/unexpired/);
  reject(value=>{value.artifacts[0].expires_at='invalid';},/unexpired/);
  for(const digest of [null,'','sha1:'+'a'.repeat(40),'sha256:'+'A'.repeat(64)])reject(value=>{value.artifacts[0].digest=digest;},/SHA256/);
  reject(value=>{value.artifacts[1].digest=value.artifacts[0].digest;},/SHA256/);
  for(const size of [0,-1,1.5,2*1024**3])reject(value=>{value.artifacts[0].size_in_bytes=size;},/smaller than/);
  reject(value=>{value.artifacts.forEach(artifact=>{artifact.size_in_bytes=800*1024**2;});},/Aggregate/);
});

test('requires unchanged stable Tauri version and original signing configuration', () => {
  reject(value=>{value.currentConfig+='\n';},/byte-identical/);
  for(const version of ['0.3.1-beta.1','v0.3.1','01.3.1','0.3.1\nRELEASE_COMMIT=evil'])reject(value=>{const config=JSON.parse(value.originalConfig);config.version=version;value.originalConfig=value.currentConfig=JSON.stringify(config);},/stable release/);
  reject(value=>{const config=JSON.parse(value.originalConfig);config.plugins.updater.requireSignedVersion=false;value.originalConfig=value.currentConfig=JSON.stringify(config);},/signed updater/);
});

test('pagination must include every item and remain consistent', () => {
  assert.deepEqual(flattenPages([{total_count:2,jobs:[1]},{total_count:2,jobs:[2]}],'jobs'),[1,2]);
  assert.throws(()=>flattenPages([{total_count:2,jobs:[1]}],'jobs'),/every provenance/);
  assert.throws(()=>flattenPages([{total_count:2,jobs:[1]},{total_count:3,jobs:[2]}],'jobs'),/changed/);
  assert.throws(()=>flattenPages([],'jobs'),/pagination/);
});

test('CLI orchestration uses read-only gh and writes validated manifest/environment only after all checks', async () => {
  const root=await mkdtemp(path.join(tmpdir(),'toris-resume-validator-'));
  try{
    const input=fixture(),configFile=path.join(root,CONFIG_PATH),runner=path.join(root,'runner');
    await mkdir(path.dirname(configFile),{recursive:true});await mkdir(runner);
    await writeFile(configFile,input.currentConfig);
    const env={RUNNER_TEMP:runner,GITHUB_ENV:path.join(root,'env'),GITHUB_OUTPUT:path.join(root,'output'),GITHUB_REPOSITORY:REPOSITORY,GITHUB_REF:'refs/heads/main',GITHUB_EVENT_NAME:'workflow_dispatch'};
    const calls=[];
    const execute=(program,args)=>{
      calls.push({program,args});
      if(program==='git')return {status:0,stdout:args[0]==='show'?input.originalConfig:''};
      assert.equal(program,'gh');assert.ok(args.includes('GET'));assert.ok(args.includes('github.com'));
      const endpoint=args.at(-1);
      if(endpoint.includes('/jobs?')){assert.ok(endpoint.includes('filter=all'));assert.ok(args.includes('--paginate'));assert.ok(args.includes('--slurp'));return {status:0,stdout:JSON.stringify([{total_count:input.jobs.length,jobs:input.jobs}])};}
      if(endpoint.includes('/artifacts?'))return {status:0,stdout:JSON.stringify([{total_count:input.artifacts.length,artifacts:input.artifacts}])};
      return {status:0,stdout:JSON.stringify(input.run)};
    };
    const result=await verifyReleaseResume(String(RUN_ID),{root,env,execute});
    assert.deepEqual(JSON.parse(await readFile(result.manifestPath,'utf8')),validateResume(input));
    assert.equal(await readFile(env.GITHUB_ENV,'utf8'),`RELEASE_VERSION=0.3.1\nRELEASE_TAG=v0.3.1\nRELEASE_COMMIT=${SOURCE}\nRELEASE_RESUME_MANIFEST=${result.manifestPath}\n`);
    assert.match(await readFile(env.GITHUB_OUTPUT,'utf8'),/artifact_ids=1000,1001,1002\n/);
    assert.ok(calls.some(call=>call.program==='git'&&call.args.join(' ')==='merge-base --is-ancestor '+SOURCE+' HEAD'));
    await assert.rejects(verifyReleaseResume(String(RUN_ID),{root,env,execute}),/EEXIST/);
    const before=await readFile(env.GITHUB_ENV,'utf8');
    input.jobs.find(job=>job.name===REQUIRED_JOBS[0]&&job.run_attempt===2).conclusion='failure';
    await assert.rejects(verifyReleaseResume(String(RUN_ID),{root,env,execute}),/Every required/);
    assert.equal(await readFile(env.GITHUB_ENV,'utf8'),before);
    assert.deepEqual(await readdir(runner),['toris-release-resume.json']);
    for(const badEnv of [{...env,GITHUB_REF:'refs/heads/foreign'},{...env,GITHUB_REPOSITORY:'fork/repo'},{...env,RUNNER_TEMP:'/tmp/bad\nENV=1'}])await assert.rejects(verifyReleaseResume(String(RUN_ID),{root,env:badEnv,execute}));
  }finally{await rm(root,{recursive:true,force:true});}
});
