import {createAudioServiceClient,verifyIdentity,AudioServiceError} from './audio-service-client.mjs';
import {createAudioPackagePlayer} from './audio-package-player.mjs';
import {exportAudioPackageZip} from './audio-package-export.mjs';

const $=id=>document.getElementById(id),ids=['brief','profile','playback','create-plan','service-health','probe-status','service-url','service-token','persistent-cache','plan-review','plan-version','plan-items','plan-budget','confirm-plan','local-state','game','game-score','unlock','pause','mute','intensity','intensity-value','play-status','job-state','job-status','components','cancel','retry','reload-package','export-zip','verified-count','transfer-size','decoded-size','ready-summary','diagnostics','events-log'];
const ui=Object.fromEntries(ids.map(id=>[id,$(id)]));
const prompts={cozy:'做一个温暖的海岛收集游戏，探索午后的岛屿，拾取贝壳并避开岩石。配乐温暖、轻盈、没有人声，拾取与受击要有清楚的反馈。',neon:'做一个霓虹太空动作游戏，驾驶飞船收集能量晶体并避开障碍。配乐使用有节奏的电子合成器，拾取与受击反馈清楚，没有人声。',ruins:'做一个神秘遗迹探索游戏，寻找古老水晶并避开障碍。音乐幽暗、稀疏、有探索感，没有人声，拾取与受击反馈清楚。'};
const eventContract={schemaVersion:1,version:1,sceneStates:['menu','exploration'],events:[{id:'item.collect',cue:'collect',required:true,maxRatePerSecond:6},{id:'player.hit',cue:'hit',required:true,maxRatePerSecond:3},{id:'ui.confirm',cue:'ui',required:true,maxRatePerSecond:4}]};
let client=null,player=createAudioPackagePlayer(),decoder=null,capabilities=null,plan=null,job=null,bundle=null,revision=0,epoch=0,playEpoch=0,planning=false,working=false,loadingPackage=false,exporting=false,disposed=false,controller=null,pollController=null,lastManifest=null,packageFailure=false,muted=false,events=[],confirmationKey=null;
const retryKeys=new Map();
let counters={collect:0,hit:0,accepted:0};
const terminalStatuses=new Set(['completed','ready','failed','cancelled','partial-ready','partial_failed','partially-failed']);
function note(text,isError=false){ui['job-status'].textContent=text;ui['job-status'].classList.toggle('error',isError);}
function bytes(value){return value>=1048576?`${(value/1048576).toFixed(2)} MB`:value>=1024?`${(value/1024).toFixed(1)} KB`:`${value} B`;}
function state(){return{planning,working,loadingPackage,disposed,planId:plan?.planId||null,planDigest:plan?.planDigest||null,identity:plan?.identity||null,jobId:job?.jobId||job?.id||null,jobStatus:job?.status||null,requiredReady:job?.requiredReady||false,allSelectedReady:job?.allSelectedReady||false,verifiedFiles:bundle?.files.size||0,transferBytes:bundle?.transferBytes||0,decodedPcmBytes:bundle?.decodedPcmBytes||0,packageId:bundle?.manifest.packageId||null,counts:{...counters},player:player.getState(),capabilityFormats:capabilities?.formats?.map(item=>item.id)||[]};}
function diagnostics(){ui.diagnostics.textContent=JSON.stringify({...state(),components:job?.components||[],quality:bundle?.manifest.quality||null,cache:client?.cacheStats||null},null,2);}
function controls(){
  ui['create-plan'].disabled=planning||working||disposed;ui['confirm-plan'].disabled=!plan||planning||working||disposed;
  for(const name of ['brief','profile','playback','service-url','service-token','persistent-cache'])ui[name].disabled=planning||working||disposed;
  for(const input of ui['plan-items'].querySelectorAll('input'))input.disabled=working||input.dataset.required==='true';
  ui.cancel.disabled=!working||disposed;ui.retry.hidden=!job||!['failed','partial-ready','partial_failed','partially-failed'].includes(job.status);ui.retry.disabled=working||disposed;ui['reload-package'].hidden=!packageFailure;ui['reload-package'].disabled=loadingPackage||disposed;
  const loaded=!!bundle?.decoded.size,ps=player.getState();ui.unlock.disabled=!loaded||disposed;ui.unlock.innerHTML=`${ps.paused?'继续游戏声音':ps.unlocked?'重新播放配乐':'开启游戏声音'} <span aria-hidden="true">▶</span>`;ui.pause.disabled=!ps.unlocked||ps.paused||disposed;ui.mute.disabled=!ps.unlocked||disposed;ui.intensity.disabled=!ps.unlocked||disposed;ui['export-zip'].disabled=!bundle||exporting||disposed;ui['export-zip'].innerHTML=`${exporting?'正在打包':job?.allSelectedReady?'下载独立声音包 ZIP':'下载已就绪声音 ZIP'} <span aria-hidden="true">↓</span>`;diagnostics();
}
function log(eventId,result,source='游戏'){
  if(result?.accepted)counters.accepted++;
  events.unshift({at:new Date().toLocaleTimeString('zh-CN',{hour12:false}),eventId,accepted:!!result?.accepted,reason:result?.reason,source});events=events.slice(0,30);
  const labels={'package-not-loaded':'声音尚未到达',locked:'等待开启声音',paused:'声音已暂停','unknown-event':'该声音尚未就绪','event-not-loaded':'该声音尚未就绪','rate-limited':'已限制过密触发','voice-budget':'同时播放数量已达上限'};
  ui['events-log'].replaceChildren(...events.map(item=>{const li=document.createElement('li');li.classList.toggle('accepted',item.accepted);li.textContent=`${item.at} ${item.source} · ${item.eventId} → ${item.accepted?'本地播放':labels[item.reason]||item.reason||'未播放'}`;return li;}));
  if(result?.accepted)ui['play-status'].textContent=`本地回应 ${eventId} · 共 ${counters.accepted} 次，播放未请求网络。`;
  diagnostics();return result;
}
function emit(eventId,payload={}){return log(eventId,player.play(eventId,{strength:.8,...payload}));}
async function setupClient(){
  await client?.dispose();const base=ui['service-url'].value.trim()||location.origin,url=new URL(base);if(!['http:','https:'].includes(url.protocol))throw new Error('声音服务地址需要 HTTP 或 HTTPS');
  const next=createAudioServiceClient({baseUrl:url.href,token:ui['service-token'].value.trim()||null,persistentCache:ui['persistent-cache'].checked});client=next;const result=await next.getCapabilities();if(client!==next)return result;capabilities=result;
  ui['service-health'].textContent=capabilities.renderer?.ready===false?'渲染依赖尚未就绪':'声音服务已连接';return capabilities;
}
async function createPlan(){
  if(planning||working||disposed)return;const prompt=ui.brief.value.trim();if(!prompt){note('先写下游戏描述。',true);return;}
  const current=++epoch;playEpoch++;controller?.abort();pollController?.abort();controller=new AbortController();planning=true;plan=null;job=null;bundle=null;lastManifest=null;packageFailure=false;ui['plan-review'].hidden=true;ui.components.replaceChildren();ui['verified-count'].textContent='0';ui['transfer-size'].textContent='—';ui['decoded-size'].textContent='—';ui['ready-summary'].textContent='等待声音';ui['job-state'].textContent='正在建立方案';note('正在连接声音服务，并测试浏览器真实解码能力……');controls();
  try{
    await player.dispose();player=createAudioPackagePlayer();muted=false;ui.mute.textContent='静音';ui.mute.setAttribute('aria-pressed','false');
    await setupClient();if(current!==epoch||disposed)return;
    const Offline=globalThis.OfflineAudioContext||globalThis.webkitOfflineAudioContext;if(!Offline)throw new Error('当前浏览器不支持 Web Audio 离线解码');decoder=new Offline(2,48000,48000);
    const probe=await client.probeFormats({audioContext:decoder,formats:capabilities.formats,signal:controller.signal});if(!probe.acceptedFormats.length)throw new Error('浏览器未通过 Opus 或 AAC 的真实解码测试');
    ui['probe-status'].textContent=`真实解码通过：${probe.acceptedFormats.join(' → ')}。探针只解码，不播放。`;
    const gameBrief={schemaVersion:1,projectId:'media-delivery-demo',revision:++revision,prompt};
    const input={gameBrief,eventContract,options:{seed:1701+revision},audioRequests:[
      {id:'sfx.item.collect',kind:'sfx',eventId:'item.collect',required:true,variants:2},
      {id:'sfx.player.hit',kind:'sfx',eventId:'player.hit',required:true,variants:2},
      {id:'sfx.ui.confirm',kind:'sfx',eventId:'ui.confirm',required:true,variants:2},
      {id:'bgm.exploration',kind:'music',scene:'exploration',required:true,loop:true,playback:ui.playback.value,maxDurationSeconds:50}
    ],delivery:{profile:'compact-opus-v1',acceptedFormats:probe.acceptedFormats,selection:'one-format-per-item',maxTransferBytes:24*1024*1024,maxDecodedPcmBytes:96*1024*1024}};
    const result=await client.createPlan(input,{signal:controller.signal});if(current!==epoch||disposed)return;
    if(!result?.planId||!result.planDigest||!Array.isArray(result.items)||result.identity?.projectId!==gameBrief.projectId||result.identity?.revision!==gameBrief.revision)throw new Error('服务返回了不匹配的方案');plan=result;confirmationKey=crypto.randomUUID();renderPlan();ui['job-state'].textContent='等待宿主确认';note('声音方案已经建立。确认项目与格式后，再提交实际制作任务。');
  }catch(cause){if(current!==epoch||disposed)return;ui['job-state'].textContent='方案建立失败';note(`方案暂未建立：${cause.message}。小游戏仍可继续。`,true);}
  finally{if(current===epoch){planning=false;controls();}}
}
function renderPlan(){
  ui['plan-review'].hidden=false;ui['plan-version'].textContent=`r${plan.identity.revision} · ${plan.identity.briefHash.slice(0,8)}`;
  ui['plan-items'].replaceChildren(...plan.items.map(item=>{const label=document.createElement('label'),input=document.createElement('input'),text=document.createElement('span'),title=document.createElement('strong'),details=document.createElement('small');input.type='checkbox';input.checked=true;input.value=item.id;input.dataset.required=String(item.required);input.disabled=!!item.required;title.textContent=item.kind==='music'?`探索配乐 · ${item.playback==='stems'?'动态分层':'完整混音'}`:({'item.collect':'拾取反馈','player.hit':'受击反馈','ui.confirm':'界面确认'}[item.eventId]||item.eventId);details.textContent=`${item.formatId} · ${item.kind==='sfx'?`${item.variants} 个变体 · `:''}${item.required?'必需':'可选'}`;text.append(title,details);label.append(input,text);return label;}));
  ui['plan-budget'].textContent=`接收上限 ${bytes(plan.delivery.maxTransferBytes)} · 解码内存上限 ${bytes(plan.delivery.maxDecodedPcmBytes)}。音频格式由实际解码能力与接收端共同确定。`;
}
function renderJob(){
  const statusLabels={queued:'排队中',running:'正在制作',rendering:'正在制作',completed:'制作完成',ready:'制作完成',partial:'部分就绪',failed:'制作失败',cancelled:'已取消','partial-ready':'部分制作失败',partial_failed:'部分制作失败','partially-failed':'部分制作失败'};ui['job-state'].textContent=statusLabels[job.status]||job.status;
  const componentLabels={queued:'等待制作',pending:'等待制作',running:'正在制作',rendering:'正在制作',ready:'已就绪',completed:'已就绪',failed:'失败，可查看原因',cancelled:'已取消'};
  ui.components.replaceChildren(...(job.components||[]).map(component=>{const card=document.createElement('article'),title=document.createElement('strong'),status=document.createElement('span');card.className='component';card.classList.toggle('ready',['ready','completed'].includes(component.status));card.classList.toggle('failed',component.status==='failed');const item=plan.items.find(item=>item.id===component.id);title.textContent=item?.kind==='music'?'探索配乐':({'item.collect':'拾取音效','player.hit':'受击音效','ui.confirm':'确认音效'}[item?.eventId]||component.id);status.textContent=component.error?.message||componentLabels[component.status]||component.status;card.append(title,status);return card;}));controls();
}
async function receivePackage(url,current){
  if(!url||lastManifest===url||loadingPackage||current!==epoch)return;
  loadingPackage=true;packageFailure=false;controls();note('已有声音就绪，正在下载、校验 SHA-256 并解码……');
  try{
    const result=await client.downloadPackage(url,{signal:pollController?.signal,audioContext:decoder,decode:true,expectedIdentity:plan.identity,planId:plan.planId,planDigest:plan.planDigest,selectionDigest:job.selectionDigest,transferBudget:plan.delivery.maxTransferBytes,decodedBudget:plan.delivery.maxDecodedPcmBytes,onProgress:progress=>{if(current===epoch)ui['job-status'].textContent=`正在接收 ${progress.completedFiles}/${progress.totalFiles} 个文件 · 已校验 ${bytes(progress.completedBytes)}`;}});
    if(current!==epoch||disposed)return;const loaded=player.load(result);if(!loaded.accepted)throw new Error(loaded.message||loaded.reason);bundle=result;lastManifest=url;ui['verified-count'].textContent=String(result.files.size);ui['transfer-size'].textContent=bytes(result.transferBytes);ui['decoded-size'].textContent=bytes(result.decodedPcmBytes);
    const music=Object.keys(result.manifest.music||{}).length,sfx=Object.keys(result.manifest.sfx||{}).length;ui['ready-summary'].textContent=`${sfx} 类音效${music?` · ${music} 段配乐`:''}`;ui['local-state'].textContent=music?'声音已在本地':'音效已在本地';ui['play-status'].textContent=music?'声音文件已在本机校验与解码。点击开启后，游戏播放不再请求网络。':'短音效已先到达，可以点击开启动作反馈；配乐仍可继续制作。';
    const ps=player.getState();if(ps.unlocked&&!ps.paused&&music&&!ps.musicPlaying){const musicId=Object.keys(result.manifest.music)[0];player.music.play(musicId);}
  }catch(cause){if(current!==epoch||disposed||cause.code==='aborted')return;packageFailure=true;note(`资源暂未接收：${cause.message}。已加载的声音与小游戏仍可使用。`,true);}
  finally{if(current===epoch){loadingPackage=false;controls();}}
}
async function followJob(initial,current){
  job=initial;working=true;pollController?.abort();pollController=new AbortController();renderJob();
  try{
    job=await client.waitForJob(job.jobId||job.id,{signal:pollController.signal,timeoutMs:360000,onUpdate:async next=>{
      if(current!==epoch||disposed)return;verifyIdentity(plan.identity,next.identity);if(next.planId!==plan.planId)throw new AudioServiceError('identity-mismatch','制作任务不属于当前声音方案');job=next;renderJob();const manifestUrl=next.manifestUrl||next.packageUrl;if(manifestUrl)await receivePackage(manifestUrl,current);
      if(pollController.signal.aborted)return;
      if(!packageFailure){const ready=(next.components||[]).filter(item=>['ready','completed'].includes(item.status)).length;note(next.allSelectedReady?'已选声音全部制作完成，并可独立交付。':`${ready}/${next.components?.length||plan.items.length} 项声音就绪。游戏可继续，短音效准备好即可先用。`);}
    }});
    if(current!==epoch||disposed)return;if(['failed','partial-ready','partial_failed','partially-failed'].includes(job.status))note('部分声音制作失败。已就绪资源仍可播放，可以重试失败项。',true);else if(job.status==='cancelled')note('制作已取消。已经接收的资源仍保留在本机。');
  }catch(cause){if(current!==epoch||disposed||cause.code==='aborted')return;note(`任务查询暂时中断：${cause.message}。可以稍后重试查询。`,true);ui['reload-package'].hidden=false;}
  finally{if(current===epoch){working=false;controls();}}
}
async function submit(){
  if(!plan||working||disposed)return;const current=epoch,acceptedItems=[...ui['plan-items'].querySelectorAll('input:checked')].map(input=>input.value);if(!acceptedItems.length){note('至少接收一个声音项目。',true);return;}
  working=true;controls();note('宿主已确认，正在提交可恢复的制作任务……');
  try{const next=await client.submitJob(plan,{acceptedItems,delivery:plan.delivery,idempotencyKey:confirmationKey,signal:controller.signal});if(current!==epoch||disposed)return;await followJob(next,current);}catch(cause){if(current===epoch&&!disposed){working=false;note(`制作任务未能确认：${cause.message}。再次确认会沿用相同请求标识，避免重复制作。`,true);controls();}}
}
async function startLocal(){
  if(!bundle||disposed)return;const current=epoch,token=++playEpoch;ui.unlock.disabled=true;
  try{const unlocked=await player.unlock();if(current!==epoch||token!==playEpoch||disposed||document.hidden)return;if(!unlocked.accepted)throw new Error(unlocked.reason);let result;if(player.getState().paused)result=await player.resume();else{const musicId=Object.keys(bundle.manifest.music||{})[0];result=musicId?player.music.play(musicId):{accepted:true};}if(!result.accepted)throw new Error(result.reason);player.setIntensity(Number(ui.intensity.value));log('ui.confirm',player.play('ui.confirm',{strength:.7}),'宿主');ui['play-status'].textContent='游戏声音已开启。所有配乐与动作音效均从本地缓冲播放。';}catch(cause){if(current===epoch&&!disposed)ui['play-status'].textContent=`声音未开启：${cause.message}。可以重试。`;}
  finally{if(current===epoch)controls();}
}
async function exportZip(){
  if(!bundle||exporting||disposed)return;exporting=true;controls();
  try{const sources=await Promise.all([fetch('/src/audio-service-client.mjs').then(response=>{if(!response.ok)throw new Error('客户端源码不可用');return response.text();}),fetch('/src/audio-package-player.mjs').then(response=>{if(!response.ok)throw new Error('播放器源码不可用');return response.text();})]);const blob=await exportAudioPackageZip(bundle,{clientModule:sources[0],playerModule:sources[1]}),url=URL.createObjectURL(blob),link=document.createElement('a');link.href=url;link.download=`game-audio-${bundle.manifest.packageId.slice(0,16)}.zip`;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);note(`已生成包含 ${bundle.files.size} 个已校验文件的独立 ZIP。解压后通过本地 HTTP 服务试听。`);}catch(cause){note(`声音包未能导出：${cause.message}`,true);}finally{exporting=false;controls();}
}

