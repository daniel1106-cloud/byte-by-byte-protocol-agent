// Serialized A/B fixtures only; these tests do not run REA, TCP or a model.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { checkPair, main } from './n09-check-pair.mjs';
import { fingerprintSources } from './n09-source-state.mjs';
import { BUDGET } from './n09-contract.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
const retained = path.resolve('runs/n09-pair-tests');
await mkdir(retained, {recursive:true});

async function fixture(dirty = false, experiment = 'practice') {
  const dir = await mkdtemp(path.join(retained, 'fixture-'));
  const raw = 'Explicit mock Ghidra evidence; never an experimental observation.';
  const rawPath = path.join(dir, 'binary.raw');
  const reaPath = path.join(dir, 'rea.json');
  const requestPath = path.join(dir, 'request.json');
  const fingerprint = await fingerprintSources();
  const binaryHash = sha('explicit mock binary');
  await writeFile(rawPath, raw);
  await writeFile(requestPath, JSON.stringify({messages:[{role:'system',content:'Explicit test fixture prompt.'}]}));
  await writeFile(reaPath, JSON.stringify({success:true,mode:'rea-only',execution_backend:'real',
    evidence:{raw_file:rawPath,validation:{upstream_provider:'ghidra',subject_sha256:binaryHash}}}));
  const a = {success:true,execution:'prepare',experiment,command_backend:'real',
    model_called:false,usage:{model_calls:0,server_queries:0},experiment_score:false,n09_complete:false,
    spec:null,condition:'A',budget:{...BUDGET},input:{pcap:{sha256:sha('mock pcap')}},
    evidence:[{source:'packet',text:'Explicit mock packet evidence.',raw_sha256:sha('mock packets')}],
    runtime:{code_dirty:dirty,code_commit:'a'.repeat(40),source_fingerprint:fingerprint},
    stages:[{status:'success'}],request_file:requestPath};
  const b = structuredClone(a);
  b.condition = 'B'; b.input.binary = {sha256:binaryHash};
  b.runtime.rea_result_file = reaPath;
  b.evidence.push({source:'binary',raw_sha256:sha(raw)});
  const aPath = path.join(dir,'A.json'), bPath = path.join(dir,'B.json'), outPath = path.join(dir,'pair.json');
  const persist = async () => {await writeFile(aPath,JSON.stringify(a));await writeFile(bPath,JSON.stringify(b));};
  await persist();
  return {a,b,aPath,bPath,outPath,persist,run:options=>checkPair({aPath,bPath,outPath,...options})};
}

test('pair checker retains the clean-checkout default', async () => {
  const f = await fixture();
  const result = await f.run();
  assert.equal(result.code_dirty,false);
  assert.equal(result.reproducibility.reference_run_eligible,true);
  assert.equal(result.reproducibility.sources_verified,true);
});

test('clean E1 pair saves its experiment label without scoring', async () => {
  const f = await fixture(false, 'E1');
  await f.run();
  const saved = JSON.parse(await readFile(f.outPath,'utf8'));
  assert.equal(saved.experiment,'E1');
  assert.equal(saved.model_calls,0);
  assert.equal(saved.experiment_score,false);
});

test('E1 rejects the dirty override even when both preparations are clean', async () => {
  const f = await fixture(false, 'E1');
  await assert.rejects(main([f.aPath,f.bPath,f.outPath,'--allow-dirty']), /E1 does not allow/);
  await assert.rejects(readFile(f.outPath), {code:'ENOENT'});
});

test('E1 rejects a dirty preparation in either condition', async () => {
  for (const condition of ['a','b']) {
    const f = await fixture(false, 'E1');
    f[condition].runtime.code_dirty = true;
    await f.persist();
    await assert.rejects(f.run(), /E1 requires both preparations from a clean checkout/);
    await assert.rejects(readFile(f.outPath), {code:'ENOENT'});
  }
});

test('mixed practice and E1 labels cannot pass with or without the override', async () => {
  const f = await fixture();
  f.b.experiment = 'E1';
  await f.persist();
  await assert.rejects(f.run(), /A\/B experiment labels differ/);
  await assert.rejects(f.run({allowDirty:true}), /A\/B experiment labels differ/);
  await assert.rejects(readFile(f.outPath), {code:'ENOENT'});
});

test('dirty practice requires explicit opt-in before writing a success summary', async () => {
  const f = await fixture(true);
  await assert.rejects(f.run(), /Uncommitted changes/);
  await assert.rejects(readFile(f.outPath), {code:'ENOENT'});
});

test('opted-in dirty practice verifies actual sources and retains the dirty label', async () => {
  const f = await fixture(true);
  const result = await f.run({allowDirty:true});
  assert.equal(result.code_dirty,true);
  assert.equal(result.reproducibility.reference_run_eligible,false);
  assert.equal(result.reproducibility.local_practice_dirty_allowed,true);
  assert.equal(result.reproducibility.sources_verified,true);
  assert.equal(result.experiment_score,false);
});

test('dirty opt-in rejects legacy preparation without actual source hashes', async () => {
  const f = await fixture(true);
  delete f.a.runtime.source_fingerprint; delete f.b.runtime.source_fingerprint;
  await f.persist();
  await assert.rejects(f.run({allowDirty:true}), /require a recorded source fingerprint/);
});

test('dirty opt-in rejects A/B prepared from different runner sources', async () => {
  const f = await fixture(true);
  f.b.runtime.source_fingerprint.sha256 = 'b'.repeat(64);
  await f.persist();
  await assert.rejects(f.run({allowDirty:true}), /A\/B runner sources differ/);
});

test('matching but stale A/B source hashes fail against the current files', async () => {
  const f = await fixture(true);
  f.a.runtime.source_fingerprint.files[0].sha256 = 'b'.repeat(64);
  f.b.runtime.source_fingerprint = structuredClone(f.a.runtime.source_fingerprint);
  await f.persist();
  await assert.rejects(f.run({allowDirty:true}), /changed since preparation/);
});

test('dirty opt-in still rejects a working-tree status change between A and B', async () => {
  const f = await fixture(true); f.b.runtime.code_dirty = false;
  await f.persist();
  await assert.rejects(f.run({allowDirty:true}), /working-tree status differs/);
});

test('pair CLI rejects unknown flags', async () => {
  await assert.rejects(main(['A','B','out','--ignore-checks']), /Usage:/);
});
