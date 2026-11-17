import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { once } from 'node:events';
import path from 'node:path';
import { BUDGET, PROMPT } from './n09-contract.mjs';
import { runLive, parseArgs } from './n09-live.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const root=path.resolve('runs/n09-live-tests');
await mkdir(root,{recursive:true});
const packet='Explicit mock packet evidence for HTTP protocol tests; this is not a real capture.\n';
async function fixture(condition='A') {
  const dir=await mkdtemp(path.join(root,'case-'));
  const pcapPath=path.join(dir,'fixture.pcap'),binaryPath=path.join(dir,'fixture-binary');
  await writeFile(pcapPath,'explicit mock input file');
  await writeFile(binaryPath,'explicit mock binary file');
  const snapshot=async file=>({path:file,sha256:sha(await readFile(file)),bytes:(await readFile(file)).length});
  const input={pcap:await snapshot(pcapPath)};
  if(condition==='B')input.binary=await snapshot(binaryPath);
  const evidence=[];
  const add=async(source,text)=>{
    const raw_file=path.join(dir,source+'.raw');
    await writeFile(raw_file,text);
    evidence.push({id:source==='packet'?'packet-1':'binary-1',source,text,
      raw_file,raw_sha256:sha(text),supplied_bytes:Buffer.byteLength(text)});
  };
  await add('packet',packet);
  if(condition==='B')await add('binary',JSON.stringify({
    operation:'binary_overview',subject:{digest:{sha256:input.binary.sha256}},
    analysis_profile:{parameters:{upstream_analysis_profile:{provider:{id:'ghidra'}}}},
    normalized_result:{fixture:true}
  }));
  const prepared={task:'N09',run_id:'preparation-'+randomUUID(),condition,experiment:'practice',
    success:true,execution:'prepare',command_backend:'real',model_called:false,spec:null,
    experiment_score:false,budget:{...BUDGET},input,evidence};
  const preparedPath=path.join(dir,'prepared.json'),resultPath=path.join(dir,'result.json');
  const persist=()=>writeFile(preparedPath,JSON.stringify(prepared));
  await persist();
  const env={LLM_CHAT_COMPLETIONS_URL:'https://model.example.test/v1/chat/completions',
    LLM_MODEL:'explicit-model-fixture',LLM_API_KEY:'explicit-test-secret-123'};
  const requests=[];
  const candidate={spec:{fixture_only:true},observations:[{claim:'An explicitly mocked packet text was supplied.',
    evidence_id:'packet-1',quote:packet.slice(0,40)}],unknowns:['No real model or protocol reconstruction.']};
  const envelope=(overrides={})=>({id:'test-response',model:'explicit-model-fixture',
    usage:{prompt_tokens:123,completion_tokens:45,total_tokens:168},
    choices:[{finish_reason:'stop',message:{role:'assistant',content:JSON.stringify(candidate)}}],...overrides});
  const fetchImpl=async(url,options)=>{requests.push({url,options,payload:JSON.parse(options.body)});
    return new Response(JSON.stringify(envelope()),{status:200,headers:{'x-request-id':'fixture-request'}});};
  const run=options=>runLive({preparedPath,resultPath,execution:'live',env,fetchImpl,...options});
  return {dir,prepared,preparedPath,resultPath,pcapPath,binaryPath,env,requests,candidate,envelope,fetchImpl,run,persist};
}
async function retainedText(dir) {
  const values=[];
  for(const e of await readdir(dir,{withFileTypes:true})){
    const p=path.join(dir,e.name);
    if(e.isDirectory())values.push(await retainedText(p));
    else values.push(await readFile(p,'utf8'));
  }
  return values.join('\n');
}