const canvas=ui.game,ctx=canvas.getContext('2d'),keys=new Set(),hero={x:85,y:170},crystals=[{x:190,y:90},{x:390,y:230},{x:650,y:110}],rocks=[{x:290,y:118,r:23},{x:545,y:235,r:27}];let lastFrame=performance.now(),lastHit=-1000,pulse=0,spawn=0;
function gameEvent(id){if(id==='item.collect')counters.collect++;if(id==='player.hit')counters.hit++;ui['game-score'].textContent=`拾取 ${counters.collect} · 碰撞 ${counters.hit}`;emit(id,{pan:(hero.x-380)/550});pulse=1;}
function draw(now){if(disposed)return;const dt=Math.min(.05,(now-lastFrame)/1000);lastFrame=now;const neon=ui.profile.value==='neon',ruins=ui.profile.value==='ruins',ground=neon?'#222b4a':ruins?'#303936':'#2e5350',accent=neon?'#accbff':ruins?'#d5d8a5':'#b4ecc7';ctx.fillStyle=neon?'#151d33':'#19343d';ctx.fillRect(0,0,760,340);ctx.strokeStyle=neon?'#33446b':'#305c61';ctx.lineWidth=1;for(let i=0;i<17;i++){ctx.beginPath();ctx.moveTo(i*46,0);ctx.lineTo(i*46,340);ctx.stroke();}for(let i=0;i<9;i++){ctx.beginPath();ctx.moveTo(0,i*42);ctx.lineTo(760,i*42);ctx.stroke();}ctx.fillStyle=ground;ctx.fillRect(27,26,706,285);
  let dx=Number(keys.has('ArrowRight')||keys.has('KeyD'))-Number(keys.has('ArrowLeft')||keys.has('KeyA')),dy=Number(keys.has('ArrowDown')||keys.has('KeyS'))-Number(keys.has('ArrowUp')||keys.has('KeyW'));const length=Math.hypot(dx,dy)||1;hero.x=Math.min(738,Math.max(22,hero.x+dx/length*dt*165));hero.y=Math.min(318,Math.max(22,hero.y+dy/length*dt*165));
  for(const rock of rocks){ctx.fillStyle=neon?'#776a9b':'#788e7e';ctx.beginPath();ctx.moveTo(rock.x-rock.r,rock.y+10);ctx.lineTo(rock.x-rock.r*.6,rock.y-rock.r*.7);ctx.lineTo(rock.x+rock.r*.5,rock.y-rock.r);ctx.lineTo(rock.x+rock.r,rock.y+10);ctx.closePath();ctx.fill();if(Math.hypot(hero.x-rock.x,hero.y-rock.y)<rock.r+11&&now-lastHit>900){lastHit=now;gameEvent('player.hit');hero.x=Math.max(22,hero.x-25);}}
  crystals.forEach((item,index)=>{const bob=Math.sin(now*.003+index)*4;ctx.fillStyle='#e4dea2';ctx.beginPath();ctx.moveTo(item.x,item.y-10+bob);ctx.lineTo(item.x+8,item.y+bob);ctx.lineTo(item.x,item.y+10+bob);ctx.lineTo(item.x-8,item.y+bob);ctx.closePath();ctx.fill();if(Math.hypot(hero.x-item.x,hero.y-item.y)<21){gameEvent('item.collect');item.x=90+(++spawn*137)%570;item.y=65+(spawn*79)%220;}});
  ctx.fillStyle='#10232a70';ctx.beginPath();ctx.ellipse(hero.x,hero.y+13,17,7,0,0,Math.PI*2);ctx.fill();ctx.fillStyle=pulse>0?'#f5e5b1':accent;ctx.beginPath();ctx.arc(hero.x,hero.y,12,0,Math.PI*2);ctx.fill();pulse=Math.max(0,pulse-dt*2);requestAnimationFrame(draw);
}
canvas.addEventListener('keydown',event=>{if(['ArrowUp','ArrowDown','ArrowLeft','ArrowRight','KeyW','KeyA','KeyS','KeyD'].includes(event.code)){keys.add(event.code);event.preventDefault();}});window.addEventListener('keyup',event=>keys.delete(event.code));canvas.addEventListener('blur',()=>keys.clear());canvas.addEventListener('click',()=>canvas.focus());
ui['service-url'].value=location.origin;ui.profile.addEventListener('change',()=>{ui.brief.value=prompts[ui.profile.value];});ui['create-plan'].addEventListener('click',()=>void createPlan());ui['confirm-plan'].addEventListener('click',()=>void submit());ui.unlock.addEventListener('click',()=>void startLocal());ui.pause.addEventListener('click',()=>{player.pause();ui['play-status'].textContent='声音已暂停，小游戏继续。点击继续游戏声音恢复。';controls();});ui.mute.addEventListener('click',()=>{muted=!muted;player.mute(muted);ui.mute.textContent=muted?'取消静音':'静音';ui.mute.setAttribute('aria-pressed',String(muted));});ui.intensity.addEventListener('input',()=>{const value=Number(ui.intensity.value);ui['intensity-value'].textContent=`${Math.round(value*100)}%`;player.setIntensity(value);});
for(const button of document.querySelectorAll('[data-event]'))button.addEventListener('click',()=>{const id=button.dataset.event;if(id==='item.collect'||id==='player.hit')gameEvent(id);else emit(id);});
ui.cancel.addEventListener('click',async()=>{if(!job||!working)return;try{job=await client.cancelJob(job.jobId||job.id);pollController?.abort();working=false;renderJob();note('制作已取消。已经接收的资源仍可本地播放。');}catch(cause){note(`取消未能确认：${cause.message}`,true);}});
ui.retry.addEventListener('click',async()=>{if(!job||working)return;working=true;controls();const id=job.jobId||job.id;if(!retryKeys.has(id))retryKeys.set(id,crypto.randomUUID());try{await followJob(await client.retryJob(id,{job,idempotencyKey:retryKeys.get(id)}),epoch);}catch(cause){working=false;note(`重试未能开始：${cause.message}`,true);controls();}});
ui['reload-package'].addEventListener('click',async()=>{if(!job)return;const current=epoch;try{pollController=new AbortController();const latest=await client.getJob(job.jobId||job.id,{signal:pollController.signal});if(current!==epoch||disposed)return;verifyIdentity(plan.identity,latest.identity);job=latest;lastManifest=null;await receivePackage(latest.manifestUrl||latest.packageUrl,current);renderJob();}catch(cause){if(current===epoch)note(`资源查询暂未完成：${cause.message}`,true);}});ui['export-zip'].addEventListener('click',()=>void exportZip());
document.addEventListener('visibilitychange',()=>{if(document.hidden){keys.clear();playEpoch++;player.pause();controls();}});window.addEventListener('pagehide',event=>{keys.clear();player.pause();if(!event.persisted)void dispose();});
async function dispose(){if(disposed)return;disposed=true;epoch++;playEpoch++;controller?.abort();pollController?.abort();await player.dispose();await client?.dispose();controls();}
window.__deliveryDemo={createPlan,submit,startLocal,exportZip,dispose,get client(){return client;},get player(){return player;},get bundle(){return bundle;},get plan(){return plan;},get job(){return job;},getState:state};
requestAnimationFrame(draw);controls();
void setupClient().then(()=>diagnostics()).catch(cause=>{ui['service-health'].textContent='服务暂未连接';ui['probe-status'].textContent=`${cause.message}，可以在连接设置中调整地址后重试。`;});
