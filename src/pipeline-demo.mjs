import {createAudioRuntime,renderScore} from './audio-engine.mjs';
import {createGameAudioAdapter,createGameRevisionIdentity,validateGameAudioJoin} from './game-audio-pipeline.mjs';
import {createGameAudioBridge,gameAudioClientSource} from './game-audio-bridge.mjs';

const $=id=>document.getElementById(id);
const ui=Object.fromEntries(['game-prompt','generate','brief-revision','brief-identity','game-task','game-state','game-version','game-timing','audio-task','audio-state','audio-version','audio-timing','host-status','game-frame','game-empty','start-audio','pause-audio','audio-availability','intensity','intensity-value','collect-count','hit-count','accepted-count','page-status','plan-details','event-log'].map(id=>[id,$(id)]));
const profiles={
  cozy:{title:'海岛拾光',prompt:'做一个温暖的海岛收集游戏，探索午后的岛屿，拾取发光的贝壳，碰到岩石时有清楚的受击反馈。配乐轻盈、温暖、没有人声。'},
  neon:{title:'霓虹穿行',prompt:'做一个霓虹太空动作游戏，驾驶飞船收集能量晶体并避开障碍。配乐使用有节奏的电子合成器，拾取与受击反馈清楚，没有人声。'}
};
const eventContract={version:1,events:[
  {id:'ui.confirm',cue:'ui',required:true,maxRatePerSecond:4},
  {id:'item.collect',cue:'collect',required:true,maxRatePerSecond:6},
  {id:'player.hit',cue:'hit',required:true,maxRatePerSecond:3}
],sceneStates:['menu','exploration','combat','reward']};
let profile='cozy',revision=0,generation=0,playbackEpoch=0,busy=false,startPending=false,disposed=false,plan=null,rendered=null,adapter=null,bridge=null,requestController=null,ticker=null,audioStarted=false,audioPaused=false;
let counts={collect:0,hit:0,accepted:0},eventEntries=[];

function showStatus(message,error=false){ui['page-status'].textContent=message;ui['page-status'].classList.toggle('error',error);}
function task(kind,state,message,versionText){ui[`${kind}-task`].classList.toggle('ready',state==='ready');ui[`${kind}-task`].classList.toggle('failed',state==='failed');ui[`${kind}-state`].textContent=message;if(versionText)ui[`${kind}-version`].textContent=versionText;}
function setBusy(value){busy=value;ui.generate.disabled=value||disposed;ui['game-prompt'].disabled=value||disposed;for(const button of document.querySelectorAll('[data-profile]'))button.disabled=value||disposed;ui.generate.innerHTML=value?'正在生成声音 <span aria-hidden="true">◌</span>':'生成并接入 <span aria-hidden="true">↗</span>';updateControls();}
function updateControls(){ui['start-audio'].disabled=disposed||busy||startPending||!rendered||!adapter;ui['pause-audio'].disabled=disposed||!audioStarted||audioPaused||startPending;ui.intensity.disabled=disposed||!audioStarted;ui['start-audio'].innerHTML=`${startPending?'正在开启声音':audioPaused?'继续有声试玩':audioStarted?'重新播放配乐':'开始有声试玩'} <span aria-hidden="true">${startPending?'◌':'▶'}</span>`;}
function renderCounts(){ui['collect-count'].textContent=String(counts.collect);ui['hit-count'].textContent=String(counts.hit);ui['accepted-count'].textContent=String(counts.accepted);}
function logEvent({operation,eventId,payload,result},source='游戏'){
  if(operation==='emit'){
    if(eventId==='item.collect')counts.collect++;
    if(eventId==='player.hit')counts.hit++;
    if(result?.accepted)counts.accepted++;
    renderCounts();
  }
  const label=operation==='emit'?eventId:operation;
  const reason=result?.accepted?'已回应':({
    'audio-not-ready':'声音尚未接入','rate-limited':'触发过快，已限流','voice-budget':'并发声音已达上限','locked':'等待开启声音'
  }[result?.reason]||result?.reason||'未接受');
  eventEntries.unshift({at:new Date().toLocaleTimeString('zh-CN',{hour12:false}),source,label,result:result?.accepted?'accepted':'rejected',reason,payload});eventEntries=eventEntries.slice(0,40);
  ui['event-log'].replaceChildren(...eventEntries.map(entry=>{const item=document.createElement('li');item.classList.toggle('accepted',entry.result==='accepted');const time=document.createElement('time');time.textContent=entry.at;item.append(time,document.createTextNode(`${entry.source} · ${entry.label} → ${entry.reason}`));return item;}));
}
function describePlan(extra={}){
  ui['plan-details'].textContent=JSON.stringify(plan?{projectId:plan.projectId,revision:plan.revision,briefHash:plan.briefHash,eventContractVersion:plan.contractVersion,eventContractHash:plan.contractHash,planId:plan.planId,bindings:plan.bindings,music:rendered?{bpm:plan.score.bpm,durationSeconds:Number(rendered.buffer.duration.toFixed(2)),stems:Object.keys(rendered.stems||{}),sampleRate:rendered.buffer.sampleRate}:null,...extra}:extra,null,2);
}
async function requestPlan(gameBrief,signal,gameIdentity){
  const response=await fetch('/api/audio/plan',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({gameBrief,eventContract,options:{seed:1701+gameBrief.revision}}),signal});
  const body=await response.json();
  if(!response.ok)throw new Error(body.error?.message||body.error||`声音计划服务返回 ${response.status}`);
  const next=body.plan;
  if(!next?.briefHash||next.projectId!==gameBrief.projectId||next.revision!==gameBrief.revision||next.contractVersion!==eventContract.version)throw new Error('声音计划与当前设计版本不匹配');
  const joined=validateGameAudioJoin(gameIdentity,next);
  if(!joined.accepted)throw new Error(`声音计划与游戏设计不匹配：${joined.reason}`);
  return next;
}

