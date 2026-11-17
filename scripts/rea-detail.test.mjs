import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {detailBundle,validateDetailBundle} from './rea-detail.mjs';

const digest='a'.repeat(64);
const evidence=(operation,normalized_result)=>({evidence_id:'ev_1234',operation,subject:{digest:{sha256:digest}},
  provider:{id:'ghidra'},normalized_result});
async function fixture(procedures=[{address:'0x1234',value:'handle_test',symbol:{external:false}}]) {
  await mkdir('runs/rea-detail-tests',{recursive:true});
  const artifacts=await mkdtemp(path.resolve('runs/rea-detail-tests/fixture-'));
  const overviewPath=path.join(artifacts,'overview.json');
  await writeFile(overviewPath,JSON.stringify(evidence('binary_overview',{fixture:true})));
  const commands=[];
  const runCommand=async(command,args)=>{commands.push({command,args});return {exitCode:0,stdout:JSON.stringify(
    args[0]==='search'?evidence('search_procedures',procedures):evidence('procedure_pseudo_code','Explicit mock pseudo code only.')),stderr:''};};
  return {artifacts,commands,run:()=>detailBundle({binaryPath:'operator-selected-fixture',binarySha:digest,
    overviewPath,artifacts,runCommand,env:{}})};
}
test('detail profile selects only an observed function and authenticates every projected record',async()=>{
  const f=await fixture(),bundle=await f.run();
  assert.equal(f.commands.length,2);assert.ok(f.commands.every(c=>c.command==='rea'));
  assert.equal(f.commands[1].args[1],'operator-selected-fixture');assert.equal(f.commands[1].args[2],'0x1234');
  assert.equal(bundle.records.length,3);assert.equal(await validateDetailBundle(bundle,digest),true);
  bundle.records[2].normalized_result='fabricated interpretation';
  await assert.rejects(validateDetailBundle(bundle,digest),/differs from raw/);
});
test('stripped or external-only inventory stays bounded without inventing a decompile target',async()=>{
  const f=await fixture([{address:'EXTERNAL:0x1',value:'main',symbol:{external:true}}]);
  const bundle=await f.run();assert.equal(f.commands.length,1);assert.equal(bundle.records.length,2);
  assert.equal(bundle.profile.selected_procedure,null);
});
test('changed raw detail evidence is rejected before it can be supplied to a model',async()=>{
  const f=await fixture(),bundle=await f.run();
  await writeFile(bundle.records[2].raw_file,(await readFile(bundle.records[2].raw_file,'utf8'))+' ');
  await assert.rejects(validateDetailBundle(bundle,digest),/source changed/);
});
