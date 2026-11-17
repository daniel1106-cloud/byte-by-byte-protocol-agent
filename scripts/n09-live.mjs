#!/usr/bin/env node
// N09: one real model request over already validated preparation evidence.
// No paid SDK, automatic retry, protocol-specific prompt, or server query.
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { BUDGET, makeRequest, validateOutput, validateSelection } from './n09-contract.mjs';

const MAX_FILE_BYTES = 16 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const fault = (code, message) => Object.assign(new Error(message), { code });
const now = () => new Date().toISOString();
const fingerprint = value => value === undefined ? null : hash(value);
async function readBounded(filename, limit = MAX_FILE_BYTES) {
  const resolved = await realpath(filename);
  const info = await stat(resolved);
  if (!info.isFile() || info.size > limit) throw fault('FILE_LIMIT', 'Expected a bounded regular file');
  const bytes = await readFile(resolved);
  if (bytes.length > limit) throw fault('FILE_LIMIT', 'File grew beyond the size limit');
  return { path: resolved, bytes, sha256: hash(bytes) };
}
async function loadPreparation(filename) {
  const source = await readBounded(filename);
  let p;
  try { p = JSON.parse(source.bytes.toString('utf8')); }
  catch { throw fault('PREPARATION_JSON', 'Preparation file is not JSON'); }
  if (p.task !== 'N09' || p.success !== true || p.execution !== 'prepare' ||
      p.command_backend !== 'real' || p.model_called !== false || p.spec !== null ||
      p.experiment_score !== false || !['practice', 'E1'].includes(p.experiment) ||
      !isDeepStrictEqual(p.budget, BUDGET)) {
    throw fault('PREPARATION_REQUIRED', 'Use a successful real N09 prepare run with the current budget');
  }
  if (p.condition === 'A' && (Object.hasOwn(p.input || {}, 'binary') || p.runtime?.rea_result_file))
    throw fault('A_BINARY_FORBIDDEN', 'Condition A must have no binary or REA preparation metadata');
  validateSelection({condition:p.condition, binaryPath:p.input?.binary?.path});
  const expectedSources = p.condition === 'A' ? ['packet'] : ['packet', 'binary'];
  if (!Array.isArray(p.evidence) || p.evidence.length !== expectedSources.length)
    throw fault('EVIDENCE_SELECTION', 'Evidence count differs from the selected A/B condition');
  const inputFiles = [];
  for (const entry of [p.input?.pcap, ...(p.condition === 'B' ? [p.input?.binary] : [])]) {
    if (!entry?.path || !/^[a-f0-9]{64}$/.test(entry.sha256 || ''))
      throw fault('INPUT_DIGEST', 'Preparation lacks a selected input digest');
    const current = await readBounded(entry.path);
    if (current.sha256 !== entry.sha256) throw fault('INPUT_CHANGED', 'Selected input digest changed');
    inputFiles.push({path:current.path, sha256:current.sha256});
  }
  const evidence = [], rawFiles = [];
  for (let index = 0; index < expectedSources.length; index++) {
    const item = p.evidence[index], sourceType = expectedSources[index];
    if (!item || item.source !== sourceType || typeof item.raw_file !== 'string' ||
        typeof item.text !== 'string' || !/^[a-f0-9]{64}$/.test(item.raw_sha256 || ''))
      throw fault('EVIDENCE_SELECTION', 'Preparation evidence has the wrong source or missing digest');
    const raw = await readBounded(item.raw_file);
    if (raw.sha256 !== item.raw_sha256) throw fault('EVIDENCE_CHANGED', 'Raw evidence digest changed');
    const limit = sourceType === 'packet' ? BUDGET.packet_evidence_bytes : BUDGET.binary_evidence_bytes;
    let end = Math.min(raw.bytes.length, limit);
    while (end < raw.bytes.length && end > 0 && (raw.bytes[end] & 0xc0) === 0x80) end--;
    if (item.text !== raw.bytes.subarray(0, end).toString('utf8'))
      throw fault('EVIDENCE_EXCERPT', 'Supplied excerpt differs from the bounded raw evidence');
    if (sourceType === 'binary') {
      let parsed;
      try { parsed = JSON.parse(raw.bytes.toString('utf8')); }
      catch { throw fault('REA_EVIDENCE', 'Binary evidence is not JSON'); }
      if (parsed.operation !== 'binary_overview' || parsed.subject?.digest?.sha256 !== p.input.binary.sha256 ||
          parsed.analysis_profile?.parameters?.upstream_analysis_profile?.provider?.id !== 'ghidra')
        throw fault('REA_EVIDENCE', 'Binary evidence is not bound to the selected Ghidra input');
    }
    evidence.push({id:item.id, source:sourceType, text:item.text});
    rawFiles.push({path:raw.path, sha256:raw.sha256});
  }
  // Rebuild the request from selected evidence; do not trust an edited request.json.
  const request = makeRequest({condition:p.condition, packet:evidence[0], binary:evidence[1] || null});
  return {source:{path:source.path,sha256:source.sha256}, preparation:p, request, inputFiles, rawFiles};
}
function configuration(env, live) {
  const missing = ['LLM_CHAT_COMPLETIONS_URL', 'LLM_MODEL', 'LLM_API_KEY']
    .filter(name => !String(env[name] || '').trim());
  let url = null;
  if (env.LLM_CHAT_COMPLETIONS_URL) {
    try { url = new URL(env.LLM_CHAT_COMPLETIONS_URL); }
    catch { throw fault('INVALID_URL', 'Invalid chat-completions endpoint'); }
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash)
      throw fault('INVALID_URL', 'Use a full HTTPS endpoint without URL credentials, query or fragment');
  }
  const tokenParameter = env.LLM_MAX_TOKENS_PARAM || 'max_completion_tokens';
  if (!['max_tokens','max_completion_tokens'].includes(tokenParameter))
    throw fault('TOKEN_PARAMETER', 'Choose max_tokens or max_completion_tokens explicitly');
  const jsonMode = env.LLM_JSON_MODE || 'off';
  if (!['on','off'].includes(jsonMode)) throw fault('JSON_MODE', 'Use on or off for LLM_JSON_MODE');
  const payload = {model:String(env.LLM_MODEL || '').trim() || '<not-configured>',
    stream:false, n:1, [tokenParameter]:BUDGET.max_output_tokens_per_call};
  if (jsonMode === 'on') payload.response_format = {type:'json_object'};
  if (env.LLM_TEMPERATURE !== undefined && env.LLM_TEMPERATURE !== '') {
    const temperature = Number(env.LLM_TEMPERATURE);
    if (!Number.isFinite(temperature) || temperature < 0 || temperature > 2)
      throw fault('TEMPERATURE', 'Temperature must be between zero and two');
    payload.temperature = temperature;
  }
  if (live && missing.length) throw fault('MISSING_CONFIGURATION', 'Missing: ' + missing.join(', '));
  return {url:url?.toString() || null,missing,payload,tokenParameter};
}
async function responseText(response) {
  if (!response.body) return '';
  const chunks = []; let size = 0;
  const reader = response.body.getReader();
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.length;
      if (size > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw fault('RESPONSE_LIMIT', 'API response exceeds 2 MiB');
      }
      chunks.push(Buffer.from(next.value));
    }
  } finally {reader.releaseLock();}
  return Buffer.concat(chunks).toString('utf8');
}
function providerUsage(raw) {
  const integer = x => Number.isSafeInteger(x) && x >= 0 ? x : null;
  return {reported:Boolean(raw && typeof raw === 'object' && !Array.isArray(raw)),
    prompt_tokens:integer(raw?.prompt_tokens), completion_tokens:integer(raw?.completion_tokens),
    total_tokens:integer(raw?.total_tokens), provider:raw || null};
}
export async function runLive({preparedPath,resultPath,execution='dry-run',env=process.env,
  fetchImpl=globalThis.fetch,timeoutMs=BUDGET.model_timeout_ms}={}) {
  if (!['dry-run','live'].includes(execution) || !preparedPath || !resultPath)
    throw fault('USAGE', 'Use --prepared FILE --out NEW_FILE --execution dry-run|live');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > BUDGET.model_timeout_ms)
    throw fault('TIMEOUT_BUDGET', 'Timeout must not exceed the shared model budget');
  const output = path.resolve(resultPath);
  if (output === path.resolve(preparedPath)) throw fault('OUTPUT_IS_INPUT', 'Output cannot replace preparation');
  await mkdir(path.dirname(output),{recursive:true});
  const reserved = await open(output,'wx',0o600); await reserved.close();
  const artifacts = output + '.artifacts-' + randomUUID();
  await mkdir(artifacts,{mode:0o700});
  const secret = String(env.LLM_API_KEY || '');
  const redact = x => secret ? String(x).split(secret).join('[REDACTED_API_KEY]') : String(x);
  const save = (filename,value) => writeFile(filename,redact(value),{flag:'wx',mode:0o600});
  const injected = fetchImpl !== globalThis.fetch;
  const result = {schema_version:1, task:'N09-live', run_id:randomUUID(),
    analysis_run_id:null, execution, classification:execution==='dry-run'?'offline-request-audit':
      injected?'injected-api-protocol-test':'live-model-candidate',
    started_at:now(), finished_at:null, success:false,stage:'preparation',stages:[],
    model_called:false, model_response_received:false, experiment_score:false,
    n05_complete:false,n09_complete:false, condition:null,experiment:null,
    source_preparation:null,request_file:null,artifacts,budget:{...BUDGET},
    model:{requested:null,returned:null,endpoint:null,operator_confirmed:false},
    usage:{api_requests:0,reported:false,prompt_tokens:null,completion_tokens:null,total_tokens:null},
    runtime:{node:process.version,platform:process.platform,arch:process.arch,
      timeout_ms:timeoutMs,execution_backend:injected?'injected-test':'real',
      runner_sha256:hash(await readFile(fileURLToPath(import.meta.url)))},
    input:null,spec:null,observations:[],unknowns:[],verification:null,
    limitations:['Candidate JSON and exact evidence quotes do not establish protocol correctness.',
      'The operator must confirm model identity; N11 scoring and N12 executable-spec compatibility remain separate.',
      'API-reported usage is not school-portal credits. Missing usage stays null.',
      'No automatic retry, server query or model-requested local tool is performed by this runner.',
      'N05 actual model-requested REA tool invocation remains a separate verification.']};
  const persist = () => writeFile(output,redact(JSON.stringify(result,null,2))+'\n',{mode:0o600});
  const stage = async (name,fn) => {
    result.stage=name; const s={stage:name,started_at:now(),status:'running'};
    result.stages.push(s); await persist();
    try {const v=await fn();s.status='success';return v;}
    catch(e){s.status='failed';throw e;}
    finally {s.finished_at=now();await persist();}
  };
  try {
    const prepared = await stage('preparation',()=>loadPreparation(preparedPath));
    result.analysis_run_id = prepared.preparation.run_id;
    result.condition = prepared.preparation.condition;
    result.experiment = prepared.preparation.experiment;
    result.source_preparation=prepared.source;
    result.input={selected:prepared.inputFiles,raw_evidence:prepared.rawFiles};
    const config=await stage('configuration',()=>configuration(env,execution==='live'));
    result.configuration={ready:config.missing.length===0,missing:config.missing,
      token_parameter:config.tokenParameter};
    result.model.requested=config.payload.model;
    result.model.endpoint=config.url;
    const payload={...config.payload,messages:prepared.request.messages};
    result.request_file=path.join(artifacts,'request.json');
    await stage('request_snapshot',async()=>{
      result.request_sha256=fingerprint(JSON.stringify(payload));
      result.system_prompt_sha256=fingerprint(prepared.request.messages[0].content);
      await save(result.request_file,JSON.stringify(payload,null,2)+'\n');
    });
    if (execution==='live') {
      let response, raw; const controller=new AbortController();
      const timer=setTimeout(()=>controller.abort(),timeoutMs);
      try {
        await stage('model_request',async()=>{
          result.usage.api_requests=1;
          response=await fetchImpl(config.url,{method:'POST',redirect:'error',signal:controller.signal,
            headers:{'Content-Type':'application/json',Authorization:'Bearer '+secret},
            body:JSON.stringify(payload)});
          result.api={status:response.status,request_id:response.headers?.get('x-request-id') || null,
            retry_after:response.headers?.get('retry-after') || null};
          raw=await responseText(response);
          result.response_file=path.join(artifacts,'response.txt');
          await save(result.response_file,raw);
          if (!response.ok) throw fault('API_HTTP_ERROR','API returned HTTP '+response.status+'; response retained');
        });
      } catch(e) {
        if (controller.signal.aborted) throw fault('MODEL_TIMEOUT','Model request exceeded its timeout');
        throw e;
      } finally {clearTimeout(timer);}
      await stage('candidate_validation',async()=>{
        let envelope;
        try {envelope=JSON.parse(raw);}
        catch {throw fault('API_JSON','API response is not JSON');}
        result.usage={...result.usage,...providerUsage(envelope.usage)};
        result.model.returned=typeof envelope.model==='string'?envelope.model:null;
        result.response_id=typeof envelope.id==='string'?envelope.id:null;
        if (!Array.isArray(envelope.choices) || envelope.choices.length!==1)
          throw fault('API_CHOICES','Expected one model choice');
        const choice=envelope.choices[0], message=choice.message;
        result.finish_reason=choice.finish_reason;
        if (message?.tool_calls?.length) throw fault('UNEXPECTED_TOOL_CALL','N09 precomputed-evidence runner does not execute tool calls');
        if (choice.finish_reason==='length') throw fault('OUTPUT_TRUNCATED','Model output reached its configured token limit');
        if (choice.finish_reason!=='stop' || message?.refusal || typeof message?.content!=='string')
          throw fault('MODEL_NO_ANSWER','Expected a completed text answer');
        result.model_response_received=true;
        result.model_called=!injected;
        let candidate;
        try {candidate=JSON.parse(message.content);}
        catch {throw fault('CANDIDATE_JSON','Model content is not the requested JSON');}
        result.raw_candidate=candidate;
        const matches=validateOutput(candidate,prepared.request);
        if (!Object.keys(candidate.spec).length || !candidate.observations.length)
          throw fault('EMPTY_CANDIDATE','A missing specification or evidence-bearing observation is not a recovered client');
        result.spec=candidate.spec;result.observations=candidate.observations;result.unknowns=candidate.unknowns;
        result.verification={exact_quotes:matches,semantic_review:'pending',grading:'pending',
          executable_spec_compatibility:'pending',actual_protocol_reconstruction_confirmed:false};
      });
    }
    result.stage='complete';result.success=true;
  } catch(e) {
    result.error={stage:result.stage,code:e.code || e.name,message:redact(e.message)};
  } finally {result.finished_at=now();await persist();}
  return result;
}
export function parseArgs(argv) {
  const keys={'--prepared':'preparedPath','--out':'resultPath','--execution':'execution'}, options={};
  for(let i=0;i<argv.length;i+=2) {
    const key=keys[argv[i]],value=argv[i+1];
    if(!key || !value || value.startsWith('--') || Object.hasOwn(options,key))
      throw fault('USAGE','Use unique named options with values');
    options[key]=value;
  }
  return options;
}
export async function main(argv=process.argv.slice(2)) {
  const result=await runLive(parseArgs(argv));
  console.log(JSON.stringify({task:result.task,success:result.success,stage:result.stage,
    model_called:result.model_called,usage:{api_requests:result.usage.api_requests,
      reported:result.usage.reported,prompt_tokens:result.usage.prompt_tokens,
      completion_tokens:result.usage.completion_tokens,total_tokens:result.usage.total_tokens},
    error:result.error || null}));
  return result.success?0:1;
}
if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url))
  main().then(code=>{process.exitCode=code;}).catch(e=>{
    console.error('N09-live: '+(e.code || e.name));process.exitCode=1;
  });
