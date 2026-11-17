import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash, randomBytes } from 'node:crypto';
import { canonicalJson } from '../src/game-audio-pipeline.mjs';

export const MEDIA_RENDERER_VERSION='native-web-audio-service-v1';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const masterJobs=new Map();
const sha256=bytes=>createHash('sha256').update(bytes).digest('hex');
export const audioDataDirectory=()=>path.resolve(process.env.GAME_AUDIO_DATA_DIR||path.join(root,'.data/audio-service'));
export function mediaError(code,message,{retryable=false,status=422}={}){return Object.assign(new Error(message),{code,retryable,status});}
export function throwIfAborted(signal){if(signal?.aborted)throw mediaError('cancelled','Audio media task was cancelled',{status:499});}
function abortable(promise,signal){
 throwIfAborted(signal);if(!signal)return promise;
 return new Promise((resolve,reject)=>{const abort=()=>reject(mediaError('cancelled','Audio media task was cancelled',{status:499}));signal.addEventListener('abort',abort,{once:true});promise.then(resolve,reject).finally(()=>signal.removeEventListener('abort',abort));});
}

/** Shared work owns its signal; a caller only owns its subscription. */
export function subscribeMediaTask(jobs,key,start,signal){
 throwIfAborted(signal);
 let entry=jobs.get(key);
 // Let an abandoned worker finish cleaning its cache directory before restarting it.
 if(entry?.controller.signal.aborted)return abortable(entry.promise.catch(()=>{}),signal).then(()=>subscribeMediaTask(jobs,key,start,signal));
 if(!entry){
  entry={controller:new AbortController(),subscribers:0,settled:false};
  const task=entry;
  task.promise=Promise.resolve().then(()=>{throwIfAborted(task.controller.signal);return start(task.controller.signal);}).finally(()=>{task.settled=true;if(jobs.get(key)===task)jobs.delete(key);});
  jobs.set(key,task);
 }
 entry.subscribers++;
 return new Promise((resolve,reject)=>{
  let released=false;
  const release=()=>{
   if(released)return false;released=true;signal?.removeEventListener('abort',abort);entry.subscribers--;
   if(!entry.settled&&entry.subscribers===0)entry.controller.abort();
   return true;
  };
  const abort=()=>{if(release())reject(mediaError('cancelled','Audio media task was cancelled',{status:499}));};
  entry.promise.then(value=>{if(release())resolve(value);},error=>{if(release())reject(error);});
  signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
 });
}

async function playwright(){
 try{return await import(process.env.GAME_AUDIO_PLAYWRIGHT?pathToFileURL(path.resolve(process.env.GAME_AUDIO_PLAYWRIGHT)).href:'playwright');}
 catch{throw mediaError('renderer-unavailable','Install this project\'s Playwright dependency and its Chromium browser before rendering.',{status:503});}
}
export async function inspectRendererDependencies(){
 try{const {chromium}=await playwright();await fs.access(chromium.executablePath());return{available:true,renderer:MEDIA_RENDERER_VERSION,browser:'playwright-chromium',nativeWebAudio:true};}
 catch(error){return{available:false,renderer:MEDIA_RENDERER_VERSION,code:error.code==='ENOENT'?'chromium-unavailable':error.code||'renderer-unavailable',message:error.message,retryable:false};}
}

