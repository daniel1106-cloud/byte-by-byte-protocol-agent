// Filesystem/command-injection tests. tcpdump, git and REA are explicit mocks.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { prepareRun, parseArgs } from './n09-prepare.mjs';
const hash = x => createHash('sha256').update(x).digest('hex');
const retained = path.resolve('runs/n09/tests');
await mkdir(retained, { recursive: true });
const ok = stdout => ({ exitCode: 0, signal: null, timedOut: false, stdout, stderr: '' });
const packet = 'Explicit mock tcpdump evidence: packet bytes 01 02 03.\n';
async function fixture(options = {}) {
  const directory = await mkdtemp(path.join(retained, 'fixture-'));
  const pcapPath = path.join(directory, 'fixture.pcap');
  const binaryPath = path.join(directory, 'fixture-binary');
  const resultPath = path.join(directory, 'result.json');
  await writeFile(pcapPath, 'explicit mock pcap, not a valid real capture');
  const binary = Buffer.from('explicit mock binary, not a real executable');
  await writeFile(binaryPath, binary);
  const raw = JSON.stringify({ evidence_id: 'ev_1234', operation: 'binary_overview',
    provider: { id: 'rea-workflow' }, subject: { digest: { sha256: hash(binary) } },
    normalized_result: { mock: true, text: 'Explicit mock binary evidence for contract preparation.' },
    limitations: [], analysis_profile: { parameters: {
      upstream_analysis_profile: { provider: { id: 'ghidra' } } } } });
  const commands = [];
  const runCommand = async (command, args, opts = {}) => {
    commands.push({ command, args, opts });
    const overridden = options.command && await options.command(command, args, opts);
    if (overridden) return overridden;
    if (command === 'git') return ok(args[0] === 'rev-parse' ? 'a'.repeat(40) : '');
    if (command === 'tcpdump') return ok(options.packet ?? packet);
    assert.equal(command, 'rea');
    if (args[0] === '--version') return ok('explicit mock REA');
    if (args[0] === 'doctor') return ok('{"healthy":true,"mock":true}');
    if (args[0] === 'analyze') return ok(raw);
    assert.fail('Unexpected mocked command');
  };
  const run = (overrides = {}) => prepareRun({ condition: 'A', pcapPath, resultPath,
    execution: 'prepare', runCommand, env: { PATH: process.env.PATH || '' }, ...overrides });
  return { directory, pcapPath, binaryPath, resultPath, raw, commands, run };
}
const saved = async filename => JSON.parse(await readFile(filename, 'utf8'));

