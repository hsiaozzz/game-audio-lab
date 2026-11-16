import { EXAMPLE_PROMPTS, directPrompt } from './director.mjs';
import { composeScore } from './composer.mjs';
import * as AudioEngine from './audio-engine.mjs';

const $=id=>document.getElementById(id);
const ui=Object.fromEntries(['prompt','examples','generate','render-status','status-text','progress','score-style','score-title','score-description','score-tags','bindings','stage-status','scene-theme','event-toast','event-counter','event-buttons','intensity','intensity-value','play','pause','stop','mute','download','track-name','track-subtitle','waveform','track-list','bar-count','metric-duration','metric-notes','metric-render','metric-rate','game-scene'].map(id=>[id,$(id)]));
const runtime=AudioEngine.createAudioRuntime();
const examples=Array.isArray(EXAMPLE_PROMPTS)?EXAMPLE_PROMPTS:[];
const labels={cozy:'海岛钓鱼',neon:'霓虹动作',ruins:'遗迹探索'};
const eventLabels=[['ui','◌','界面'],['collect','✧','收集'],['hit','◇','命中'],['cast','⌁','抛投'],['splash','≈','入水'],['footstep','⋯','脚步'],['explosion','✳','爆炸'],['charge','↗','蓄力']];
const palettes={cozy:{water:'#233e4a',tile:'#527d70',edge:'#355c55',high:'#a3efce',top:'#e8d8b1',side:'#ac9d7b',dark:'#617665'},neon:{water:'#17213c',tile:'#343457',edge:'#262641',high:'#a9c8ff',top:'#9c8fc4',side:'#625582',dark:'#3d496f'},ruins:{water:'#242b35',tile:'#515c54',edge:'#35423c',high:'#d8d7a4',top:'#9a9f83',side:'#69735f',dark:'#43564e'}};
let currentScore=null,currentRender=null,currentMode='hybrid',busy=false,playing=false,paused=false,muted=false,eventCount=0,lastEvent=null,theme='cozy',renderToken=0,transportToken=0,transportPending=false,disposed=false;
const renderedById={},pressed=new Set(),hero={x:0,z:1},particles=[];
let sceneLast=performance.now(),stepDistance=0,toastTimer;

function status(text,error=false){ui['status-text'].textContent=text;ui['render-status'].classList.toggle('error',error);}
function setBusy(value){busy=value;ui.generate.disabled=value||disposed;ui.prompt.disabled=value||disposed;for(const button of document.querySelectorAll('#examples button,[data-mode]'))button.disabled=value||disposed;ui.progress.hidden=!value||disposed;ui.generate.innerHTML=value?'<span class="spark">◌</span> 正在编排与渲染 <span class="arrow">↗</span>':'<span class="spark">✧</span> 编排并渲染声音包 <span class="arrow">↗</span>';updateTransport();}
function selectExample(example){ui.prompt.value=example.prompt;for(const button of ui.examples.children)button.classList.toggle('selected',button.dataset.id===example.id);}
examples.forEach(example=>{const button=document.createElement('button');button.className='example-button';button.type='button';button.dataset.id=example.id;button.textContent=labels[example.id]||example.title||example.id;button.addEventListener('click',()=>selectExample(example));ui.examples.appendChild(button);});
if(examples[0])selectExample(examples[0]);
document.querySelectorAll('[data-mode]').forEach(button=>button.addEventListener('click',()=>{currentMode=button.dataset.mode;document.querySelectorAll('[data-mode]').forEach(item=>item.classList.toggle('active',item===button));}));