function relativeAsset(url){
 const relative=String(url).replace(/^\/+/,''),absolute=path.resolve(root,relative);
 if(!absolute.startsWith(path.join(root,'assets')+path.sep))throw mediaError('invalid-asset','Sound bank contains an unsafe asset path');
 return{relative,absolute};
}
async function dependencies(sourcePlan,item,mode){
 const manifestBytes=await fs.readFile(path.join(root,'assets/manifest.json')),manifest=JSON.parse(manifestBytes.toString('utf8'));
 const selected={schemaVersion:manifest.schemaVersion,samples:[],instruments:{}},assets=[];
 const files={};
 async function include(sample){
  const{relative,absolute}=relativeAsset(sample.url),bytes=await fs.readFile(absolute),digest=sha256(bytes);
  if(sample.sha256&&digest!==sample.sha256)throw mediaError('asset-integrity-error','Prepared asset differs from its recorded SHA-256: '+relative,{status:500});
  files[sample.url]=bytes.toString('base64');
  assets.push({path:relative,sha256:digest,bytes:bytes.length,source:sample.source??null,sourceFile:sample.sourceFile??sample.note??null,license:sample.license||'CC0-1.0'});
 }
 if(mode==='hybrid'&&item.kind==='sfx'){
  const sample=manifest.samples.find(sample=>sample.id===item.cue);
  if(sample){selected.samples.push(sample);await include(sample);}
 }
 if(mode==='hybrid'&&item.kind==='music'&&sourcePlan.score.tracks.some(track=>track.instrument==='marimba')){
  const instrument=manifest.instruments?.marimbaSampled;if(!instrument)throw mediaError('asset-unavailable','Prepared marimba instrument is unavailable',{status:503});
  selected.instruments.marimbaSampled=instrument;
  for(const sample of instrument.samples||[])await include({...sample,license:instrument.license||'CC0-1.0'});
  for(const url of Object.values(instrument.urls||{}))if(!files[url])throw mediaError('asset-unavailable','Prepared instrument lacks source provenance: '+url,{status:503});
 }
 const engineBytes=await fs.readFile(path.join(root,'src/audio-engine.mjs')),toneBytes=await fs.readFile(path.join(root,'vendor/Tone.js')),workerBytes=await fs.readFile(path.join(root,'src/service-render-worker.mjs'));
 return{bank:{manifest:selected,files},assets,engineBytes,toneBytes,workerBytes,engineSha256:sha256(engineBytes),toneSha256:sha256(toneBytes),workerSha256:sha256(workerBytes),manifestSha256:sha256(manifestBytes)};
}

export function validateMediaItem(plan,item){
 const sourcePlan=plan?.sourcePlan;
 if(!sourcePlan?.score||typeof sourcePlan.scoreHash!=='string')throw mediaError('invalid-source-plan','Media renderer requires plan.sourcePlan from createAudioPlan');
 if(!item||typeof item.id!=='string'||!['sfx','music'].includes(item.kind))throw mediaError('invalid-item','A declared media item is required');
 if(item.sampleRate!==48000||![1,2].includes(item.channels))throw mediaError('unsupported-format','Delivery requires 48 kHz and one or two channels');
 if(!['opus-ogg','aac-lc-m4a'].includes(item.formatId))throw mediaError('unsupported-format','Unsupported media format');
 if(!Number.isFinite(item.bitrateKbps)||item.bitrateKbps<16||item.bitrateKbps>256)throw mediaError('unsupported-bitrate','Target bitrate must be between 16 and 256 kbps');
 const mode=item.renderMode??plan.delivery?.renderMode??plan.renderMode??'hybrid';if(!['synth','hybrid'].includes(mode))throw mediaError('unsupported-render-mode','Unsupported renderer mode');
 if(item.kind==='music'){
  if(item.channels!==2||!['mix','stems'].includes(item.playback))throw mediaError('invalid-item','Music requires stereo and mix or stems playback');
  if(!Number.isFinite(sourcePlan.score.duration)||sourcePlan.score.duration<=0||sourcePlan.score.duration>120)throw mediaError('render-budget-exceeded','Music duration must be between 0 and 120 seconds');
 }else{
  if(!Number.isInteger(item.variants)||item.variants<1||item.variants>3)throw mediaError('unsupported-variants','One to three recipe variants are supported');
  if(sourcePlan.bindings?.[item.eventId]?.cue!==item.cue)throw mediaError('binding-mismatch','Requested cue differs from the source event contract');
  if(['victory','failure'].includes(item.cue)&&item.variants>1)throw mediaError('unsupported-variants','This tonal cue has one deterministic recipe, not multiple distinct variants');
  if(mode==='synth'&&['ui','collect','laser'].includes(item.cue)&&item.variants>1)throw mediaError('unsupported-variants','This procedural cue has one recipe; distinct variants require its prepared sample');
 }
 return{sourcePlan,mode};
}

