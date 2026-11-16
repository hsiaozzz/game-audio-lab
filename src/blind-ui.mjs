const $=id=>document.getElementById(id);
const ui=Object.fromEntries(['intro','round-view','results-view','start','restart','sync-progress','round-number','progress','question-label','listening-hint','score-cards','score-rule','result-rows','result-rounds-label','status'].map(id=>[id,$(id)]));
const STORAGE_KEY='game-audio-lab.blind-session.v1';
let session=null,heard={A:false,B:false},playingClip=null,busy=false,roundGeneration=0,playSequence=0,stateUncertain=false;
const player=new Audio();
player.preload='none';

function showStatus(message,isError=false){ui.status.textContent=message;ui.status.classList.toggle('error',isError);ui.status.hidden=!message;}
function setBusy(value){busy=value;ui.start.disabled=value;ui.restart.disabled=value;updateRoundControls();}
function saveSession(id){try{localStorage.setItem(STORAGE_KEY,id);}catch{}}
function loadSessionId(){try{return localStorage.getItem(STORAGE_KEY);}catch{return null;}}
async function jsonRequest(path,options={}){
  const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),12000);
  try{
    const response=await fetch(path,{...options,signal:controller.signal,headers:{'Content-Type':'application/json',...options.headers}});
    if(!response.ok){const error=new Error('request-failed');error.status=response.status;throw error;}
    return await response.json();
  }finally{clearTimeout(timeout);}
}
function setClipProgress(side,fraction){
  const percent=Math.round(Math.min(1,Math.max(0,fraction))*100),bar=$(`clip-progress-${side}`);
  bar.style.width=`${percent}%`;
  bar.parentElement.setAttribute('aria-valuenow',String(percent));
}
function stopClip(){
  playSequence++;
  if(playingClip){playingClip.interrupted=true;clearTimeout(playingClip.timeout);}
  player.onended=null;player.onerror=null;player.pause();player.removeAttribute('src');player.load();playingClip=null;
  for(const side of ['A','B'])setClipProgress(side,heard[side]?1:0);
  updateRoundControls();
}
function resetListening(){roundGeneration++;stopClip();heard={A:false,B:false};for(const side of ['A','B'])setClipProgress(side,0);}
function updateRoundControls(){
  const loading=playingClip?.status==='loading',ready=heard.A&&heard.B&&!busy&&!loading&&!stateUncertain;
  for(const side of ['A','B']){
    const isPlaying=playingClip?.side===side,card=$(`card-${side}`),button=$(`play-${side}`);
    card.classList.toggle('listened',heard[side]);card.classList.toggle('playing',isPlaying);
    $(`heard-${side}`).textContent=heard[side]?'已完整试听 ✓':'尚未完整试听';
    button.disabled=busy;button.setAttribute('aria-pressed',String(isPlaying));
    button.innerHTML=`<span aria-hidden="true">${isPlaying?'■':'▶'}</span> ${isPlaying?`${loading?'取消载入':'停止'} ${side}`:heard[side]?`回听 ${side}`:`试听 ${side}`}`;
  }
  for(const button of document.querySelectorAll('[data-choice]'))button.disabled=!ready;
  ui['sync-progress'].hidden=!stateUncertain;ui['sync-progress'].disabled=busy;
  ui['listening-hint'].classList.toggle('ready',ready);
  ui['listening-hint'].textContent=stateUncertain?'尚未确认上一轮的保存状态，请先同步评审进度。':ready?'两段都已完整试听。请选择你的真实偏好。':loading?'正在载入声音。可以取消，或切换到另一段。':playingClip?'正在播放，请完整听完这一段。':'请先完整听过两段，再选择。回听不会影响已记录的试听状态。';
}
function validateSession(payload){
  if(!payload||typeof payload.id!=='string'||!payload.id||!Number.isInteger(payload.total)||payload.total<1||payload.total>64)throw new Error('invalid-session');
  if(payload.completed){
    if(!Array.isArray(payload.results?.scores)||!Array.isArray(payload.results?.rounds))throw new Error('invalid-results');
  }else{
    const round=payload.round;
    if(!round||!Number.isInteger(round.index)||round.index<0||round.index>=payload.total||typeof round.token!=='string'||!round.token)throw new Error('invalid-round');
    const prefix=`/api/blind/sessions/${encodeURIComponent(payload.id)}/clips/`;
    for(const side of ['A','B']){
      if(typeof round.clips?.[side]!=='string')throw new Error('invalid-clip');
      const url=new URL(round.clips[side],location.origin);
      if(url.origin!==location.origin||!url.pathname.startsWith(prefix))throw new Error('invalid-clip');
    }
  }
  return payload;
}
function renderRound(){
  ui.intro.hidden=true;ui['results-view'].hidden=true;ui['round-view'].hidden=false;
  const {index}=session.round,total=session.total;
  ui['round-number'].replaceChildren(document.createTextNode(String(index+1).padStart(2,'0')+' '));const small=document.createElement('small');small.textContent=`/ ${String(total).padStart(2,'0')}`;ui['round-number'].appendChild(small);
  ui['question-label'].textContent=`第 ${index+1} 轮 / 匿名短音效`;
  ui.progress.style.gridTemplateColumns=`repeat(${total},1fr)`;
  ui.progress.replaceChildren(...Array.from({length:total},(_,i)=>{const step=document.createElement('span');step.className=i<index?'complete':i===index?'current':'';step.title=`第 ${i+1} 轮`;return step;}));
  ui.progress.setAttribute('aria-label',`共 ${total} 轮，当前第 ${index+1} 轮`);
  ui.progress.setAttribute('aria-valuemax',String(total));ui.progress.setAttribute('aria-valuenow',String(index+1));updateRoundControls();
}
function sourceLabel(source,results){return results.scores?.find(score=>score.id===source)?.label||String(source??'—');}
function number(value){return Number.isFinite(Number(value))?Number(value):0;}
function choiceLabel(choice){return({A:'更喜欢 A',B:'更喜欢 B',tie:'差不多',neither:'都不喜欢'})[choice]||String(choice??'—');}
function renderResults(results){
  stopClip();ui.intro.hidden=true;ui['round-view'].hidden=true;ui['results-view'].hidden=false;
  ui['score-cards'].replaceChildren(...results.scores.map(score=>{const card=document.createElement('article');card.className='score-card';const title=document.createElement('h2');title.textContent=score.label;const total=document.createElement('div');total.className='score-total';total.append(document.createTextNode(String(number(score.score))));const unit=document.createElement('span');unit.textContent=results.maxScore?`/ ${number(results.maxScore)} 分`:'本次得分';total.appendChild(unit);const details=document.createElement('div');details.className='score-details';for(const text of [`获选 ${number(score.wins)} 次`,`差不多 ${number(score.ties)} 次`,`都不喜欢 ${number(score.neither)} 次`]){const item=document.createElement('span');item.textContent=text;details.appendChild(item);}card.append(title,total,details);return card;}));
  const rule=results.scoreRule||results.scoringRule;
  ui['score-rule'].textContent=typeof rule==='string'?rule:rule?.description||'分数依据本次服务端记录汇总；逐题选择完整保留在下方。';
  const rounds=results.rounds;ui['result-rounds-label'].textContent=`${rounds.length} 轮记录`;
  ui['result-rows'].replaceChildren(...rounds.map(round=>{const tr=document.createElement('tr');const winner=round.choice==='tie'?'差不多':round.choice==='neither'?'都不喜欢':sourceLabel(round.winner,results);for(const text of [String(number(round.index)+1).padStart(2,'0'),round.event||'—',sourceLabel(round.A,results),sourceLabel(round.B,results),choiceLabel(round.choice),winner]){const td=document.createElement('td');td.textContent=text;tr.appendChild(td);}return tr;}));
  showStatus('这份结果已保存在本地服务。重新开始会创建新的记录。');
}
function acceptSession(payload){
  validateSession(payload);resetListening();session=payload;stateUncertain=false;saveSession(payload.id);
  if(payload.completed)renderResults(payload.results);else renderRound();
}
function focusView(){
  $(session?.completed?'results-heading-title':'round-heading-title').focus({preventScroll:true});
  window.scrollTo({top:0,behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'instant':'smooth'});
}
async function createSession(){
  if(busy)return;
  stopClip();setBusy(true);showStatus('正在创建匿名会话并随机安排题目……');
  try{acceptSession(await jsonRequest('/api/blind/sessions',{method:'POST',body:'{}'}));showStatus('');focusView();}
  catch{showStatus('暂时无法开始盲听。请确认本地服务已运行，然后重试。',true);}
  finally{setBusy(false);}
}
function clipIsCurrent(clip){return playingClip===clip&&!clip.interrupted&&clip.generation===roundGeneration&&clip.attempt===playSequence&&session?.round?.token===clip.token;}
async function playSide(side){
  if(!session?.round||session.completed||busy||document.hidden)return;
  if(playingClip?.side===side){stopClip();return;}
  const {token,clips}=session.round;stopClip();showStatus('');
  const clip={side,token,interrupted:false,status:'loading',generation:roundGeneration,attempt:++playSequence,timeout:null};
  playingClip=clip;updateRoundControls();
  const fail=()=>{if(!clipIsCurrent(clip))return;stopClip();showStatus('这一段声音暂时无法播放，请重试。',true);};
  clip.timeout=setTimeout(fail,12000);
  player.src=clips[side];player.onerror=fail;
  player.onended=()=>{
    if(!clipIsCurrent(clip)||!player.ended)return;
    if(!document.hidden)heard[side]=true;
    stopClip();
  };
  try{
    await player.play();
    if(!clipIsCurrent(clip))return;
    if(document.hidden){stopClip();return;}
    clip.status='playing';updateRoundControls();
    function progress(){
      if(!clipIsCurrent(clip))return;
      const duration=Number.isFinite(player.duration)&&player.duration>0?player.duration:1.8;
      setClipProgress(side,player.currentTime/duration);requestAnimationFrame(progress);
    }
    requestAnimationFrame(progress);
  }catch{fail();}
}
async function reconcileSession(id,token,{afterVote=false}={}){
  const latest=validateSession(await jsonRequest(`/api/blind/sessions/${encodeURIComponent(id)}`));
  if(latest.completed||latest.round.token!==token){acceptSession(latest);showStatus(latest.completed?'评审已完成，来源现已揭晓。':'已同步到最新进度。当前轮请完整试听后选择。');focusView();}
  else{session=latest;stateUncertain=false;renderRound();showStatus(afterVote?'本轮尚未保存，可以重新提交。当前试听记录仍然保留。':'进度已同步，可以继续选择。',afterVote);}
}
async function vote(choice){
  if(busy||stateUncertain||playingClip?.status==='loading'||!heard.A||!heard.B||!session?.round||!['A','B','tie','neither'].includes(choice))return;
  const {id,total}=session,token=session.round.token;stopClip();setBusy(true);showStatus('正在保存本轮选择……');
  try{
    const next=await jsonRequest(`/api/blind/sessions/${encodeURIComponent(id)}/votes`,{method:'POST',body:JSON.stringify({token,choice})});
    acceptSession({...next,id:next.id||id,total:next.total||total});showStatus(next.completed?'评审已完成，来源现已揭晓。':'');focusView();
  }catch{
    showStatus('正在核对本轮是否已保存……');
    try{await reconcileSession(id,token,{afterVote:true});}
    catch{stateUncertain=true;showStatus('暂时无法确认保存状态。请同步评审进度后继续，避免重复提交。',true);}
  }finally{setBusy(false);}
}
ui.start.addEventListener('click',createSession);ui.restart.addEventListener('click',createSession);
ui['sync-progress'].addEventListener('click',async()=>{
  if(busy||!session?.round)return;
  const id=session.id,token=session.round.token;setBusy(true);showStatus('正在同步评审进度……');
  try{await reconcileSession(id,token);}
  catch{showStatus('仍无法同步进度，请确认本地服务可用后重试。',true);}
  finally{setBusy(false);}
});
for(const side of ['A','B'])$(`play-${side}`).addEventListener('click',()=>playSide(side));
for(const button of document.querySelectorAll('[data-choice]'))button.addEventListener('click',()=>vote(button.dataset.choice));
document.addEventListener('visibilitychange',()=>{if(document.hidden)stopClip();});window.addEventListener('pagehide',stopClip);
async function restore(){
  const id=loadSessionId();if(!id)return;setBusy(true);showStatus('正在恢复上次的匿名评审……');
  try{const payload=await jsonRequest(`/api/blind/sessions/${encodeURIComponent(id)}`);acceptSession(payload);showStatus(payload.completed?'已恢复上次的评审结果。':'已恢复上次进度。当前轮请重新完整试听 A 和 B 后选择。');}
  catch(error){showStatus(error.status===404?'上次会话已不可用。点击开始，创建新的匿名评审。':'暂时无法恢复上次进度。可以稍后刷新重试，或开始新的匿名评审。',true);}
  finally{setBusy(false);}
}
restore();
