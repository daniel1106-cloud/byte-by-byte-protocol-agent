// N05 regression tests. Every API/REA response is an explicit mock fixture.
// Artifacts stay in ignored runs/n05/tests so failed runs can be inspected.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runSmoke } from './rea-smoke.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const retained = path.join(root, 'runs', 'n05', 'tests');
await mkdir(retained, { recursive: true });
const key = 'N05-mock-key-never-a-real-credential';
const env = {
  LLM_CHAT_COMPLETIONS_URL: 'https://mock.invalid/v1/chat/completions',
  LLM_MODEL: 'explicit-mock-model', LLM_API_KEY: key,
  PATH: process.env.PATH || '',
};
const quote = 'Mock-only REA evidence: PING request receives PONG response.';
const binaryFixture = Buffer.from('N05 mock binary fixture; never an experiment input.\n');
const evidenceFixture = (overrides = {}) => ({
  evidence_id: 'ev_0123456789abcdef', operation: 'binary_overview',
  provider: { id: 'rea-workflow' },
  subject: { digest: { sha256: createHash('sha256').update(binaryFixture).digest('hex') } },
  normalized_result: { mock: true, evidence: quote }, limitations: [],
  analysis_profile: { parameters: { upstream_analysis_profile: { provider: { id: 'ghidra' } } } },
  ...overrides,
});
const raw = JSON.stringify(evidenceFixture(), null, 2);
const call = (overrides = {}) => ({
  id: 'model-original-call-42', type: 'function',
  function: { name: 'inspect_practice_binary', arguments: '{}' }, ...overrides,
});
const first = (calls = [call()], content = null) => ({ role: 'assistant', content, tool_calls: calls });
const final = (overrides = {}) => ({ role: 'assistant', content: JSON.stringify({
  claims: [{ claim: 'The mock evidence describes a PING/PONG exchange.', quote }],
  unknowns: ['The actual binary has not been inspected by this test.'], ...overrides,
}) });
const response = (message, status = 200) => new Response(JSON.stringify({
  model: 'explicit-mock-model', choices: [{ message }],
}), { status, headers: { 'Content-Type': 'application/json' } });
const ok = (stdout = '') => ({ exitCode: 0, signal: null, stdout, stderr: '', timedOut: false });

async function fixture(name, options = {}) {
  const directory = await mkdtemp(path.join(retained, `${name}-`));
  const binaryPath = path.join(directory, 'mock-practice-binary');
  const resultPath = path.join(directory, 'result.json');
  const binary = Buffer.from('N05 mock binary fixture; never an experiment input.\n');
  await writeFile(binaryPath, binary);
  const requests = [], commands = [];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    requests.push({ url, init, body });
    if (options.fetch) return options.fetch(requests.length, body, init);
    return response(requests.length === 1 ? (options.first || first()) : (options.final || final()));
  };
  const runCommand = async (command, args, opts = {}) => {
    commands.push({ command, args, opts });
    if (command === 'git') return ok(args[0] === 'rev-parse' ? `${'a'.repeat(40)}\n` : '');
    assert.equal(command, 'rea', 'the model cannot select an executable');
    if (options.command) {
      const override = await options.command(args, opts);
      if (override) return override;
    }
    if (args[0] === '--version') return ok('rea explicit-mock-version\n');
    if (args[0] === 'doctor') return ok('{"provider":"ghidra","mock":true,"healthy":true}');
    if (args[0] === 'analyze') return ok(options.raw || raw);
    assert.fail(`Unexpected command: ${args.join(' ')}`);
  };
  const run = (overrides = {}) => runSmoke({ binaryPath, resultPath, mode: 'full',
    env, fetchImpl, runCommand, ...overrides });
  return { directory, binaryPath, resultPath, binary, requests, commands, run };
}

const reaCommands = f => f.commands.filter(item => item.command === 'rea');
const saved = async f => JSON.parse(await readFile(f.resultPath, 'utf8'));
async function filesUnder(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await filesUnder(filename));
    else files.push(filename);
  }
  return files;
}

