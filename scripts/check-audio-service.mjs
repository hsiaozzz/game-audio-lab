import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { createDeliveryPlan, verifyDeliveryPlan, normalizeDelivery, digest } from '../server/audio-plan.mjs';
import { createAudioApi } from '../server/audio-api.mjs';
import { createAudioPlan } from '../src/game-audio-pipeline.mjs';
import { loadDirectorOptions } from '../server/audio-director.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const input=JSON.parse(await fs.readFile(path.join(root,'examples/audio-service-request.json'),'utf8'));
const checks=[];
const plan=await createDeliveryPlan(input);
assert.equal(verifyDeliveryPlan(plan),true);
assert.deepEqual(plan.items.map(item=>[item.kind,item.formatId,item.channels,item.bitrateKbps]),[['music','opus-ogg',2,64],['sfx','opus-ogg',1,48]]);
assert.equal((await createDeliveryPlan(JSON.parse(JSON.stringify(input)))).planDigest,plan.planDigest);
checks.push('deterministic plan identity, default Opus formats and budgets');
const changed=structuredClone(plan);changed.items[0].bitrateKbps=32;assert.throws(()=>verifyDeliveryPlan(changed),/differs/);
checks.push('content digest rejects altered plan');
for(const patch of [
  {audioRequests:[input.audioRequests[1]]},
  {audioRequests:[{...input.audioRequests[0],eventId:'unknown'}]},
  {audioRequests:[{...input.audioRequests[1],maxDurationSeconds:1},input.audioRequests[0]]},
  {delivery:{...input.delivery,maxDecodedPcmBytes:4096}},
  {delivery:{acceptedFormats:['wav']}},
  {delivery:{profile:'compact-opus-v1',formatOverrides:{unknown:'opus-ogg'}}},
  {audioRequests:[{...input.audioRequests[0],position:[0,1,2]}]},
  {options:{director:'untrusted-url'}}
])await assert.rejects(()=>createDeliveryPlan({...input,...patch}));
checks.push('required coverage, unknown events, unsupported fields, duration and memory limits');
const aac=await createDeliveryPlan({...input,delivery:{...input.delivery,acceptedFormats:['aac-lc-m4a']}});
assert(aac.items.every(item=>item.formatId==='aac-lc-m4a'));
assert.deepEqual(aac.items.map(item=>item.bitrateKbps),[96,64]);
checks.push('AAC capability fallback selects one confirmed encoding per item');
const plugin=await loadDirectorOptions({GAME_AUDIO_DIRECTOR_MODULE:path.join(root,'examples/algorithm-plugin.mjs')});
const algorithmPlan=await createDeliveryPlan(input,{directorOptions:plugin.options});
assert.equal(algorithmPlan.sourcePlan.composerVersion,'example-algorithm-module-v1');
await assert.rejects(()=>createAudioPlan(input.gameBrief,input.eventContract,{composer:()=>({bpm:92,bars:16,meter:4,duration:999,tracks:[]})}));
checks.push('configured algorithm plugin and bounded score validation');
assert.match(algorithmPlan.versions.algorithm.sourceHash,/^[a-f0-9]{64}$/);
// An optional candidate must not prevent confirming a smaller required-only selection.
const optionalMusic=structuredClone(input); optionalMusic.audioRequests[1].required=false;
optionalMusic.delivery.maxDecodedPcmBytes=1024*1024;
const smallPlan=await createDeliveryPlan(optionalMusic);
assert(smallPlan.estimates.decodedPcmBytes>smallPlan.delivery.maxDecodedPcmBytes);
assert(smallPlan.estimates.requiredDecodedPcmBytes<smallPlan.delivery.maxDecodedPcmBytes);
checks.push('optional candidates do not consume the required-only planning budget');
let directorResponse={style:'neon',mode:'minor',bpm:120,rootMidi:60}, directorStatus=200, directorRaw;
const mockDirector=http.createServer(async(req,res)=>{
  let body='';for await(const chunk of req)body+=chunk;
  assert.equal(JSON.parse(body).response_format.type,'json_schema');
  res.writeHead(directorStatus,{'Content-Type':'application/json'});
  res.end(directorRaw??JSON.stringify({choices:[{message:{content:JSON.stringify(directorResponse)}}]}));
});
await new Promise(resolve=>mockDirector.listen(0,'127.0.0.1',resolve));
try{
 const remote=await loadDirectorOptions({GAME_AUDIO_DIRECTOR_PROVIDER:'openai-compatible',GAME_AUDIO_DIRECTOR_URL:'http://127.0.0.1:'+mockDirector.address().port,GAME_AUDIO_DIRECTOR_MODEL:'test-model'});
 const remotePlan=await createDeliveryPlan(input,{directorOptions:remote.options});assert.equal(remotePlan.sourcePlan.score.brief.style,'neon');
 assert.equal(remotePlan.versions.algorithm.model,'test-model');
 directorResponse={...directorResponse,bpm:999};await assert.rejects(()=>createDeliveryPlan(input,{directorOptions:remote.options}),error=>error.status===502);
 directorRaw='x'.repeat(131073);await assert.rejects(()=>createDeliveryPlan(input,{directorOptions:remote.options}),error=>error.code==='director-response-too-large');directorRaw=undefined;
 directorStatus=429;await assert.rejects(()=>createDeliveryPlan(input,{directorOptions:remote.options}),error=>error.status===503&&error.retryable);
 await assert.rejects(()=>loadDirectorOptions({GAME_AUDIO_DIRECTOR_PROVIDER:'openai-compatible',GAME_AUDIO_DIRECTOR_URL:'http://localhost',GAME_AUDIO_DIRECTOR_MODEL:'test',GAME_AUDIO_DIRECTOR_TIMEOUT_MS:'0'}));
 checks.push('remote director schema, invalid-output and upstream-error handling (mock endpoint; no paid model claim)');
}finally{mockDirector.closeAllConnections();await new Promise(resolve=>mockDirector.close(resolve));}
// HTTP checks run with a temporary private store and never render or overwrite historical reports.
const temporary=await fs.mkdtemp(path.join(os.tmpdir(),'audio-api-check-'));
const token='test-backend-token-with-at-least-24-characters';
const api=await createAudioApi({root,dataDir:temporary,env:{GAME_AUDIO_API_TOKENS_JSON:JSON.stringify({backend:token,other:'different-client-token-over-24-characters'}),GAME_AUDIO_ALLOWED_ORIGINS:'https://host.example'}});
const server=http.createServer(async(req,res)=>{if(!await api.handle(req,res,new URL(req.url,'http://localhost'))){res.writeHead(404);res.end();}});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const origin='http://127.0.0.1:'+server.address().port;
const request=async(route,{body,authorization=token,...options}={})=>{
  const response=await fetch(origin+route,{...options,method:body===undefined?options.method||'GET':options.method||'POST',headers:{...(authorization?{Authorization:'Bearer '+authorization}:{}),...(body===undefined?{}:{'Content-Type':'application/json'}),...options.headers},body:body===undefined?undefined:JSON.stringify(body)});
  return{status:response.status,headers:response.headers,data:response.status===204?null:await response.json()};
};
try{
  assert.equal((await request('/v1/audio/capabilities',{authorization:null})).status,401);
  assert.equal((await request('/v1/audio/capabilities',{authorization:'wrong'})).status,401);
  const create=await request('/v1/audio/plans',{body:input});assert.equal(create.status,201);assert.equal(create.data.plan.planDigest,plan.planDigest);
  assert.equal((await request('/v1/audio/plans/'+plan.planId)).status,200);
  assert.equal((await request('/v1/audio/plans/'+plan.planId,{authorization:'different-client-token-over-24-characters'})).status,404);
  checks.push('authenticated plan create/read and owner isolation');
  const allowed=await request('/v1/audio/plans/'+plan.planId,{headers:{Origin:'https://host.example'}});assert.equal(allowed.headers.get('Access-Control-Allow-Origin'),'https://host.example');
  assert(allowed.headers.get('Access-Control-Expose-Headers').includes('ETag'));
  assert.equal((await request('/v1/audio/plans/'+plan.planId,{headers:{Origin:'https://attacker.example'}})).status,403);
  assert.equal((await request('/v1/audio/plans',{method:'OPTIONS',authorization:null,headers:{Origin:'https://host.example'}})).status,204);
  checks.push('exact CORS allowlist and preflight');
  const error=await request('/v1/audio/plans',{body:{...input,delivery:{acceptedFormats:['bad']}}});assert.equal(error.status,422);assert.equal(error.data.error.retryable,false);
  assert.equal((await request('/v1/audio/jobs/unknown')).status,404);
  checks.push('structured HTTP errors and unknown resource handling');
  await assert.rejects(()=>createAudioApi({root,dataDir:path.join(temporary,'invalid'),env:{GAME_AUDIO_HOST:'0.0.0.0'}}),/requires/);
  checks.push('public listener refuses missing authentication');
}finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await api.close();await fs.rm(temporary,{recursive:true,force:true});}
console.log(JSON.stringify({pass:true,checks},null,2));