function describeScore(score){
  const brief=score.brief||{};theme=palettes[brief.style]?brief.style:'cozy';hero.x=0;hero.z=1;
  ui['score-style'].textContent=(brief.style||'custom').toUpperCase();ui['score-title'].textContent=brief.title||'游戏主题配乐';
  ui['score-description'].textContent=({cozy:'温暖的木琴主题、柔和键盘与轻盈的切分低音，用岛屿打击乐勾勒午后的节奏。',neon:'小调合成器主题、悬浮铺底与脉冲低音，在稳定节拍上逐步展开动作感。',ruins:'稀疏钟音、悬置的小调和声与低频脉冲，让拨弦回声留出探索的空间。'})[theme]||brief.description||`${score.bars} 小节主题与变奏，配合游戏事件组织声音。`;
  ui['score-tags'].replaceChildren(...[`${score.bpm} BPM`,`${score.meter||4}/4`,`${score.bars} 小节`,`${score.tracks.length} 音轨`].map(text=>{const el=document.createElement('span');el.textContent=text;return el;}));
  ui['scene-theme'].textContent=theme==='neon'?'NEON / ORBIT':theme==='ruins'?'RUINS / DUSK':'ISLAND / DAYLIGHT';
  ui.bindings.replaceChildren(...Object.entries(brief.eventBindings||{}).slice(0,8).map(([event,sound])=>{const line=document.createElement('div');const key=document.createElement('code');key.textContent=event;const value=document.createElement('span');value.textContent=`→ ${sound}`;line.append(key,value);return line;}));ui.bindings.hidden=!ui.bindings.childElementCount;
  ui['bar-count'].textContent=`${score.bars} BARS`;
  const colors=['#a3efce','#a4b9f0','#f0d6a1','#d2b8e8','#89bdce','#e8b9d1','#becf9b','#99b8e1'];
  const names={lead:'主题',harmony:'和声',bass:'低音',drums:'节奏',ornament:'点缀',pad:'铺底',kick:'底鼓',snare:'军鼓',hat:'踩镲',shaker:'沙锤'};
  ui['track-list'].replaceChildren(...score.tracks.map((track,index)=>{
    const row=document.createElement('div');row.className='track-row';row.style.setProperty('--track-color',colors[index%colors.length]);
    const label=document.createElement('span');label.className='track-label';const dot=document.createElement('i');label.append(dot,document.createTextNode(names[track.instrument]||names[track.role]||track.id));
    const bars=document.createElement('div');bars.className='track-bars';bars.style.setProperty('--bars',score.bars);
    const counts=Array.from({length:score.bars},()=>0);for(const event of track.events||[]){const bar=Math.floor(event.beat/(score.meter||4));if(bar>=0&&bar<counts.length)counts[bar]++;}
    const max=Math.max(1,...counts);for(const count of counts){const block=document.createElement('span');block.style.setProperty('--opacity',count?String(.3+.7*count/max):'.08');block.title=`${count} 个音符事件`;bars.appendChild(block);}
    row.append(label,bars);return row;
  }));
  ui['metric-notes'].textContent=String(score.tracks.reduce((sum,track)=>sum+(track.events?.length||0),0));
}

function drawWaveform(buffer){
  const canvas=ui.waveform,ctx=canvas.getContext('2d'),width=canvas.width,height=canvas.height;ctx.clearRect(0,0,width,height);ctx.strokeStyle='#35445b';ctx.beginPath();ctx.moveTo(0,height/2);ctx.lineTo(width,height/2);ctx.stroke();
  if(!buffer){ctx.fillStyle='#7e8ba3';ctx.font='12px "Segoe UI", "Microsoft YaHei", sans-serif';ctx.textAlign='center';ctx.fillText('等待音频渲染',width/2,height/2-10);ctx.textAlign='start';canvas.setAttribute('aria-label','尚未渲染音频');return;}
  canvas.setAttribute('aria-label','配乐实际 PCM 波形');
  const data=buffer.getChannelData(0),bins=180,step=Math.max(1,Math.floor(data.length/bins));ctx.fillStyle='#a3efce';
  for(let i=0;i<bins;i++){let peak=0;for(let j=i*step;j<Math.min(data.length,(i+1)*step);j+=Math.max(1,Math.floor(step/80)))peak=Math.max(peak,Math.abs(data[j]));const h=Math.max(2,peak*(height-10));ctx.globalAlpha=.5+peak*.5;ctx.fillRect(i*width/bins,height/2-h/2,2.4,h);}ctx.globalAlpha=1;
}

