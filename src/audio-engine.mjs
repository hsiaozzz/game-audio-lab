const getTone=()=>{if(!globalThis.Tone)throw new Error('Local Tone.js runtime is unavailable');return globalThis.Tone;};
const db=value=>10**(value/20),hz=midi=>440*2**((midi-69)/12);
const clamp=(value,min,max)=>Math.max(min,Math.min(max,value));
const INSTRUMENTS=new Set(['marimba','fmBell','softKeys','pad','bass','lead','pluck','kick','snare','hat','shaker']);
const STYLES=new Set(['cozy','neon','ruins']);
let assetsPromise,renderQueue=Promise.resolve();

function finiteNumber(value,label){const number=Number(value);if(value===null||value===''||!Number.isFinite(number))throw new TypeError(label+' must be a finite number');return number;}
function normalizedSfxBrief(brief){
 if(brief==null)return{rootMidi:62,mode:'major'};
 if(typeof brief!=='object')throw new TypeError('Expected a game audio brief');
 const rootMidi=brief.rootMidi??62,mode=brief.mode??'major';
 if(!Number.isFinite(rootMidi)||rootMidi<0||rootMidi>127)throw new RangeError('rootMidi must be between 0 and 127');
 if(!['major','minor'].includes(mode))throw new TypeError('Unsupported musical mode: '+mode);
 return{...brief,rootMidi,mode};
}
function validateScore(score,mode,sampleRate){
 if(!score||!Array.isArray(score.tracks)||!score.tracks.length)throw new TypeError('A score with tracks is required');
 if(!STYLES.has(score.brief?.style))throw new TypeError('Unsupported score style: '+score.brief?.style);
 normalizedSfxBrief(score.brief);
 if(!['synth','hybrid'].includes(mode))throw new TypeError('Unsupported rendering mode: '+mode);
 if(!Number.isFinite(sampleRate)||sampleRate<8000||sampleRate>96000)throw new RangeError('sampleRate must be between 8000 and 96000');
 if(!Number.isFinite(score.duration)||score.duration<=0||!Number.isFinite(score.bpm)||score.bpm<=0)throw new RangeError('Score duration and BPM must be positive finite numbers');
 for(const track of score.tracks){
  if(!track||!INSTRUMENTS.has(track.instrument))throw new Error('Unknown instrument: '+track?.instrument);
  if(!Number.isFinite(track.pan)||Math.abs(track.pan)>1||!Number.isFinite(track.gainDb)||!Array.isArray(track.events))throw new TypeError('Invalid track pan, gain or events');
  for(const event of track.events)if(!event||!Number.isFinite(event.beat)||event.beat<0||!Number.isFinite(event.durationBeats)||event.durationBeats<=0||!Number.isFinite(event.velocity)||event.velocity<0||event.velocity>1||!Number.isFinite(event.midi))throw new TypeError('Invalid score event');
 }
}

function decodePreparedPCM(bytes){
 const view=new DataView(bytes),tag=offset=>String.fromCharCode(...new Uint8Array(bytes,offset,4));
 if(tag(0)!=='RIFF'||tag(8)!=='WAVE')throw new Error('Expected prepared RIFF/WAVE');
 let channels,rate,bits,format,dataOffset,dataLength;
 for(let offset=12;offset+8<=bytes.byteLength;){const id=tag(offset),length=view.getUint32(offset+4,true),body=offset+8;
  if(body+length>bytes.byteLength)throw new Error('Truncated WAV chunk');
  if(id==='fmt '){format=view.getUint16(body,true);channels=view.getUint16(body+2,true);rate=view.getUint32(body+4,true);bits=view.getUint16(body+14,true);}
  if(id==='data'){dataOffset=body;dataLength=length;}offset=body+length+(length%2);
 }
 if(format!==1||bits!==16||!channels||!dataLength)throw new Error('Sound bank requires PCM16 WAV');
 const frames=dataLength/(channels*2),buffer=new AudioBuffer({length:frames,numberOfChannels:channels,sampleRate:rate});
 for(let ch=0;ch<channels;ch++){const samples=buffer.getChannelData(ch);for(let i=0;i<frames;i++)samples[i]=view.getInt16(dataOffset+(i*channels+ch)*2,true)/32768;}
 return buffer;
}