test('A creates an offline request and never invokes REA or accesses a binary selection', async () => {
  const f = await fixture(), result = await f.run();
  assert.equal(result.success, true);
  assert.equal(result.model_called, false);
  assert.equal(result.usage.model_calls, 0);
  assert.equal(result.experiment_score, false);
  assert.equal(result.n09_complete, false);
  assert.equal(result.spec, null);
  assert.equal(result.input.binary, undefined);
  assert.equal(f.commands.some(x => x.command === 'rea'), false);
  assert.equal((await saved(result.request_file)).condition, 'A');
  assert.equal((await saved(f.resultPath)).input.pcap.sha256, hash(await readFile(f.pcapPath)));
});
test('B reuses N05 REA-only with matching binary digest and retains the raw evidence', async () => {
  const f = await fixture(), result = await f.run({ condition: 'B', binaryPath: f.binaryPath });
  assert.equal(result.success, true);
  assert.equal(result.evidence.length, 2);
  assert.equal(result.evidence[1].subject_sha256, hash(await readFile(f.binaryPath)));
  assert.equal(await readFile(result.evidence[1].raw_file, 'utf8'), f.raw);
  assert.equal(result.model_called, false);
  assert.equal((await saved(result.runtime.rea_result_file)).mode, 'rea-only');
});
test('A with a binary argument fails before creating any output or running commands', async () => {
  const f = await fixture();
  await assert.rejects(f.run({ binaryPath: 'nonexistent-private-answer-file' }), { code: 'A_BINARY_FORBIDDEN' });
  assert.equal(f.commands.length, 0);
  await assert.rejects(readFile(f.resultPath), { code: 'ENOENT' });
});
test('B without a binary fails before command execution', async () => {
  const f = await fixture();
  await assert.rejects(f.run({ condition: 'B' }), { code: 'B_BINARY_REQUIRED' });
  assert.equal(f.commands.length, 0);
});
test('mock output is explicitly labeled and never becomes an experiment score', async () => {
  const f = await fixture(), result = await f.run({ execution: 'mock', experiment: 'E1' });
  assert.equal(result.success, true);
  assert.match(result.classification, /mock/);
  assert.deepEqual(result.spec, {});
  assert.equal(result.experiment_score, false);
  assert.equal(result.verification.actual_protocol_reconstruction, false);
});
test('packet extraction failures are saved with their stage and raw diagnostics', async () => {
  const f = await fixture({ command: async command => command === 'tcpdump'
    ? { ...ok(''), exitCode: 1, stderr: 'explicit mock invalid PCAP' } : null });
  const result = await f.run();
  assert.equal(result.success, false);
  assert.equal(result.error.code, 'PACKET_COMMAND_FAILED');
  assert.equal(result.error.stage, 'packet_evidence');
  assert.match(await readFile(result.runtime.packet_command.stderr, 'utf8'), /invalid PCAP/);
  assert.equal((await saved(f.resultPath)).success, false);
});
test('zero exit plus timeout is still a packet extraction failure', async () => {
  const f = await fixture({ command: async command => command === 'tcpdump'
    ? { ...ok(packet), timedOut: true } : null });
  assert.equal((await f.run()).error.code, 'PACKET_COMMAND_FAILED');
});
test('a failed REA doctor in B is not converted to success', async () => {
  const f = await fixture({ command: async (command, args) =>
    command === 'rea' && args[0] === 'doctor' ? ok('{"healthy":false}') : null });
  const result = await f.run({ condition: 'B', binaryPath: f.binaryPath });
  assert.equal(result.success, false);
  assert.equal(result.error.code, 'REA_PREPARATION_FAILED');
  assert.equal(f.commands.some(x => x.command === 'rea' && x.args[0] === 'analyze'), false);
});
test('PCAP mutation during extraction is detected', async () => {
  let f;
  f = await fixture({ command: async command => {
    if (command === 'tcpdump') await writeFile(f.pcapPath, 'changed explicit mock input');
    return null;
  } });
  assert.equal((await f.run()).error.code, 'INPUT_CHANGED');
});
test('packet excerpt is UTF-8 safe and full raw output is retained', async () => {
  const raw = '가'.repeat(30000), f = await fixture({ packet: raw });
  const result = await f.run();
  assert.equal(result.success, true);
  assert.equal(result.evidence[0].truncated, true);
  assert.equal(result.evidence[0].text.includes('\ufffd'), false);
  assert.ok(Buffer.byteLength(result.evidence[0].text) <= 65536);
  assert.equal(await readFile(result.evidence[0].raw_file, 'utf8'), raw);
});
test('existing results and input files cannot be overwritten', async () => {
  const f = await fixture();
  await writeFile(f.resultPath, 'old evidence');
  await assert.rejects(f.run(), { code: 'EEXIST' });
  assert.equal(await readFile(f.resultPath, 'utf8'), 'old evidence');
  await assert.rejects(f.run({ resultPath: f.pcapPath }), { code: 'OUTPUT_IS_INPUT' });
  assert.equal(f.commands.length, 0);
});
test('credentials are not forwarded to local subprocesses', async () => {
  const f = await fixture();
  const result = await f.run({ condition: 'B', binaryPath: f.binaryPath,
    env: { PATH: process.env.PATH || '', LLM_API_KEY: 'explicit-mock-secret', LLM_MODEL: 'unused', SOME_TOKEN: 'unused' } });
  assert.equal(result.success, true);
  for (const call of f.commands) {
    assert.equal(call.opts.env.LLM_API_KEY, undefined);
    assert.equal(call.opts.env.LLM_MODEL, undefined);
    assert.equal(call.opts.env.SOME_TOKEN, undefined);
  }
});
test('CLI accepts only documented, unique named options', () => {
  assert.deepEqual(parseArgs(['--condition', 'A', '--pcap', 'test.pcap', '--out', 'new.json']),
    { condition: 'A', pcapPath: 'test.pcap', resultPath: 'new.json' });
  for (const args of [['--condition'], ['--oops', 'x'], ['--condition', 'A', '--condition', 'B']])
    assert.throws(() => parseArgs(args), { code: 'USAGE' });
});