async function renderCurrent(options={}){
  if(disposed)throw new Error('实验会话已关闭，请重新打开页面');
  if(busy)throw new Error('已有音频渲染任务正在运行');
  const prompt=options.prompt??ui.prompt.value;if(!String(prompt).trim())throw new Error('请先写下游戏描述');
  const token=++renderToken;setBusy(true);status('正在解析游戏描述，组织主题与声音事件……');
  try{
    stopMusic();currentScore=null;currentRender=null;drawWaveform(null);updateTransport();
    ui['track-name'].textContent='正在渲染配乐';ui['track-subtitle'].textContent='等待当前任务完成';
    for(const id of ['metric-duration','metric-notes','metric-render','metric-rate'])ui[id].textContent='—';
    ui['score-title'].textContent='正在编排声音包';ui['score-description'].textContent='正在根据当前游戏描述组织主题与声音事件。';ui['score-style'].textContent='RENDERING';ui['score-tags'].replaceChildren();ui['track-list'].replaceChildren();ui.bindings.replaceChildren();ui.bindings.hidden=true;ui['bar-count'].textContent='— BARS';
    const started=performance.now(),brief=directPrompt(prompt,{seed:options.seed}),score=composeScore(brief);
    const mode=options.mode||currentMode;status(`已完成 ${score.bars} 小节编排，正在离线渲染乐谱……`);
    await new Promise(resolve=>requestAnimationFrame(()=>resolve()));
    const rendered=await AudioEngine.renderScore(score,{mode,sampleRate:options.sampleRate||44100});
    if(token!==renderToken||disposed)throw new Error('渲染任务已被替换');
    const buffer=rendered.buffer;if(!buffer?.getChannelData)throw new Error('音频引擎未返回有效 AudioBuffer');
    currentRender=rendered;currentScore=score;currentRender.mode=mode;currentRender.uiRenderMs=performance.now()-started;describeScore(score);
    renderedById[brief.id||brief.style||'current']=currentRender;if(brief.style)renderedById[brief.style]=currentRender;
    ui['metric-duration'].textContent=`${buffer.duration.toFixed(1)} s`;ui['metric-render'].textContent=`${(currentRender.uiRenderMs/1000).toFixed(2)} s`;ui['metric-rate'].textContent=`${(buffer.sampleRate/1000).toFixed(1)}k`;
    const source=rendered.stats.instrumentSource;
    const sourceLabel=source==='synthesis'?'合成配器':source==='VSCO2 CE marimba + synthesis'?'VSCO2 木琴采样 + 合成':source;
    ui['track-name'].textContent=brief.title||'游戏主题配乐';ui['track-subtitle'].textContent=`${sourceLabel} · ${score.bpm} BPM · ${buffer.duration.toFixed(1)} 秒`;
    drawWaveform(buffer);updateTransport();
    const scopeNote=mode==='hybrid'&&source==='synthesis'?'该风格当前为合成配器，采样用于事件音效。':'点击播放，在固定演示场景中触发音效。';
    status(`声音包已渲染。${brief.director?.matched===false?'提示词未匹配已支持风格，本次使用海岛休闲配置。':''}${scopeNote}`);return currentRender;
  }catch(error){currentRender=null;currentScore=null;if(!disposed){drawWaveform(null);ui['track-name'].textContent='配乐渲染失败';ui['track-subtitle'].textContent='请重新编排并渲染';ui['score-title'].textContent='声音包尚未生成';ui['score-style'].textContent='WAITING';status(`渲染失败：${error.message}`,true);}throw error;}finally{setBusy(false);}
}