test('N05 tool loop preserves original call ID, operator input, raw evidence and quote offsets', async () => {
  const f = await fixture('success');
  const result = await f.run();
  assert.equal(result.success, true);
  assert.equal(result.classification, '모의 검증');
  assert.equal(result.n05_complete, false, 'operator course-model and semantic review remain explicit');
  assert.equal(result.input.sha256, createHash('sha256').update(f.binary).digest('hex'));
  assert.equal(f.requests.length, 2);
  assert.equal(f.requests[0].body.model, env.LLM_MODEL);
  assert.equal(f.requests[0].body.tools.length, 1);
  assert.deepEqual(f.requests[0].body.tools[0].function.parameters.properties, {});
  const toolMessage = f.requests[1].body.messages.find(message => message.role === 'tool');
  assert.equal(toolMessage.tool_call_id, 'model-original-call-42');
  assert.equal(result.evidence.tool_call_id, toolMessage.tool_call_id);
  assert.deepEqual(reaCommands(f).find(item => item.args[0] === 'analyze').args,
    ['analyze', result.input.path, '--provider', 'ghidra', '--json']);
  assert.equal(await readFile(result.evidence.raw_file, 'utf8'), raw);
  const match = result.verification.matches[0];
  assert.equal(match.exact_match, true);
  assert.equal(Buffer.from(raw).subarray(match.raw_start_byte, match.raw_end_byte).toString(), quote);
  assert.equal((await saved(f)).summary.claims[0].quote, quote);
});

test('N05 absent tool call fails before any REA invocation', async () => {
  const f = await fixture('missing-call', { first: { role: 'assistant', content: 'No tool requested.' } });
  const result = await f.run();
  assert.equal(result.success, false);
  assert.equal(result.error.stage, 'model_tool_request');
  assert.equal(reaCommands(f).length, 0);
  assert.equal((await saved(f)).success, false);
});

test('N05 preserves provider thought signatures and explicitly caps both calls', async () => {
  const message=first();message.extra_content={google:{thought_signature:'mock-signature'}};
  message.tool_calls[0].extra_content={google:{thought_signature:'mock-tool-signature'}};
  const f=await fixture('provider-signatures',{first:message});
  const result=await f.run({env:{...env,LLM_JSON_MODE:'on',LLM_MAX_TOKENS_PARAM:'max_tokens'}});
  assert.equal(result.success,true);
  assert.deepEqual(f.requests[1].body.messages.find(m=>m.role==='assistant'),message);
  assert.ok(f.requests.every(r=>r.body.max_tokens===4096));
  assert.deepEqual(f.requests[1].body.response_format,{type:'json_object'});
  assert.equal(result.usage.api_requests,2);
});

test('N05 records API usage independently for the two model rounds', async () => {
  const f=await fixture('two-round-usage',{fetch:(round)=>new Response(JSON.stringify({
    model:'explicit-mock-model',usage:{prompt_tokens:round*10,completion_tokens:round,total_tokens:round*11},
    choices:[{message:round===1?first():final()}]
  }),{status:200})});
  const result=await f.run();
  assert.equal(result.success,true);assert.equal(result.usage.api_requests,2);
  assert.equal(result.usage.prompt_tokens,30);assert.equal(result.usage.completion_tokens,3);
  assert.equal(result.usage.total_tokens,33);
});

for (const [name, calls] of [
  ['unknown-tool', [call({ function: { name: 'run_shell', arguments: '{}' } })]],
  ['multiple-tools', [call(), call({ id: 'another-call' })]],
  ['path-argument', [call({ function: { name: 'inspect_practice_binary', arguments: '{"path":"/etc/passwd"}' } })]],
  ['null-arguments', [call({ function: { name: 'inspect_practice_binary', arguments: 'null' } })]],
  ['array-arguments', [call({ function: { name: 'inspect_practice_binary', arguments: '[]' } })]],
  ['malformed-arguments', [call({ function: { name: 'inspect_practice_binary', arguments: '{' } })]],
  ['blank-id', [call({ id: ' ' })]],
]) {
  test(`N05 rejects ${name} before REA`, async () => {
    const f = await fixture(name, { first: first(calls) });
    const result = await f.run();
    assert.equal(result.success, false);
    assert.equal(result.error.stage, 'model_tool_request');
    assert.equal(reaCommands(f).length, 0);
    assert.equal(f.requests.length, 1);
  });
}