export async function loadSoundBank(){
 if(!assetsPromise)assetsPromise=(async()=>{
  const response=await fetch('/api/sound-bank');if(!response.ok)throw new Error('Sound-bank package unavailable');
  const {manifest,files}=await response.json(),buffers=new Map();
  const entries=[...(manifest.samples||[]).map(item=>({key:item.id,...item})),...Object.entries(manifest.instruments?.marimbaSampled?.urls||{}).map(([note,url])=>({key:`marimba:${note}`,url}))];
  for(const item of entries){try{const binary=atob(files[item.url]),bytes=Uint8Array.from(binary,char=>char.charCodeAt(0));buffers.set(item.key,decodePreparedPCM(bytes.buffer));}catch(error){throw new Error(`Cannot decode ${item.url}: ${error.message}`);}}
  return{manifest,buffers};
 })().catch(error=>{assetsPromise=undefined;throw error;});
 return assetsPromise;
}

function instrumentFor(Tone,id,bank,mode){
 const poly=(voice,options)=>new Tone.PolySynth({voice,maxPolyphony:16,options});
 if(id==='marimba'&&mode==='hybrid'){
  const urls=Object.fromEntries([...bank.buffers].filter(([key])=>key.startsWith('marimba:')).map(([key,buffer])=>[key.slice(8),buffer]));
  if(!Object.keys(urls).length)throw new Error('Hybrid marimba requires verified local multisamples');
  const sampler=new Tone.Sampler({urls,attack:.003,release:.22,curve:'exponential'});
  sampler.volume.value=bank.manifest.instruments.marimbaSampled.gainDb??-8;return sampler;
 }
 if(id==='marimba')return poly(Tone.FMSynth,{harmonicity:3.98,modulationIndex:5.8,oscillator:{type:'sine'},envelope:{attack:.002,decay:.32,sustain:0,release:.15},modulation:{type:'sine'},modulationEnvelope:{attack:.001,decay:.1,sustain:0,release:.08}});
 if(id==='fmBell')return poly(Tone.FMSynth,{harmonicity:2.003,modulationIndex:2.2,oscillator:{type:'sine'},envelope:{attack:.003,decay:1.15,sustain:.015,release:.65},modulationEnvelope:{attack:.001,decay:.35,sustain:0,release:.18}});
 if(id==='softKeys')return poly(Tone.FMSynth,{harmonicity:2,modulationIndex:.75,oscillator:{type:'sine'},envelope:{attack:.008,decay:1.1,sustain:.08,release:.5},modulationEnvelope:{attack:.003,decay:.24,sustain:.05,release:.2}});
 if(id==='pad')return poly(Tone.Synth,{oscillator:{type:'fatsine',count:3,spread:9},envelope:{attack:.42,decay:.9,sustain:.35,release:1.6}});
 if(id==='bass')return new Tone.MonoSynth({oscillator:{type:'triangle'},filter:{type:'lowpass',Q:.4,rolloff:-24},envelope:{attack:.005,decay:.18,sustain:.28,release:.16},filterEnvelope:{attack:.002,decay:.25,sustain:.12,release:.12,baseFrequency:130,octaves:2.2}});
 if(id==='lead')return new Tone.MonoSynth({oscillator:{type:'fatsawtooth',count:2,spread:5},filter:{type:'lowpass',Q:.65,rolloff:-24},envelope:{attack:.006,decay:.15,sustain:.22,release:.15},filterEnvelope:{attack:.008,decay:.18,sustain:.22,release:.14,baseFrequency:580,octaves:2}});
 if(id==='pluck')return poly(Tone.FMSynth,{harmonicity:1.001,modulationIndex:2.2,envelope:{attack:.003,decay:.25,sustain:0,release:.35},modulationEnvelope:{attack:.002,decay:.08,sustain:0,release:.1}});
 if(id==='kick')return new Tone.MembraneSynth({pitchDecay:.025,octaves:4.5,envelope:{attack:.001,decay:.19,sustain:0,release:.08}});
 if(['snare','hat','shaker'].includes(id))return new Tone.NoiseSynth({noise:{type:id==='shaker'?'pink':'white'},envelope:{attack:.001,decay:id==='snare'?.115:id==='hat'?.035:.06,sustain:0,release:.015}});
 throw new Error('Unknown instrument: '+id);
}