// The fixed host is independent from the audio renderer and does not fetch any resources.
function installGame(config){
  const canvas=document.getElementById('scene'),ctx=canvas.getContext('2d'),keys=new Set();
  const neon=config.theme==='neon',palette=neon?{bg:'#161d35',line:'#36416c',floor:'#263455',hero:'#a9cdff',crystal:'#b4f6e4',obstacle:'#776ba5',shadow:'#0a142b'}:{bg:'#1a3740',line:'#355c60',floor:'#375e59',hero:'#b3f2c9',crystal:'#e9dc9c',obstacle:'#7c9584',shadow:'#122d32'};
  const player={x:100,y:190},items=[{x:205,y:120},{x:430,y:250},{x:620,y:130}],rocks=[{x:325,y:130,r:24},{x:550,y:248,r:26},{x:220,y:275,r:20}];
  let collected=0,hits=0,last=performance.now(),lastHit=-1000,flash=0,pulse=null,sequence=0,disposed=false;
  const hint=document.getElementById('hint'),counter=document.getElementById('counter');
  function report(id,strength=1){
    void window.GameAudio.emit(id,{strength,pan:Math.max(-.7,Math.min(.7,(player.x-390)/550))}).then(result=>{hint.textContent=result.accepted?'动作已传给声音宿主':'游戏继续 · 声音尚未回应';});
  }
  function collect(index=0){const item=items[index];collected++;pulse={x:item.x,y:item.y,life:1};item.x=110+((++sequence*137+index*83)%560);item.y=75+((sequence*97+index*51)%230);counter.textContent=`拾取 ${collected} · 碰撞 ${hits}`;report('item.collect',.8);}
  function hit(){hits++;flash=1;counter.textContent=`拾取 ${collected} · 碰撞 ${hits}`;report('player.hit',.72);}
  function draw(now){
    if(disposed)return;
    const dt=Math.min(.05,(now-last)/1000);last=now;
    let x=Number(keys.has('ArrowRight')||keys.has('KeyD'))-Number(keys.has('ArrowLeft')||keys.has('KeyA')),y=Number(keys.has('ArrowDown')||keys.has('KeyS'))-Number(keys.has('ArrowUp')||keys.has('KeyW'));
    const distance=Math.hypot(x,y)||1;player.x=Math.max(22,Math.min(758,player.x+x/distance*dt*170));player.y=Math.max(35,Math.min(355,player.y+y/distance*dt*170));
    ctx.fillStyle=palette.bg;ctx.fillRect(0,0,780,390);ctx.strokeStyle=palette.line;ctx.lineWidth=1;
    for(let row=0;row<9;row++){const yy=35+row*41;ctx.beginPath();ctx.moveTo(0,yy);ctx.lineTo(780,yy);ctx.stroke();}
    for(let col=0;col<18;col++){const xx=col*46;ctx.beginPath();ctx.moveTo(xx,25);ctx.lineTo(xx,390);ctx.stroke();}
    ctx.fillStyle=palette.floor;ctx.globalAlpha=.55;ctx.fillRect(33,40,714,315);ctx.globalAlpha=1;
    for(const rock of rocks){ctx.fillStyle=palette.shadow;ctx.beginPath();ctx.ellipse(rock.x+3,rock.y+9,rock.r+4,rock.r*.55,0,0,Math.PI*2);ctx.fill();ctx.fillStyle=palette.obstacle;ctx.beginPath();ctx.moveTo(rock.x-rock.r,rock.y+7);ctx.lineTo(rock.x-rock.r*.6,rock.y-rock.r*.8);ctx.lineTo(rock.x+rock.r*.5,rock.y-rock.r);ctx.lineTo(rock.x+rock.r,rock.y+7);ctx.closePath();ctx.fill();if(Math.hypot(player.x-rock.x,player.y-rock.y)<rock.r+12&&now-lastHit>900){lastHit=now;hit();player.x=Math.max(22,player.x-24);}}
    items.forEach((item,index)=>{const lift=Math.sin(now*.003+index)*4;ctx.fillStyle=palette.crystal;ctx.beginPath();ctx.moveTo(item.x,item.y-11+lift);ctx.lineTo(item.x+8,item.y+lift);ctx.lineTo(item.x,item.y+11+lift);ctx.lineTo(item.x-8,item.y+lift);ctx.closePath();ctx.fill();if(Math.hypot(player.x-item.x,player.y-item.y)<22)collect(index);});
    ctx.fillStyle=palette.shadow;ctx.beginPath();ctx.ellipse(player.x,player.y+13,17,7,0,0,Math.PI*2);ctx.fill();ctx.fillStyle=flash>0?'#f3b1b9':palette.hero;ctx.beginPath();if(neon){ctx.moveTo(player.x,player.y-17);ctx.lineTo(player.x+15,player.y+13);ctx.lineTo(player.x,player.y+7);ctx.lineTo(player.x-15,player.y+13);ctx.closePath();}else{ctx.arc(player.x,player.y,12,0,Math.PI*2);}ctx.fill();flash=Math.max(0,flash-dt*2);
    if(pulse){pulse.life-=dt*1.8;ctx.strokeStyle=palette.crystal;ctx.globalAlpha=Math.max(0,pulse.life);ctx.beginPath();ctx.arc(pulse.x,pulse.y,12+(1-pulse.life)*40,0,Math.PI*2);ctx.stroke();ctx.globalAlpha=1;if(pulse.life<=0)pulse=null;}
    requestAnimationFrame(draw);
  }
  const movement=['ArrowUp','ArrowDown','ArrowLeft','ArrowRight','KeyW','KeyA','KeyS','KeyD'];
  addEventListener('keydown',event=>{if(movement.includes(event.code)){keys.add(event.code);event.preventDefault();}});addEventListener('keyup',event=>keys.delete(event.code));addEventListener('blur',()=>keys.clear());document.addEventListener('visibilitychange',()=>{if(document.hidden)keys.clear();});
  document.querySelectorAll('[data-move]').forEach(button=>{const code=button.dataset.move;button.addEventListener('pointerdown',event=>{event.preventDefault();keys.add(code);button.setPointerCapture(event.pointerId);});for(const type of ['pointerup','pointercancel','lostpointercapture'])button.addEventListener(type,()=>keys.delete(code));});
  document.getElementById('collect').addEventListener('click',()=>collect(0));document.getElementById('hit').addEventListener('click',hit);document.getElementById('confirm').addEventListener('click',()=>report('ui.confirm',.65));
  document.getElementById('world').textContent=`${config.title} / r${config.revision}`;
  window.GameAudio.ready.then(metadata=>{hint.textContent=`共享设计 r${metadata.revision} · 方向键 / WASD 移动`;
    // Scene metadata is explicit; it does not pretend to compose or switch a new song.
  });
  addEventListener('pagehide',()=>{disposed=true;keys.clear();});requestAnimationFrame(draw);
}

