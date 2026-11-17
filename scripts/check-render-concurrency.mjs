import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const script = fileURLToPath(import.meta.url);

// Substitute only external browser/process boundaries. Production renderer/media
// modules, cache operations, cancellation and encoding coordination run unchanged.
const fakeBrowser = String.raw`
import { Buffer } from 'node:buffer';
export const state={launches:0,evaluations:0,abortedBrowsers:0,pending:new Set()};
export function releaseMasters(){for(const gate of [...state.pending]){state.pending.delete(gate);gate.resolve();}}
function wav(channels,variant){
 const frames=4800,bytes=Buffer.alloc(44+frames*channels*4);
 bytes.write('RIFF',0);bytes.writeUInt32LE(bytes.length-8,4);bytes.write('WAVEfmt ',8);bytes.writeUInt32LE(16,16);bytes.writeUInt16LE(3,20);bytes.writeUInt16LE(channels,22);bytes.writeUInt32LE(48000,24);bytes.writeUInt32LE(48000*channels*4,28);bytes.writeUInt16LE(channels*4,32);bytes.writeUInt16LE(32,34);bytes.write('data',36);bytes.writeUInt32LE(frames*channels*4,40);
 for(let index=44;index<bytes.length;index+=4)bytes.writeFloatLE(.2+variant*.01,index);
 return bytes;
}
export const chromium={executablePath:()=>process.execPath,launch:async()=>{
 state.launches++;let origin,closed=false,pending=null;
 return{version:()=> 'FAKE browser for cancellation contract only',
  newContext:async()=>({route:async()=>{},newPage:async()=>({goto:async value=>{origin=value;},evaluate:async(_fn,{item,uploadToken})=>{
   state.evaluations++;
   const gate={};await new Promise((resolve,reject)=>{gate.resolve=resolve;gate.reject=reject;pending=gate;state.pending.add(gate);}).finally(()=>{state.pending.delete(gate);pending=null;});
   if(closed)throw new Error('fake browser closed');
   const ids=item.kind==='music'?(item.playback==='stems'?['core','texture','rhythm']:['mix']):Array.from({length:item.variants},(_,index)=>'variant-'+(index+1)),outputs=[];
   for(const [index,id]of ids.entries()){
    const response=await fetch(origin+'/_upload/'+uploadToken+'/'+id,{method:'POST',body:wav(item.channels,index)});if(!response.ok)throw new Error('fake master upload failed');
    outputs.push({id,frames:4800,channels:item.channels,metrics:{peak:.2+index*.01},...(item.kind==='music'?{loop:{enabled:true,referenceSampleRate:48000,startFrame:0,endFrame:4800}}:{})});
   }
   return{outputs,toneVersion:'FAKE boundary fixture'};
  }})}),
  close:async()=>{if(closed)return;closed=true;if(pending){state.abortedBrowsers++;pending.reject(new Error('fake browser aborted'));}}
 };
}};
`;