function makeImpulse(context,seconds=1.3){
 const buffer=context.createBuffer(2,Math.ceil(seconds*context.sampleRate),context.sampleRate);let seed=77291;
 for(let ch=0;ch<2;ch++){const data=buffer.getChannelData(ch);for(let i=0;i<data.length;i++){seed=(Math.imul(seed,1664525)+1013904223)>>>0;data[i]=((seed/4294967296)*2-1)*Math.exp(-i/(context.sampleRate*.23))*.13;}}
 return buffer;
}
const groupFor=track=>track.role==='drums'?'rhythm':['harmony','pad','ornament'].includes(track.role)?'texture':'core';
async function renderStem(score,tracks,bank,mode,sampleRate){
 const Tone=getTone(),owned=[],rawOwned=[],originalContext=Tone.getContext();let result,renderContext;
 try{
 result=await Tone.Offline(offlineContext=>{
  renderContext=offlineContext;
  const context=offlineContext,transport=context.transport;
  transport.bpm.value=score.bpm;
  const bus=new Tone.Gain(.83),highpass=new Tone.Filter(30,'highpass'),compressor=new Tone.Compressor({threshold:-18,ratio:2,attack:.012,release:.18});
  bus.connect(highpass);highpass.connect(compressor);compressor.toDestination();owned.push(bus,highpass,compressor);
  const raw=context.rawContext,convolver=raw.createConvolver(),send=raw.createGain();rawOwned.push(convolver,send);convolver.buffer=makeImpulse(raw);send.gain.value=score.brief.style==='ruins'?.3:.14;convolver.connect(send);send.connect(bus.input);
  for(const track of tracks){
   const instrument=instrumentFor(Tone,track.instrument,bank,mode),pan=new Tone.Panner(track.pan),gain=new Tone.Gain(db(track.gainDb));
   instrument.connect(pan);pan.connect(gain);gain.connect(bus);owned.push(instrument,pan,gain);
   if(!['bass','kick','hat','shaker'].includes(track.instrument)){const reverbSend=raw.createGain();rawOwned.push(reverbSend);reverbSend.gain.value=track.role==='lead'?.28:.45;gain.connect(reverbSend);reverbSend.connect(convolver);}
   if(['hat','shaker','snare'].includes(track.instrument)){
    const filter=new Tone.Filter(track.instrument==='snare'?1400:6200,'highpass');instrument.disconnect();instrument.connect(filter);filter.connect(pan);owned.push(filter);
   }
   const beatSeconds=60/score.bpm;
   for(let cycle=0;cycle<2;cycle++)for(const event of track.events){
    const when=cycle*score.duration+event.beat*beatSeconds,duration=event.durationBeats*beatSeconds;
    if(['snare','hat','shaker'].includes(track.instrument))instrument.triggerAttackRelease(duration,when,event.velocity);
    else instrument.triggerAttackRelease(hz(event.midi),duration,when,event.velocity);
   }
  }
 },score.duration*2+.04,2,sampleRate);
 const source=result.get(),start=Math.round(score.duration*sampleRate),length=Math.round(score.duration*sampleRate),out=new AudioBuffer({length,numberOfChannels:2,sampleRate});
 for(let ch=0;ch<2;ch++)out.copyToChannel(source.getChannelData(ch).subarray(start,start+length),ch);
 return out;
 }finally{
  // Tone 15.1.22 does not restore the global context if its callback rejects.
  // Do not overwrite a live context another caller deliberately installed.
  if(renderContext&&Tone.getContext()===renderContext)Tone.setContext(originalContext);
  for(const node of owned)try{node.dispose();}catch{}
  for(const node of rawOwned)try{node.disconnect();}catch{}
  try{result?.dispose();}catch{}
  try{renderContext?.dispose();}catch{}
 }
}

export function bufferMetrics(buffer){
 let peak=0,sum=0,nonfinite=0,clipped=0;const n=buffer.length*buffer.numberOfChannels;
 for(let ch=0;ch<buffer.numberOfChannels;ch++)for(const x of buffer.getChannelData(ch)){if(!Number.isFinite(x)){nonfinite++;continue;}peak=Math.max(peak,Math.abs(x));sum+=x*x;if(Math.abs(x)>=.999)clipped++;}
 const rms=Math.sqrt(sum/n),edge=[];
 for(let ch=0;ch<buffer.numberOfChannels;ch++){const data=buffer.getChannelData(ch);edge.push(Math.abs(data[0]-data[data.length-1]));}
 return{sampleRate:buffer.sampleRate,channels:buffer.numberOfChannels,durationSeconds:buffer.duration,pcmBytes:n*4,peak,peakDbFS:peak?20*Math.log10(peak):-120,rms,rmsDbFS:rms?20*Math.log10(rms):-120,nonfinite,clippedSamples:clipped,loopBoundaryJump:Math.max(...edge)};
}

