import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {createGameAudioBridge,gameAudioClientSource} from '../src/game-audio-bridge.mjs';
const report={createdAt:new Date().toISOString(),checks:[],pass:false};
const plan={briefHash:'test-brief',revision:3,planId:'test-plan'};
let remote,metadata,sequence=0,calls=0;const waiting=new Map();
const iframe={contentWindow:{postMessage(message,target,ports){
 assert.equal(target,'*');metadata=message;remote=ports[0];
 remote.onmessage=event=>{const pending=waiting.get(event.data.sequence);if(pending){waiting.delete(event.data.sequence);pending(event.data.result);}};remote.start();
 remote.postMessage({type:'audio:ready',session:message.session,briefHash:message.briefHash,revision:message.revision});
}}};
const adapter={async emit(id,payload){calls++;assert.equal(id,'item.collect');assert.equal(payload.strength,.7);return{accepted:true};},setScene(value){return{accepted:value==='exploration'};},setIntensity(value){return{accepted:value===.8};}};
const bridge=createGameAudioBridge({iframe,plan,adapter});
function send(operation,fields={}){return new Promise(resolve=>{const id=++sequence;waiting.set(id,resolve);remote.postMessage({type:'audio:request',session:metadata.session,briefHash:plan.briefHash,revision:plan.revision,sequence:id,operation,...fields});});}
try{
 assert.equal((await bridge.connect()).accepted,true);assert.equal(bridge.getState().connected,true);
 assert.equal((await send('emit',{eventId:'item.collect',payload:{strength:.7}})).reason,'audio-not-ready');assert.equal(calls,0);
 report.checks.push('dedicated channel handshake and default audio gate');
 bridge.setEnabled(true);assert.equal((await send('emit',{eventId:'item.collect',payload:{strength:.7}})).accepted,true);assert.equal(calls,1);
 assert.equal((await send('setScene',{value:'exploration'})).accepted,true);assert.equal((await send('setIntensity',{value:.8})).accepted,true);
 assert.equal((await send('dispose')).reason,'unknown-operation');report.checks.push('semantic events and state reach adapter; game cannot dispose host audio');
 remote.postMessage({type:'audio:request',session:metadata.session,briefHash:plan.briefHash,revision:2,sequence:++sequence,operation:'emit',eventId:'item.collect',payload:{strength:.7}});
 remote.postMessage({type:'audio:request',session:'wrong',briefHash:plan.briefHash,revision:3,sequence:++sequence,operation:'emit',eventId:'item.collect',payload:{strength:.7}});
 assert.equal((await send('setScene',{value:'exploration'})).accepted,true);assert.equal(calls,1);report.checks.push('stale revision and wrong capability are ignored');
 const source=gameAudioClientSource();new Function(source);assert(!/fetch\s*\(|AudioContext/.test(source));report.checks.push('inline game client is self-contained and owns no audio or network loader');
 bridge.dispose();assert.equal(bridge.getState().disposed,true);assert.equal((await bridge.connect()).reason,'bridge-disposed');remote.close();report.checks.push('dispose closes bridge and prevents reconnect');
 let unused;
 const timeoutBridge=createGameAudioBridge({iframe:{contentWindow:{postMessage(message,target,ports){unused=ports[0];}}},plan,adapter,timeoutMs:20});
 assert.equal((await timeoutBridge.connect()).reason,'handshake-timeout');timeoutBridge.dispose();unused.close();report.checks.push('missing game handshake times out without blocking host');
 report.pass=true;
}catch(error){report.error=String(error.stack||error);process.exitCode=1;}
finally{bridge.dispose();remote?.close();await fs.writeFile(fileURLToPath(new URL('../artifacts/bridge-validation.json',import.meta.url)),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));}
