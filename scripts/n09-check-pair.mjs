#!/usr/bin/env node
// Verify the real, key-free N09 A/B preparation pair; never produce E1 scores.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fingerprintSources } from './n09-source-state.mjs';
import { validateDetailBundle } from './rea-detail.mjs';
const read = async filename => JSON.parse(await readFile(filename, 'utf8'));
const hash = value => createHash('sha256').update(value).digest('hex');

export async function checkPair({aPath, bPath, outPath, allowDirty = false}) {
assert.ok(aPath && bPath && outPath, 'A, B and a new summary path are required');
const [a, b] = await Promise.all([read(aPath), read(bPath)]);
for (const result of [a, b]) {
  assert.equal(result.success, true);
  assert.equal(result.execution, 'prepare');
  assert.equal(result.experiment, 'practice');
  assert.equal(result.command_backend, 'real');
  assert.equal(result.model_called, false);
  assert.equal(result.usage.model_calls, 0);
  assert.equal(result.usage.server_queries, 0);
  assert.equal(result.experiment_score, false);
  assert.equal(result.n09_complete, false);
  assert.equal(result.spec, null);
  assert.equal(typeof result.runtime.code_dirty, 'boolean', 'Missing working-tree status');
  if (!allowDirty) assert.equal(result.runtime.code_dirty, false,
    'Uncommitted changes: use --allow-dirty only for a local practice pilot, or commit changes first');
  assert.match(result.runtime.code_commit, /^[0-9a-f]{40}$/);
  assert.ok(result.stages.every(stage => stage.status === 'success'));
}
assert.equal(a.condition, 'A');
assert.equal(b.condition, 'B');
assert.equal(a.input.binary, undefined);
assert.equal(a.runtime.rea_result_file, undefined);
assert.equal(a.evidence.length, 1);
assert.equal(b.evidence.length, 2);
assert.deepEqual(a.input.pcap, b.input.pcap);
assert.deepEqual(a.evidence[0].text, b.evidence[0].text);
assert.equal(a.evidence[0].raw_sha256, b.evidence[0].raw_sha256);
assert.deepEqual(a.budget, b.budget);
assert.equal(a.runtime.code_commit, b.runtime.code_commit);
assert.equal(a.runtime.code_dirty, b.runtime.code_dirty, 'A/B working-tree status differs');
const sourceFingerprint = a.runtime.source_fingerprint || null;
if (a.runtime.code_dirty || a.runtime.source_fingerprint || b.runtime.source_fingerprint) {
  assert.ok(sourceFingerprint, 'Dirty practice runs require a recorded source fingerprint; prepare again');
  assert.deepEqual(sourceFingerprint, b.runtime.source_fingerprint, 'A/B runner sources differ');
  assert.deepEqual(sourceFingerprint, await fingerprintSources(), 'Runner sources changed since preparation');
}
const [aRequest, bRequest, rea] = await Promise.all([read(a.request_file), read(b.request_file), read(b.runtime.rea_result_file)]);
assert.deepEqual(aRequest.messages[0], bRequest.messages[0]);
assert.equal(rea.success, true);
assert.equal(rea.mode, 'rea-only');
assert.equal(rea.execution_backend, 'real');
assert.equal(rea.evidence.validation.upstream_provider, 'ghidra');
assert.equal(rea.evidence.validation.subject_sha256, b.input.binary.sha256);
const binaryRaw = await readFile(rea.evidence.raw_file, 'utf8');
if(b.evidence[1].operation==='rea-evidence-bundle-v1') {
  const bundleRaw=await readFile(b.evidence[1].raw_file,'utf8'),bundle=JSON.parse(bundleRaw);
  assert.equal(hash(bundleRaw),b.evidence[1].raw_sha256);
  await validateDetailBundle(bundle,b.input.binary.sha256);
  assert.equal(bundle.records[0].raw_sha256,hash(binaryRaw));
} else assert.equal(hash(binaryRaw), b.evidence[1].raw_sha256);
const summary = {
  task: 'N09', classification: 'real-local-tools-key-free-preparation',
  recorded_at: new Date().toISOString(),
  execution_code_commit: a.runtime.code_commit, code_dirty: a.runtime.code_dirty,
  source_fingerprint: sourceFingerprint,
  reproducibility: { clean_checkout: !a.runtime.code_dirty,
    sources_verified: Boolean(sourceFingerprint),
    reference_run_eligible: !a.runtime.code_dirty,
    local_practice_dirty_allowed: allowDirty },
  input: { pcap: a.input.pcap, binary: b.input.binary },
  same_packet_sha256: a.evidence[0].raw_sha256,
  same_system_prompt_sha256: hash(aRequest.messages[0].content),
  same_budget: a.budget,
  checks: { a_packet_only: true, b_real_rea: true, same_pcap: true,
    same_packet_text: true, same_prompt: true, same_budget: true, binary_hash_match: true },
  rea: { version: b.runtime.rea_version, validation: rea.evidence.validation },
  supplied_evidence: { a: a.evidence.map(x => ({source:x.source, supplied_bytes:x.supplied_bytes, truncated:x.truncated})),
    b: b.evidence.map(x => ({source:x.source, supplied_bytes:x.supplied_bytes, truncated:x.truncated})) },
  runtime: a.runtime,
  result_files: { a: aPath, b: bPath, rea: b.runtime.rea_result_file },
  model_calls: 0, experiment_score: false, n05_complete: false, n09_complete: false,
  semantic_review: 'pending', human_execution_check: 'pending'
};
await writeFile(outPath, JSON.stringify(summary, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
return summary;
}

export async function main(argv = process.argv.slice(2)) {
  const [aPath, bPath, outPath, flag] = argv;
  assert.ok(argv.length === 3 || (argv.length === 4 && flag === '--allow-dirty'),
    'Usage: A.json B.json new-summary.json [--allow-dirty]');
  const summary = await checkPair({aPath, bPath, outPath, allowDirty: flag === '--allow-dirty'});
  console.log('N09_PAIR_SUMMARY ' + JSON.stringify(summary));
  return 0;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(code => {process.exitCode = code;}).catch(error => {
    console.error('N09-pair: ' + error.message); process.exitCode = 1;
  });
}