async function doRenderScore(score,{mode='synth',sampleRate=44100}={}){
 validateScore(score,mode,sampleRate);
 const start=performance.now(),bank=mode==='hybrid'?await loadSoundBank():null;
 const stems={},skippedSilentStems=[];for(const group of ['core','texture','rhythm']){
  const tracks=score.tracks.filter(track=>groupFor(track)===group);
  if(tracks.every(track=>track.events.length===0)){stems[group]=new AudioBuffer({length:Math.round(score.duration*sampleRate),numberOfChannels:2,sampleRate});skippedSilentStems.push(group);}
  else stems[group]=await renderStem(score,tracks,bank,mode,sampleRate);
 }
 const length=stems.core.length,mix=new AudioBuffer({length,numberOfChannels:2,sampleRate});
 for(let ch=0;ch<2;ch++){const data=mix.getChannelData(ch);for(const buffer of Object.values(stems)){const source=buffer.getChannelData(ch);for(let i=0;i<length;i++)data[i]+=source[i];}}
 const before=bufferMetrics(mix),target=db(-20),gain=Math.min(target/(before.rms||1),db(-1)/(before.peak||1),db(12));
 for(const buffer of [mix,...Object.values(stems)])for(let ch=0;ch<2;ch++){const data=buffer.getChannelData(ch);for(let i=0;i<length;i++)data[i]*=gain;}
 return{buffer:mix,stems,score,stats:{...bufferMetrics(mix),renderMs:performance.now()-start,mode,instrumentSource:mode==='hybrid'&&score.tracks.some(t=>t.instrument==='marimba')?'VSCO2 CE marimba + synthesis':'synthesis',normalizationGainDb:20*Math.log10(gain),trackCount:score.tracks.length,eventCount:score.statistics?.eventCount??score.tracks.reduce((sum,track)=>sum+track.events.length,0),stemCount:3,offlineStemCount:3-skippedSilentStems.length,skippedSilentStems,totalCachedPcmBytes:mix.length*2*4*4,method:'Tone.Offline, two cycles per nonempty stem, retained second cycle; silent stems allocated directly',toneVersion:getTone().version}};
}
export function renderScore(score,options){const job=renderQueue.then(()=>doRenderScore(score,options??{}));renderQueue=job.catch(()=>{});return job;}