const fakeProcesses = String.raw`
import {EventEmitter} from 'node:events';
import fs from 'node:fs/promises';
export const state={probeStarts:0,encodeStarts:0,decodeStarts:0,kills:0,holdProbes:false,pendingProbes:new Set(),pendingEncodes:new Set()};
export function releaseProbes(){state.holdProbes=false;for(const gate of [...state.pendingProbes]){state.pendingProbes.delete(gate);gate.resolve();}}
export function releaseEncodes(){for(const gate of [...state.pendingEncodes]){state.pendingEncodes.delete(gate);gate.resolve();}}
export function spawn(executable,args){
 const child=new EventEmitter();child.stdout=new EventEmitter();child.stderr=new EventEmitter();let killed=false,closed=false,pending=null;
 const finish=code=>{if(closed)return;closed=true;child.emit('close',code);};
 child.kill=()=>{if(closed||killed)return true;killed=true;state.kills++;if(pending){state.pendingProbes.delete(pending);state.pendingEncodes.delete(pending);pending.resolve();}queueMicrotask(()=>finish(137));return true;};
 async function gate(set){const value={};await new Promise(resolve=>{value.resolve=resolve;pending=value;set.add(value);});set.delete(value);pending=null;}
 queueMicrotask(async()=>{try{
  let output;
  if(args.includes('-version')||args.includes('-encoders')){
   state.probeStarts++;if(state.holdProbes)await gate(state.pendingProbes);
   output=Buffer.from(args.includes('-encoders')?' A..... libopus fake\n A..... aac fake\n':'FAKE toolchain version 1\n');
  }else if(executable.endsWith('fixture-ffprobe')){
   output=Buffer.from(JSON.stringify({streams:[{codec_type:'audio',sample_rate:'48000',channels:1,codec_name:'opus',profile:null}],format:{format_name:'ogg'}}));
  }else if(args.at(-1)==='pipe:1'){
   state.decodeStarts++;output=Buffer.alloc(4800*4);for(let index=0;index<output.length;index+=4)output.writeFloatLE(.2,index);
  }else{
   state.encodeStarts++;await gate(state.pendingEncodes);if(killed)return;
   await fs.writeFile(args.at(-1),Buffer.from('FAKE ENCODED BYTES: cancellation contract fixture'));
  }
  if(killed)return;if(output)child.stdout.emit('data',output);finish(0);
 }catch(error){child.emit('error',error);finish(1);}});
 return child;
}
`;

