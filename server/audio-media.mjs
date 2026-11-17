import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { canonicalJson } from '../src/game-audio-pipeline.mjs';
import { MEDIA_RENDERER_VERSION,audioDataDirectory,mediaError,throwIfAborted,subscribeMediaTask,validateMediaItem,renderItemMasters,mediaItemCacheKey as rendererCacheKey,inspectRendererDependencies } from './audio-renderer.mjs';

export { MEDIA_RENDERER_VERSION };
const encodeJobs=new Map(),toolchains=new Map(),toolchainJobs=new Map();
const sha256=bytes=>createHash('sha256').update(bytes).digest('hex');
const formats={
 'opus-ogg':{extension:'.ogg',mimeType:'audio/ogg; codecs="opus"',container:'ogg',codec:'opus',encoder:'libopus',rateControl:'vbr'},
 'aac-lc-m4a':{extension:'.m4a',mimeType:'audio/mp4; codecs="mp4a.40.2"',container:'mp4',codec:'aac-lc',encoder:'aac',rateControl:'target-bitrate'}
};

/** No shell interpolation: every executable receives an argument array. */
export function runMediaCommand(executable,args,{signal,timeoutMs=60000,maxOutputBytes=128*1024*1024}={}){
 throwIfAborted(signal);
 return new Promise((resolve,reject)=>{
  let child,settled=false,outputBytes=0,diagnosticBytes=0,terminationError;const stdout=[],stderr=[];
  const finish=(error,result)=>{if(settled)return;settled=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);error?reject(error):resolve(result);};
  const terminate=error=>{terminationError=terminationError||error;child?.kill('SIGKILL');};
  const abort=()=>terminate(mediaError('cancelled','Audio media command was cancelled',{status:499}));
  const timer=setTimeout(()=>terminate(mediaError('media-command-timeout','Audio encoding or validation timed out',{status:503,retryable:true})),timeoutMs);
  try{child=spawn(executable,args,{shell:false,windowsHide:true,stdio:['ignore','pipe','pipe']});}
  catch(error){finish(mediaError('encoder-unavailable',error.message,{status:503}));return;}
  signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
  child.stdout.on('data',chunk=>{outputBytes+=chunk.length;if(outputBytes>maxOutputBytes)terminate(mediaError('decode-budget-exceeded','Media command output exceeded the validation memory budget'));else stdout.push(chunk);});
  child.stderr.on('data',chunk=>{diagnosticBytes+=chunk.length;if(diagnosticBytes<=1024*1024)stderr.push(chunk);});
  child.once('error',error=>finish(mediaError('encoder-unavailable',error.message,{status:503})));
  child.once('close',code=>{const diagnostic=Buffer.concat(stderr).toString('utf8');if(terminationError)finish(terminationError);else if(code!==0)finish(mediaError('media-command-failed',`Media tool exited with code ${code}: ${diagnostic.slice(-4000)}`,{status:503,retryable:true}));else finish(null,{stdout:Buffer.concat(stdout),stderr:diagnostic});});
 });
}

export async function getMediaToolchain({signal}={}){
 const ffmpeg=process.env.GAME_AUDIO_FFMPEG||'ffmpeg',ffprobe=process.env.GAME_AUDIO_FFPROBE||'ffprobe',key=ffmpeg+'\n'+ffprobe;
 throwIfAborted(signal);
 if(toolchains.has(key))return toolchains.get(key);
 return subscribeMediaTask(toolchainJobs,key,async sharedSignal=>{
   const results=await Promise.all([runMediaCommand(ffmpeg,['-version'],{signal:sharedSignal,maxOutputBytes:1024*1024}),runMediaCommand(ffprobe,['-version'],{signal:sharedSignal,maxOutputBytes:1024*1024}),runMediaCommand(ffmpeg,['-hide_banner','-encoders'],{signal:sharedSignal,maxOutputBytes:1024*1024})]);
   const encoders=results[2].stdout.toString('utf8');
   if(!/\blibopus\b/.test(encoders)||!/^\s*A\S*\s+aac\s/m.test(encoders))throw mediaError('encoder-unavailable','FFmpeg must provide both libopus and AAC-LC encoders',{status:503});
   const value={ffmpeg,ffprobe,ffmpegVersion:results[0].stdout.toString('utf8').split(/\r?\n/)[0],ffprobeVersion:results[1].stdout.toString('utf8').split(/\r?\n/)[0],opus:true,aacLC:true};
   throwIfAborted(sharedSignal);toolchains.set(key,value);return value;
 },signal);
}