function updateTransport(){const unavailable=disposed||busy||!currentRender;ui.play.disabled=unavailable||transportPending;ui.pause.disabled=unavailable||transportPending||!playing;ui.stop.disabled=unavailable;ui.download.disabled=unavailable;ui.play.textContent=transportPending?'…':playing&&!paused?'↻':'▶';ui.play.setAttribute('aria-label',transportPending?'正在准备播放':playing&&!paused?'重新播放配乐':'播放配乐');ui.pause.textContent=paused?'继续':'暂停';ui['stage-status'].innerHTML=`<i></i> ${playing&&!paused?'配乐播放中':'固定演示场景'}`;}
function stopMusic(){transportToken++;transportPending=false;runtime.stop();playing=false;paused=false;updateTransport();}
async function playMusic(){
  if(disposed)throw new Error('实验会话已关闭，请重新打开页面');
  if(!currentRender||busy||transportPending||document.hidden)return false;
  const token=++transportToken,rendered=currentRender;transportPending=true;updateTransport();
  try{
    await runtime.unlock();if(token!==transportToken||disposed||document.hidden)return false;
    runtime.setMuted(muted);const accepted=await runtime.play(rendered,{loop:true});
    if(token!==transportToken||disposed||document.hidden)return false;
    playing=accepted!==false;paused=false;runtime.setIntensity(Number(ui.intensity.value));return playing;
  }catch(error){if(token!==transportToken||disposed)return false;runtime.stop();playing=false;paused=false;throw error;}
  finally{if(token===transportToken){transportPending=false;updateTransport();}}
}
async function togglePause(){
  if(disposed||busy||transportPending||!playing)return;
  if(!paused){transportToken++;runtime.pause();paused=true;updateTransport();return;}
  const token=++transportToken;transportPending=true;updateTransport();
  try{
    await runtime.unlock();if(token!==transportToken||disposed||document.hidden)return;
    runtime.setMuted(muted);const accepted=await runtime.resume();
    if(token!==transportToken||disposed||document.hidden)return;
    if(accepted!==false)paused=false;
  }catch(error){if(token!==transportToken||disposed)return;runtime.stop();playing=false;paused=false;throw error;}
  finally{if(token===transportToken){transportPending=false;updateTransport();}}
}
ui.generate.addEventListener('click',()=>renderCurrent().catch(console.error));
ui.play.addEventListener('click',()=>playMusic().catch(error=>status(`播放失败：${error.message}`,true)));
ui.pause.addEventListener('click',()=>togglePause().catch(error=>status(`播放失败：${error.message}`,true)));
ui.stop.addEventListener('click',stopMusic);
ui.mute.addEventListener('click',()=>{muted=!muted;runtime.setMuted(muted);ui.mute.textContent=muted?'取消静音':'静音';ui.mute.setAttribute('aria-pressed',String(muted));updateTransport();});
ui.intensity.addEventListener('input',()=>{const value=Number(ui.intensity.value);ui['intensity-value'].textContent=`${Math.round(value*100)}%`;runtime.setIntensity(value);});

function showEvent(id,label){eventCount++;lastEvent={id,at:performance.now()};ui['event-counter'].textContent=`${eventCount} 次触发`;ui['event-toast'].textContent=`${label} / ${id}`;ui['event-toast'].classList.add('show');clearTimeout(toastTimer);toastTimer=setTimeout(()=>ui['event-toast'].classList.remove('show'),1600);const color=palettes[theme].high;for(let i=0;i<12;i++)particles.push({x:hero.x,z:hero.z,y:.4,dx:(Math.random()-.5)*2,dz:(Math.random()-.5)*2,dy:.8+Math.random(),life:1,color});}
async function triggerEvent(id,options={}){if(disposed)throw new Error('实验会话已关闭，请重新打开页面');await runtime.unlock();if(disposed)throw new Error('实验会话已关闭，请重新打开页面');if(document.hidden)return{accepted:false,reason:'background',event:id,count:eventCount,state:runtime.getState()};runtime.setMuted(muted);const result=await runtime.playEvent(id,{strength:.8,pan:Math.max(-.7,Math.min(.7,hero.x/5)),...options});if(disposed)return{accepted:false,reason:'disposed',event:id,count:eventCount};if(result?.accepted!==false)showEvent(id,eventLabels.find(event=>event[0]===id)?.[2]||id);return{...result,accepted:result?.accepted!==false,event:id,count:eventCount,state:runtime.getState()};}
eventLabels.forEach(([id,icon,label])=>{const button=document.createElement('button');button.className='event-button';button.type='button';button.dataset.event=id;button.innerHTML=`<span class="event-icon">${icon}</span>${label}`;button.addEventListener('click',async()=>{try{const result=await triggerEvent(id);if(!result.accepted){if(result.reason==='voice-budget')status('同时播放的音效已达上限，本次未触发。');return;}button.classList.add('firing');setTimeout(()=>button.classList.remove('firing'),220);}catch(error){if(!disposed)status(`音效失败：${error.message}`,true);}});ui['event-buttons'].appendChild(button);});

