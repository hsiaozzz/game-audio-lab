import { renderScore, renderSfxItem, bufferMetrics } from './audio-engine.mjs';

function floatWav(buffer,channels=buffer.numberOfChannels){
 const frames=buffer.length,bytes=new ArrayBuffer(44+frames*channels*4),view=new DataView(bytes),tag=(offset,value)=>{for(let index=0;index<value.length;index++)view.setUint8(offset+index,value.charCodeAt(index));};
 tag(0,'RIFF');view.setUint32(4,bytes.byteLength-8,true);tag(8,'WAVEfmt ');view.setUint32(16,16,true);view.setUint16(20,3,true);view.setUint16(22,channels,true);view.setUint32(24,buffer.sampleRate,true);view.setUint32(28,buffer.sampleRate*channels*4,true);view.setUint16(32,channels*4,true);view.setUint16(34,32,true);tag(36,'data');view.setUint32(40,frames*channels*4,true);
 const data=Array.from({length:buffer.numberOfChannels},(_,channel)=>buffer.getChannelData(channel));
 for(let frame=0;frame<frames;frame++)for(let channel=0;channel<channels;channel++)view.setFloat32(44+(frame*channels+channel)*4,channels===1&&data.length>1?(data[0][frame]+data[1][frame])*.5:data[channel][frame],true);
 return bytes;
}

/** Invoked only by an isolated background browser, never the UI or user's browser. */
export async function renderServiceMasters({score,item,mode='hybrid',uploadToken}){
 const outputs=[];
 async function save(id,buffer,detail={}){
  const metrics=bufferMetrics(buffer);
  if(metrics.nonfinite||metrics.peak===0||metrics.clippedSamples)throw new Error('Rendered master is silent, clipped or nonfinite: '+id);
  const response=await fetch(`/_upload/${uploadToken}/${id}`,{method:'POST',headers:{'Content-Type':'audio/wav'},body:floatWav(buffer,item.channels)});
  if(!response.ok)throw new Error('Master upload failed: '+response.status);
  outputs.push({id,frames:buffer.length,sampleRate:buffer.sampleRate,channels:item.channels,durationSeconds:buffer.duration,metrics,...detail});
 }
 if(item.kind==='music'){
  const rendered=await renderScore(score,{mode,sampleRate:48000});
  if(item.playback==='stems')for(const id of ['core','texture','rhythm'])await save(id,rendered.stems[id],{loop:{enabled:item.loop!==false,startFrame:0,endFrame:rendered.stems[id].length,referenceSampleRate:48000},renderStats:rendered.stats});
  else await save('mix',rendered.buffer,{loop:{enabled:item.loop!==false,startFrame:0,endFrame:rendered.buffer.length,referenceSampleRate:48000},renderStats:rendered.stats});
 }else{
  for(let variant=0;variant<item.variants;variant++){
   const rendered=await renderSfxItem(score.brief,{cue:item.cue,variant,sampleRate:48000,mode});
   await save(`variant-${variant+1}`,rendered.buffer,{variant:variant+1,cue:item.cue,source:rendered.source,sourceTrim:rendered.trim});
  }
 }
 return{outputs,toneVersion:globalThis.Tone?.version};
}