async function descriptor(plan,item){
 const{sourcePlan,mode}=validateMediaItem(plan,item);
 for(const[file,expected]of Object.entries(plan.versions?.sourceHashes||{})){
  if(!['src/audio-engine.mjs','src/composer.mjs','src/director.mjs','assets/manifest.json','vendor/Tone.js','src/service-render-worker.mjs','server/audio-renderer.mjs','server/audio-media.mjs'].includes(file))throw mediaError('stale-renderer','Plan contains an unsupported renderer dependency',{status:409});
  if(sha256(await fs.readFile(path.join(root,file)))!==expected)throw mediaError('stale-renderer','Confirmed renderer source changed; create a new plan before rendering: '+file,{status:409});
 }
 if(sha256(canonicalJson(sourcePlan.score))!==sourcePlan.scoreHash)throw mediaError('score-integrity-error','Source score differs from its plan hash');
 const deps=await dependencies(sourcePlan,item,mode),{chromium}=await playwright();
 const rendererModuleSha256=sha256(await fs.readFile(fileURLToPath(import.meta.url))),mediaModuleSha256=sha256(await fs.readFile(path.join(root,'server/audio-media.mjs')));
 const fingerprint={renderer:MEDIA_RENDERER_VERSION,rendererModuleSha256,mediaModuleSha256,engineSha256:deps.engineSha256,toneSha256:deps.toneSha256,workerSha256:deps.workerSha256,soundBankManifestSha256:deps.manifestSha256,assets:deps.assets.map(({path,sha256})=>({path,sha256})),browserExecutable:chromium.executablePath()};
 // Exclude output codec and semantic labels: one actual PCM can back a new delivery encoding.
 const spec=item.kind==='music'?{kind:'music',scoreHash:sourcePlan.scoreHash,playback:item.playback,loop:item.loop!==false}:{kind:'sfx',cue:item.cue,variants:item.variants,rootMidi:sourcePlan.score.brief.rootMidi,mode:sourcePlan.score.brief.mode};
 const masterKey=sha256(canonicalJson({fingerprint,spec,sampleRate:48000,channels:item.channels,renderMode:mode}));
 return{sourcePlan,mode,deps,masterKey,fingerprint};
}

/** Includes actual engine, renderer, score and relevant prepared-asset hashes. */
export async function mediaItemCacheKey({plan,item}){
 const info=await descriptor(plan,item);
 return sha256(canonicalJson({masterKey:info.masterKey,formatId:item.formatId,bitrateKbps:item.bitrateKbps,channels:item.channels,encodingContract:'ffmpeg-compact-delivery-v1'}));
}

async function cachedMasters(directory){
 try{
  const entry=JSON.parse(await fs.readFile(path.join(directory,'masters.json'),'utf8'));
  for(const output of entry.outputs){if(!/^(mix|core|texture|rhythm|variant-[1-3])\.wav$/.test(output.path))return null;const bytes=await fs.readFile(path.join(directory,output.path));if(sha256(bytes)!==output.sha256)return null;}
  return entry;
 }catch(error){if(error.code==='ENOENT'||error instanceof SyntaxError)return null;throw error;}
}