function encodeWav(buffer){const channels=buffer.numberOfChannels,length=buffer.length,bytes=44+length*channels*2,view=new DataView(new ArrayBuffer(bytes));const write=(offset,text)=>{for(let i=0;i<text.length;i++)view.setUint8(offset+i,text.charCodeAt(i));};write(0,'RIFF');view.setUint32(4,bytes-8,true);write(8,'WAVE');write(12,'fmt ');view.setUint32(16,16,true);view.setUint16(20,1,true);view.setUint16(22,channels,true);view.setUint32(24,buffer.sampleRate,true);view.setUint32(28,buffer.sampleRate*channels*2,true);view.setUint16(32,channels*2,true);view.setUint16(34,16,true);write(36,'data');view.setUint32(40,bytes-44,true);const data=Array.from({length:channels},(_,i)=>buffer.getChannelData(i));let offset=44;for(let i=0;i<length;i++)for(let c=0;c<channels;c++){const value=Math.max(-1,Math.min(1,data[c][i]));view.setInt16(offset,value<0?value*32768:value*32767,true);offset+=2;}return view.buffer;}
ui.download.addEventListener('click',()=>{if(!currentRender||busy||disposed)return;const url=URL.createObjectURL(new Blob([encodeWav(currentRender.buffer)],{type:'audio/wav'})),link=document.createElement('a');link.href=url;link.download=`game-audio-${currentScore?.brief?.style||'theme'}-${currentRender.mode||currentMode}.wav`;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);});

const canvas=ui['game-scene'],ctx=canvas.getContext('2d');
function iso(x,z,y=0){return{x:canvas.width/2+(x-z)*43,y:canvas.height/2+25+(x+z)*20-y*42};}
function polygon(points,fill){ctx.beginPath();points.forEach((point,index)=>index?ctx.lineTo(point.x,point.y):ctx.moveTo(point.x,point.y));ctx.closePath();ctx.fillStyle=fill;ctx.fill();}
function box(x,z,width,depth,height,color,side){const a=iso(x-width/2,z-depth/2,height),b=iso(x+width/2,z-depth/2,height),c=iso(x+width/2,z+depth/2,height),d=iso(x-width/2,z+depth/2,height),e=iso(x+width/2,z-depth/2),f=iso(x+width/2,z+depth/2),g=iso(x-width/2,z+depth/2);polygon([b,c,f,e],side);polygon([c,d,g,f],side);polygon([a,b,c,d],color);}
function drawScene(now){if(disposed)return;const dt=Math.min(.05,(now-sceneLast)/1000);sceneLast=now;const p=palettes[theme];ctx.fillStyle=p.water;ctx.fillRect(0,0,canvas.width,canvas.height);
  ctx.strokeStyle=theme==='neon'?'#3a416e':'#3c5961';ctx.lineWidth=1;for(let i=0;i<9;i++){const y=80+i*33;ctx.beginPath();for(let x=0;x<canvas.width;x+=12){const yy=y+Math.sin(x/80+now*.00025+i)*3;x?ctx.lineTo(x,yy):ctx.moveTo(x,yy);}ctx.stroke();}
  let dx=Number(pressed.has('KeyD')||pressed.has('ArrowRight'))-Number(pressed.has('KeyA')||pressed.has('ArrowLeft')),dz=Number(pressed.has('KeyS')||pressed.has('ArrowDown'))-Number(pressed.has('KeyW')||pressed.has('ArrowUp'));const length=Math.hypot(dx,dz)||1;hero.x=Math.max(-2.8,Math.min(2.8,hero.x+dx/length*dt*2.6));hero.z=Math.max(-2.8,Math.min(2.8,hero.z+dz/length*dt*2.6));if(dx||dz){stepDistance+=dt*2.6;if(stepDistance>.8){stepDistance=0;triggerEvent('footstep',{strength:.45}).catch(()=>{});}}
  box(0,0,7,7,.22,p.tile,p.edge);ctx.strokeStyle='#a9c6ae15';for(let i=-3;i<=3;i++){const a=iso(i,-3.4,.23),b=iso(i,3.4,.23);ctx.beginPath();ctx.moveTo(a.x,a.y);ctx.lineTo(b.x,b.y);ctx.stroke();}
  const objects=[{x:-2.3,z:-1.5,w:.7,d:.7,h:1.7},{x:1.6,z:-2.3,w:.9,d:.8,h:1.1},{x:2.4,z:.3,w:.6,d:.7,h:1.7},{x:-1.7,z:2.1,w:.6,d:.6,h:.65}];
  const sceneObjects=objects.map(object=>({...object,type:'pillar'}));sceneObjects.push({x:hero.x,z:hero.z,type:'hero'});sceneObjects.sort((a,b)=>(a.x+a.z)-(b.x+b.z));
  for(const object of sceneObjects){if(object.type==='hero'){const q=iso(hero.x,hero.z,.23);ctx.fillStyle='#0d242955';ctx.beginPath();ctx.ellipse(q.x,q.y+3,13,6,0,0,Math.PI*2);ctx.fill();box(hero.x,hero.z,.31,.31,.78,p.high,'#6eaa98');const head=iso(hero.x,hero.z,.9);ctx.fillStyle='#f5e9c3';ctx.beginPath();ctx.arc(head.x,head.y,8,0,Math.PI*2);ctx.fill();}else{box(object.x,object.z,object.w,object.d,object.h,p.top,p.side);if(theme==='cozy'){const crown=iso(object.x,object.z,object.h+.15);polygon([{x:crown.x,y:crown.y-22},{x:crown.x+20,y:crown.y+8},{x:crown.x-20,y:crown.y+8}],p.high);}}}
  for(const [x,z]of [[-1,-1],[1,.7],[-.7,2]]){const point=iso(x,z,.7+Math.sin(now*.002+x)*.08);polygon([{x:point.x,y:point.y-8},{x:point.x+6,y:point.y},{x:point.x,y:point.y+8},{x:point.x-6,y:point.y}],p.high);}
  for(let i=particles.length-1;i>=0;i--){const particle=particles[i];particle.life-=dt;particle.x+=particle.dx*dt;particle.z+=particle.dz*dt;particle.y+=particle.dy*dt;particle.dy-=dt*2;if(particle.life<=0){particles.splice(i,1);continue;}const point=iso(particle.x,particle.z,particle.y);ctx.globalAlpha=particle.life;ctx.fillStyle=particle.color;ctx.fillRect(point.x,point.y,3,3);}ctx.globalAlpha=1;
  requestAnimationFrame(drawScene);
}
canvas.addEventListener('keydown',event=>{if(['KeyW','KeyA','KeyS','KeyD','ArrowUp','ArrowDown','ArrowLeft','ArrowRight'].includes(event.code)){pressed.add(event.code);event.preventDefault();}});window.addEventListener('keyup',event=>pressed.delete(event.code));canvas.addEventListener('blur',()=>pressed.clear());canvas.addEventListener('click',()=>{canvas.focus();triggerEvent('collect').catch(error=>status(error.message,true));});
function suspendMusic(){if(disposed)return;pressed.clear();transportToken++;transportPending=false;runtime.pause();if(playing)paused=true;updateTransport();}
document.addEventListener('visibilitychange',()=>{if(document.hidden)suspendMusic();});window.addEventListener('pagehide',suspendMusic);
drawWaveform(null);requestAnimationFrame(drawScene);

