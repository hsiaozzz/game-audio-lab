import {spawn} from 'node:child_process';
import {once} from 'node:events';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
import os from 'node:os';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const report={createdAt:new Date().toISOString(),purpose:'HTTP serving and blind-session restart QA; all votes are automated qa inputs.',checks:[],pass:false};
let child,origin;
const serviceData=await fs.mkdtemp(path.join(os.tmpdir(),'audio-legacy-http-'));
async function start(){
 child=spawn(process.execPath,['scripts/server.mjs'],{cwd:root,env:{...process.env,GAME_AUDIO_PORT:'0',GAME_AUDIO_DATA_DIR:serviceData,GAME_AUDIO_HOST:'127.0.0.1',GAME_AUDIO_API_TOKEN:'',GAME_AUDIO_API_TOKENS_JSON:'',GAME_AUDIO_DIRECTOR_MODULE:'',GAME_AUDIO_DIRECTOR_PROVIDER:'local'},windowsHide:true,stdio:['ignore','pipe','pipe']});
 origin=await new Promise((resolve,reject)=>{
  const timer=setTimeout(()=>reject(new Error('Server startup timeout')),8000);
  child.once('error',error=>{clearTimeout(timer);reject(error);});
  child.once('exit',code=>{clearTimeout(timer);reject(new Error('Server exited: '+code));});
  child.stdout.on('data',chunk=>{const match=String(chunk).match(/http:\/\/127\.0\.0\.1:\d+/);if(match){clearTimeout(timer);resolve(match[0]);}});
 });
}
async function stop(){if(child&&child.exitCode===null){const done=once(child,'exit');child.kill();await done;}}
const json=async(route,body)=>{const response=await fetch(origin+route,{method:body===undefined?'GET':'POST',headers:body===undefined?{}:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});return{status:response.status,data:await response.json()};};
try{
 await start();
 for(const route of ['/','/blind.html','/listen.html','/src/audio-engine.mjs','/assets/manifest.json','/vendor/Tone.js'])assert.equal((await fetch(origin+route)).status,200,route);
 report.checks.push('all three pages and runtime resources served');
 for(const route of ['/.git/HEAD','/scripts/server.mjs','/artifacts/blind-sessions/session-test.json','/assets/.source/vsco/LICENSE'])assert.equal((await fetch(origin+route)).status,403,route);
 report.checks.push('project internals and listener records are not static resources');
 const audio='/artifacts/sfx-reference-matched.wav';
 const head=await fetch(origin+audio,{method:'HEAD'});assert.equal(head.status,200);assert(Number(head.headers.get('content-length'))>1000);assert.equal((await head.arrayBuffer()).byteLength,0);
 const range=await fetch(origin+audio,{headers:{Range:'bytes=0-43'}});assert.equal(range.status,206);const header=Buffer.from(await range.arrayBuffer());assert.equal(header.length,44);assert.equal(header.toString('ascii',0,4),'RIFF');
 const suffix=await fetch(origin+audio,{headers:{Range:'bytes=-12'}});assert.equal(suffix.status,206);assert.equal((await suffix.arrayBuffer()).byteLength,12);
 assert.equal((await fetch(origin+audio,{headers:{Range:'bytes=999999999-'}})).status,416);
 report.checks.push('HEAD, byte ranges, suffix ranges and out-of-bounds ranges');
 const banks=await Promise.all([json('/api/sound-bank'),json('/api/sound-bank')]);assert.equal(Object.keys(banks[0].data.files).length,17);assert.deepEqual(banks[0],banks[1]);report.checks.push('cached sound bank retains all 17 files');
 const planInput={gameBrief:{schemaVersion:1,projectId:'http-pipeline-qa',revision:1,prompt:'neon space shooter'},eventContract:{version:1,events:[{id:'item.collect',cue:'collect',required:true}],sceneStates:['exploration']},options:{seed:1701}};
 const planned=await json('/api/audio/plan',planInput);assert.equal(planned.status,200);assert.equal(planned.data.plan.revision,1);assert.equal(planned.data.plan.bindings['item.collect'].cue,'collect');assert.equal(planned.data.plan.director.modelConnected,false);
 assert.equal((await json('/api/audio/plan',{})).status,400);
 assert.equal((await json('/api/audio/capabilities')).data.eventBridge,'message-channel-v1');
 report.checks.push('independent audio planning API returns versioned score and rejects invalid game contracts');
 let state=(await json('/api/blind/sessions',{purpose:'qa'})).data;
 const route=`/api/blind/sessions/${state.id}`;
 await Promise.all(Object.values(state.round.clips).map(async url=>{const response=await fetch(origin+url);await response.arrayBuffer();}));
 state=(await json(route+'/votes',{token:state.round.token,choice:'tie'})).data;
 assert.equal(state.completedCount,1);const token=state.round.token;
 await stop();await start();
 state=(await json(route)).data;assert.equal(state.completedCount,1);assert.equal(state.round.token,token);assert.equal(state.results,undefined);
 report.checks.push('unfinished session restored after process restart without revealing sources');
 while(!state.completed){await Promise.all(Object.values(state.round.clips).map(async url=>{const response=await fetch(origin+url);await response.arrayBuffer();}));state=(await json(route+'/votes',{token:state.round.token,choice:'tie'})).data;}
 const scores=state.results.scores;
 await stop();await start();
 const restored=await json(route);assert.equal(restored.status,200);assert.equal(restored.data.completed,true);assert.deepEqual(restored.data.results.scores,scores);
 report.checks.push('completed results and score preserved after process restart');
 report.pass=true;
}catch(error){report.error=String(error.stack||error);process.exitCode=1;}
finally{await stop();await fs.rm(serviceData,{recursive:true,force:true});await fs.writeFile(path.join(root,'artifacts/server-validation.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));}
