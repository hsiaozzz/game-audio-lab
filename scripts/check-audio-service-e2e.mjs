import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { digest } from '../server/audio-plan.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const temporary=await fs.mkdtemp(path.join(os.tmpdir(),'game-audio-real-e2e-'));
const report={schemaVersion:1,createdAt:new Date().toISOString(),purpose:'Real service generation, encoding, delivery, persistent cache and restart checks; no subjective audio-quality claim.',checks:[],pass:false};
report.sourceHashes=Object.fromEntries(await Promise.all(['server/audio-plan.mjs','server/audio-jobs.mjs','server/audio-api.mjs','server/audio-director.mjs','server/audio-renderer.mjs','server/audio-media.mjs','src/audio-engine.mjs','src/game-audio-pipeline.mjs','src/service-render-worker.mjs','scripts/server.mjs'].map(async file=>[file,createHash('sha256').update(await fs.readFile(path.join(root,file))).digest('hex')])));
let child,origin;
async function start(){
  child=spawn(process.execPath,['scripts/server.mjs'],{cwd:root,env:{...process.env,GAME_AUDIO_PORT:'0',GAME_AUDIO_HOST:'127.0.0.1',GAME_AUDIO_DATA_DIR:temporary,GAME_AUDIO_CACHE_DIR:path.join(temporary,'render-cache'),GAME_AUDIO_DIRECTOR_PROVIDER:'local',GAME_AUDIO_DIRECTOR_MODULE:'',GAME_AUDIO_API_TOKEN:'',GAME_AUDIO_API_TOKENS_JSON:''},windowsHide:true,stdio:['ignore','pipe','pipe']});
  origin=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Service startup timeout')),15000);child.once('error',reject);child.once('exit',code=>{clearTimeout(timer);reject(new Error('Service exited '+code));});child.stderr.on('data',chunk=>process.stderr.write(chunk));child.stdout.on('data',chunk=>{const match=String(chunk).match(/http:\/\/127\.0\.0\.1:\d+/);if(match){clearTimeout(timer);resolve(match[0]);}});});
}
async function stop(){if(child&&child.exitCode===null){const done=once(child,'exit');child.kill();await done;}}
async function api(route,body,key){const response=await fetch(origin+route,{method:body===undefined?'GET':'POST',headers:body===undefined?{}:{'Content-Type':'application/json',...(key?{'Idempotency-Key':key}:{})},body:body===undefined?undefined:JSON.stringify(body)});const result=await response.json();if(!response.ok)throw new Error(`HTTP ${response.status}: ${JSON.stringify(result)}`);return result;}
async function waitJob(jobId){const started=Date.now();let last;while(Date.now()-started<180000){const {job}=await api('/v1/audio/jobs/'+jobId);if(job.status!==last){console.log('job '+jobId+' '+job.status);last=job.status;}if(['ready','partial-ready','failed','cancelled'].includes(job.status))return job;await new Promise(resolve=>setTimeout(resolve,350));}throw new Error('Rendering exceeded three-minute e2e deadline');}
function requestFor(plan){return{planId:plan.planId,planDigest:plan.planDigest,identity:plan.identity,acceptedItems:plan.items.filter(item=>item.required).map(item=>item.id),delivery:plan.delivery};}
async function verifyPackage(job){
  const manifest=await api(job.manifestUrl||job.packageUrl),{packageId,...core}=manifest;
  assert.equal(packageId,digest(core));
  for(const file of manifest.files){
    const base=`/v1/audio/packages/${packageId}/files/${file.path.split('/').map(encodeURIComponent).join('/')}`;
    const response=await fetch(origin+base),bytes=Buffer.from(await response.arrayBuffer());assert(response.ok);assert.equal(bytes.length,file.bytes);assert.equal(createHash('sha256').update(bytes).digest('hex'),file.sha256);
    const head=await fetch(origin+base,{method:'HEAD'});assert.equal(Number(head.headers.get('Content-Length')),bytes.length);
    const range=await fetch(origin+base,{headers:{Range:'bytes=0-15'}});assert.equal(range.status,206);assert.equal((await range.arrayBuffer()).byteLength,Math.min(16,bytes.length));
  }
  return manifest;
}
try{
  await start();
  const health=await api('/v1/audio/health');assert.notEqual(health.renderer.ready,false);report.checks.push('real Chromium and FFmpeg health preflight');
  const input=JSON.parse(await fs.readFile(path.join(root,'examples/audio-service-request.json'),'utf8'));input.gameBrief.prompt='霓虹动作收集游戏，电子合成器背景音乐和清晰的拾取声音';input.audioRequests[0].variants=1;
  const optional={id:'sfx.player.hit',kind:'sfx',eventId:'player.hit',required:false,variants:1};input.audioRequests.push(optional);
  const {plan}=await api('/v1/audio/plans',input);report.planId=plan.planId;
  assert.equal((await api('/v1/audio/plans/'+plan.planId)).plan.planDigest,plan.planDigest);
  const request=requestFor(plan),submitted=await api('/v1/audio/jobs',request,'real-e2e-primary');
  const replay=await api('/v1/audio/jobs',request,'real-e2e-primary');assert.equal(replay.job.jobId||replay.job.id,submitted.job.jobId||submitted.job.id);report.checks.push('plan persistence and idempotent confirmation');
  const job=await waitJob(submitted.job.jobId||submitted.job.id);assert.equal(job.status,'ready',JSON.stringify(job));
  const manifest=await verifyPackage(job);assert(!manifest.sfx[optional.id]);assert.equal(Object.keys(manifest.music).length,1);assert.equal(Object.keys(manifest.sfx).length,1);assert(manifest.files.filter(file=>file.mimeType.startsWith('audio/')).every(file=>file.formatId==='opus-ogg'));
  report.checks.push('selected SFX and real BGM generated into Opus package without unselected audio','immutable manifest hash and binary bytes/hash/HEAD/Range verification');
  report.opus={packageId:manifest.packageId,files:manifest.files.filter(file=>file.mimeType.startsWith('audio/')).map(({id,bytes,frames,sampleRate,channels,formatId})=>({id,bytes,frames,sampleRate,channels,formatId}))};
  const cached=await api('/v1/audio/jobs',request,'real-e2e-cache');const cachedJob=await waitJob(cached.job.jobId||cached.job.id);assert.equal(cachedJob.status,'ready');assert(cachedJob.components.every(item=>item.cacheHit===true));report.checks.push('second task reuses persistent media cache');report.cacheComponents=cachedJob.components.map(({id,status,cacheHit})=>({id,status,cacheHit}));
  await stop();await start();const restored=await api('/v1/audio/jobs/'+(job.jobId||job.id));assert.equal(restored.job.status,'ready');await verifyPackage(restored.job);report.checks.push('completed task and package survive process restart');
  const aacInput=structuredClone(input);aacInput.delivery.acceptedFormats=['aac-lc-m4a'];const aacPlan=(await api('/v1/audio/plans',aacInput)).plan;
  const aacSubmitted=await api('/v1/audio/jobs',requestFor(aacPlan),'real-e2e-aac');const aacJob=await waitJob(aacSubmitted.job.jobId||aacSubmitted.job.id);assert.equal(aacJob.status,'ready',JSON.stringify(aacJob));const aacManifest=await verifyPackage(aacJob);assert(aacManifest.files.filter(file=>file.mimeType.startsWith('audio/')).every(file=>file.formatId==='aac-lc-m4a'));report.checks.push('AAC-LC fallback produces a distinct verified package using real masters');
  report.aac={packageId:aacManifest.packageId,files:aacManifest.files.filter(file=>file.mimeType.startsWith('audio/')).map(({id,bytes,frames,sampleRate,channels,formatId})=>({id,bytes,frames,sampleRate,channels,formatId}))};
  report.pass=true;
}catch(error){report.error=String(error.stack||error);process.exitCode=1;}
finally{
  await stop();await fs.mkdir(path.join(root,'artifacts'),{recursive:true});await fs.writeFile(path.join(root,'artifacts/service-e2e-validation.json'),JSON.stringify(report,null,2));
  await fs.rm(temporary,{recursive:true,force:true});console.log(JSON.stringify(report,null,2));
}
