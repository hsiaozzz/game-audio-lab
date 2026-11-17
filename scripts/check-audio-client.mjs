import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {createAudioServiceClient,configureAudioMemoryCache,sha256,verifyManifest} from '../src/audio-service-client.mjs';
import {createAudioPackagePlayer} from '../src/audio-package-player.mjs';
import {exportAudioPackageZip} from '../src/audio-package-export.mjs';

const encode=value=>new TextEncoder().encode(value);
const canonical=value=>value===null||typeof value!=='object'?JSON.stringify(value):Array.isArray(value)?'['+value.map(canonical).join(',')+']':'{'+Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+canonical(value[key])).join(',')+'}';
const identity={projectId:'sdk-fixture',revision:3,briefHash:'a'.repeat(64),contractVersion:1,contractHash:'b'.repeat(64)};
const tests=[];
const test=(name,run)=>tests.push({name,run});
const routes=new Map();let fetchCount=0,mediaFetchCount=0;
const fetchImpl=async(url,options={})=>{
  fetchCount++;if(options.signal?.aborted)throw new DOMException('Aborted','AbortError');
  const fixture=routes.get(url.pathname);
  if(fixture instanceof ArrayBuffer){mediaFetchCount++;return new Response(fixture.slice(0),{headers:{'Content-Length':String(fixture.byteLength)}});}
  if(typeof fixture==='function')return fixture(url,options);
  return fixture?Response.json(fixture):Response.json({error:{code:'not-found',message:'Missing fixture',retryable:false}},{status:404});
};
function audioBuffer(length=16,sampleRate=48000,channels=1){const data=Array.from({length:channels},()=>new Float32Array(length));return{length,sampleRate,numberOfChannels:channels,duration:length/sampleRate,getChannelData:channel=>data[channel],copyToChannel(values,channel){data[channel].set(values);}};}
function decoder({length=16,sampleRate=48000,channels=1}={}){let count=0;return{sampleRate,get count(){return count;},async decodeAudioData(){count++;return audioBuffer(length,sampleRate,channels);},createBuffer:(channels,length,rate)=>audioBuffer(length,rate,channels)};}
async function fixture(name,{music=false,spatial=false,frames=16,channels=1,byteLength=4,tag=1}={}){
  const bytes=Uint8Array.from({length:byteLength},(_,index)=>(index+tag)%256).buffer;
  const file={id:name,path:`media/${name}.ogg`,sha256:await sha256(bytes),bytes:bytes.byteLength,mimeType:'audio/ogg',formatId:'opus-ogg',sampleRate:48000,channels,frames,decodedPcmBytes:frames*channels*4,trim:{referenceSampleRate:48000,masterFrames:frames,leadingPaddingFrames:0}};
  const provenanceBytes=encode('Fixture provenance. No actual music assets.').buffer,provenance={id:'licenses',path:'provenance/LICENSES.txt',sha256:await sha256(provenanceBytes),bytes:provenanceBytes.byteLength,mimeType:'text/plain',kind:'provenance',decodedPcmBytes:0};
  const core={schemaVersion:1,identity,planId:'plan-fixture',planDigest:'c'.repeat(64),selectionDigest:'d'.repeat(64),files:[file,provenance],sfx:{pickup:{eventId:'item.collect',variants:[file.id],maxRatePerSecond:2,spatial:{enabled:spatial,refDistance:1,maxDistance:100,rolloffFactor:1,distanceModel:'inverse'}}},music:music?{exploration:{stemFileIds:[file.id],stemRoles:{[file.id]:'core'},stemGainDb:{[file.id]:-6},loop:{enabled:true,referenceSampleRate:48000,startFrame:0,endFrame:frames}}}:{},provenance:{licensesPath:provenance.path},quality:{technical:'fixture-only'}};
  const manifest={...core,packageId:await sha256(encode(canonical(core)))},manifestUrl=`/v1/audio/packages/${manifest.packageId}/manifest`,root=manifestUrl.replace(/\/manifest$/,'/files/');
  routes.set(manifestUrl,manifest);routes.set(root+file.path,bytes);routes.set(root+provenance.path,provenanceBytes);
  return{manifest,file,bytes,manifestUrl,fileUrl:root+file.path};
}
function fakeContext(){
  const gains=[],sources=[],panners=[],param=()=>({value:0,setTargetAtTime(value){this.value=value;},setValueAtTime(value){this.value=value;}}),node=()=>({connected:false,connect(){this.connected=true;},disconnect(){this.connected=false;}});
  return{state:'running',currentTime:0,sampleRate:48000,destination:{},gains,sources,panners,listener:Object.fromEntries(['positionX','positionY','positionZ','forwardX','forwardY','forwardZ','upX','upY','upZ'].map(key=>[key,param()])),resume:async()=>{},close:async()=>{},createGain(){const value={...node(),gain:param()};gains.push(value);return value;},createStereoPanner(){return{...node(),pan:param()};},createPanner(){const value={...node(),positionX:param(),positionY:param(),positionZ:param()};panners.push(value);return value;},createBufferSource(){const value={...node(),start(...args){this.started=args;},stop(){this.stopped=true;},finish(){this.onended?.();}};sources.push(value);return value;}};
}
const client=createAudioServiceClient({baseUrl:'https://sdk.test',token:'fixture-secret-not-for-export',fetchImpl});
let primary,primaryBundle;

