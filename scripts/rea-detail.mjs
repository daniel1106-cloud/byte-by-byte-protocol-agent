// Fixed bounded B-only profile: one inventory search and at most one observed function decompile.
import {readFile,writeFile,stat} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {isDeepStrictEqual} from 'node:util';
const sha=value=>createHash('sha256').update(value).digest('hex');
const fault=message=>Object.assign(new Error(message),{code:'REA_DETAIL'});
function check(record,digest) {
  if(!record?.evidence_id||record.subject?.digest?.sha256!==digest||
    !['binary_overview','search_procedures','procedure_pseudo_code'].includes(record.operation)||
    !(record.provider?.id==='ghidra'||record.analysis_profile?.parameters?.upstream_analysis_profile?.provider?.id==='ghidra'))
    throw fault('Detail evidence does not match the selected Ghidra binary');
}
function projection(record,rawFile,raw) {
  return {evidence_id:record.evidence_id,operation:record.operation,subject_sha256:record.subject.digest.sha256,
    raw_file:rawFile,raw_sha256:sha(raw),normalized_result:record.normalized_result};
}
export async function detailBundle({binaryPath,binarySha,overviewPath,artifacts,runCommand,env}) {
  const records=[],commands=[];
  const overviewRaw=await readFile(overviewPath,'utf8'),overview=JSON.parse(overviewRaw);
  check(overview,binarySha);records.push(projection(overview,overviewPath,overviewRaw));
  const invoke=async(label,args)=>{
    const stdoutPath=path.join(artifacts,label+'.json'),stderrPath=path.join(artifacts,label+'.stderr');
    const result=await runCommand('rea',args,{env,timeoutMs:120000,stdoutPath,stderrPath});
    for(const [file,value] of [[stdoutPath,result.stdout],[stderrPath,result.stderr]]){
      try{await writeFile(file,value||'',{flag:'wx',mode:0o600});}catch(error){if(error.code!=='EEXIST')throw error;}
    }
    commands.push({argv:['rea',...args],exit_code:result.exitCode,timed_out:Boolean(result.timedOut),stdout:stdoutPath,stderr:stderrPath});
    if(result.exitCode!==0||result.timedOut||result.spawnError)throw fault('REA detail command failed; raw output retained');
    if((await stat(stdoutPath)).size>1024*1024)throw fault('REA detail exceeded 1 MiB');
    const raw=await readFile(stdoutPath,'utf8'),record=JSON.parse(raw);check(record,binarySha);
    records.push(projection(record,stdoutPath,raw));return record;
  };
  const search=await invoke('rea-procedure-search',['search',binaryPath,'main|handle|process|parse|request','--kind','procedures','--mode','regex','--provider','ghidra','--format','json']);
  const procedures=Array.isArray(search.normalized_result)?search.normalized_result:[];
  const candidates=procedures.filter(p=>p.symbol?.external===false&&typeof p.value==='string'&&
    !p.value.includes('EXTERNAL')&&/^0x[0-9a-f]+$/.test(p.address||''));
  candidates.sort((a,b)=>Number(!/handle|process|parse|request/i.test(a.value))-Number(!/handle|process|parse|request/i.test(b.value))||a.value.localeCompare(b.value));
  const selected=candidates[0]||null;
  if(selected)await invoke('rea-procedure-code',['decompile',binaryPath,selected.address,'--provider','ghidra','--format','json']);
  return {format:'rea-evidence-bundle-v1',subject_sha256:binarySha,records,
    profile:{version:'named-procedure-v1',max_additional_commands:2,selected_procedure:selected,commands},
    limitations:['Fixed name-based inventory selection may find no function in stripped binaries; not a general reverse engineering solution.']};
}
export async function validateDetailBundle(bundle,digest) {
  if(bundle?.format!=='rea-evidence-bundle-v1'||bundle.subject_sha256!==digest||!Array.isArray(bundle.records)||
    bundle.records.length<2||bundle.records.length>3)throw fault('Invalid detail bundle');
  if(bundle.records[0].operation!=='binary_overview'||bundle.records[1].operation!=='search_procedures'||
    (bundle.records[2]&&bundle.records[2].operation!=='procedure_pseudo_code'))throw fault('Unexpected detail operations');
  for(const item of bundle.records) {
    if((await stat(item.raw_file)).size>1024*1024)throw fault('Detail source too large');
    const raw=await readFile(item.raw_file,'utf8');if(sha(raw)!==item.raw_sha256)throw fault('Detail source changed');
    const record=JSON.parse(raw);check(record,digest);
    if(!isDeepStrictEqual(item,projection(record,item.raw_file,raw)))throw fault('Detail projection differs from raw REA evidence');
  }
  return true;
}