if (!process.argv.includes('--worker')) {
  const temporaryRoot = path.resolve(os.tmpdir());
  const temporary = await fs.mkdtemp(path.join(temporaryRoot, 'audio-render-concurrency-'));
  try {
    const browserPath = path.join(temporary, 'fake-playwright.mjs');
    const processesPath = path.join(temporary, 'fake-processes.mjs');
    const loaderPath = path.join(temporary, 'loader.mjs');
    const bootstrapPath = path.join(temporary, 'bootstrap.mjs');
    await fs.writeFile(browserPath, fakeBrowser);
    await fs.writeFile(processesPath, fakeProcesses);
    const mediaUrl = pathToFileURL(path.join(root, 'server/audio-media.mjs')).href;
    await fs.writeFile(loaderPath, `export async function resolve(specifier,context,next){if(specifier==='node:child_process'&&context.parentURL===${JSON.stringify(mediaUrl)})return{url:${JSON.stringify(pathToFileURL(processesPath).href)},shortCircuit:true};return next(specifier,context);}`);
    await fs.writeFile(bootstrapPath, `import {register} from 'node:module';register(${JSON.stringify(pathToFileURL(loaderPath).href)},import.meta.url);`);
    const child = spawn(process.execPath, ['--import', pathToFileURL(bootstrapPath).href, script, '--worker', temporary], {
      cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: {
        ...process.env, GAME_AUDIO_PLAYWRIGHT: browserPath, GAME_AUDIO_DATA_DIR: path.join(temporary, 'data'),
        GAME_AUDIO_FFMPEG: 'fixture-ffmpeg', GAME_AUDIO_FFPROBE: 'fixture-ffprobe'
      }
    });
    let output = '', diagnostic = '';
    child.stdout.on('data', bytes => { output += bytes; });
    child.stderr.on('data', bytes => { diagnostic += bytes; });
    const timer = setTimeout(() => child.kill('SIGKILL'), 20000);
    let code;
    try { code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); }); }
    finally { clearTimeout(timer); }
    assert.equal(code, 0, `${output}\n${diagnostic}`);
    process.stdout.write(output);
  } finally {
    const target = path.resolve(temporary);
    assert(target.startsWith(temporaryRoot + path.sep), 'Temporary cleanup escaped OS temp directory');
    await fs.rm(target, { recursive: true, force: true });
  }
} else {
  const temporary = process.argv.at(-1);
  const { createDeliveryPlan } = await import('../server/audio-plan.mjs');
  const { renderItemMasters } = await import('../server/audio-renderer.mjs');
  const { renderMediaItem, getMediaToolchain, clearDependencyStatus } = await import('../server/audio-media.mjs');
  const browser = await import(pathToFileURL(path.join(temporary, 'fake-playwright.mjs')).href);
  const processes = await import(pathToFileURL(path.join(temporary, 'fake-processes.mjs')).href);
  const checks = [];
  const observe = promise => promise.then(value => ({ value }), error => ({ error }));
  async function until(predicate, message) {
    const deadline = Date.now() + 5000;
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error('Timed out: ' + message);
      await new Promise(resolve => setTimeout(resolve, 5));
    }
  }
  function trackedController() {
    const controller = new AbortController();
    let notify;
    const subscribed = new Promise(resolve => { notify = resolve; });
    const add = controller.signal.addEventListener.bind(controller.signal);
    controller.signal.addEventListener = (type, ...args) => { add(type, ...args); if (type === 'abort') notify(); };
    return { controller, signal: controller.signal, subscribed };
  }
  async function cancelled(promise) { const result = await promise; assert.equal(result.error?.code, 'cancelled', result.error?.stack); }
  async function success(promise) { const result = await promise; assert(!result.error, result.error?.stack); return result.value; }
  const input = { gameBrief: { schemaVersion: 1, projectId: 'render-concurrency-fixture', revision: 1, prompt: 'cozy island' },
    eventContract: { version: 1, events: [{ id: 'item.collect', cue: 'collect', required: true }] },
    audioRequests: [{ id: 'sfx.collect', kind: 'sfx', eventId: 'item.collect', variants: 1 }], delivery: { renderMode: 'synth', acceptedFormats: ['opus-ogg'] } };
  const plan = await createDeliveryPlan(input), item = plan.items[0];

  // The original bug: the first subscriber's cancellation killed both callers.
  const first = trackedController(), second = trackedController();
  const render1 = observe(renderItemMasters({ plan, item, signal: first.signal }));
  await first.subscribed;
  await until(() => browser.state.evaluations === 1, 'first fake browser evaluation');
  const render2 = observe(renderItemMasters({ plan, item, signal: second.signal }));
  await second.subscribed;
  first.controller.abort();
  await cancelled(render1);
  assert.equal(second.signal.aborted, false);
  assert.equal(browser.state.abortedBrowsers, 0, 'Active subscriber must keep the shared browser alive');
  browser.releaseMasters();
  const master = await success(render2);
  assert.equal(master.outputs.length, 1);
  assert.equal(browser.state.launches, 1, 'Concurrent master requests must still deduplicate');
  assert.equal((await renderItemMasters({ plan, item })).cacheHit, true);
  checks.push('master rendering: cancelling first caller leaves second subscribed and successful; one shared render and persistent cache reuse');

  // Last subscriber cancellation stops work; a new subscriber waits for cleanup.
  const alternatePlan = await createDeliveryPlan({ ...input, audioRequests: [{ ...input.audioRequests[0], variants: 2 }], delivery: { ...input.delivery, renderMode: 'hybrid' } });
  const alternateItem = alternatePlan.items[0], abandoned = trackedController();
  const abandonedRender = observe(renderItemMasters({ plan: alternatePlan, item: alternateItem, signal: abandoned.signal }));
  await abandoned.subscribed;
  await until(() => browser.state.evaluations === 2, 'abandoned fake browser evaluation');
  abandoned.controller.abort();
  await cancelled(abandonedRender);
  const restartedRender = observe(renderItemMasters({ plan: alternatePlan, item: alternateItem }));
  await until(() => browser.state.evaluations === 3, 'replacement fake browser after cleanup');
  assert.equal(browser.state.abortedBrowsers, 1);
  browser.releaseMasters();
  assert.equal((await success(restartedRender)).outputs.length, 2);
  assert.equal((await renderItemMasters({ plan: alternatePlan, item: alternateItem })).cacheHit, true);
  checks.push('master rendering: last cancellation closes browser, replacement waits for cleanup, uncancelled caller publishes reusable cache');

  // Tool discovery is shared too, and must not inherit its first caller's signal.
  clearDependencyStatus();
  processes.state.holdProbes = true;
  const toolsFirst = trackedController(), toolsSecond = trackedController();
  const tools1 = observe(getMediaToolchain({ signal: toolsFirst.signal }));
  await toolsFirst.subscribed;
  await until(() => processes.state.pendingProbes.size === 3, 'three fake toolchain probes');
  const tools2 = observe(getMediaToolchain({ signal: toolsSecond.signal }));
  await toolsSecond.subscribed;
  const beforeProbeKills = processes.state.kills;
  toolsFirst.controller.abort();await cancelled(tools1);
  assert.equal(processes.state.kills, beforeProbeKills);
  processes.releaseProbes();assert.equal((await success(tools2)).opus, true);
  const probes = processes.state.probeStarts;await getMediaToolchain();assert.equal(processes.state.probeStarts, probes);
  checks.push('toolchain discovery: per-caller cancellation and successful probe cache are isolated');

  const encodedFirst = trackedController(), encodedSecond = trackedController();
  const encode1 = observe(renderMediaItem({ plan, item, directory: path.join(temporary, 'encoded-cancelled'), signal: encodedFirst.signal }));
  await encodedFirst.subscribed;
  await until(() => processes.state.encodeStarts === 1, 'first fake encoder');
  const encode2 = observe(renderMediaItem({ plan, item, directory: path.join(temporary, 'encoded-success'), signal: encodedSecond.signal }));
  await encodedSecond.subscribed;
  const beforeEncoderKills = processes.state.kills;
  encodedFirst.controller.abort();await cancelled(encode1);
  assert.equal(encodedSecond.signal.aborted, false);
  assert.equal(processes.state.kills, beforeEncoderKills, 'Active subscriber must keep the shared encoder alive');
  processes.releaseEncodes();
  const encoded = await success(encode2);
  assert.equal(encoded.files.length, 1);
  assert.equal(processes.state.encodeStarts, 1);
  assert.equal((await renderMediaItem({ plan, item, directory: path.join(temporary, 'encoded-cache') })).cacheHit, true);
  assert.equal(processes.state.encodeStarts, 1);
  checks.push('encoding: cancelling first caller leaves second successful; one shared encoder and persistent encoded-cache reuse');

  const alternateEncoding = await createDeliveryPlan({ ...input, delivery: { ...input.delivery, sfxQuality: 'compact-approved' } });
  const finalSubscriber = trackedController();
  const stoppedEncoding = observe(renderMediaItem({ plan: alternateEncoding, item: alternateEncoding.items[0], directory: path.join(temporary, 'encoded-abandoned'), signal: finalSubscriber.signal }));
  await finalSubscriber.subscribed;
  await until(() => processes.state.encodeStarts === 2, 'abandoned fake encoder');
  finalSubscriber.controller.abort();await cancelled(stoppedEncoding);
  const replacementEncoding = observe(renderMediaItem({ plan: alternateEncoding, item: alternateEncoding.items[0], directory: path.join(temporary, 'encoded-restarted') }));
  await until(() => processes.state.encodeStarts === 3, 'replacement encoder after cleanup');
  assert.equal(processes.state.kills, beforeEncoderKills + 1);
  processes.releaseEncodes();assert.equal((await success(replacementEncoding)).files.length, 1);
  assert.equal((await renderMediaItem({ plan: alternateEncoding, item: alternateEncoding.items[0], directory: path.join(temporary, 'encoded-restarted-cache') })).cacheHit, true);
  checks.push('encoding: last cancellation kills process; replacement waits for cleanup and publishes reusable cache');
  assert.equal(processes.state.pendingProbes.size, 0);
  assert.equal(processes.state.pendingEncodes.size, 0);
  assert.equal(browser.state.pending.size, 0);
  console.log(JSON.stringify({ pass: true, checks, verification: 'Browser, encoder, probe output and PCM are explicit FAKE boundary fixtures. No real audio rendering, codec or listening-quality claim.' }, null, 2));
}