window.__audioLab={get ready(){return !disposed;},get currentScore(){return currentScore;},get currentRender(){return currentRender;},runtime,renderedById,renderCurrent,triggerEvent,encodeWav,getState:()=>({ready:!disposed,busy,playing,paused,muted,mode:currentMode,style:currentScore?.brief?.style||null,eventCount,lastEvent,hero:{...hero},runtime:runtime.getState(),renderStats:currentRender?.stats||null}),async renderExample(id,options={}){if(busy)throw new Error('已有音频渲染任务正在运行');const example=examples.find(item=>item.id===id);if(!example)throw new Error('未知示例 '+id);selectExample(example);return renderCurrent({...options,prompt:example.prompt});},async renderExamples(options={}){const results=[];for(const example of examples){const rendered=await this.renderExample(example.id,options);results.push({id:example.id,score:currentScore,rendered});}return results;},async renderSfx(brief=currentScore?.brief){if(disposed)throw new Error('实验会话已关闭，请重新打开页面');return AudioEngine.renderSfxReel(brief);},async dispose(){if(disposed)return;disposed=true;renderToken++;transportToken++;transportPending=false;pressed.clear();clearTimeout(toastTimer);playing=false;paused=false;updateTransport();document.querySelectorAll('button,textarea,input').forEach(element=>element.disabled=true);ui.progress.hidden=true;await runtime.dispose();status('实验会话已关闭。重新打开页面可开始新的实验。');}};
