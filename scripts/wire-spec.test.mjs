import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { validateWireSpec,encodeMessage,decodeMessage } from './wire-spec.mjs';
import { buildPracticeCases,evaluatePractice } from './n12-practice-bridge.mjs';

// Public N06 oracle fixture, never passed to the recovery model by the runner.
const field=(name,type,extra={})=>({name,type,...extra});
const numeric={bytes:2,endian:'big'};
const spec={format:'wire-spec-v1',transport:'tcp',
  request:{fields:[field('marker','const',{hex:'42420101'}),field('size','length',{...numeric,of:'items'}),field('items','uint_array',numeric)]},
  response:{fields:[field('marker','const',{hex:'42420181'}),field('size','length',{...numeric,of:'answer'}),field('answer','uint',{bytes:4,endian:'big'})]}};

test('declarative fields construct the published wire frames without protocol code',()=>{
  assert.equal(encodeMessage(spec,'request',{items:[1,2,3]}).toString('hex'),'424201010006000100020003');
  assert.equal(encodeMessage(spec,'response',{answer:131070}).toString('hex'),'4242018100040001fffe');
  assert.equal(encodeMessage(spec,'request',{items:[]}).toString('hex'),'424201010000');
});
test('decoder waits across every partial frame and separates combined frames',()=>{
  const frame=Buffer.from('42420181000400000006','hex');
  for(let i=0;i<frame.length;i++)assert.equal(decodeMessage(spec,'response',frame.subarray(0,i)).complete,false);
  const first=decodeMessage(spec,'response',Buffer.concat([frame,frame]));
  assert.equal(first.values.answer,6);assert.equal(first.bytes_consumed,frame.length);
  assert.equal(first.remaining_hex,frame.toString('hex'));
  assert.equal(decodeMessage(spec,'response',Buffer.from(first.remaining_hex,'hex')).values.answer,6);
});
test('decoder rejects wrong constants and inconsistent declared byte lengths',()=>{
  assert.throws(()=>decodeMessage(spec,'response',Buffer.from('41420181000400000006','hex')),/Constant mismatch/);
  assert.throws(()=>decodeMessage(spec,'response',Buffer.from('42420181000200000006','hex')),/Incorrect byte length/);
  assert.throws(()=>decodeMessage(spec,'request',Buffer.from('424201010003000100','hex')),/not aligned/);
});
test('codec rejects overflow, extra inputs, unknown fields and executable attributes',()=>{
  assert.throws(()=>encodeMessage(spec,'request',{items:[65536]}),/Out-of-range/);
  assert.throws(()=>encodeMessage(spec,'request',{items:[],injected:1}),/Unexpected input/);
  for(const mutate of [s=>s.request.fields.push(field('x','unknown')),
    s=>s.request.fields[0].eval='process.exit()',s=>s.request.fields[2].name='constructor',
    s=>s.request.fields[1].of='missing']){
    const copy=structuredClone(spec);mutate(copy);assert.throws(()=>validateWireSpec(copy));
  }
});
test('little-endian fields are interpreted from the supplied spec',()=>{
  const copy=structuredClone(spec);copy.request.fields[2].endian='little';
  assert.equal(encodeMessage(copy,'request',{items:[258]}).toString('hex'),'4242010100020201');
  assert.deepEqual([...decodeMessage(copy,'request',Buffer.from('4242010100020201','hex')).values.items],[258]);
});
test('public oracle bridge uses recovered layout and names for unseen application values',()=>{
  const cases=buildPracticeCases(spec,{cases:[{id:'new',numbers:[2,4,8],expected_result:14}]});
  assert.equal(cases.cases.length,3);
  assert.equal(cases.cases[0].send_hex[0],'424201010006000200040008');
  assert.equal(cases.cases[0].expect_hex,'4242018100040000000e');
  assert.equal(cases.cases[1].send_hex.join(''),cases.cases[0].send_hex[0]);
});
test('bridge refuses failed or mock model analyses before starting the server',async()=>{
  await mkdir('runs/wire-tests',{recursive:true});const dir=await mkdtemp(path.resolve('runs/wire-tests/invalid-'));
  const analysisPath=path.join(dir,'analysis.json'),resultPath=path.join(dir,'result.json');
  await writeFile(analysisPath,JSON.stringify({success:true,model_called:false,spec}));
  const result=await evaluatePractice({analysisPath,resultPath,binaryPath:'must-not-execute'});
  assert.equal(result.success,false);assert.match(result.error.message,/validated real model/);
  assert.equal(result.evaluation_file,undefined);
  assert.equal(JSON.parse(await readFile(resultPath,'utf8')).success,false);
});