test('manifest digest, design identity and package URL reject mismatches',async()=>{
  primary=await fixture('primary',{music:true,spatial:true});
  await verifyManifest(primary.manifest,{expectedIdentity:identity});
  await assert.rejects(verifyManifest({...primary.manifest,quality:{tampered:true}}),error=>error.code==='manifest-digest-mismatch');
  await assert.rejects(client.getManifest(primary.manifestUrl,{expectedIdentity:{...identity,revision:4}}),error=>error.code==='identity-mismatch');
  const wrongUrl='/v1/audio/packages/'+'0'.repeat(64)+'/manifest';routes.set(wrongUrl,primary.manifest);
  await assert.rejects(client.getManifest(wrongUrl),error=>error.code==='manifest-digest-mismatch');
});

test('verified package hashes all files, decodes only audio and trims codec tails',async()=>{
  const context=decoder({length:1040}),before=mediaFetchCount;
  primaryBundle=await client.downloadPackage(primary.manifestUrl,{audioContext:context,decode:true,expectedIdentity:identity,planId:'plan-fixture'});
  assert.equal(primaryBundle.verified,true);assert.equal(primaryBundle.files.size,2);assert.equal(primaryBundle.decoded.size,1);assert.equal(context.count,1);assert.equal(primaryBundle.decoded.get(primary.file.id).length,16);assert.equal(mediaFetchCount-before,2);
  const beforeCached=mediaFetchCount;await client.downloadPackage(primary.manifestUrl,{audioContext:context});assert.equal(mediaFetchCount,beforeCached);assert.equal(context.count,1);
});

test('encoded and declared PCM budgets reject before media transfer',async()=>{
  const before=mediaFetchCount;
  await assert.rejects(client.downloadPackage(primary.manifestUrl,{transferBudget:1}),error=>error.code==='transfer-budget-exceeded');
  await assert.rejects(client.downloadPackage(primary.manifestUrl,{decodedBudget:1}),error=>error.code==='pcm-budget-exceeded');
  assert.equal(mediaFetchCount,before);
});

test('corrupt media, oversized streams and truncated decode fail closed',async()=>{
  const corrupt=await fixture('corrupt',{tag:55});routes.set(corrupt.fileUrl,new Uint8Array([9,9,9,9]).buffer);
  await assert.rejects(client.downloadPackage(corrupt.manifestUrl),error=>error.code==='hash-mismatch');
  const oversized=await fixture('oversized',{tag:66});routes.set(oversized.fileUrl,new Uint8Array(100).buffer);
  await assert.rejects(client.downloadPackage(oversized.manifestUrl),error=>error.code==='transfer-budget-exceeded');
  const short=await fixture('short',{tag:77,frames:128});
  await assert.rejects(client.downloadPackage(short.manifestUrl,{audioContext:decoder({length:16})}),error=>error.code==='truncated-audio');
});

