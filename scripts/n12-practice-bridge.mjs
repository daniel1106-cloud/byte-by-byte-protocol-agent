// Reference handoff for N12: compile declarative model fields, never execute model code.
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, open } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultRunCommand } from './rea-smoke.mjs';
import { validateWireSpec, encodeMessage, decodeMessage } from './wire-spec.mjs';

const sha=value=>createHash('sha256').update(value).digest('hex');
export function buildPracticeCases(spec, vectors) {
  validateWireSpec(spec);
  const requestInputs=spec.request.fields.filter(f=>!['const','length'].includes(f.type));
  const responseOutputs=spec.response.fields.filter(f=>!['const','length'].includes(f.type));
  if(requestInputs.length!==1||requestInputs[0].type!=='uint_array'||
      responseOutputs.length!==1||responseOutputs[0].type!=='uint')
    throw new Error('Public N06 bridge needs exactly one recovered integer-array input and one integer output');
  if(!Array.isArray(vectors.cases)||vectors.cases.length===0)throw new Error('Missing public oracle vectors');
  const cases=[];
  for(const vector of vectors.cases) {
    const request=encodeMessage(spec,'request',{[requestInputs[0].name]:vector.numbers});
    const expected=encodeMessage(spec,'response',{[responseOutputs[0].name]:vector.expected_result});
    for(const [suffix,chunks] of [
      ['whole',[request]],['byte-split',[...request].map(byte=>Buffer.from([byte]))],
      ['split-three',[request.subarray(0,3),request.subarray(3)].filter(b=>b.length)],
    ]) cases.push({id:`${vector.id}-${suffix}`,description:'Recovered frame layout with independent public application oracle',
      send_hex:chunks.map(chunk=>chunk.toString('hex')),expect_hex:expected.toString('hex')});
  }
  return {name:'n12-public-recovered-client',description:'Actual model wire layout; public oracle values excluded from model input',
    spec_source:'model candidate wire-spec-v1',defaults:{timeout_s:3,chunk_delay_ms:2},cases};
}

export async function evaluatePractice({analysisPath,binaryPath,resultPath,env=process.env}) {
  const output=path.resolve(resultPath);await mkdir(path.dirname(output),{recursive:true});
  const reserved=await open(output,'wx',0o600);await reserved.close();
  const result={task:'N12-reference',classification:'public-practice-recovered-wire-client',
    experiment_score:false,success:false,started_at:new Date().toISOString(),analysis_run_id:null,
    condition:null,repeat:null,evaluation_status:'not_run'};
  try {
    const raw=await readFile(analysisPath,'utf8'),analysis=JSON.parse(raw);
    result.analysis_sha256=sha(raw);
    result.analysis_run_id=analysis.analysis_run_id ?? (analysis.task==='N09-live'?analysis.run_id:null) ?? null;
    result.condition=analysis.condition ?? null;
    result.repeat=analysis.repeat ?? null;
    if(analysis.success===false) {
      const error=new Error(analysis.error?.message || 'Upstream N09 analysis failed');
      error.code=analysis.error?.code || 'ANALYSIS_FAILED';
      error.stage=analysis.error?.stage || analysis.stage || 'analysis';
      throw error;
    }
    if(!analysis.success||!analysis.model_called||analysis.runtime?.execution_backend!=='real')
      throw new Error('Use a validated real model candidate; mock, empty and failed analysis results cannot execute');
    const vectorPath=new URL('../practice/n06/client-vectors.json',import.meta.url);
    const vectorRaw=await readFile(vectorPath,'utf8');result.oracle_sha256=sha(vectorRaw);
    result.spec_sha256=sha(JSON.stringify(analysis.spec));
    const cases=buildPracticeCases(analysis.spec,JSON.parse(vectorRaw));
    result.generated_cases_file=output+'.cases.json';result.evaluation_file=output+'.evaluation.json';
    await writeFile(result.generated_cases_file,JSON.stringify(cases,null,2)+'\n',{flag:'wx',mode:0o600});
    const safeEnv=Object.fromEntries(Object.entries(env).filter(([name])=>!/KEY|TOKEN|SECRET|^LLM_/i.test(name)));
    result.evaluation_status='error';
    const execution=await defaultRunCommand('python3',['scripts/n07-evaluate.py','--cases',result.generated_cases_file,
      '--binary',path.resolve(binaryPath),'--out',result.evaluation_file],{env:safeEnv,timeoutMs:120000,
      stdoutPath:output+'.stdout',stderrPath:output+'.stderr'});
    const evaluated=JSON.parse(await readFile(result.evaluation_file,'utf8'));
    result.summary=evaluated.summary;result.server_stopped=evaluated.server_stopped;
    result.runtime={exit_code:execution.exitCode,timed_out:execution.timedOut};
    result.decoded_responses=(evaluated.results||[]).map(item=>{
      try {return {case_id:item.case_id,...decodeMessage(analysis.spec,'response',Buffer.from(item.actual_hex,'hex'))};}
      catch(error){return {case_id:item.case_id,error:error.message};}
    });
    result.success=execution.exitCode===0&&!execution.timedOut&&evaluated.summary?.all_pass===true&&
      evaluated.server_stopped===true&&result.decoded_responses.every(r=>r.complete&&r.remaining_hex==='');
    result.evaluation_status=result.success?'passed':'failed';
  } catch(error) {
    result.error={code:error.code||error.name,message:error.message};
    if(error.stage) result.error.stage=error.stage;
  }
  result.finished_at=new Date().toISOString();
  await writeFile(output,JSON.stringify(result,null,2)+'\n',{mode:0o600});return result;
}

export async function main(argv=process.argv.slice(2)) {
  const keys={'--analysis':'analysisPath','--binary':'binaryPath','--out':'resultPath'},options={};
  for(let i=0;i<argv.length;i+=2){const key=keys[argv[i]];
    if(!key||!argv[i+1]||Object.hasOwn(options,key))throw new Error('Use --analysis FILE --binary FILE --out NEW_FILE');
    options[key]=argv[i+1];}
  if(Object.keys(options).length!==3)throw new Error('Missing bridge option');
  const result=await evaluatePractice(options);
  console.log(JSON.stringify({task:result.task,condition:result.condition,success:result.success,
    summary:result.summary,error:result.error||null}));return result.success?0:1;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))
  main().then(code=>{process.exitCode=code;}).catch(error=>{console.error(error.message);process.exitCode=1;});