const EVENT_ALIASES={step:'footstep',shoot:'laser',confirm:'ui',bite:'charge',alert:'charge',reward:'collect'};
function eventId(id){const leaf=String(id).split('.').pop();return EVENT_ALIASES[leaf]||leaf;}
function sfxVoice(context,destination,id,{when=context.currentTime,strength=1,pan=0,bank,rootMidi=62,mode='major',variant=0}={}){
 id=eventId(id);const gain=context.createGain(),panner=context.createStereoPanner();gain.gain.value=clamp(strength,.05,1)*.8;panner.pan.value=clamp(pan,-1,1);gain.connect(panner);panner.connect(destination);
 let duration=.5,nodes=[gain,panner];
 const tone=(frequency,end,length,level=.2,wave='sine',offset=0)=>{
  const osc=context.createOscillator(),amp=context.createGain();osc.type=wave;osc.frequency.setValueAtTime(frequency,when+offset);osc.frequency.exponentialRampToValueAtTime(Math.max(20,end),when+offset+length);
  amp.gain.setValueAtTime(0,when+offset);amp.gain.linearRampToValueAtTime(level,when+offset+.003);amp.gain.exponentialRampToValueAtTime(.0001,when+offset+length);
  osc.connect(amp);amp.connect(gain);osc.start(when+offset);osc.stop(when+offset+length+.02);nodes.push(osc,amp);duration=Math.max(duration,offset+length+.03);
 };
 const noise=(length,frequency,level=.12)=>{
  const buffer=context.createBuffer(1,Math.ceil(context.sampleRate*length),context.sampleRate),data=buffer.getChannelData(0);let seed=731+variant*193;
  for(let i=0;i<data.length;i++){seed=(Math.imul(seed,1664525)+1013904223)>>>0;data[i]=(seed/2147483648-1)*Math.min(1,i/(context.sampleRate*.002))*Math.exp(-i/(context.sampleRate*length*.2));}
  const source=context.createBufferSource(),filter=context.createBiquadFilter(),amp=context.createGain();source.buffer=buffer;filter.type='lowpass';filter.frequency.value=frequency;amp.gain.value=level;source.connect(filter);filter.connect(amp);amp.connect(gain);source.start(when);nodes.push(source,filter,amp);duration=Math.max(duration,length+.03);
 };
 const sample=bank?.buffers.get(id),info=bank?.manifest.samples.find(item=>item.id===id);
 if(sample){const source=context.createBufferSource(),sampleGain=context.createGain();source.buffer=sample;source.playbackRate.value=1+(variant%3-1)*.025;sampleGain.gain.value=db(info?.gainDb??-8);source.connect(sampleGain);sampleGain.connect(gain);source.start(when);duration=Math.max(duration,sample.duration/source.playbackRate.value+.1);nodes.push(source,sampleGain);}
 if(id==='ui')tone(700,1000,.065,.12,'sine');
 else if(id==='collect'){tone(hz(rootMidi+12),hz(rootMidi+12),.17,.22);tone(hz(rootMidi+19),hz(rootMidi+19),.29,.16,'sine',.075);}
 else if(id==='hit'){tone(165,45,.14,.35,'triangle');noise(.13,2300,.2);}
 else if(id==='cast'){noise(.24,4200,.08);tone(360,100,.18,.1,'triangle');}
 else if(id==='splash'){noise(.48,1800,.15);tone(420,65,.12,.08);}
 else if(id==='footstep'||id==='footstepWood'){if(!sample){noise(.07,850,.17);tone(110,55,.06,.15);}}
 else if(id==='explosion'){tone(95,24,.7,.48);noise(1.05,1400,.4);duration=Math.max(duration,1.15);}
 else if(id==='charge'){tone(220,1050,.62,.15,'triangle');tone(330,1575,.62,.07,'sine');duration=Math.max(duration,.7);}
 else if(id==='laser'){tone(1600,150,.17,.17,'sawtooth');}
 else if(id==='victory'||id==='failure'){
  const notes=id==='victory'?[0,mode==='minor'?3:4,7,12]:[7,3,0,-5];notes.forEach((offset,i)=>tone(hz(rootMidi+offset),hz(rootMidi+offset),i===3?.75:.22,.21,'triangle',i*.16));duration=Math.max(duration,1.3);
 }else if(!sample){tone(500,220,.15,.14);}
 return{duration,nodes,source:sample?'sample+procedural':'procedural',id};
}

export async function renderSfxReel(brief){
 brief=normalizedSfxBrief(brief);
 const bank=await loadSoundBank(),ids=['ui','collect','cast','splash','footstep','hit','laser','charge','explosion','victory','failure'],spacing=1.6,length=Math.ceil((ids.length*spacing+.4)*44100),context=new OfflineAudioContext(2,length,44100),bus=context.createGain();bus.gain.value=.8;bus.connect(context.destination);
 const events=ids.map((id,i)=>{const when=i*spacing+.15,voice=sfxVoice(context,bus,id,{when,bank,rootMidi:brief.rootMidi,mode:brief.mode,variant:i});return{id,time:when,duration:voice.duration,source:voice.source};});
 const buffer=await context.startRendering();return{buffer,events,stats:bufferMetrics(buffer)};
}