test('browser resampling is checked against actual PCM memory',async()=>{
  const resampled=await fixture('resampled',{tag:78,frames:16});
  await assert.rejects(client.downloadPackage(resampled.manifestUrl,{audioContext:decoder({length:32,sampleRate:96000}),decodedBudget:100}),error=>error.code==='pcm-budget-exceeded');
});

test('actual decoder probe falls back from Opus to AAC without playing',async()=>{
  const attempts=[],context={sampleRate:44117,async decodeAudioData(bytes){const magic=String.fromCharCode(...new Uint8Array(bytes).slice(0,4));attempts.push(magic);if(magic==='OggS')throw Error('Unsupported fixture codec');return audioBuffer();}};
  const result=await client.probeFormats({audioContext:context,formats:[{id:'opus-ogg'},{id:'aac-lc-m4a'}]});
  assert.deepEqual(result.acceptedFormats,['aac-lc-m4a']);assert.equal(attempts.length,2);assert.equal(result.results[0].probe,'native-decodeAudioData');
});

test('partial-ready terminates polling and retry preserves the original confirmation',async()=>{
  const original={id:'partial',jobId:'partial',status:'partial-ready',planId:'plan-fixture',planDigest:'plan-digest',identity,selectionDigest:'select',acceptedItems:['pickup'],delivery:{profile:'compact-opus-v1'},allSelectedReady:false,requiredReady:false};
  routes.set('/v1/audio/jobs/partial',{job:original});let submitted;
  routes.set('/v1/audio/jobs/partial/retry',(_url,options)=>{submitted={headers:options.headers,body:JSON.parse(options.body)};return Response.json({job:{...original,id:'retry'}});});
  const completed=await client.waitForJob('partial',{intervalMs:1,timeoutMs:100});assert.equal(completed.status,'partial-ready');
  await client.retryJob('partial',{idempotencyKey:'fixed-retry-key',retryItems:['pickup']});assert.deepEqual(submitted.body,{planId:original.planId,planDigest:original.planDigest,identity,acceptedItems:original.acceptedItems,delivery:original.delivery,retryItems:['pickup']});assert.equal(submitted.headers['Idempotency-Key'],'fixed-retry-key');
});

test('a host can recover and review the stored delivery plan',async()=>{
  const stored={schemaVersion:1,kind:'audio-delivery-plan',planId:'plan-stored',planDigest:'stored-digest',identity,items:[],delivery:{profile:'compact-opus-v1'}};routes.set('/v1/audio/plans/plan-stored',{plan:stored});assert.deepEqual(await client.getPlan('plan-stored'),stored);
});

test('a verified partial package upgrades to music while local playback performs zero requests',async()=>{
  const context=fakeContext(),player=createAudioPackagePlayer({audioContext:context,maxVoices:1}),before=fetchCount;
  const partialManifest={...primary.manifest,music:{}};const{packageId,...partialCore}=partialManifest;partialManifest.packageId=await sha256(encode(canonical(partialCore)));
  assert.equal(player.load({...primaryBundle,manifest:partialManifest}).accepted,true);assert.equal(player.play('item.collect').reason,'locked');await player.unlock();assert.equal(player.play('item.collect').accepted,true);
  assert.equal(player.load(primaryBundle).accepted,true);assert.equal(player.music.play('exploration').accepted,true);assert.ok(Math.abs(context.gains.at(-1).gain.value-.9*10**(-6/20))<1e-10);
  assert.equal(player.play('item.collect').reason,'rate-limited');context.currentTime=1;assert.equal(player.play('item.collect').reason,'voice-budget');context.sources[0].finish();assert.equal(player.play('item.collect').accepted,true);
  player.pause();assert.equal(player.getState().activeVoices,0);assert.equal(player.play('item.collect').reason,'paused');await player.resume();assert.equal(player.getState().musicPlaying,true);player.mute(true);assert.equal(player.getState().muted,true);player.stop();assert.equal(player.getState().musicSources,0);
  await player.dispose();assert.equal(player.play('item.collect').reason,'disposed');assert.equal(fetchCount,before);
});

