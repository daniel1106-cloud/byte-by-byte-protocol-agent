// Container worker. All analysis uses the public practice capture/binary only.
import { mkdir, writeFile, readFile, open } from 'node:fs/promises';
import path from 'node:path';
import { defaultRunCommand, runSmoke } from './rea-smoke.mjs';
import { prepareRun } from './n09-prepare.mjs';
import { checkPair } from './n09-check-pair.mjs';
import { runLive } from './n09-live.mjs';
import { evaluatePractice } from './n12-practice-bridge.mjs';
import { fingerprintSources } from './n09-source-state.mjs';

const args=process.argv.slice(2),options={};
for(let i=0;i<args.length;i+=2){if(!['--out','--phase','--execution','--allow-dirty'].includes(args[i])||!args[i+1])
  throw new Error('Invalid practice option');options[args[i]]=args[i+1];}
const directory=path.resolve(options['--out']),phase=options['--phase']||'all',execution=options['--execution']||'dry-run';
if(!['all','smoke','recover'].includes(phase)||!['dry-run','live'].includes(execution))throw new Error('Invalid phase/execution');
await mkdir(directory,{recursive:true});
const summaryPath=path.join(directory,'summary.json'),reservation=await open(summaryPath,'wx',0o600);await reservation.close();
const summary={classification:'public-practice-only',experiment_score:false,phase,execution,success:false,
  started_at:new Date().toISOString(),model_requests:0,results:[]};
const safeEnv=Object.fromEntries(Object.entries(process.env).filter(([name])=>!/KEY|TOKEN|SECRET|^LLM_/i.test(name)));
const record=async(label,result)=>{summary.results.push({label,...result});await writeFile(summaryPath,JSON.stringify(summary,null,2)+'\n');};
const binary=path.join(directory,'practice-server');
try {
  const trusted=await defaultRunCommand('git',['config','--global','--add','safe.directory',process.cwd()],{env:safeEnv,timeoutMs:10000});
  if(trusted.exitCode!==0)throw new Error('Cannot configure the container repository ownership');
  const commit=await defaultRunCommand('git',['rev-parse','HEAD'],{env:safeEnv,timeoutMs:10000});
  const dirty=await defaultRunCommand('git',['status','--porcelain'],{env:safeEnv,timeoutMs:10000});
  if(commit.exitCode!==0||dirty.exitCode!==0)throw new Error('Cannot record execution Git state');
  summary.code_commit=commit.stdout.trim();summary.code_dirty=Boolean(dirty.stdout.trim());
  summary.source_fingerprint=await fingerprintSources();summary.model=process.env.LLM_MODEL||null;
  const compile=await defaultRunCommand('gcc',['-O0','-fno-inline','-Wall','-Wextra','-o',binary,'practice/n06/server.c'],{env:safeEnv,timeoutMs:30000});
  if(compile.exitCode!==0)throw new Error('Public practice server compilation failed');
  if(phase==='all'||phase==='smoke') {
    const smokePath=path.join(directory,'n05.json');
    const result=await runSmoke({binaryPath:binary,resultPath:smokePath,mode:execution==='live'?'full':'rea-only'});
    summary.model_requests+=result.usage?.api_requests||0;
    await record('N05',{file:smokePath,success:result.success,usage:result.usage,error:result.error||null});
    if(!result.success)throw new Error('N05 failed; original attempt retained');
  }
  if(phase==='all'||phase==='recover') {
    const aPath=path.join(directory,'A-prepare.json'),bPath=path.join(directory,'B-prepare.json');
    for(const [condition,resultPath] of [['A',aPath],['B',bPath]]) {
      const result=await prepareRun({condition,resultPath,pcapPath:'practice/n06/normal-sessions.pcap',binaryPath:condition==='B'?binary:undefined,packetFormat:'tcp-streams-v1',binaryDetails:condition==='B'});
      if(!result.success)throw new Error('Preparation failed: '+condition);
    }
    await checkPair({aPath,bPath,outPath:path.join(directory,'pair.json'),allowDirty:options['--allow-dirty']==='true'});
    for(const [condition,preparedPath] of [['A',aPath],['B',bPath]]) {
      const resultPath=path.join(directory,condition+'-analysis.json');
      const result=await runLive({preparedPath,resultPath,execution,condition,repeat:1});
      const attempt={analysis_run_id:result.analysis_run_id,condition:result.condition,repeat:result.repeat};
      summary.model_requests+=result.usage.api_requests;
      await record('N09-'+condition,{...attempt,file:resultPath,success:result.success,usage:result.usage,error:result.error||null});
      if(execution==='live') {
        const bridgePath=path.join(directory,condition+'-client.json');
        const bridge=await evaluatePractice({analysisPath:resultPath,binaryPath:binary,resultPath:bridgePath});
        await record('N12-reference-'+condition,{...attempt,file:bridgePath,success:bridge.success,
          evaluation_status:bridge.evaluation_status,summary:bridge.summary,error:bridge.error||null});
      }
      if(result.api&&result.api.status!==200)break;
    }
  }
  summary.success=summary.results.length>0&&summary.results.every(result=>result.success);
} catch(error) {summary.error={code:error.code||error.name,message:error.message};}
summary.finished_at=new Date().toISOString();
await writeFile(summaryPath,JSON.stringify(summary,null,2)+'\n');
console.log('GEMINI_PRACTICE '+JSON.stringify(summary));process.exitCode=summary.success?0:1;