export async function renderSfxComparison(brief){
 brief=normalizedSfxBrief(brief);
 const bank=await loadSoundBank(),ids=['ui','collect','cast','footstep','hit','laser','charge','explosion'],spacing=1.8,sampleRate=44100,reels={};
 for(const mode of ['synth','reference','hybrid']){
  const context=new OfflineAudioContext(2,Math.ceil((ids.length*spacing+.4)*sampleRate),sampleRate),bus=context.createGain();bus.gain.value=1;bus.connect(context.destination);
  const events=ids.map((id,index)=>{
   const when=index*spacing+.2;
   if(mode==='reference'){
    const buffer=bank.buffers.get(id);if(!buffer)throw new Error('Reference sample unavailable: '+id);
    const source=context.createBufferSource();source.buffer=buffer;source.playbackRate.value=1;source.connect(bus);source.start(when);
    const info=bank.manifest.samples.find(item=>item.id===id);
    return{id,time:when,segmentStart:index*spacing,segmentEnd:(index+1)*spacing,duration:buffer.duration,source:'reference-sample-only',components:['sample'],sourceFile:info?.sourceFile,sourcePack:info?.pack};
   }
   const voice=sfxVoice(context,bus,id,{when,bank:mode==='hybrid'?bank:undefined,rootMidi:brief.rootMidi,mode:brief.mode,variant:0});
   const sampleOnly=mode==='hybrid'&&id==='footstep';
   return{id,time:when,segmentStart:index*spacing,segmentEnd:(index+1)*spacing,duration:voice.duration,source:mode==='synth'?'procedural-only':sampleOnly?'sample-only-hybrid-path':voice.source,components:mode==='synth'?['procedural']:sampleOnly?['sample']:['sample','procedural']};
  });
  const buffer=await context.startRendering();reels[mode]={buffer,events,stats:bufferMetrics(buffer),normalization:'none; raw output for level-matched comparison'};
 }
 return{reels,brief,kind:'matched-event-sfx-comparison',spacingSeconds:spacing,eventIds:ids};
}

export async function renderContextShowcase(rendered){
 if(!(rendered?.buffer instanceof AudioBuffer))throw new TypeError('A rendered audio buffer is required');
 const brief=normalizedSfxBrief(rendered.score?.brief);
 const bank=await loadSoundBank(),sampleRate=44100,duration=22,context=new OfflineAudioContext(2,duration*sampleRate,sampleRate),music=context.createGain(),sfx=context.createGain(),master=context.createGain();
 music.gain.value=.75;sfx.gain.value=1;master.gain.value=.8;music.connect(master);sfx.connect(master);master.connect(context.destination);
 const source=context.createBufferSource();source.buffer=rendered.buffer;source.connect(music);source.start(0);
 const timeline=[{time:1.2,id:'cast'},{time:2.1,id:'splash'},{time:5.6,id:'charge'},{time:7,id:'collect'},{time:10,id:'footstep'},{time:10.45,id:'footstep'},{time:12.3,id:'hit'},{time:16,id:'collect'},{time:19,id:'victory'}];
 for(const [index,event] of timeline.entries()){
  sfxVoice(context,sfx,event.id,{when:event.time,strength:event.id==='footstep'?.5:.9,pan:index%2?.2:-.2,bank,rootMidi:brief.rootMidi,mode:brief.mode,variant:index});
  if(event.id!=='footstep'){music.gain.setTargetAtTime(.5,event.time,.015);music.gain.setTargetAtTime(.75,event.time+.3,.2);}
 }
 master.gain.setValueAtTime(.8,duration-.7);master.gain.linearRampToValueAtTime(0,duration);
 const buffer=await context.startRendering();return{buffer,timeline,stats:bufferMetrics(buffer),kind:'scripted-context-audition',sourceScore:brief.id??null};
}