test('spatial playback is opt-in and listener positions reach the Web Audio graph',async()=>{
  const context=fakeContext(),player=createAudioPackagePlayer({audioContext:context});player.load(primaryBundle);await player.unlock();assert.equal(player.setListener({position:{x:2,y:0,z:0}}).accepted,true);assert.equal(context.listener.positionX.value,2);
  assert.equal(player.play('item.collect',{position:{x:1,y:0,z:-4}}).accepted,true);assert.equal(context.panners[0].panningModel,'HRTF');assert.equal(context.panners[0].positionZ.value,-4);assert.equal(context.panners[0].refDistance,1);
  assert.equal(player.play('item.collect',{position:{x:NaN,y:0,z:0}}).reason,'invalid-position');await player.dispose();
});

test('stop cancels a resume waiting on AudioContext without starting late music',async()=>{
  const context=fakeContext(),player=createAudioPackagePlayer({audioContext:context});player.load(primaryBundle);await player.unlock();player.music.play('exploration');player.pause();let release;context.resume=()=>new Promise(resolve=>{release=resolve;});const pending=player.resume();player.stop();release();assert.equal((await pending).reason,'cancelled');assert.equal(player.getState().musicPlaying,false);await player.dispose();
});

test('shared caches enforce encoded and decoded byte caps with LRU eviction',async()=>{
  client.clearMemoryCache();configureAudioMemoryCache({maxEncodedBytes:8,maxDecodedBytes:128});
  const make=async(index)=>{const value=await fixture('lru'+index,{tag:100+index});const{packageId,...core}=value.manifest;core.files=[value.file];delete core.provenance;value.manifest={...core,packageId:await sha256(encode(canonical(core)))};value.manifestUrl=`/lru${index}/manifest`;routes.set(value.manifestUrl,value.manifest);routes.set(`/lru${index}/files/${value.file.path}`,value.bytes);return value;};
  const values=await Promise.all([1,2,3].map(make)),context=decoder(),read=value=>client.downloadPackage(value.manifestUrl,{audioContext:context});
  const before=mediaFetchCount;await read(values[0]);await read(values[1]);await read(values[0]);assert.equal(mediaFetchCount-before,2);assert.equal(context.count,2);await read(values[2]);assert.equal(client.cacheStats.files,2);assert.equal(client.cacheStats.decoded,2);assert.equal(client.cacheStats.encodedBytes,8);assert.equal(client.cacheStats.decodedBytes,128);await read(values[1]);assert.equal(mediaFetchCount-before,4);assert.equal(context.count,4);
  configureAudioMemoryCache({maxEncodedBytes:0,maxDecodedBytes:0});assert.equal(client.cacheStats.encodedBytes,0);assert.equal(client.cacheStats.decodedBytes,0);await read(values[0]);assert.equal(client.cacheStats.files,0);assert.equal(client.cacheStats.decoded,0);configureAudioMemoryCache();
});

test('disposed client rejects every operation including cached manifest and media paths',async()=>{
  const target=createAudioServiceClient({baseUrl:'https://sdk.test',fetchImpl});await target.getManifest(primary.manifestUrl);await target.dispose();const before=fetchCount;
  for(const operation of [
    ()=>target.request('/anything'),()=>target.getHealth(),()=>target.getCapabilities(),()=>target.createPlan({}),()=>target.getPlan('plan'),()=>target.submitJob(undefined),()=>target.getJob('job'),()=>target.cancelJob('job'),()=>target.retryJob('job'),()=>target.waitForJob('job'),()=>target.getManifest(primary.manifestUrl),()=>target.downloadPackage(primary.manifest,{fileBaseUrl:new URL(primary.manifestUrl.replace(/\/manifest$/,'/files/'),'https://sdk.test')}),()=>target.decodePackage(primaryBundle,decoder()),()=>target.probeFormats({audioContext:decoder(),formats:[{id:'opus-ogg'}]})
  ])await assert.rejects(operation,error=>error.code==='client-disposed');
  assert.throws(()=>target.clearMemoryCache(),error=>error.code==='client-disposed');await target.dispose();assert.equal(fetchCount,before);
});