async function renderFresh(info,item,signal){
 const cacheRoot=path.join(audioDataDirectory(),'cache/masters'),destination=path.join(cacheRoot,info.masterKey);
 await fs.mkdir(cacheRoot,{recursive:true});const staging=await fs.mkdtemp(path.join(cacheRoot,'.render-'));
 const token=randomBytes(24).toString('hex'),allowed=new Set(item.kind==='music'?(item.playback==='stems'?['core','texture','rhythm']:['mix']):Array.from({length:item.variants},(_,index)=>`variant-${index+1}`));
 const uploaded=new Map(),uploads=new Set(),bankBytes=Buffer.from(JSON.stringify(info.deps.bank));
 let browser,server,abortHandler,timeout,combined;
 const mime={'/src/audio-engine.mjs':['text/javascript',info.deps.engineBytes],'/src/service-render-worker.mjs':['text/javascript',info.deps.workerBytes],'/vendor/Tone.js':['text/javascript',info.deps.toneBytes],'/api/sound-bank':['application/json',bankBytes]};
 try{
  server=http.createServer(async(req,res)=>{
   try{
    if(req.method==='GET'&&req.url==='/'){const body=Buffer.from('<!doctype html><meta charset="utf-8"><script src="/vendor/Tone.js"></script>');res.writeHead(200,{'Content-Type':'text/html','Content-Length':body.length});res.end(body);return;}
    if(req.method==='GET'&&mime[req.url]){const[type,body]=mime[req.url];res.writeHead(200,{'Content-Type':type,'Content-Length':body.length,'Cache-Control':'no-store'});res.end(body);return;}
    const match=req.url?.match(new RegExp(`^/_upload/${token}/([a-z0-9-]+)$`));
    if(req.method==='POST'&&match&&allowed.has(match[1])&&!uploaded.has(match[1])&&!uploads.has(match[1])){
     uploads.add(match[1]);const chunks=[];let total=0;
     for await(const chunk of req){throwIfAborted(signal);total+=chunk.length;if(total>100*1024*1024)throw new Error('Master upload exceeds budget');chunks.push(chunk);}
     const bytes=Buffer.concat(chunks),filename=match[1]+'.wav';await fs.writeFile(path.join(staging,filename),bytes,{flag:'wx'});uploaded.set(match[1],{path:filename,bytes:bytes.length,sha256:sha256(bytes)});res.writeHead(200);res.end('saved');return;
    }
    res.writeHead(404);res.end();
   }catch{if(!res.headersSent)res.writeHead(500);res.end('Render resource request failed');}
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  const origin=`http://127.0.0.1:${server.address().port}`;
  throwIfAborted(signal);const{chromium}=await playwright();
  browser=await chromium.launch({headless:true,timeout:30000,args:['--no-sandbox','--disable-background-timer-throttling']});
  const controller=new AbortController();combined=signal?AbortSignal.any([signal,controller.signal]):controller.signal;
  timeout=setTimeout(()=>controller.abort(),Number(process.env.GAME_AUDIO_RENDER_TIMEOUT_MS)||180000);
  abortHandler=()=>{void browser?.close();};combined.addEventListener('abort',abortHandler,{once:true});
  const context=await browser.newContext();await context.route('**/*',route=>route.request().url().startsWith(origin+'/')?route.continue():route.abort());
  const page=await context.newPage();await page.goto(origin,{waitUntil:'load',timeout:15000});
  const result=await abortable(page.evaluate(async request=>{const{renderServiceMasters}=await import('/src/service-render-worker.mjs');return renderServiceMasters(request);},{score:info.sourcePlan.score,item,mode:info.mode,uploadToken:token}),combined);
  throwIfAborted(combined);if(result.outputs.length!==allowed.size||uploaded.size!==allowed.size)throw new Error('Renderer returned an incomplete selected item');
  const outputs=result.outputs.map(output=>{if(!allowed.has(output.id)||!uploaded.has(output.id))throw new Error('Unexpected renderer output');return{...output,...uploaded.get(output.id)};});
  if(item.kind==='sfx'&&new Set(outputs.map(output=>output.sha256)).size!==outputs.length)throw mediaError('unsupported-variants','Recipe produced duplicate variants; distinct variants cannot be claimed');
  const entry={schemaVersion:1,masterKey:info.masterKey,outputs,provenance:{rendererVersion:MEDIA_RENDERER_VERSION,rendererModuleSha256:info.fingerprint.rendererModuleSha256,mediaModuleSha256:info.fingerprint.mediaModuleSha256,engineSha256:info.deps.engineSha256,toneSha256:info.deps.toneSha256,workerSha256:info.deps.workerSha256,soundBankManifestSha256:info.deps.manifestSha256,sourceScoreHash:info.sourcePlan.scoreHash,browserVersion:browser.version(),toneVersion:result.toneVersion,renderMode:info.mode,assets:info.deps.assets}};
  await fs.writeFile(path.join(staging,'masters.json'),JSON.stringify(entry,null,2));
  try{await fs.rename(staging,destination);}catch(error){if(!['EEXIST','ENOTEMPTY','EPERM'].includes(error.code))throw error;const existing=await cachedMasters(destination);if(!existing)throw error;}
  return entry;
 }catch(error){throwIfAborted(signal);if(error.code)throw error;throw mediaError('render-failed',error.message,{retryable:true,status:503});}
 finally{
  clearTimeout(timeout);if(combined&&abortHandler)combined.removeEventListener('abort',abortHandler);
  if(browser)await browser.close().catch(()=>{});
  if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
  await fs.rm(staging,{recursive:true,force:true});
 }
}

export async function renderItemMasters({plan,item,signal}){
 throwIfAborted(signal);const info=await descriptor(plan,item),directory=path.join(audioDataDirectory(),'cache/masters',info.masterKey);
 let entry=await cachedMasters(directory),cacheHit=!!entry;
 if(!entry){
  entry=await subscribeMediaTask(masterJobs,info.masterKey,async sharedSignal=>{await fs.rm(directory,{recursive:true,force:true});throwIfAborted(sharedSignal);return renderFresh(info,item,sharedSignal);},signal);
 }
 throwIfAborted(signal);return{...entry,directory,cacheHit};
}