export async function inspectMediaDependencies(){
 const[renderer,toolchain]=await Promise.all([inspectRendererDependencies(),getMediaToolchain().then(value=>({available:true,ffmpegVersion:value.ffmpegVersion,ffprobeVersion:value.ffprobeVersion,opus:true,aacLC:true}),error=>({available:false,code:error.code||'encoder-unavailable',message:error.message,retryable:false}))]);
 return{available:renderer.available&&toolchain.available,renderer,encoding:toolchain};
}
export function clearDependencyStatus(){toolchains.clear();}

export async function mediaItemCacheKey({plan,item,signal}){
 throwIfAborted(signal);const[base,tools]=await Promise.all([rendererCacheKey({plan,item}),getMediaToolchain({signal})]);
 return sha256(canonicalJson({rendererKey:base,ffmpegVersion:tools.ffmpegVersion,ffprobeVersion:tools.ffprobeVersion,encodingVersion:'compact-delivery-v1'}));
}

function inspectMaster(bytes){
 if(bytes.toString('ascii',0,4)!=='RIFF'||bytes.toString('ascii',8,12)!=='WAVE')throw mediaError('invalid-master','Native renderer returned an invalid WAV');
 let channels,sampleRate,bits,format,dataLength;
 for(let offset=12;offset+8<=bytes.length;){const id=bytes.toString('ascii',offset,offset+4),length=bytes.readUInt32LE(offset+4),body=offset+8;if(body+length>bytes.length)throw mediaError('invalid-master','Truncated master WAV');if(id==='fmt '){format=bytes.readUInt16LE(body);channels=bytes.readUInt16LE(body+2);sampleRate=bytes.readUInt32LE(body+4);bits=bytes.readUInt16LE(body+14);}if(id==='data')dataLength=length;offset=body+length+(length%2);}
 if(format!==3||bits!==32||sampleRate!==48000||![1,2].includes(channels)||!dataLength||dataLength%(channels*4))throw mediaError('invalid-master','Expected a 48 kHz Float32 WAV master');
 return{frames:dataLength/(channels*4),sampleRate,channels};
}

function pcmMetrics(bytes,channels,validFrames){
 if(bytes.length%(channels*4))throw mediaError('invalid-decode','Decoded Float32 PCM is not frame-aligned');
 const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength),frames=bytes.length/(channels*4);let peak=0,sum=0,nonfinite=0,clipped=0;
 for(let index=0;index<bytes.length/4;index++){const value=view.getFloat32(index*4,true);if(!Number.isFinite(value)){nonfinite++;continue;}peak=Math.max(peak,Math.abs(value));sum+=value*value;if(Math.abs(value)>=1)clipped++;}
 let boundaryJump=0;
 if(validFrames>0&&validFrames<=frames)for(let channel=0;channel<channels;channel++)boundaryJump=Math.max(boundaryJump,Math.abs(view.getFloat32(channel*4,true)-view.getFloat32(((validFrames-1)*channels+channel)*4,true)));
 return{decodedFrames:frames,peak,peakDbFS:peak?20*Math.log10(peak):null,rms:Math.sqrt(sum/(frames*channels)),nonfinite,clippedSamples:clipped,loopBoundaryJump:boundaryJump};
}

async function probeAndDecode(filename,item,master,tools,signal){
 const probe=await runMediaCommand(tools.ffprobe,['-v','error','-show_streams','-show_format','-of','json',filename],{signal,maxOutputBytes:4*1024*1024});
 const metadata=JSON.parse(probe.stdout.toString('utf8')),streams=metadata.streams?.filter(stream=>stream.codec_type==='audio')||[],stream=streams[0];
 if(streams.length!==1||Number(stream.sample_rate)!==48000||stream.channels!==item.channels||stream.codec_name!==(item.formatId==='opus-ogg'?'opus':'aac'))throw mediaError('encoded-format-mismatch','Encoded codec, channel count or sample rate differs from the confirmed item');
 if(item.formatId==='opus-ogg'?!metadata.format?.format_name?.split(',').includes('ogg'):!metadata.format?.format_name?.split(',').includes('mp4'))throw mediaError('encoded-container-mismatch','Encoded container differs from the confirmed item');
 const decoded=await runMediaCommand(tools.ffmpeg,['-nostdin','-hide_banner','-v','error','-i',filename,'-map','0:a:0','-vn','-sn','-dn','-c:a','pcm_f32le','-f','f32le','pipe:1'],{signal,maxOutputBytes:128*1024*1024});
 const metrics=pcmMetrics(decoded.stdout,item.channels,master.frames),padding=metrics.decodedFrames-master.frames;
 if(metrics.nonfinite||metrics.peak===0||metrics.clippedSamples)throw mediaError('decoded-audio-invalid','Encoded media decodes to silence, clipping or nonfinite samples');
 if(padding<0||padding>(item.formatId==='opus-ogg'?0:2048))throw mediaError('decoded-duration-mismatch','Decoded audio length does not preserve the valid master frames');
 return{metrics,profile:stream.profile??null,paddingFrames:padding};
}