test('client disposal aborts its owned in-flight fetch and ignores a late token provider',async()=>{
  let started,observed;const began=new Promise(resolve=>{started=resolve;}),target=createAudioServiceClient({baseUrl:'https://abort.test',fetchImpl:(_url,{signal})=>new Promise((_resolve,reject)=>{observed=signal;signal.addEventListener('abort',()=>reject(new DOMException('Aborted','AbortError')),{once:true});started();})}),pending=target.getHealth();await began;const rejected=assert.rejects(pending,error=>error.code==='client-disposed');await target.dispose();await rejected;assert.equal(observed.aborted,true);
  let releaseToken,tokenStarted,requests=0;const tokenBegan=new Promise(resolve=>{tokenStarted=resolve;}),late=createAudioServiceClient({baseUrl:'https://abort.test',token:()=>new Promise(resolve=>{releaseToken=resolve;tokenStarted();}),fetchImpl:async()=>{requests++;return Response.json({});}}),inFlight=late.getHealth();await tokenBegan;await late.dispose();releaseToken('not-sent');await assert.rejects(inFlight,error=>error.code==='client-disposed');assert.equal(requests,0);
});

test('codec results arriving after dispose do not populate caches or produce a bundle',async()=>{
  client.clearMemoryCache();let release,decodeStarted,trimCalls=0;const began=new Promise(resolve=>{decodeStarted=resolve;}),context={sampleRate:44123,decodeAudioData:()=>new Promise(resolve=>{release=resolve;decodeStarted();}),createBuffer(){trimCalls++;return audioBuffer();}},target=createAudioServiceClient({baseUrl:'https://sdk.test',fetchImpl}),pending=target.decodePackage(primaryBundle,context);await began;const before=client.cacheStats.decoded;await target.dispose();release(audioBuffer(1040,44123));await assert.rejects(pending,error=>error.code==='client-disposed');assert.equal(trimCalls,0);assert.equal(client.cacheStats.decoded,before);
  let releaseProbe,probeStarted;const probeBegan=new Promise(resolve=>{probeStarted=resolve;}),probeContext={sampleRate:44129,decodeAudioData:()=>new Promise(resolve=>{releaseProbe=resolve;probeStarted();})},probeClient=createAudioServiceClient({baseUrl:'https://sdk.test',fetchImpl}),probePending=probeClient.probeFormats({audioContext:probeContext,formats:[{id:'opus-ogg'}]});await probeBegan;await probeClient.dispose();releaseProbe(audioBuffer());await assert.rejects(probePending,error=>error.code==='client-disposed');let retried=0;await client.probeFormats({audioContext:{sampleRate:44129,decodeAudioData:async()=>{retried++;return audioBuffer();}},formats:[{id:'opus-ogg'}]});assert.equal(retried,1,'Disposed probe result must not be reused');
});

test('caller abort also rejects cached loads and discards a late codec result',async()=>{
  client.clearMemoryCache();const cancelled=new AbortController();cancelled.abort();await assert.rejects(client.getManifest(primary.manifestUrl,{signal:cancelled.signal}),error=>error.code==='aborted');await assert.rejects(client.downloadPackage(primary.manifest,{fileBaseUrl:'https://sdk.test/files/',signal:cancelled.signal}),error=>error.code==='aborted');
  let release,started;const began=new Promise(resolve=>{started=resolve;}),controller=new AbortController(),context={sampleRate:44133,decodeAudioData:()=>new Promise(resolve=>{release=resolve;started();}),createBuffer(){throw Error('An aborted decode must not trim or allocate');}},pending=client.decodePackage(primaryBundle,context,{signal:controller.signal});await began;controller.abort();release(audioBuffer(1040,44133));await assert.rejects(pending,error=>error.code==='aborted');assert.equal(client.cacheStats.decoded,0);
});

test('dispose during a download callback prevents further files and polling stops promptly',async()=>{
  const target=createAudioServiceClient({baseUrl:'https://sdk.test',fetchImpl});let callbacks=0;await assert.rejects(target.downloadPackage(primary.manifestUrl,{onProgress(){callbacks++;void target.dispose();}}),error=>error.code==='client-disposed');assert.equal(callbacks,1);
  routes.set('/v1/audio/jobs/polling',{job:{id:'polling',status:'rendering',allSelectedReady:false,requiredReady:false}});let updated;const began=new Promise(resolve=>{updated=resolve;}),polling=createAudioServiceClient({baseUrl:'https://sdk.test',fetchImpl}),pending=polling.waitForJob('polling',{intervalMs:30000,onUpdate:()=>updated()});await began;await new Promise(resolve=>setTimeout(resolve,0));const rejected=assert.rejects(pending,error=>error.code==='client-disposed');await polling.dispose();await Promise.race([rejected,new Promise((_resolve,reject)=>setTimeout(()=>reject(Error('Disposed polling did not stop promptly')),300))]);
});