export function createAudioRuntime(){
 let context,master,music,sfx,analyser,compressor,sourceData,startedAt=0,offset=0,playing=false,paused=false,intensity=.5,muted=false,bank,totalEvents=0,variant=0,rootMidi=62,rootMode='major',intensityAt=0,playbackToken=0,requestToken=0,disposed=false,unlockPromise,disposePromise;
 const sources=[],voices=[],retiringSources=new Set();
 const levels=value=>({core:.9,texture:.35+.65*value,rhythm:.12+.88*value});
 const assertActive=()=>{if(disposed)throw new Error('Audio runtime is disposed; create a new runtime to reopen audio');};
 async function unlock(){
  assertActive();
  if(!unlockPromise)unlockPromise=(async()=>{
   // Runtime owns only this realtime graph; Tone.Offline may replace Tone's global context.
   if(!context){context=new AudioContext({latencyHint:'interactive'});master=context.createGain();master.gain.value=muted?0:.8;music=context.createGain();sfx=context.createGain();compressor=context.createDynamicsCompressor();compressor.threshold.value=-9;compressor.knee.value=8;compressor.ratio.value=8;compressor.attack.value=.003;compressor.release.value=.16;analyser=context.createAnalyser();analyser.fftSize=1024;music.connect(compressor);sfx.connect(compressor);compressor.connect(master);master.connect(analyser);analyser.connect(context.destination);}
   try{await context.resume();}catch(error){assertActive();throw error;}
   assertActive();return context.state;
  })();
  const pending=unlockPromise;try{return await pending;}finally{if(unlockPromise===pending)unlockPromise=undefined;}
 }
 function disconnectSource(item){try{item.source.onended=null;item.source.disconnect();item.gain.disconnect();}catch{}retiringSources.delete(item);}
 function clear(immediate=false){
  playbackToken++;const now=context?.currentTime||0,fade=context?.state==='running'?.012:0;
  for(const item of sources.splice(0))try{
   if(fade&&!immediate){
    const param=item.gain.gain;
    if(typeof param.cancelAndHoldAtTime==='function')param.cancelAndHoldAtTime(now);
    else{const value=param.value;param.cancelScheduledValues(now);param.setValueAtTime(value,now);}
    param.linearRampToValueAtTime(0,now+fade);retiringSources.add(item);item.source.stop(now+fade+.002);
   }else{item.source.stop();disconnectSource(item);}
  }catch{disconnectSource(item);}
  if(immediate)for(const item of [...retiringSources]){try{item.source.stop();}catch{}disconnectSource(item);}
  playing=false;
 }
 function releaseVoice(voice){
  if(voice.released)return;voice.released=true;
  if(voice.sentinel)voice.sentinel.onended=null;
  for(const node of [...voice.nodes,voice.sentinel]){try{node?.stop?.();}catch{}try{node?.disconnect();}catch{}}
  const index=voices.indexOf(voice);if(index>=0)voices.splice(index,1);
 }
 function pruneVoices(){if(context)for(const voice of [...voices])if(voice.end<=context.currentTime)releaseVoice(voice);}
 function playbackData(rendered,options){
  if(!rendered||typeof rendered!=='object')throw new TypeError('A rendered audio buffer is required');
  const data=rendered instanceof AudioBuffer?{buffer:rendered,...options}:{...rendered,...options},buffers=data.stems||{core:data.buffer};
  if(!(buffers.core instanceof AudioBuffer)||buffers.core.duration<=0)throw new TypeError('A nonempty core audio buffer is required');
  for(const buffer of Object.values(buffers))if(!(buffer instanceof AudioBuffer)||buffer.length!==buffers.core.length||buffer.sampleRate!==buffers.core.sampleRate)throw new TypeError('Stem buffers must have matching lengths and sample rates');
  normalizedSfxBrief(data.score?.brief);return data;
 }
 function startAt(position){
  clear();const buffers=sourceData?.stems||{core:sourceData?.buffer||sourceData};if(!buffers.core)throw new Error('No rendered music');
  const when=context.currentTime+.015,duration=buffers.core.duration,loop=sourceData?.loop!==false,token=playbackToken;
  for(const [id,buffer] of Object.entries(buffers)){
   const source=context.createBufferSource(),gain=context.createGain(),item={source,gain,id};source.buffer=buffer;source.loop=loop;gain.gain.value=0;gain.gain.setValueAtTime(0,when);gain.gain.linearRampToValueAtTime(levels(intensity)[id]??1,when+.03);source.connect(gain);gain.connect(music);
   source.onended=()=>{
    disconnectSource(item);
    if(token!==playbackToken)return;
    const index=sources.indexOf(item);if(index>=0)sources.splice(index,1);
    if(!loop&&sources.length===0){playing=false;paused=false;offset=duration;}
   };
   source.start(when,position%duration);sources.push(item);
  }
  startedAt=when;offset=position%duration;playing=true;paused=false;
 }
 return{
  unlock,
  async play(rendered,options={}){assertActive();const data=playbackData(rendered,options??{}),request=++requestToken;await unlock();assertActive();if(request!==requestToken)return false;sourceData=data;const brief=normalizedSfxBrief(data.score?.brief);rootMidi=brief.rootMidi;rootMode=brief.mode;startAt(0);return true;},
  stop(){assertActive();requestToken++;clear();offset=0;paused=false;},
  pause(){assertActive();requestToken++;if(playing){offset+=Math.max(0,context.currentTime-startedAt);clear();paused=true;}},
  async resume(){assertActive();const request=++requestToken;await unlock();assertActive();if(request!==requestToken)return false;if(paused&&sourceData){startAt(offset);return true;}return false;},
  setIntensity(value){assertActive();intensity=clamp(finiteNumber(value,'Intensity'),0,1);if(context){const barSeconds=(sourceData?.score?.meter||4)*60/(sourceData?.score?.bpm||92),position=offset+Math.max(0,context.currentTime-startedAt),untilBar=playing?(barSeconds-position%barSeconds)%barSeconds:0;intensityAt=context.currentTime+untilBar;for(const item of sources){item.gain.gain.cancelScheduledValues(context.currentTime);item.gain.gain.setTargetAtTime(levels(intensity)[item.id]??1,intensityAt,.15);}}return{intensity,scheduledContextTime:intensityAt};},
  setMuted(value){assertActive();muted=!!value;if(master)master.gain.setTargetAtTime(muted?0:.8,context.currentTime,.025);},
  async playEvent(id,options={}){
   assertActive();if(typeof id!=='string'||!id.trim())throw new TypeError('A nonempty sound event ID is required');
   options=options??{};const strength=finiteNumber(options.strength??1,'Sound strength'),pan=finiteNumber(options.pan??0,'Sound pan');
   await unlock();bank=bank||await loadSoundBank();assertActive();const now=context.currentTime;pruneVoices();
   if(voices.length>=12)return{accepted:false,reason:'voice-budget'};
   const voice=sfxVoice(context,sfx,id,{when:now+.004,strength,pan,bank,rootMidi,mode:rootMode,variant:variant++});totalEvents++;
   const entry={end:now+.004+voice.duration,nodes:voice.nodes,sentinel:context.createBufferSource()};
   // An audio-clock sentinel survives suspension without wall-clock tail truncation.
   entry.sentinel.buffer=context.createBuffer(1,1,context.sampleRate);entry.sentinel.connect(sfx);entry.sentinel.onended=()=>releaseVoice(entry);entry.sentinel.start(entry.end);voices.push(entry);
   music.gain.cancelScheduledValues(now);music.gain.setTargetAtTime(.75,now,.012);music.gain.setTargetAtTime(1,now+.11,.16);
   return{accepted:true,id:voice.id,scheduledDelayMs:4,source:voice.source};
  },
  getState(){pruneVoices();return{contextState:disposed?'closed':context?.state||'uninitialized',disposed,playing,paused,intensity,muted,position:playing?offset+Math.max(0,context.currentTime-startedAt):offset,totalEvents,activeSources:sources.length,retiringSources:retiringSources.size,stemLevels:Object.fromEntries(sources.map(s=>[s.id,s.gain.gain.value])),voiceCount:voices.length,retainedVoiceCount:voices.length,baseLatency:context?.baseLatency,outputLatency:context?.outputLatency,intensityAt};},
  getWaveform(){if(!analyser)return new Float32Array(0);const values=new Float32Array(analyser.fftSize);analyser.getFloatTimeDomainData(values);return values;},
  async dispose(){
   if(disposePromise)return disposePromise;if(disposed)return;disposed=true;requestToken++;clear(true);paused=false;offset=0;sourceData=undefined;bank=undefined;
   for(const voice of [...voices])releaseVoice(voice);
   for(const node of [music,sfx,compressor,master,analyser])try{node?.disconnect();}catch{}
   analyser=undefined;disposePromise=context&&context.state!=='closed'?context.close():Promise.resolve();return disposePromise;
  }
 };
}

export function encodeWav(buffer){
 const channels=buffer.numberOfChannels,length=buffer.length,bytes=new ArrayBuffer(44+length*channels*2),view=new DataView(bytes),write=(offset,text)=>{for(let i=0;i<text.length;i++)view.setUint8(offset+i,text.charCodeAt(i));};
 write(0,'RIFF');view.setUint32(4,bytes.byteLength-8,true);write(8,'WAVE');write(12,'fmt ');view.setUint32(16,16,true);view.setUint16(20,1,true);view.setUint16(22,channels,true);view.setUint32(24,buffer.sampleRate,true);view.setUint32(28,buffer.sampleRate*channels*2,true);view.setUint16(32,channels*2,true);view.setUint16(34,16,true);write(36,'data');view.setUint32(40,length*channels*2,true);
 const data=Array.from({length:channels},(_,ch)=>buffer.getChannelData(ch));let offset=44;for(let i=0;i<length;i++)for(let ch=0;ch<channels;ch++){const value=clamp(data[ch][i],-1,1);view.setInt16(offset,Math.round(value*(value<0?32768:32767)),true);offset+=2;}return bytes;
}