async function licenseProvenance(masterEntry){
 // Return portable source references; package store copies license texts as dependencies.
 const licenses=[{id:'project-notice',path:'THIRD_PARTY_NOTICES.md',scope:'Self-owned project source has no open-source license grant; owner-authorized internal delivery. Third-party asset licenses are recorded separately.'}];
 for(const asset of masterEntry.provenance.assets)if(asset.source?.includes('kenney.nl')&&!licenses.some(value=>value.id==='kenney'))licenses.push({id:'kenney',path:'assets/licenses/Kenney-CC0.md',spdx:'CC0-1.0',scope:'prepared Kenney SFX used by this item'});
 if(masterEntry.provenance.assets.some(asset=>asset.path.includes('instruments/marimba')))licenses.push({id:'vsco',path:'assets/licenses/VSCO-CC0.txt',spdx:'CC0-1.0',scope:'VSCO2 CE prepared marimba samples used by this item'});
 licenses.push({id:'tone',path:'vendor/Tone.LICENSE.md',spdx:'MIT',scope:'Tone.js offline renderer; license notice must accompany code distribution'});
 return{...masterEntry.provenance,licenses};
}

async function cachedEncoded(directory){
 try{const entry=JSON.parse(await fs.readFile(path.join(directory,'encoded.json'),'utf8'));for(const file of entry.files){if(path.basename(file.path)!==file.path)return null;const bytes=await fs.readFile(path.join(directory,file.path));if(sha256(bytes)!==file.sha256||bytes.length!==file.bytes)return null;}return entry;}
 catch(error){if(error.code==='ENOENT'||error instanceof SyntaxError)return null;throw error;}
}

async function encodeFresh({plan,item,cacheKey,signal,tools}){
 const masters=await renderItemMasters({plan,item,signal}),cacheRoot=path.join(audioDataDirectory(),'cache/encoded'),destination=path.join(cacheRoot,cacheKey);await fs.mkdir(cacheRoot,{recursive:true});const staging=await fs.mkdtemp(path.join(cacheRoot,'.encode-'));
 try{
  const format=formats[item.formatId],files=[];
  for(const master of masters.outputs){
   throwIfAborted(signal);const source=path.join(masters.directory,master.path),actual=inspectMaster(await fs.readFile(source));
   if(actual.frames!==master.frames||actual.channels!==item.channels)throw mediaError('master-integrity-error','Cached master dimensions differ from renderer metadata');
   const filename=master.id+format.extension,target=path.join(staging,filename);
   const args=['-y','-nostdin','-hide_banner','-v','error','-i',source,'-map','0:a:0','-vn','-sn','-dn','-map_metadata','-1','-ar','48000','-ac',String(item.channels)];
   if(item.formatId==='opus-ogg')args.push('-c:a','libopus','-b:a',item.bitrateKbps+'k','-vbr','on','-compression_level','10','-application','audio','-frame_duration','20','-f','ogg');
   else args.push('-c:a','aac','-profile:a','aac_low','-b:a',item.bitrateKbps+'k','-movflags','+faststart','-f','ipod');
   args.push(target);await runMediaCommand(tools.ffmpeg,args,{signal,maxOutputBytes:1024*1024});
   const validation=await probeAndDecode(target,item,master,tools,signal),bytes=await fs.readFile(target);
   files.push({id:master.id,path:filename,...(item.kind==='music'?{group:master.id}:{}),sha256:sha256(bytes),bytes:bytes.length,mimeType:format.mimeType,formatId:item.formatId,container:format.container,codec:format.codec,sampleRate:48000,channels:item.channels,frames:master.frames,decodedFrames:validation.metrics.decodedFrames,durationSeconds:master.frames/48000,decodedPcmBytes:validation.metrics.decodedFrames*item.channels*4,
    encoding:{encoder:format.encoder,version:tools.ffmpegVersion,targetBitrateKbps:item.bitrateKbps,rateControl:format.rateControl,profile:validation.profile},
    trim:{referenceSampleRate:48000,masterFrames:master.frames,leadingPaddingFrames:0,trailingPaddingFrames:validation.paddingFrames,startFrame:0,endFrame:master.frames,decodedFrames:validation.metrics.decodedFrames,priming:'container-signalled; FFmpeg decoder already discards leading encoder priming'},
    ...(master.loop?{loop:master.loop}:{}),
    quality:{technical:'passed',listening:'not-evaluated',nativeMaster:master.metrics,decoded:validation.metrics,loop:'frame-boundaries-recorded; listening-not-evaluated'},
    master:{sha256:master.sha256,frames:master.frames,format:'wav-float32',...(master.sourceTrim?{sourceTrim:master.sourceTrim}:{})}
   });
  }
  const entry={schemaVersion:1,cacheKey,files,provenance:await licenseProvenance(masters),quality:{technical:'passed',binding:'contract-validated',listening:'not-evaluated',checks:['Native Chromium OfflineAudioContext rendered the selected score or cue','Master WAV SHA-256 and dimensions verified','FFprobe container/codec/48kHz/channel count verified','FFmpeg decoded every delivered file to finite non-silent Float32 PCM','Effective master frames and decoder padding recorded; no listening-quality claim']}};
  await fs.writeFile(path.join(staging,'encoded.json'),JSON.stringify(entry,null,2));
  try{await fs.rename(staging,destination);}catch(error){if(!['EEXIST','ENOTEMPTY','EPERM'].includes(error.code)||!await cachedEncoded(destination))throw error;}
  return entry;
 }finally{await fs.rm(staging,{recursive:true,force:true});}
}