test('dry-run needs no credentials, makes zero requests and stores an offline request',async()=>{
  const f=await fixture(),r=await f.run({execution:'dry-run',env:{}});
  assert.equal(r.success,true);assert.equal(f.requests.length,0);
  assert.equal(r.model_called,false);assert.equal(r.spec,null);
  assert.equal(r.configuration.ready,false);
  assert.equal(r.configuration.missing.length,3);
  const q=JSON.parse(await readFile(r.request_file,'utf8'));
  assert.equal(q.messages[0].content,PROMPT);
  assert.equal(q.max_completion_tokens,4096);
});
test('live protocol fixture records real usage fields but cannot claim an actual model experiment',async()=>{
  const f=await fixture(),r=await f.run();
  assert.equal(r.success,true);assert.equal(f.requests.length,1);
  assert.equal(r.model_called,false);assert.equal(r.model_response_received,true);
  assert.equal(r.classification,'injected-api-protocol-test');
  assert.equal(r.analysis_run_id,f.prepared.run_id);
  assert.equal(r.usage.total_tokens,168);
  assert.equal(r.usage.api_requests,1);
  assert.equal(r.experiment_score,false);assert.equal(r.n09_complete,false);
  assert.equal(r.verification.semantic_review,'pending');
  assert.equal(r.verification.actual_protocol_reconstruction_confirmed,false);
  assert.equal(f.requests[0].options.redirect,'error');
  assert.equal(f.requests[0].options.headers.Authorization,'Bearer '+f.env.LLM_API_KEY);
  assert.equal(f.requests[0].payload.max_completion_tokens,4096);
  assert.equal(f.requests[0].payload.messages.length,2);
  assert.equal((await retainedText(f.dir)).includes(f.env.LLM_API_KEY),false);
});
test('B supplies the same packet plus independently hash-bound Ghidra evidence',async()=>{
  const f=await fixture('B'),r=await f.run();
  assert.equal(r.success,true);
  const evidence=JSON.parse(f.requests[0].payload.messages[1].content).evidence;
  assert.deepEqual(evidence.map(e=>e.source),['packet','binary']);
  assert.equal(evidence[0].text,packet);
});
test('existing result and selected preparation cannot be overwritten',async()=>{
  const f=await fixture();
  await writeFile(f.resultPath,'sentinel');
  await assert.rejects(f.run(),{code:'EEXIST'});
  assert.equal(await readFile(f.resultPath,'utf8'),'sentinel');
  await assert.rejects(f.run({resultPath:f.preparedPath}),{code:'OUTPUT_IS_INPUT'});
  assert.equal(f.requests.length,0);
});
test('mock preparation is rejected before a model request',async()=>{
  const f=await fixture();f.prepared.execution='mock';await f.persist();
  assert.equal((await f.run()).error.code,'PREPARATION_REQUIRED');
  assert.equal(f.requests.length,0);
});
test('A rejects binary metadata even if its path is empty',async()=>{
  const f=await fixture();f.prepared.input.binary={path:''};await f.persist();
  assert.equal((await f.run()).error.code,'A_BINARY_FORBIDDEN');
  assert.equal(f.requests.length,0);
});
test('changed input digest is rejected before sending any evidence',async()=>{
  const f=await fixture();await writeFile(f.pcapPath,'changed input');
  assert.equal((await f.run()).error.code,'INPUT_CHANGED');
  assert.equal(f.requests.length,0);
});
test('changed raw evidence and edited excerpts are both rejected',async()=>{
  const f=await fixture();await writeFile(f.prepared.evidence[0].raw_file,'changed evidence');
  assert.equal((await f.run()).error.code,'EVIDENCE_CHANGED');
  assert.equal(f.requests.length,0);
  const g=await fixture();g.prepared.evidence[0].text+='invented claim';await g.persist();
  assert.equal((await g.run()).error.code,'EVIDENCE_EXCERPT');
  assert.equal(g.requests.length,0);
});
test('an edited request.json is ignored and cannot add repository documents to model input',async()=>{
  const f=await fixture();
  f.prepared.request_file=path.join(f.dir,'edited-request.json');
  await writeFile(f.prepared.request_file,'edited request containing DO_NOT_SEND');
  await f.persist();const r=await f.run();
  assert.equal(r.success,true);
  assert.equal(f.requests[0].options.body.includes('DO_NOT_SEND'),false);
});
test('missing credentials persist a configuration failure without a call',async()=>{
  const f=await fixture(),r=await f.run({env:{}});
  assert.equal(r.success,false);assert.equal(r.error.code,'MISSING_CONFIGURATION');
  assert.equal(r.usage.api_requests,0);assert.equal(f.requests.length,0);
  assert.equal(JSON.parse(await readFile(f.resultPath,'utf8')).error.stage,'configuration');
});
test('HTTP 429 keeps its body and usage unknown without automatic retries',async()=>{
  const f=await fixture();let count=0;
  const r=await f.run({fetchImpl:async()=>{count++;return new Response(
    JSON.stringify({error:'fixture rejected '+f.env.LLM_API_KEY}),{status:429,headers:{'retry-after':'60'}});}});
  assert.equal(r.error.code,'API_HTTP_ERROR');assert.equal(count,1);
  assert.equal(r.api.retry_after,'60');assert.equal(r.usage.total_tokens,null);
  assert.match(await readFile(r.response_file,'utf8'),/REDACTED_API_KEY/);
  assert.equal((await retainedText(f.dir)).includes(f.env.LLM_API_KEY),false);
});
test('request timeout persists failure instead of leaving an unbounded fetch',async()=>{
  const f=await fixture();
  const r=await f.run({timeoutMs:10,fetchImpl:async(_,opts)=>new Promise((_,reject)=>{
    opts.signal.addEventListener('abort',()=>reject(new DOMException('aborted','AbortError')),{once:true});
  })});
  assert.equal(r.error.code,'MODEL_TIMEOUT');
  assert.equal(r.usage.api_requests,1);assert.equal(r.model_called,false);
});
test('unsupported schemes, URL secrets and oversized timeout budgets cannot cause a call',async()=>{
  for(const url of ['http://example.test/api','https://user:secret@example.test/api','https://example.test/api?key=secret']){
    const f=await fixture(),r=await f.run({env:{...f.env,LLM_CHAT_COMPLETIONS_URL:url}});
    assert.equal(r.error.code,'INVALID_URL');assert.equal(f.requests.length,0);
  }
  const f=await fixture();
  await assert.rejects(f.run({timeoutMs:BUDGET.model_timeout_ms+1}),{code:'TIMEOUT_BUDGET'});
});
test('a provider-specific token parameter is explicit and stays capped at 4096',async()=>{
  const f=await fixture(),r=await f.run({env:{...f.env,LLM_MAX_TOKENS_PARAM:'max_tokens',LLM_JSON_MODE:'on'}});
  assert.equal(r.success,true);assert.equal(f.requests[0].payload.max_tokens,4096);
  assert.equal(f.requests[0].payload.max_completion_tokens,undefined);
  assert.deepEqual(f.requests[0].payload.response_format,{type:'json_object'});
});
test('missing provider usage is null rather than an invented token or credit count',async()=>{
  const f=await fixture();const e=f.envelope();delete e.usage;
  const r=await f.run({fetchImpl:async()=>new Response(JSON.stringify(e))});
  assert.equal(r.success,true);assert.equal(r.usage.reported,false);
  assert.equal(r.usage.total_tokens,null);assert.equal(r.usage.prompt_tokens,null);
});
test('malformed API JSON, malformed candidate and fabricated quotes cannot pass',async()=>{
  const cases=[
    ['not JSON','API_JSON'],
    [JSON.stringify({choices:[{finish_reason:'stop',message:{content:'not JSON'}}]}),'CANDIDATE_JSON']
  ];
  const f0=await fixture();
  const bad={...f0.candidate,observations:[{claim:'fabricated',evidence_id:'packet-1',quote:'this quote is entirely invented'}]};
  cases.push([JSON.stringify(f0.envelope({choices:[{finish_reason:'stop',message:{content:JSON.stringify(bad)}}]})),'QUOTE_MISMATCH']);
  for(const [body,code] of cases){
    const f=await fixture(),r=await f.run({fetchImpl:async()=>new Response(body)});
    assert.equal(r.success,false);assert.equal(r.error.code,code);
  }
});
test('truncation, tool requests and empty candidate specs are preserved as failures',async()=>{
  for(const [reason,message,code] of [
    ['length',{content:'{}'},'OUTPUT_TRUNCATED'],
    ['tool_calls',{tool_calls:[{id:'fixture-tool'}]},'UNEXPECTED_TOOL_CALL'],
    ['stop',{content:JSON.stringify({spec:{},observations:[],unknowns:[]})},'EMPTY_CANDIDATE']
  ]){
    const f=await fixture(),r=await f.run({fetchImpl:async()=>new Response(JSON.stringify(f.envelope({
      choices:[{finish_reason:reason,message}]
    })))});
    assert.equal(r.error.code,code);assert.equal(r.spec,null);
    assert.ok(await readFile(r.response_file,'utf8'));
  }
});
test('CLI parsing rejects unknown, duplicate or missing arguments',()=>{
  assert.deepEqual(parseArgs(['--prepared','p.json','--out','r.json']),
    {preparedPath:'p.json',resultPath:'r.json'});
  for(const args of [['--out'],['--oops','a'],['--out','a','--out','b']])
    assert.throws(()=>parseArgs(args),{code:'USAGE'});
});
test('an actual loopback HTTP fixture exercises wire serialization without invoking a real LLM',async t=>{
  const f=await fixture();let received;
  const server=createServer((req,res)=>{
    let body='';req.setEncoding('utf8');req.on('data',part=>{body+=part;});
    req.on('end',()=>{received={method:req.method,auth:req.headers.authorization,body:JSON.parse(body)};
      res.setHeader('Content-Type','application/json');res.end(JSON.stringify(f.envelope()));});
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const url='http://127.0.0.1:'+server.address().port+'/v1/chat/completions';
  const r=await f.run({fetchImpl:(_,options)=>fetch(url,options)});
  assert.equal(r.success,true);assert.equal(received.method,'POST');
  assert.equal(received.auth,'Bearer '+f.env.LLM_API_KEY);
  assert.equal(received.body.model,f.env.LLM_MODEL);
  assert.equal(r.model_called,false);assert.equal(r.usage.total_tokens,168);
});
