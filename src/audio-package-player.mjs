import {validateManifest,verifyIdentity,AudioServiceError} from './audio-service-client.mjs';

const clamp=(value,min,max)=>Math.min(max,Math.max(min,value));
const amplitude=db=>10**((Number.isFinite(db)?db:0)/20);
/** Plays decoded, verified media only. It never fetches, generates, evaluates or synthesizes audio. */
export function createAudioPackagePlayer({audioContext=null,maxVoices=12,maxEventsPerSecond=8,onEvent=()=>{},onError=()=>{}}={}){
  let context=audioContext,ownsContext=!audioContext,master,musicBus,sfxBus,manifest=null,buffers=new Map(),disposed=false,unlocked=false,muted=false,paused=false,intensity=.35,scene=null,musicItemId=null,musicStartedAt=0,musicOffset=0,musicLoopStart=0,musicLoopEnd=0,musicDuration=0,musicPlaying=false,operation=0,eventCount=0,listenerPose={position:{x:0,y:0,z:0},forward:{x:0,y:0,z:-1},up:{x:0,y:1,z:0}};
  const voices=new Set(),musicSources=new Set(),lastEvents=new Map(),variantIndices=new Map();
  function fail(reason,details={}){const result={accepted:false,reason,...details};try{onError(result);}catch{}return result;}
  function ready(){return disposed?fail('disposed'):!manifest?fail('package-not-loaded'):!unlocked||context?.state!=='running'?fail('locked'):paused?fail('paused'):null;}
  const vector=value=>value&&['x','y','z'].every(axis=>Number.isFinite(value[axis]));
  function applyListener(){const listener=context?.listener;if(!listener)return;const{position,forward,up}=listenerPose;if(listener.positionX){for(const axis of ['x','y','z']){const capital=axis.toUpperCase();listener['position'+capital].setValueAtTime(position[axis],context.currentTime);listener['forward'+capital].setValueAtTime(forward[axis],context.currentTime);listener['up'+capital].setValueAtTime(up[axis],context.currentTime);}}else{listener.setPosition(position.x,position.y,position.z);listener.setOrientation(forward.x,forward.y,forward.z,up.x,up.y,up.z);}}
  function graph(){if(master)return;master=context.createGain();musicBus=context.createGain();sfxBus=context.createGain();master.gain.value=muted?0:.8;musicBus.connect(master);sfxBus.connect(master);master.connect(context.destination);applyListener();}
  function releaseVoice(voice){if(!voices.has(voice))return;voices.delete(voice);voice.source.onended=null;try{voice.source.stop();}catch{}for(const node of [voice.source,voice.gain,voice.pan])try{node?.disconnect();}catch{}}
  function clearMusic(){for(const item of musicSources){item.source.onended=null;try{item.source.stop();}catch{}for(const node of [item.source,item.gain])try{node.disconnect();}catch{}}musicSources.clear();musicPlaying=false;}
  function musicPosition(){if(!musicPlaying)return musicOffset;const position=musicOffset+Math.max(0,context.currentTime-musicStartedAt);return musicLoopEnd>musicLoopStart?musicLoopStart+((position-musicLoopStart)%(musicLoopEnd-musicLoopStart)+(musicLoopEnd-musicLoopStart))%(musicLoopEnd-musicLoopStart):Math.min(musicDuration,position);}
  function stemEntries(item){if(item.mixFileId)return[['mix',item.mixFileId]];if(Array.isArray(item.stemFileIds))return item.stemFileIds.map((id,index)=>[item.stemRoles?.[id]||manifest?.files.find(file=>file.id===id)?.group||['core','texture','rhythm'][index]||String(index),id]);return Object.entries(item.stemFileIds||{});}
  function layerGain(item,role,fileId){const db=typeof item.stemGainDb==='object'?item.stemGainDb[fileId]??item.stemGainDb[role]??item.gainDb:item.gainDb;const dynamic=role==='rhythm'?.12+.88*intensity:role==='texture'?.35+.65*intensity:role==='core'?.9:1;return amplitude(db)*dynamic;}
  function playMusic(id,{offset=0}={}){
    const blocked=ready();if(blocked)return blocked;const item=manifest.music?.[id];if(!item)return fail('unknown-music',{itemId:id});
    const entries=stemEntries(item);if(!entries.length||entries.some(([,fileId])=>!buffers.has(fileId)))return fail('music-not-loaded',{itemId:id});
    const durations=entries.map(([,fileId])=>buffers.get(fileId).duration),duration=Math.min(...durations),loop=item.loop;
    const start=loop?.startFrame/(loop?.referenceSampleRate||1)||0,end=loop?.endFrame/(loop?.referenceSampleRate||1)||duration;
    if(start<0||end<=start||end>duration+1/(context.sampleRate||48000))return fail('invalid-loop',{itemId:id});
    clearMusic();musicItemId=id;musicDuration=duration;musicLoopStart=start;musicLoopEnd=loop?.enabled===false?0:Math.min(end,duration);musicOffset=Math.max(0,offset);if(musicLoopEnd>start)musicOffset=start+((musicOffset-start)%(musicLoopEnd-start)+(musicLoopEnd-start))%(musicLoopEnd-start);
    const when=context.currentTime+.012;
    try{
      for(const [stem,fileId]of entries){const source=context.createBufferSource(),gain=context.createGain(),entry={source,gain,stem,fileId};source.buffer=buffers.get(fileId);source.loop=loop?.enabled!==false;source.loopStart=start;source.loopEnd=end;gain.gain.value=layerGain(item,stem,fileId);source.connect(gain);gain.connect(musicBus);source.onended=()=>{source.disconnect();gain.disconnect();musicSources.delete(entry);if(musicSources.size===0){musicPlaying=false;musicOffset=duration;}};source.start(when,musicOffset);musicSources.add(entry);}
      musicStartedAt=when;musicPlaying=true;return{accepted:true,itemId:id,stems:entries.length};
    }catch(cause){clearMusic();return fail('playback-failed',{message:cause.message});}
  }
  const api={
    async unlock(){if(disposed)return fail('disposed');try{if(!context){const AudioContextClass=globalThis.AudioContext||globalThis.webkitAudioContext;if(!AudioContextClass)return fail('web-audio-unavailable');context=new AudioContextClass({latencyHint:'interactive'});}graph();await context.resume();if(disposed)return fail('disposed');unlocked=context.state==='running';return unlocked?{accepted:true}:fail('audio-not-running');}catch(cause){return fail('unlock-failed',{message:cause.message});}},
    load(bundle){
      if(disposed)return fail('disposed');
      try{
        if(!bundle?.verified||!(bundle.decoded instanceof Map))throw new AudioServiceError('unverified-package','先由客户端完整验证并解码资源包');
        validateManifest(bundle.manifest);if(manifest){verifyIdentity(manifest.identity,bundle.manifest.identity);if(manifest.planId!==bundle.manifest.planId||manifest.selectionDigest!==bundle.manifest.selectionDigest)throw new AudioServiceError('package-mismatch','新资源包与当前选择不匹配');}
        const referenced=new Set();for(const item of Object.values(bundle.manifest.sfx||{}))for(const id of item.variants||[])referenced.add(id);for(const item of Object.values(bundle.manifest.music||{}))for(const [,id]of stemEntries(item))referenced.add(id);
        for(const id of referenced)if(!bundle.decoded.has(id)&&!buffers.has(id))throw new AudioServiceError('decoded-media-missing',`音频未解码：${id}`);
        for(const [id,buffer]of bundle.decoded){if(!buffer?.getChannelData||buffer.length<1)throw new AudioServiceError('invalid-audio-buffer','音频缓冲无效');buffers.set(id,buffer);}
        manifest=bundle.manifest;return{accepted:true,packageId:manifest.packageId,eventIds:Object.values(manifest.sfx||{}).map(item=>item.eventId),musicIds:Object.keys(manifest.music||{})};
      }catch(cause){return fail(cause.code||'invalid-package',{message:cause.message});}
    },
    play(eventId,payload={}){
      const blocked=ready();if(blocked)return blocked;
      if(!payload||typeof payload!=='object'||Array.isArray(payload))return fail('invalid-payload');
      for(const [name,min,max]of [['strength',0,1],['pan',-1,1]])if(payload[name]!==undefined&&(!Number.isFinite(payload[name])||payload[name]<min||payload[name]>max))return fail('invalid-payload',{field:name});
      let entry=Object.entries(manifest.sfx||{}).find(([,item])=>item.eventId===eventId);if(!entry)return fail('unknown-event',{eventId});const [itemId,item]=entry,variants=item.variants||[];
      if(payload.position!==undefined&&(!vector(payload.position)||!item.spatial?.enabled))return fail(vector(payload.position)?'unsupported-spatial-payload':'invalid-position');
      if(!variants.length||variants.some(id=>!buffers.has(id)))return fail('event-not-loaded',{eventId});
      const now=context.currentTime,rate=item.maxRatePerSecond||maxEventsPerSecond,previous=lastEvents.get(eventId);
      if(previous!==undefined&&now-previous<1/rate)return fail('rate-limited',{eventId});
      if(voices.size>=maxVoices)return fail('voice-budget',{eventId});
      const spatial=payload.position!==undefined,variant=(variantIndices.get(eventId)||0)%variants.length,source=context.createBufferSource(),gain=context.createGain(),pan=spatial?context.createPanner():typeof context.createStereoPanner==='function'?context.createStereoPanner():null,voice={source,gain,pan};
      source.buffer=buffers.get(variants[variant]);gain.gain.value=amplitude(item.gainDb)*(payload.strength??1);source.connect(gain);if(pan){if(spatial){const config=item.spatial;pan.panningModel='HRTF';pan.distanceModel=config.distanceModel||'inverse';pan.refDistance=config.refDistance??1;pan.maxDistance=config.maxDistance??100;pan.rolloffFactor=config.rolloffFactor??1;const position=payload.position;if(pan.positionX)for(const axis of ['x','y','z'])pan['position'+axis.toUpperCase()].setValueAtTime(position[axis],context.currentTime);else pan.setPosition(position.x,position.y,position.z);}else pan.pan.value=clamp(payload.pan??0,-1,1);gain.connect(pan);pan.connect(sfxBus);}else gain.connect(sfxBus);
      source.onended=()=>releaseVoice(voice);
      try{source.start();voices.add(voice);variantIndices.set(eventId,variant+1);lastEvents.set(eventId,now);eventCount++;const result={accepted:true,eventId,itemId,fileId:variants[variant],variant};try{onEvent(result);}catch{}return result;}
      catch(cause){try{source.disconnect();gain.disconnect();pan?.disconnect();}catch{}return fail('playback-failed',{message:cause.message});}
    },
    emit(eventId,payload){return this.play(eventId,payload);},
    setIntensity(value){if(disposed)return fail('disposed');if(!Number.isFinite(value)||value<0||value>1)return fail('invalid-intensity');intensity=value;const item=manifest?.music?.[musicItemId];if(context&&item)for(const entry of musicSources)entry.gain.gain.setTargetAtTime(layerGain(item,entry.stem,entry.fileId),context.currentTime,.12);return{accepted:true,intensity};},
    setListener(pose){if(disposed)return fail('disposed');if(!pose||!vector(pose.position)||pose.forward!==undefined&&!vector(pose.forward)||pose.up!==undefined&&!vector(pose.up))return fail('invalid-listener');listenerPose={position:{...pose.position},forward:{...(pose.forward||listenerPose.forward)},up:{...(pose.up||listenerPose.up)}};try{applyListener();return{accepted:true,capability:'HRTF-distance-panning-without-occlusion'};}catch(cause){return fail('listener-failed',{message:cause.message});}},
    setScene(value){if(disposed)return fail('disposed');scene=value;return{accepted:true,scene,musicTransition:'explicit-only'};},
    pause(){if(disposed)return fail('disposed');if(!unlocked)return fail('locked');operation++;musicOffset=musicPosition();clearMusic();for(const voice of [...voices])releaseVoice(voice);paused=true;return{accepted:true};},
    async resume(){if(disposed)return fail('disposed');if(!paused)return fail('not-paused');const token=++operation,result=await this.unlock();if(!result.accepted)return result;if(token!==operation||disposed)return fail('cancelled');paused=false;return musicItemId?playMusic(musicItemId,{offset:musicOffset}):{accepted:true};},
    setMuted(value){if(disposed)return fail('disposed');muted=!!value;if(master)master.gain.setTargetAtTime(muted?0:.8,context.currentTime,.025);return{accepted:true,muted};},
    mute(value=true){return this.setMuted(value);},
    stop(){if(disposed)return fail('disposed');operation++;clearMusic();for(const voice of [...voices])releaseVoice(voice);musicOffset=0;musicItemId=null;paused=false;return{accepted:true};},
    music:{play:playMusic,stop(){clearMusic();musicOffset=0;musicItemId=null;return{accepted:!disposed};}},
    getState:()=>({disposed,unlocked,contextState:context?.state||'uninitialized',muted,paused,intensity,scene,musicPlaying,musicItemId,musicOffset:musicPosition(),activeVoices:voices.size,musicSources:musicSources.size,eventCount,packageId:manifest?.packageId||null,loadedFiles:buffers.size,eventIds:Object.values(manifest?.sfx||{}).map(item=>item.eventId),musicIds:Object.keys(manifest?.music||{}),spatialCapability:'HRTF-distance-panning-without-occlusion',listenerPose:structuredClone(listenerPose)}),
    async dispose(){if(disposed)return{accepted:true};this.stop();disposed=true;unlocked=false;buffers.clear();manifest=null;for(const node of [musicBus,sfxBus,master])try{node?.disconnect();}catch{}if(ownsContext&&context&&context.state!=='closed')await context.close();return{accepted:true};}
  };
  return api;
}
