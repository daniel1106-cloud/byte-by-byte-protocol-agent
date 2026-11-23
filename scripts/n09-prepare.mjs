#!/usr/bin/env node
// N09 key-free preparation. A=PCAP only; B=same PCAP plus explicit REA/Ghidra evidence.
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultRunCommand, runSmoke } from './rea-smoke.mjs';
import { BUDGET, makeRequest, mockOutput, validateOutput, validateSelection } from './n09-contract.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
const now = () => new Date().toISOString();
const fault = (code, message) => Object.assign(new Error(message), { code });
const MAX_INPUT_BYTES = 16 * 1024 * 1024;
async function snapshot(filename) {
  const resolved = await realpath(filename);
  const info = await stat(resolved);
  if (!info.isFile() || info.size > MAX_INPUT_BYTES) throw fault('INPUT_LIMIT', 'Input must be a regular file up to 16 MiB');
  const bytes = await readFile(resolved);
  if (bytes.length > MAX_INPUT_BYTES) throw fault('INPUT_LIMIT', 'Input grew past 16 MiB');
  return { path: resolved, bytes: bytes.length, sha256: sha(bytes) };
}
function excerpt(text, limit) {
  const raw = Buffer.from(text);
  let end = Math.min(raw.length, limit);
  while (end < raw.length && end > 0 && (raw[end] & 0xc0) === 0x80) end--;
  return { text: raw.subarray(0, end).toString('utf8'), total_bytes: raw.length,
    supplied_bytes: end, truncated: end < raw.length, raw_sha256: sha(raw) };
}
export async function prepareRun({ condition, pcapPath, binaryPath, resultPath,
  execution = 'prepare', experiment = 'practice', env = process.env,
  runCommand = defaultRunCommand } = {}) {
  // Reject A+binary before reading any input or creating a result.
  validateSelection({ condition, binaryPath, execution, experiment });
  if (!pcapPath || !resultPath) throw fault('USAGE', 'PCAP and a new output JSON path are required');
  const output = path.resolve(resultPath);
  if ([pcapPath, binaryPath].filter(Boolean).some(x => path.resolve(x) === output))
    throw fault('OUTPUT_IS_INPUT', 'Output cannot be an input file');
  await mkdir(path.dirname(output), { recursive: true });
  const reserved = await open(output, 'wx', 0o600); await reserved.close();
  const artifacts = output + '.artifacts-' + randomUUID();
  await mkdir(artifacts, { mode: 0o700 });
  const safeEnv = Object.fromEntries(Object.entries(env).filter(([key]) => !/KEY|TOKEN|SECRET|^LLM_/i.test(key)));
  const secret = env.LLM_API_KEY || '';
  const redact = x => secret ? String(x).split(secret).join('[REDACTED_API_KEY]') : String(x);
  const saveText = (filename, text) => writeFile(filename, redact(text), { flag: 'wx', mode: 0o600 });
  const result = {
    schema_version: 1, task: 'N09', run_id: randomUUID(), condition, execution, experiment,
    classification: execution === 'mock' ? 'mock-output-with-local-evidence' : 'input-preparation-only',
    command_backend: runCommand === defaultRunCommand ? 'real' : 'injected-test',
    started_at: now(), finished_at: null, success: false, stage: 'input',
    experiment_score: false, model_called: false, n05_complete: false, n09_complete: false,
    input: {}, budget: { ...BUDGET }, usage: { model_calls: 0, server_queries: 0, tokens: null },
    runtime: { node: process.version, platform: process.platform, arch: process.arch, code_commit: null, code_dirty: null },
    artifacts, stages: [], evidence: [], spec: null, observations: [], unknowns: [],
    verification: null, request_file: null, limitations: [
      'Preparation/mock results are not E1 scores. Real course-model invocation and human review remain pending.',
      'tcpdump is a packet-level hex view, not TCP stream reassembly; retransmissions and capture gaps may occur.',
      'REA binary_overview is limited evidence, not function decompilation or complete protocol reconstruction.',
      'A/B preprocessing differs by the additional binary evidence; identical model allowances do not imply identical input token counts.',
      'The request file is an offline template, not a provider API payload. Model ID, endpoint and token parameter remain to be verified.',
    ],
  };
  const persist = () => writeFile(output, redact(JSON.stringify(result, null, 2)) + '\n', { mode: 0o600 });
  const stage = async (name, fn) => {
    result.stage = name;
    const item = { stage: name, started_at: now(), status: 'running' };
    result.stages.push(item); await persist();
    try { const value = await fn(); item.status = 'success'; return value; }
    catch (error) { item.status = 'failed'; throw error; }
    finally { item.finished_at = now(); await persist(); }
  };
  try {
    await stage('input', async () => {
      result.input.pcap = await snapshot(pcapPath);
      // Snapshot the selected binary only in B. No directory scan, README or hidden-answer lookup.
      if (condition === 'B') result.input.binary = await snapshot(binaryPath);
      const git = await runCommand('git', ['rev-parse', 'HEAD'], { env: safeEnv, timeoutMs: 10000 });
      const dirty = await runCommand('git', ['status', '--porcelain'], { env: safeEnv, timeoutMs: 10000 });
      result.runtime.code_commit = git.exitCode === 0 ? git.stdout.trim() : null;
      result.runtime.code_dirty = dirty.exitCode === 0 ? Boolean(dirty.stdout.trim()) : null;
    });
    let packet;
    await stage('packet_evidence', async () => {
      const filename = path.join(artifacts, 'packet.stdout.txt');
      const stderr = path.join(artifacts, 'packet.stderr.txt');
      const args = ['-nn', '-tt', '-s', '0', '-XX', '-r', result.input.pcap.path];
      const command = await runCommand('tcpdump', args, {
        env: safeEnv, timeoutMs: 30000, stdoutPath: filename, stderrPath: stderr,
      });
      for (const [target, value] of [[filename, command.stdout], [stderr, command.stderr]]) {
        try { await saveText(target, value || ''); }
        catch (error) { if (error.code !== 'EEXIST') throw error; }
      }
      result.runtime.packet_command = { argv: ['tcpdump', ...args], exit_code: command.exitCode,
        timed_out: Boolean(command.timedOut), stdout: filename, stderr };
      if (command.exitCode !== 0 || command.timedOut || command.spawnError)
        throw fault('PACKET_COMMAND_FAILED', 'tcpdump failed; inspect retained artifacts');
      if ((await stat(filename)).size > MAX_INPUT_BYTES) throw fault('PACKET_OUTPUT_LIMIT', 'Packet dump exceeded 16 MiB; raw file retained');
      if ((await snapshot(pcapPath)).sha256 !== result.input.pcap.sha256) throw fault('INPUT_CHANGED', 'PCAP changed during extraction');
      const raw = await readFile(filename, 'utf8');
      packet = { id: 'packet-1', source: 'packet', ...excerpt(raw, BUDGET.packet_evidence_bytes) };
      result.evidence.push({ ...packet, raw_file: filename });
    });
    let binary = null;
    if (condition === 'B') await stage('binary_evidence', async () => {
      const rea = await runSmoke({ binaryPath: result.input.binary.path,
        resultPath: path.join(artifacts, 'rea-result.json'), mode: 'rea-only', env: safeEnv, runCommand });
      result.runtime.rea_result_file = path.join(artifacts, 'rea-result.json');
      result.runtime.rea_version = rea.runtime.rea_version || null;
      if (!rea.success) throw fault('REA_PREPARATION_FAILED', 'N05 REA-only preparation failed; inspect retained rea-result.json');
      if (rea.input.sha256 !== result.input.binary.sha256 ||
          (await snapshot(binaryPath)).sha256 !== result.input.binary.sha256)
        throw fault('INPUT_CHANGED', 'Binary changed during preparation');
      // N05 validates the Ghidra Evidence envelope and its subject digest against the selected binary.
      const raw = await readFile(rea.evidence.raw_file, 'utf8');
      binary = { id: 'binary-1', source: 'binary', ...excerpt(raw, BUDGET.binary_evidence_bytes) };
      result.evidence.push({ ...binary, raw_file: rea.evidence.raw_file,
        subject_sha256: rea.input.sha256, operation: rea.evidence.validation.operation });
    });
    let request;
    await stage('request_template', async () => {
      request = makeRequest({ condition, packet: { id: packet.id, source: packet.source, text: packet.text },
        binary: binary && { id: binary.id, source: binary.source, text: binary.text } });
      result.request_file = path.join(artifacts, 'request.json');
      await saveText(result.request_file, JSON.stringify(request, null, 2) + '\n');
      result.runtime.prompt_sha256 = sha(request.messages[0].content);
    });
    if (execution === 'mock') await stage('mock_output', async () => {
      const mock = mockOutput(request);
      const matches = validateOutput(mock, request);
      result.spec = mock.spec; result.observations = mock.observations; result.unknowns = mock.unknowns;
      result.verification = { exact_quotes: matches, semantic_review: 'pending', actual_protocol_reconstruction: false };
    });
    result.stage = 'complete'; result.success = true;
  } catch (error) {
    result.error = { stage: result.stage, code: error.code || error.name, message: redact(error.message) };
  } finally {
    result.finished_at = now(); await persist();
  }
  return result;
}
export function parseArgs(argv) {
  const names = { '--condition': 'condition', '--pcap': 'pcapPath', '--binary': 'binaryPath',
    '--out': 'resultPath', '--execution': 'execution', '--experiment': 'experiment' };
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = names[argv[index]], value = argv[index + 1];
    if (!key || !value || value.startsWith('--') || Object.hasOwn(options, key))
      throw fault('USAGE', 'Use each named option once with a value');
    options[key] = value;
  }
  return options;
}
export async function main(argv = process.argv.slice(2)) {
  const result = await prepareRun(parseArgs(argv));
  console.log(JSON.stringify({ task: result.task, condition: result.condition, success: result.success,
    model_called: false, experiment_score: false, error: result.error || null }));
  return result.success ? 0 : 1;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(code => { process.exitCode = code; }).catch(error => {
    console.error('N09: ' + (error.code || error.name) + ': ' + error.message); process.exitCode = 1;
  });
}