for (const round of [1, 2]) {
  test(`N05 saves API HTTP failure in round ${round}`, async () => {
    const f = await fixture(`api-http-${round}`, { fetch: async n =>
      n === round ? new Response('{"error":"explicit mock unavailable"}', { status: 503 }) : response(first()) });
    const result = await f.run();
    assert.equal(result.success, false);
    assert.equal(result.error.code, 'API_HTTP_ERROR');
    assert.equal(result.error.stage, round === 1 ? 'model_tool_request' : 'model_summary');
    assert.equal(f.requests.length, round);
    assert.equal(reaCommands(f).some(item => item.args[0] === 'analyze'), round === 2);
    assert.match(await readFile(path.join(result.artifacts, `api-${round}.response.txt`), 'utf8'), /mock unavailable/);
  });
}

test('N05 saves network failure and redacts credential from error', async () => {
  const f = await fixture('api-network', { fetch: async () => { throw new Error(`mock network failure ${key}`); } });
  const result = await f.run();
  assert.equal(result.success, false);
  assert.equal(result.error.stage, 'model_tool_request');
  assert.match((await saved(f)).error.message, /REDACTED_API_KEY/);
});

for (const phase of ['doctor', 'analyze']) {
  test(`N05 records REA ${phase} failure and retains raw diagnostics`, async () => {
    const f = await fixture(`rea-${phase}-failure`, { command: async args => args[0] === phase ?
      { ...ok('{"mock_error":"ghidra failed"}'), exitCode: 2, stderr: 'explicit mock failure\n' } : null });
    const result = await f.run();
    assert.equal(result.success, false);
    assert.equal(result.error.stage, phase === 'doctor' ? 'rea_doctor' : 'rea_analysis');
    assert.equal(result.error.code, 'REA_COMMAND_FAILED');
    assert.match(await readFile(path.join(result.artifacts, `rea-${phase}.stdout`), 'utf8'), /ghidra failed/);
    assert.equal(f.requests.length, 1);
    if (phase === 'doctor') assert.equal(reaCommands(f).some(item => item.args[0] === 'analyze'), false);
  });
}

test('N05 treats an analysis timeout as failure even with zero exit code', async () => {
  const f = await fixture('rea-timeout', { command: async args => args[0] === 'analyze' ?
    { ...ok(raw), timedOut: true } : null });
  const result = await f.run();
  assert.equal(result.success, false);
  assert.equal(result.error.stage, 'rea_analysis');
  assert.equal(result.runtime['rea-analyze'].timed_out, true);
});

test('N05 bounds UTF-8 evidence for model while retaining the complete raw file', async () => {
  const largeRaw = JSON.stringify(evidenceFixture({ normalized_result: { evidence: quote, padding: '가'.repeat(30000) } }));
  const f = await fixture('bounded-evidence', { raw: largeRaw });
  const result = await f.run();
  assert.equal(result.success, true);
  assert.equal(result.evidence.truncated, true);
  assert.ok(Buffer.byteLength(result.evidence.text) <= 24 * 1024);
  assert.equal(result.evidence.end_byte, Buffer.byteLength(result.evidence.text));
  assert.equal(result.evidence.total_bytes, Buffer.byteLength(largeRaw));
  assert.equal(result.evidence.text.includes('\ufffd'), false);
  assert.equal(await readFile(result.evidence.raw_file, 'utf8'), largeRaw);
  const toolMessage = f.requests[1].body.messages.find(message => message.role === 'tool');
  assert.equal(JSON.parse(toolMessage.content).evidence.text, result.evidence.text);
  assert.ok(Buffer.byteLength(toolMessage.content) < Buffer.byteLength(largeRaw));
});