function crc32(bytes){let crc=0xffffffff;for(const value of bytes){crc^=value;for(let bit=0;bit<8;bit++)crc=(crc&1)?0xedb88320^(crc>>>1):crc>>>1;}return(crc^0xffffffff)>>>0;}
function inspectZip(bytes){
  const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength),end=bytes.byteLength-22;assert.equal(view.getUint32(end,true),0x06054b50);const count=view.getUint16(end+10,true),directorySize=view.getUint32(end+12,true),start=view.getUint32(end+16,true),files=new Map();let cursor=start;
  for(let index=0;index<count;index++){
    assert.equal(view.getUint32(cursor,true),0x02014b50);assert.equal(view.getUint16(cursor+10,true),0);const crc=view.getUint32(cursor+16,true),size=view.getUint32(cursor+24,true),nameLength=view.getUint16(cursor+28,true),extraLength=view.getUint16(cursor+30,true),commentLength=view.getUint16(cursor+32,true),local=view.getUint32(cursor+42,true),name=new TextDecoder().decode(bytes.subarray(cursor+46,cursor+46+nameLength));assert.equal(view.getUint32(local,true),0x04034b50);assert.equal(view.getUint32(local+14,true),crc);assert.equal(view.getUint32(local+22,true),size);const offset=local+30+view.getUint16(local+26,true)+view.getUint16(local+28,true),content=bytes.subarray(offset,offset+size);assert.equal(crc32(content),crc,`CRC mismatch: ${name}`);files.set(name,content);cursor+=46+nameLength+extraLength+commentLength;
  }
  assert.equal(cursor-start,directorySize);assert.equal(cursor,end);return files;
}

test('ZIP central directory, all CRCs, verified media and standalone runtime are valid',async()=>{
  const clientModule=await fs.readFile(new URL('../src/audio-service-client.mjs',import.meta.url),'utf8'),playerModule=await fs.readFile(new URL('../src/audio-package-player.mjs',import.meta.url),'utf8'),blob=await exportAudioPackageZip(primaryBundle,{clientModule,playerModule}),contents=inspectZip(new Uint8Array(await blob.arrayBuffer()));
  assert.equal(blob.type,'application/zip');for(const path of ['index.html','manifest.json','README.txt','runtime/audio-service-client.mjs','runtime/audio-package-player.mjs',...primary.manifest.files.map(file=>'files/'+file.path)])assert.ok(contents.has(path),path);
  const localManifest=JSON.parse(new TextDecoder().decode(contents.get('manifest.json')));assert.equal(localManifest.packageId,primary.manifest.packageId);for(const file of primary.manifest.files)assert.equal(await sha256(contents.get('files/'+file.path)),file.sha256);
  for(const content of contents.values())assert.equal(new TextDecoder().decode(content).includes('fixture-secret-not-for-export'),false);
  const html=new TextDecoder().decode(contents.get('index.html'));assert.ok(html.includes('./runtime/audio-package-player.mjs'));assert.equal(html.includes('127.0.0.1'),false);assert.equal(html.includes('Tone.js'),false);
  const forged={...primaryBundle,files:new Map(primaryBundle.files)};forged.files.set(primary.file.id,new Uint8Array([9,9,9,9]).buffer);await assert.rejects(exportAudioPackageZip(forged,{clientModule,playerModule}),error=>error.code==='hash-mismatch');
});

let passed=0;
try{for(const entry of tests){await entry.run();passed++;console.log(`PASS ${entry.name}`);}console.log(`Audio media client: ${passed} checks passed.`);}
finally{configureAudioMemoryCache();client.clearMemoryCache();await client.dispose();}
