#!/usr/bin/env node
// Host launcher: Node --env-file supplies the private key; command args never contain it.
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function main(argv=process.argv.slice(2)) {
  const options={execution:'dry-run',phase:'all',allowDirty:false};
  for(let i=0;i<argv.length;i++) {
    if(argv[i]==='--allow-dirty')options.allowDirty=true;
    else if(['--execution','--phase'].includes(argv[i])&&argv[i+1])options[argv[i].slice(2)]=argv[++i];
    else throw new Error('Use [--execution dry-run|live] [--phase all|smoke|recover] [--allow-dirty]');
  }
  if(!['dry-run','live'].includes(options.execution)||!['all','smoke','recover'].includes(options.phase))throw new Error('Invalid execution/phase');
  const key=process.env.GEMINI_API_KEY?.trim();
  if(options.execution==='live'&&!key)throw new Error('Set GEMINI_API_KEY locally; never paste it into chat');
  const root=fileURLToPath(new URL('../',import.meta.url)),tag=new Date().toISOString().replace(/[:.]/g,'-');
  const env={...process.env,LLM_API_KEY:key||'',LLM_MODEL:process.env.GEMINI_MODEL||'gemini-3.5-flash-lite',
    LLM_CHAT_COMPLETIONS_URL:'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
    LLM_MAX_TOKENS_PARAM:'max_tokens',LLM_JSON_MODE:'on'};
  const execution=spawnSync('docker',['compose','-f','compose.n05.yaml','run','--rm',
    '-e','LLM_MAX_TOKENS_PARAM','-e','LLM_JSON_MODE','n05','node','scripts/gemini-practice.mjs',
    '--out','runs/gemini/'+tag,'--execution',options.execution,'--phase',options.phase,
    '--allow-dirty',String(options.allowDirty)],{cwd:root,env,stdio:'inherit',windowsHide:true});
  console.log('Practice artifacts: runs/gemini/'+tag);
  return execution.status??1;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  try{process.exitCode=main();}catch(error){console.error(error.message);process.exitCode=1;}
}