test('N05 credentials stay out of every persisted result/artifact and the REA environment', async () => {
  const f = await fixture('redaction', {
    first: first([call()], `Mock model echoed ${key}`),
    final: final({ unknowns: [`Mock model echoed ${key}`] }),
  });
  assert.equal((await f.run()).success, true);
  for (const filename of await filesUnder(f.directory)) {
    assert.equal((await readFile(filename, 'utf8')).includes(key), false, filename);
  }
  assert.equal(f.requests[0].init.headers.Authorization, `Bearer ${key}`);
  for (const command of reaCommands(f)) {
    assert.equal(command.opts.env.LLM_API_KEY, undefined);
    assert.equal(command.opts.env.LLM_CHAT_COMPLETIONS_URL, undefined);
  }
});

test('N05 rejects summary quotes absent from the supplied and original evidence', async () => {
  const f = await fixture('fabricated-quote', { final: final({
    claims: [{ claim: 'An unsupported mocked claim.', quote: 'This exact quote is absent from REA output.' }],
  }) });
  const result = await f.run();
  assert.equal(result.success, false);
  assert.equal(result.error.stage, 'evidence_verification');
  assert.equal(result.error.code, 'EVIDENCE_QUOTE_MISMATCH');
  assert.equal(result.verification.all_quotes_match, false);
  assert.equal((await saved(f)).verification.matches[0].exact_match, false);
});

test('N05 refuses to overwrite the selected input or an existing result', async () => {
  const f = await fixture('overwrite-protection');
  await assert.rejects(f.run({ resultPath: f.binaryPath }), { code: 'EEXIST' });
  assert.deepEqual(await readFile(f.binaryPath), f.binary);
  await writeFile(f.resultPath, 'previous run evidence');
  await assert.rejects(f.run(), { code: 'EEXIST' });
  assert.equal(await readFile(f.resultPath, 'utf8'), 'previous run evidence');
  assert.equal(f.commands.length, 0);
  assert.equal(f.requests.length, 0);
});

test('N05 REA-only mode needs no model credentials or API call', async () => {
  const f = await fixture('rea-only');
  const result = await f.run({ mode: 'rea-only', env: {} });
  assert.equal(result.success, true);
  assert.equal(result.tool_call, null);
  assert.equal(result.summary, null);
  assert.equal(f.requests.length, 0);
  assert.equal(await readFile(result.evidence.raw_file, 'utf8'), raw);
});

// A zero process exit does not establish a healthy analyzer or valid provenance.
test('N05 blocks an unhealthy doctor JSON even with a successful process exit', async () => {
  const f = await fixture('doctor-unhealthy', { command: async args => args[0] === 'doctor' ?
    ok('{"healthy":false,"mock":true}') : null });
  const result = await f.run();
  assert.equal(result.success, false);
  assert.equal(result.error.stage, 'rea_doctor');
  assert.equal(reaCommands(f).some(item => item.args[0] === 'analyze'), false);
});

for (const [name, output] of [
  ['not-json', 'Explicit mock non-JSON output'],
  ['missing-envelope', JSON.stringify({ mock: true, evidence: quote })],
  ['wrong-binary-digest', JSON.stringify(evidenceFixture({ subject: { digest: { sha256: '0'.repeat(64) } } }))],
  ['wrong-analysis-provider', JSON.stringify(evidenceFixture({
    analysis_profile: { parameters: { upstream_analysis_profile: { provider: { id: 'r2' } } } },
  }))],
]) {
  test(`N05 refuses REA output with ${name}`, async () => {
    const f = await fixture(`rea-schema-${name}`, { raw: output });
    const result = await f.run();
    assert.equal(result.success, false);
    assert.equal(result.error.stage, 'rea_analysis');
    assert.equal(f.requests.length, 1, 'invalid evidence must not reach the summary model');
  });
}
