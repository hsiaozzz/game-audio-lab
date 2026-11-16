const PROTOCOL=1;

/** The host owns the audio graph; a sandboxed game only receives this narrow event port. */
export function createGameAudioBridge({iframe,plan,adapter,onEvent=()=>{},onState=()=>{},timeoutMs=5000}){
 if(!iframe?.contentWindow||!plan?.briefHash||!Number.isInteger(plan.revision)||!adapter)throw new Error('Bridge requires an iframe, plan and adapter');
 const session=crypto.randomUUID();let port,connected=false,enabled=false,disposed=false,pending,handshakeTimer,finishHandshake,lastSequence=0,eventCount=0,rejectedCount=0;
 const state=()=>({connected,enabled,disposed,eventCount,rejectedCount});
 const notify=()=>{try{onState(state());}catch{}};
 const result=(accepted,reason)=>({accepted,...(reason?{reason}:{})});
 async function request(message){
  if(!message||message.type!=='audio:request'||message.session!==session||message.briefHash!==plan.briefHash||message.revision!==plan.revision||
     !Number.isSafeInteger(message.sequence)||message.sequence<=lastSequence)return;
  lastSequence=message.sequence;let answer;
  try{
   if(!enabled)answer=result(false,'audio-not-ready');
   else if(message.operation==='emit'&&typeof message.eventId==='string')answer=await adapter.emit(message.eventId,message.payload??{});
   else if(message.operation==='setScene')answer=await adapter.setScene(message.value);
   else if(message.operation==='setIntensity')answer=await adapter.setIntensity(message.value);
   else answer=result(false,'unknown-operation');
  }catch{answer=result(false,'audio-operation-failed');}
  if(disposed)return;
  if(answer?.accepted)eventCount++;else rejectedCount++;
  port.postMessage({type:'audio:result',session,sequence:message.sequence,result:answer});
  try{onEvent({operation:message.operation,eventId:message.eventId,payload:message.payload,result:answer});}catch{}
  notify();
 }
 return{
  getState:state,
  setEnabled(value){enabled=!!value&&!disposed;notify();},
  connect(){
   if(disposed)return Promise.resolve(result(false,'bridge-disposed'));
   if(pending)return pending;
   const channel=new MessageChannel();port=channel.port1;
   pending=new Promise(resolve=>{
    finishHandshake=resolve;
    handshakeTimer=setTimeout(()=>{connected=false;enabled=false;port.close();resolve(result(false,'handshake-timeout'));notify();},timeoutMs);
    port.onmessage=event=>{
     const message=event.data;
     if(message?.type==='audio:ready'&&message.session===session&&message.briefHash===plan.briefHash&&message.revision===plan.revision){
      clearTimeout(handshakeTimer);connected=true;resolve(result(true));notify();return;
     }
     if(connected&&!disposed)void request(message);
    };
    port.start();
    try{iframe.contentWindow.postMessage({type:'audio:init',protocol:PROTOCOL,session,briefHash:plan.briefHash,revision:plan.revision,planId:plan.planId},'*',[channel.port2]);}
    catch{clearTimeout(handshakeTimer);port.close();channel.port2.close();resolve(result(false,'frame-unavailable'));}
   });
   return pending;
  },
  dispose(){if(disposed)return;disposed=true;enabled=false;connected=false;clearTimeout(handshakeTimer);finishHandshake?.(result(false,'bridge-disposed'));port?.close();notify();}
 };
}

// This self-contained function is embedded as trusted inline code in an opaque srcdoc.
function installGameAudioClient(){
 const pending=new Map();let port,metadata,sequence=0,resolveReady;
 const ready=new Promise(resolve=>{resolveReady=resolve;});
 function send(operation,fields){
  if(!port)return Promise.resolve({accepted:false,reason:'bridge-not-ready'});
  const id=++sequence;
  return new Promise(resolve=>{
   const timer=setTimeout(()=>{pending.delete(id);resolve({accepted:false,reason:'audio-response-timeout'});},5000);
   pending.set(id,{resolve,timer});
   try{port.postMessage({type:'audio:request',session:metadata.session,briefHash:metadata.briefHash,revision:metadata.revision,sequence:id,operation,...fields});}
   catch{clearTimeout(timer);pending.delete(id);resolve({accepted:false,reason:'bridge-closed'});}
  });
 }
 addEventListener('message',event=>{
  const message=event.data;
  if(event.source!==parent||message?.type!=='audio:init'||message.protocol!==1||typeof message.session!=='string'||
     typeof message.briefHash!=='string'||!Number.isInteger(message.revision)||!event.ports[0])return;
  port?.close();for(const item of pending.values()){clearTimeout(item.timer);item.resolve({accepted:false,reason:'bridge-replaced'});}pending.clear();
  port=event.ports[0];metadata=message;sequence=0;
  port.onmessage=event=>{
   const reply=event.data;if(reply?.type!=='audio:result'||reply.session!==metadata.session)return;
   const item=pending.get(reply.sequence);if(!item)return;clearTimeout(item.timer);pending.delete(reply.sequence);item.resolve(reply.result);
  };
  port.start();port.postMessage({type:'audio:ready',session:metadata.session,briefHash:metadata.briefHash,revision:metadata.revision});
  resolveReady({briefHash:metadata.briefHash,revision:metadata.revision,planId:metadata.planId});
 });
 window.GameAudio=Object.freeze({ready,emit:(eventId,payload={})=>send('emit',{eventId,payload}),setScene:value=>send('setScene',{value}),setIntensity:value=>send('setIntensity',{value}),getState:()=>({connected:!!port,revision:metadata?.revision??null})});
}

export function gameAudioClientSource(){return `(${installGameAudioClient.toString()})();`;}