/** Produces only the selected item's one confirmed format, never an entire default reel. */
export async function renderMediaItem({plan,item,directory,signal}){
 throwIfAborted(signal);validateMediaItem(plan,item);
 if(typeof directory!=='string'||!directory)throw mediaError('invalid-output-directory','An output directory is required');
 const tools=await getMediaToolchain({signal}),cacheKey=await mediaItemCacheKey({plan,item,signal}),cacheDirectory=path.join(audioDataDirectory(),'cache/encoded',cacheKey);
 let entry=await cachedEncoded(cacheDirectory),cacheHit=!!entry;
 if(!entry){
  entry=await subscribeMediaTask(encodeJobs,cacheKey,async sharedSignal=>{await fs.rm(cacheDirectory,{recursive:true,force:true});throwIfAborted(sharedSignal);return encodeFresh({plan,item,cacheKey,signal:sharedSignal,tools});},signal);
 }
 throwIfAborted(signal);await fs.mkdir(directory,{recursive:true});const copied=[];
 try{
  const prefix=sha256(item.id).slice(0,16);
  const files=[];
  for(const file of entry.files){throwIfAborted(signal);const filename=`${prefix}-${file.path}`,destination=path.join(directory,filename);await fs.copyFile(path.join(cacheDirectory,file.path),destination);copied.push(destination);files.push({...file,id:`${item.id}:${file.id}`,path:filename});}
  const loop=files[0]?.loop;
  const mapping=item.kind==='sfx'?{sfx:{eventId:item.eventId,variants:files.map(file=>file.id),maxRatePerSecond:item.maxRatePerSecond??null,...(item.spatial!==undefined?{spatial:item.spatial}:{})}}:{music:{scene:item.scene,gainDb:0,loop,...(item.playback==='stems'?{stemFileIds:files.map(file=>file.id),stemRoles:Object.fromEntries(files.map(file=>[file.id,file.group])),stemGainDb:Object.fromEntries(files.map(file=>[file.id,0]))}:{mixFileId:files[0].id})}};
  const totalBytes=files.reduce((sum,file)=>sum+file.bytes,0),decodedPcmBytes=files.reduce((sum,file)=>sum+file.decodedPcmBytes,0);
  if(Number.isFinite(item.maxTransferBytes)&&totalBytes>item.maxTransferBytes)throw mediaError('transfer-budget-exceeded','Encoded item exceeds its transfer budget');
  if(Number.isFinite(item.maxDecodedPcmBytes)&&decodedPcmBytes>item.maxDecodedPcmBytes)throw mediaError('decode-budget-exceeded','Encoded item exceeds its decoded PCM budget');
  return{cacheKey,cacheHit,files,...mapping,quality:entry.quality,provenance:{...entry.provenance,requestedSourceScoreHash:plan.sourcePlan.scoreHash},totalBytes,decodedPcmBytes};
 }catch(error){for(const file of copied)await fs.unlink(file).catch(()=>{});throw error;}
}