function gameDocument(gameBrief,theme){
  const config={theme,title:profiles[theme].title,revision:gameBrief.revision};
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'none'"><style>*{box-sizing:border-box}html,body{height:100%;margin:0;background:#172936;color:#c8dcd5;font-family:'Segoe UI','Microsoft YaHei',sans-serif}body{display:flex;flex-direction:column}header{padding:10px 13px;display:flex;justify-content:space-between;gap:10px;font-size:10px;color:#a2c7b7}header span:last-child{color:#829ea9}canvas{display:block;width:100%;flex:1;min-height:0;object-fit:contain;background:#172e39;outline:none}.controls{display:flex;align-items:center;gap:7px;padding:10px 12px;background:#182b38;flex-wrap:wrap}.movement{display:flex;gap:4px;margin-right:auto}button{border:1px solid #527468;border-radius:5px;background:#29413c;color:#c3e8d7;font-size:10px;padding:7px 9px;cursor:pointer;touch-action:none}button:focus-visible{outline:2px solid #a3efce;outline-offset:2px}.hint{margin:0;padding:0 12px 9px;color:#7d9da8;background:#182b38;font-size:9px}@media(max-width:400px){.controls{gap:5px;padding:8px}.movement{gap:3px}button{padding:7px;font-size:9px}header{font-size:9px}}</style></head><body><header><span id="world"></span><span id="counter">拾取 0 · 碰撞 0</span></header><canvas id="scene" width="780" height="390" tabindex="0" aria-label="方向键或 WASD 移动，接触光点收集，接触岩石受击"></canvas><div class="controls"><div class="movement" aria-label="移动控制"><button type="button" data-move="ArrowLeft" aria-label="向左">←</button><button type="button" data-move="ArrowUp" aria-label="向上">↑</button><button type="button" data-move="ArrowDown" aria-label="向下">↓</button><button type="button" data-move="ArrowRight" aria-label="向右">→</button></div><button id="collect" type="button">试拾取</button><button id="hit" type="button">试受击</button><button id="confirm" type="button">确认</button></div><p id="hint" class="hint">方向键 / WASD 移动 · 下方按钮可快速验证动作声音</p><script>${gameAudioClientSource()}</script><script>(${installGame.toString()})(${JSON.stringify(config)});</script></body></html>`;
}
function mountGame(gameBrief,theme,token,started){
  ui['game-empty'].hidden=true;
  return new Promise(resolve=>{
    ui['game-frame'].addEventListener('load',()=>{if(token!==generation||disposed){resolve(false);return;}task('game','ready','已可试玩 · 声音制作不阻塞玩法');ui['game-timing'].textContent=`${((performance.now()-started)/1000).toFixed(2)} s`;ui['host-status'].textContent='游戏已就绪';resolve(true);},{once:true});
    ui['game-frame'].srcdoc=gameDocument(gameBrief,theme);
  });
}
async function generate(){
  if(busy||disposed)return;
  const prompt=ui['game-prompt'].value.trim();if(!prompt){showStatus('先写下游戏描述。',true);ui['game-prompt'].focus();return;}
  const token=++generation,started=performance.now(),previousAdapter=adapter;playbackEpoch++;
  bridge?.dispose();bridge=null;adapter=null;plan=null;rendered=null;audioStarted=false;audioPaused=false;startPending=false;
  counts={collect:0,hit:0,accepted:0};eventEntries=[];renderCounts();ui['event-log'].replaceChildren();
  const gameBrief={schemaVersion:1,projectId:'pipeline-demo',revision:++revision,prompt};
  ui['brief-revision'].textContent=`r${revision}`;ui['brief-identity'].textContent='正在确认共享设计指纹';ui['audio-availability'].textContent='游戏可先玩，声音随后接入';ui['audio-timing'].textContent='—';ui['game-timing'].textContent='—';ui['host-status'].textContent='正在建立游戏';
  task('game','running','启动固定示例小游戏',`共享设计 r${revision}`);task('audio','running','请求独立声音服务',`共享设计 r${revision}`);describePlan({gameBrief,eventContract});setBusy(true);showStatus('小游戏正在启动；声音计划与渲染在另一条任务中进行。');
  const gameReady=mountGame(gameBrief,profile,token,started);
  requestController=new AbortController();const timeout=setTimeout(()=>requestController?.abort(),30000);
  ticker=setInterval(()=>{if(token===generation)ui['audio-timing'].textContent=`已用 ${((performance.now()-started)/1000).toFixed(1)} s`;},200);
  try{
    await previousAdapter?.dispose();
    const gameIdentity=await createGameRevisionIdentity(gameBrief,eventContract);if(token!==generation||disposed)return;
    ui['game-version'].textContent=`r${gameIdentity.revision} · ${gameIdentity.briefHash.slice(0,12)}`;
    ui['brief-identity'].textContent=`设计指纹 ${gameIdentity.briefHash.slice(0,20)}`;
    const next=await requestPlan(gameBrief,requestController.signal,gameIdentity);clearTimeout(timeout);if(token!==generation||disposed)return;
    plan=next;adapter=createGameAudioAdapter({plan,runtime:createAudioRuntime()});
    const identity=`r${revision} · ${plan.briefHash.slice(0,12)}`;
    ui['brief-identity'].textContent=`设计指纹 ${plan.briefHash.slice(0,20)}`;ui['game-version'].textContent=identity;ui['audio-version'].textContent=identity;describePlan();
    bridge=createGameAudioBridge({iframe:ui['game-frame'],plan,adapter,onEvent:event=>{if(token===generation&&!disposed)logEvent(event);},onState:state=>{if(token===generation&&!disposed&&state.connected)ui['host-status'].textContent=state.enabled?'游戏与声音已连接':'游戏已就绪';}});
    void gameReady.then(async ready=>{if(!ready||token!==generation||disposed)return;const result=await bridge?.connect();if(token===generation&&!disposed&&!result?.accepted)showStatus('小游戏可继续运行，声音通道连接失败。请重新生成后重试。',true);});
    task('audio','running','计划已建立，正在真实渲染三层配乐',identity);showStatus('游戏已经可以试玩。正在渲染主题、氛围与节奏三层声音。');
    const renderStarted=performance.now(),output=await renderScore(plan.score,{mode:'hybrid',sampleRate:44100});if(token!==generation||disposed)return;
    if(!output.buffer||!['core','texture','rhythm'].every(id=>output.stems?.[id]))throw new Error('声音渲染未返回完整三层配乐');
    rendered=output;task('audio','ready','已生成，等待点击开启声音',identity);ui['audio-availability'].textContent=`${output.buffer.duration.toFixed(1)} 秒配乐 · 三层声音`;
    describePlan({audioTaskMs:Number((performance.now()-started).toFixed(1)),renderMs:Number((performance.now()-renderStarted).toFixed(1)),instrumentSource:output.stats?.instrumentSource});showStatus('声音已就位。点击「开始有声试玩」，再拾取、受击或确认，听真实动作的回应。');
  }catch(error){
    if(token!==generation||disposed)return;
    task('audio','failed','声音生成失败，游戏仍可继续',`共享设计 r${revision}`);ui['audio-availability'].textContent='声音暂不可用，可以重新生成';showStatus(`声音暂未接入：${error.message}。小游戏仍可继续。`,true);describePlan({error:error.message,gameBrief,eventContract});
  }finally{
    clearTimeout(timeout);if(token===generation){clearInterval(ticker);ticker=null;requestController=null;ui['audio-timing'].textContent=`${((performance.now()-started)/1000).toFixed(2)} s`;setBusy(false);}
  }
}
async function startAudio(){
  if(!adapter||!rendered||busy||startPending||disposed||document.hidden)return;
  const token=generation,epoch=++playbackEpoch,target=adapter;startPending=true;updateControls();showStatus('正在开启浏览器声音并连接当前游戏……');
  try{
    const unlocked=await target.unlock();if(token!==generation||epoch!==playbackEpoch||disposed||document.hidden)return;if(!unlocked.accepted)throw new Error(unlocked.reason||'浏览器声音未开启');
    const result=audioPaused?await target.resume():await target.start(rendered);if(token!==generation||epoch!==playbackEpoch||disposed)return;if(!result.accepted)throw new Error(result.reason||'当前配乐未能接入');
    if(document.hidden){target.pause();audioPaused=true;return;}
    audioStarted=true;audioPaused=false;bridge?.setEnabled(true);target.setScene('exploration');target.setIntensity(Number(ui.intensity.value));
    const confirm=await target.emit('ui.confirm',{strength:.65});if(token!==generation||epoch!==playbackEpoch||disposed)return;logEvent({operation:'emit',eventId:'ui.confirm',payload:{strength:.65},result:confirm},'宿主');
    task('audio','ready','已接入当前游戏 · 配乐播放中',`r${plan.revision} · ${plan.briefHash.slice(0,12)}`);showStatus('声音已经接入。小游戏只发送动作事件，实际播放由宿主管理。');
  }catch(error){if(token===generation&&epoch===playbackEpoch&&!disposed){bridge?.setEnabled(false);showStatus(`声音未能开启：${error.message}。可以重试，游戏仍可继续。`,true);}}
  finally{if(token===generation&&epoch===playbackEpoch){startPending=false;updateControls();}}
}
function pauseAudio(){if(!adapter||!audioStarted||disposed)return;const result=adapter.pause();if(result.accepted){audioPaused=true;bridge?.setEnabled(false);task('audio','ready','声音已暂停 · 游戏仍可继续');showStatus('声音已暂停。点击「继续有声试玩」恢复。');updateControls();}else showStatus(`声音暂停失败：${result.reason}`,true);}
function suspend(){if(disposed)return;playbackEpoch++;startPending=false;bridge?.setEnabled(false);if(adapter&&audioStarted){adapter.pause();audioPaused=true;task('audio','ready','页面已暂停 · 点击继续有声试玩');showStatus('页面离开前台，声音已暂停。返回后点击继续。');}else adapter?.stop();updateControls();}
async function dispose(){if(disposed)return;disposed=true;generation++;playbackEpoch++;requestController?.abort();clearInterval(ticker);bridge?.dispose();await adapter?.dispose();updateControls();ui.generate.disabled=true;ui['host-status'].textContent='演示已关闭';}

for(const button of document.querySelectorAll('[data-profile]'))button.addEventListener('click',()=>{if(busy||disposed)return;profile=button.dataset.profile;ui['game-prompt'].value=profiles[profile].prompt;for(const item of document.querySelectorAll('[data-profile]')){const selected=item===button;item.classList.toggle('selected',selected);item.setAttribute('aria-pressed',String(selected));}});
ui['game-prompt'].value=profiles.cozy.prompt;ui.generate.addEventListener('click',()=>void generate());ui['start-audio'].addEventListener('click',()=>void startAudio());ui['pause-audio'].addEventListener('click',pauseAudio);
ui.intensity.addEventListener('input',()=>{const value=Number(ui.intensity.value);ui['intensity-value'].textContent=`${Math.round(value*100)}%`;if(adapter&&audioStarted)adapter.setIntensity(value);});
document.addEventListener('visibilitychange',()=>{if(document.hidden)suspend();});window.addEventListener('pagehide',event=>{suspend();if(!event.persisted)void dispose();});
window.__pipelineDemo={generate,startAudio,dispose,get plan(){return plan;},get rendered(){return rendered;},get adapter(){return adapter;},get bridge(){return bridge;},getState:()=>({revision,busy,startPending,disposed,audioStarted,audioPaused,counts:{...counts},planId:plan?.planId||null,briefHash:plan?.briefHash||null,stems:Object.keys(rendered?.stems||{}),adapter:adapter?.getState()||null,bridge:bridge?.getState()||null})};
