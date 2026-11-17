/** Browser SDK for immutable media packages. No music model or synthesis engine runs here. */
export class AudioServiceError extends Error {
  constructor(code,message,{retryable=false,componentId,status,cause}={}){super(message,{cause});this.name='AudioServiceError';this.code=code;this.retryable=retryable;this.componentId=componentId;this.status=status;}
  toJSON(){return{error:{code:this.code,message:this.message,retryable:this.retryable,...(this.componentId?{componentId:this.componentId}:{})}};}
}
const error=(code,message,details)=>new AudioServiceError(code,message,details);
const abortError=()=>error('aborted','操作已取消');
const identityFields=['projectId','revision','briefHash','contractVersion','contractHash'];
class ByteLru{
  constructor(limit,measure){this.limit=limit;this.measure=measure;this.entries=new Map();this.bytes=0;}
  get size(){return this.entries.size;}
  get(key){const entry=this.entries.get(key);if(!entry)return undefined;this.entries.delete(key);this.entries.set(key,entry);return entry.value;}
  set(key,value){this.delete(key);const size=this.measure(value);if(!Number.isSafeInteger(size)||size<0||size>this.limit)return;this.entries.set(key,{value,size});this.bytes+=size;this.trim();}
  delete(key){const entry=this.entries.get(key);if(entry){this.bytes-=entry.size;this.entries.delete(key);}}
  trim(){while(this.bytes>this.limit&&this.entries.size)this.delete(this.entries.keys().next().value);}
  resize(limit){this.limit=limit;this.trim();}
  clear(){this.entries.clear();this.bytes=0;}
}
// Content hashes can be shared across clients, but decoded buffers must never accumulate without a bound.
const memoryBytes=new ByteLru(32*1024*1024,value=>value.byteLength),memoryDecoded=new ByteLru(96*1024*1024,value=>value.length*value.numberOfChannels*4);
export function configureAudioMemoryCache({maxEncodedBytes=32*1024*1024,maxDecodedBytes=96*1024*1024}={}){for(const value of [maxEncodedBytes,maxDecodedBytes])if(!Number.isSafeInteger(value)||value<0||value>256*1024*1024)throw error('invalid-cache-limit','缓存上限必须在 0 到 256 MB 之间');memoryBytes.resize(maxEncodedBytes);memoryDecoded.resize(maxDecodedBytes);return{maxEncodedBytes:memoryBytes.limit,maxDecodedBytes:memoryDecoded.limit};}
const probeResults=new Map();
// Static, silent 40 ms decoder fixtures, encoded by FFmpeg (libopus / native AAC).
// These are decoded only, never connected to an output node or played.
const probes={
  'opus-ogg':'T2dnUwACAAAAAAAAAABLGPkGAAAAAK/R3noBE09wdXNIZWFkAQE4AYC7AAAAAABPZ2dTAAAAAAAAAAAAAEsY+QYBAAAAwsgXoQE8T3B1c1RhZ3MMAAAATGF2ZjYzLjEuMTAxAQAAABwAAABlbmNvZGVyPUxhdmM2My4xLjEwMSBsaWJvcHVzT2dnUwAEuAgAAAAAAABLGPkGAgAAAHDqh5IDAwMD+P/++P/++P/+',
  'aac-lc-m4a':'AAAAHGZ0eXBNNEEgAAACAE00QSBpc29taXNvMgAAAwZtb292AAAAbG12aGQAAAAAAAAAAAAAAAAAALuAAAAHgAABAAABAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACAAACMXRyYWsAAABcdGtoZAAAAAMAAAAAAAAAAAAAAAEAAAAAAAAHgAAAAAAAAAAAAAAAAQEAAAAAAQAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAACRlZHRzAAAAHGVsc3QAAAAAAAAAAQAAB4AAAAQAAAEAAAAAAaltZGlhAAAAIG1kaGQAAAAAAAAAAAAAAAAAALuAAAALgFXEAAAAAAAtaGRscgAAAAAAAAAAc291bgAAAAAAAAAAAAAAAFNvdW5kSGFuZGxlcgAAAAFUbWluZgAAABBzbWhkAAAAAAAAAAAAAAAkZGluZgAAABxkcmVmAAAAAAAAAAEAAAAMdXJsIAAAAAEAAAEYc3RibAAAAGpzdHNkAAAAAAAAAAEAAABabXA0YQAAAAAAAAABAAAAAAAAAAAAAQAQAAAAALuAAAAAAAA2ZXNkcwAAAAADgICAJQABAASAgIAXQBUAAAAAAH0AAAANwQWAgIAFEYhW5QAGgICAAQIAAAAgc3R0cwAAAAAAAAACAAAAAgAABAAAAAABAAADgAAAABxzdHNjAAAAAAAAAAEAAAABAAAAAwAAAAEAAAAgc3RzegAAAAAAAAAAAAAAAwAAABMAAAAEAAAABAAAABRzdGNvAAAAAAAAAAEAAAMyAAAAGnNncGQBAAAAcm9sbAAAAAIAAAAB//8AAAAcc2JncAAAAAByb2xsAAAAAQAAAAMAAAABAAAAYXVkdGEAAABZbWV0YQAAAAAAAAAhaGRscgAAAAAAAAAAbWRpcmFwcGwAAAAAAAAAAAAAAAAsaWxzdAAAACSpdG9vAAAAHGRhdGEAAAABAAAAAExhdmY2My4xLjEwMQAAAAhmcmVlAAAAI21kYXTcAExhdmM2My4xLjEwMQACMEAOARggBwEYIAc='
};
function fromBase64(text){const bytes=atob(text),result=new Uint8Array(bytes.length);for(let i=0;i<bytes.length;i++)result[i]=bytes.charCodeAt(i);return result.buffer;}
export async function sha256(bytes){if(!globalThis.crypto?.subtle)throw error('secure-context-required','完整性验证需要 HTTPS 或 localhost');const hash=await crypto.subtle.digest('SHA-256',bytes);return Array.from(new Uint8Array(hash),byte=>byte.toString(16).padStart(2,'0')).join('');}
function canonicalJson(value){if(value===null||typeof value==='boolean'||typeof value==='string')return JSON.stringify(value);if(typeof value==='number'&&Number.isFinite(value))return JSON.stringify(value);if(Array.isArray(value))return'['+value.map(canonicalJson).join(',')+']';if(value&&typeof value==='object')return'{'+Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+canonicalJson(value[key])).join(',')+'}';throw error('invalid-manifest','资源清单不是有效的规范 JSON');}
export async function verifyManifest(manifest,options){validateManifest(manifest,options);const{packageId,...content}=manifest;if(await sha256(new TextEncoder().encode(canonicalJson(content)))!==packageId)throw error('manifest-digest-mismatch','资源清单摘要与 packageId 不符');return manifest;}
export function verifyIdentity(expected,actual){if(!expected)return;for(const key of identityFields)if(expected[key]!==undefined&&expected[key]!==actual?.[key])throw error('identity-mismatch',`声音资源与游戏设计不匹配：${key}`);}
function positive(value,name){if(!Number.isSafeInteger(value)||value<0)throw error('invalid-manifest',`${name} 必须是非负整数`);return value;}
function safePath(path){if(typeof path!=='string'||!path||path.startsWith('/')||path.includes('\\')||path.split('/').some(part=>!part||part==='.'||part==='..')||/[?#\x00-\x1f]/.test(path)||/%2e|%2f|%5c/i.test(path))throw error('invalid-path','资源包包含不安全的文件路径');return path;}
export function validateManifest(manifest,{expectedIdentity,planId,planDigest,selectionDigest}={}){
  if(!manifest||manifest.schemaVersion!==1||!Array.isArray(manifest.files)||!manifest.identity||typeof manifest.packageId!=='string')throw error('invalid-manifest','声音资源清单无效');
  verifyIdentity(expectedIdentity,manifest.identity);
  for(const [key,expected]of Object.entries({planId,planDigest,selectionDigest}))if(expected!==undefined&&expected!==manifest[key])throw error('identity-mismatch',`声音资源清单 ${key} 不匹配`);
  const ids=new Set(),paths=new Set();
  for(const file of manifest.files){if(typeof file.id!=='string'||!file.id||ids.has(file.id)||paths.has(file.path))throw error('invalid-manifest','资源文件 ID 或路径重复');ids.add(file.id);paths.add(safePath(file.path));if(!/^[a-f0-9]{64}$/.test(file.sha256))throw error('invalid-manifest','资源文件缺少 SHA-256');positive(file.bytes,'bytes');positive(file.decodedPcmBytes??0,'decodedPcmBytes');if(typeof file.mimeType!=='string')throw error('invalid-manifest','资源文件缺少 MIME 类型');if(file.mimeType.startsWith('audio/')&&(!Number.isSafeInteger(file.sampleRate)||file.sampleRate<8000||file.sampleRate>192000||!Number.isSafeInteger(file.channels)||file.channels<1||file.channels>8||!Number.isSafeInteger(file.frames)||file.frames<1))throw error('invalid-manifest','音频 PCM 元数据无效');}
  for(const item of Object.values(manifest.sfx||{}))for(const id of item.variants||[])if(!ids.has(id))throw error('invalid-manifest',`音效引用了缺失文件：${id}`);
  for(const item of Object.values(manifest.music||{})){const fileIds=item.mixFileId?[item.mixFileId]:Array.isArray(item.stemFileIds)?item.stemFileIds:Object.values(item.stemFileIds||{});for(const id of fileIds)if(!ids.has(id))throw error('invalid-manifest',`配乐引用了缺失文件：${id}`);const loop=item.loop;if(loop&&(!Number.isFinite(loop.referenceSampleRate)||loop.referenceSampleRate<=0||!Number.isSafeInteger(loop.startFrame)||!Number.isSafeInteger(loop.endFrame)||loop.startFrame<0||loop.endFrame<=loop.startFrame))throw error('invalid-loop','配乐循环边界无效');}
  return manifest;
}
function combineSignal(signal,timeoutMs,ownerSignal){const controller=new AbortController(),listeners=[];for(const source of [signal,ownerSignal]){if(!source)continue;const abort=()=>controller.abort(source.reason);if(source.aborted)abort();else{source.addEventListener('abort',abort,{once:true});listeners.push([source,abort]);}}const timer=setTimeout(()=>controller.abort('timeout'),timeoutMs);return{signal:controller.signal,close(){clearTimeout(timer);for(const[source,abort]of listeners)source.removeEventListener('abort',abort);}};}
function wait(ms,signal){return new Promise((resolve,reject)=>{if(signal?.aborted){reject(abortError());return;}const timer=setTimeout(()=>{signal?.removeEventListener('abort',abort);resolve();},ms);function abort(){clearTimeout(timer);reject(abortError());}signal?.addEventListener('abort',abort,{once:true});});}
function createPersistentCache(enabled){
  let connection,closed=false;const transactions=new Set();
  async function db(){if(closed||!enabled||!globalThis.indexedDB)return null;try{if(!connection)connection=new Promise((resolve,reject)=>{const request=indexedDB.open('game-audio-media-cache-v1',1);request.onupgradeneeded=()=>request.result.createObjectStore('sha256');request.onsuccess=()=>{if(closed){request.result.close();resolve(null);}else resolve(request.result);};request.onerror=()=>reject(request.error);});return await connection;}catch{return null;}}
  return{async get(hash){const store=await db();if(!store||closed)return null;return new Promise(resolve=>{try{const transaction=store.transaction('sha256'),request=transaction.objectStore('sha256').get(hash);transactions.add(transaction);request.onsuccess=()=>resolve(closed?null:request.result||null);request.onerror=()=>resolve(null);transaction.oncomplete=()=>transactions.delete(transaction);transaction.onabort=()=>{transactions.delete(transaction);resolve(null);};}catch{resolve(null);}});},async put(hash,bytes){const store=await db();if(!store||closed)return;await new Promise(resolve=>{try{const transaction=store.transaction('sha256','readwrite');transactions.add(transaction);transaction.objectStore('sha256').put(bytes,hash);transaction.oncomplete=transaction.onerror=transaction.onabort=()=>{transactions.delete(transaction);resolve();};}catch{resolve();}});},async close(){if(closed)return;closed=true;for(const transaction of transactions)try{transaction.abort();}catch{}transactions.clear();if(connection)void connection.then(store=>store?.close()).catch(()=>{});connection=null;}};
}
async function decodeFile(context,file,bytes,assertActive=()=>{}){
  let decoded;try{decoded=await context.decodeAudioData(bytes.slice(0));}catch(cause){assertActive();throw error('decode-failed',`浏览器无法解码 ${file.path}`,{componentId:file.id,cause});}assertActive();
  if(!decoded?.length||!decoded.numberOfChannels||!Number.isFinite(decoded.sampleRate))throw error('decode-failed',`解码输出无效：${file.path}`,{componentId:file.id});
  if(file.channels&&decoded.numberOfChannels!==file.channels)throw error('decode-metadata-mismatch',`声道数不匹配：${file.path}`,{componentId:file.id});
  const masterFrames=file.trim?.masterFrames??file.frames,referenceRate=file.trim?.referenceSampleRate??file.sampleRate;
  if(Number.isSafeInteger(masterFrames)&&masterFrames>0&&referenceRate>0){
    const targetFrames=Math.round(masterFrames/referenceRate*decoded.sampleRate);
    if(decoded.length+1<targetFrames)throw error('truncated-audio',`音频时长短于母版：${file.path}`,{componentId:file.id});
    // Browser containers remove AAC priming. Trim only the known trailing padding, never 1024 samples at the front.
    if(decoded.length>targetFrames){const trimmed=context.createBuffer(decoded.numberOfChannels,targetFrames,decoded.sampleRate);for(let channel=0;channel<decoded.numberOfChannels;channel++)trimmed.copyToChannel(decoded.getChannelData(channel).subarray(0,targetFrames),channel);decoded=trimmed;}
  }
  return decoded;
}

export function createAudioServiceClient({baseUrl=globalThis.location?.origin||'http://localhost',token=null,fetchImpl=globalThis.fetch,persistentCache=false,timeoutMs=30000,maxTransferBytes=64*1024*1024,maxDecodedPcmBytes=160*1024*1024}={}){
  const base=new URL(baseUrl,globalThis.location?.href||'http://localhost/'),persistent=createPersistentCache(persistentCache),manifests=new ByteLru(2*1024*1024,value=>new TextEncoder().encode(JSON.stringify(value)).byteLength),ownerController=new AbortController();let disposed=false;
  function assertActive(){if(disposed)throw error('client-disposed','声音客户端已关闭');}
  function assertOperation(signal){assertActive();if(signal?.aborted)throw abortError();}
  function resolve(path){return new URL(path,base.href.endsWith('/')?base.href:base.href+'/');}
  async function request(path,{method='GET',body,headers={},signal,binary=false,maxBytes,timeout=timeoutMs}={}){
    assertOperation(signal);
    const url=resolve(path);if(url.origin!==base.origin)throw error('cross-origin-url','声音服务返回了不同来源的资源地址');
    const auth=typeof token==='function'?await token():token;assertOperation(signal);const combined=combineSignal(signal,timeout,ownerController.signal);
    try{
      const response=await fetchImpl(url,{method,headers:{...(auth?{Authorization:`Bearer ${auth}`}:{ }),...(body!==undefined?{'Content-Type':'application/json'}:{}),...headers},...(body!==undefined?{body:JSON.stringify(body)}:{}),signal:combined.signal,credentials:'omit'});assertOperation(signal);
      if(!response.ok){let payload;try{payload=await response.json();}catch{}assertOperation(signal);throw error(payload?.error?.code||`http-${response.status}`,payload?.error?.message||`声音服务请求失败 (${response.status})`,{status:response.status,retryable:payload?.error?.retryable??response.status>=500,componentId:payload?.error?.componentId});}
      if(binary){
        if(maxBytes!==undefined&&Number(response.headers?.get('Content-Length'))>maxBytes)throw error('transfer-budget-exceeded','服务返回的文件超过声明大小');
        if(maxBytes!==undefined&&response.body?.getReader){const reader=response.body.getReader(),chunks=[];let length=0;try{while(true){const{done,value}=await reader.read();assertOperation(signal);if(done)break;length+=value.byteLength;if(length>maxBytes){await reader.cancel();assertOperation(signal);throw error('transfer-budget-exceeded','资源传输超过声明文件大小');}chunks.push(value);}const result=new Uint8Array(length);let offset=0;for(const chunk of chunks){result.set(chunk,offset);offset+=chunk.byteLength;}return result.buffer;}finally{reader.releaseLock();}}
        const result=await response.arrayBuffer();assertOperation(signal);return result;
      }
      const result=await response.json();assertOperation(signal);return result;
    }catch(cause){assertActive();if(cause instanceof AudioServiceError)throw cause;if(signal?.aborted)throw abortError();if(combined.signal.aborted)throw error('request-timeout','声音服务响应超时，可以重试',{retryable:true,cause});throw error('network-error','无法连接声音服务',{retryable:true,cause});}
    finally{combined.close();}
  }
  async function getManifest(path,options={}){
    const check=()=>assertOperation(options.signal);check();
    const url=resolve(path),key=url.href;
    let value=manifests.get(key);if(!value){const response=await request(url,options);check();value=response.manifest||response;await verifyManifest(value,options);check();manifests.set(key,value);}
    await verifyManifest(value,options);check();const requestedDigest=url.pathname.match(/\/packages\/([a-f0-9]{64})\/manifest\/?$/)?.[1];if(requestedDigest&&requestedDigest!==value.packageId)throw error('manifest-digest-mismatch','资源清单与请求的包地址不符');return value;
  }
  async function downloadPackage(input,{signal,audioContext,decode=!!audioContext,onProgress=()=>{},expectedIdentity,planId,planDigest,selectionDigest,fileBaseUrl,transferBudget=maxTransferBytes,decodedBudget=maxDecodedPcmBytes}={}){
    const check=()=>assertOperation(signal);check();
    const manifestUrl=typeof input==='string'||input instanceof URL?resolve(input):null,manifest=manifestUrl?await getManifest(manifestUrl,{signal,expectedIdentity,planId,planDigest,selectionDigest}):await verifyManifest(input,{expectedIdentity,planId,planDigest,selectionDigest});
    check();
    const totalBytes=manifest.files.reduce((sum,file)=>sum+file.bytes,0),declaredPcm=manifest.files.reduce((sum,file)=>sum+(file.decodedPcmBytes||0),0);
    if(totalBytes>transferBudget)throw error('transfer-budget-exceeded',`资源包大小超过接收预算 (${totalBytes} > ${transferBudget})`);
    if(declaredPcm>decodedBudget)throw error('pcm-budget-exceeded','资源包解码内存超过接收预算');
    if(decode&&!audioContext)throw error('audio-context-required','解码需要由宿主提供 AudioContext');
    const root=fileBaseUrl?resolve(fileBaseUrl):manifestUrl?new URL(manifestUrl.pathname.replace(/\/manifest\/?$/,'/files/'),manifestUrl):null;
    if(!root)throw error('package-url-required','传入清单对象时需要 fileBaseUrl');
    if(root.origin!==base.origin)throw error('cross-origin-url','资源文件来源与声音服务不一致');
    const files=new Map(),decoded=new Map();let completedBytes=0,actualPcm=0;
    for(const file of manifest.files){
      check();if(signal?.aborted)throw abortError();
      let bytes=memoryBytes.get(file.sha256)||await persistent.get(file.sha256),cacheHit=!!bytes;
      check();if(bytes){const valid=bytes instanceof ArrayBuffer&&bytes.byteLength===file.bytes&&await sha256(bytes)===file.sha256;check();if(!valid){bytes=null;cacheHit=false;memoryBytes.delete(file.sha256);}}
      if(!bytes){bytes=await request(new URL(file.path.split('/').map(encodeURIComponent).join('/'),root),{signal,binary:true,maxBytes:file.bytes});check();if(bytes.byteLength!==file.bytes)throw error('size-mismatch',`文件长度校验失败：${file.path}`,{componentId:file.id});const digest=await sha256(bytes);check();if(digest!==file.sha256)throw error('hash-mismatch',`SHA-256 校验失败：${file.path}`,{componentId:file.id});memoryBytes.set(file.sha256,bytes.slice(0));await persistent.put(file.sha256,bytes);check();}
      files.set(file.id,bytes.slice(0));completedBytes+=bytes.byteLength;
      if(decode&&file.mimeType.startsWith('audio/')){
        const key=`${file.sha256}:${audioContext.sampleRate}:${file.trim?.masterFrames??file.frames??''}`,buffer=memoryDecoded.get(key)||await decodeFile(audioContext,file,bytes,check);check();
        actualPcm+=buffer.length*buffer.numberOfChannels*4;if(actualPcm>decodedBudget)throw error('pcm-budget-exceeded','浏览器实际解码内存超过接收预算');memoryDecoded.set(key,buffer);decoded.set(file.id,buffer);
      }
      onProgress({fileId:file.id,path:file.path,completedBytes,totalBytes,completedFiles:files.size,totalFiles:manifest.files.length,cacheHit});check();
    }
    check();return{manifest,files,decoded,transferBytes:totalBytes,decodedPcmBytes:actualPcm,verified:true};
  }
  return{
    request,getHealth:options=>request('/v1/audio/health',options),getCapabilities:options=>request('/v1/audio/capabilities',options),
    async probeFormats({audioContext,formats,signal}={}){
      const check=()=>assertOperation(signal);check();
      if(!audioContext?.decodeAudioData)throw error('audio-context-required','实际解码探测需要 AudioContext');
      const supported=formats||((await request('/v1/audio/capabilities',{signal})).formats||[]),results=[];check();
      for(const formatId of ['opus-ogg','aac-lc-m4a']){
        check();if(!supported.some(format=>format.id===formatId))continue;if(signal?.aborted)throw abortError();
        const key=`${formatId}:${audioContext.sampleRate}`;let accepted=probeResults.get(key);
        if(accepted===undefined){try{const buffer=await audioContext.decodeAudioData(fromBase64(probes[formatId]));check();accepted=buffer.length>0&&buffer.numberOfChannels>0;}catch{check();accepted=false;}probeResults.set(key,accepted);}
        results.push({formatId,accepted,probe:'native-decodeAudioData'});
      }
      check();return{acceptedFormats:results.filter(item=>item.accepted).map(item=>item.formatId),results};
    },
    async createPlan(input,options){assertActive();const response=await request('/v1/audio/plans',{...options,method:'POST',body:input});assertActive();return response.plan||response;},
    async getPlan(id,options){assertActive();const response=await request(`/v1/audio/plans/${encodeURIComponent(id)}`,options);assertActive();return response.plan||response;},
    async submitJob(plan,options={}){assertActive();const{acceptedItems=plan.items?.map(item=>item.id)||[],delivery=plan.delivery,idempotencyKey=crypto.randomUUID(),signal}=options;const response=await request('/v1/audio/jobs',{method:'POST',body:{planId:plan.planId,planDigest:plan.planDigest,identity:plan.identity,acceptedItems,delivery},headers:{'Idempotency-Key':idempotencyKey},signal});assertActive();return response.job||response;},
    async getJob(id,options){assertActive();const response=await request(`/v1/audio/jobs/${encodeURIComponent(id)}`,options);assertActive();return response.job||response;},
    async cancelJob(id,options){assertActive();const response=await request(`/v1/audio/jobs/${encodeURIComponent(id)}`,{...options,method:'DELETE'});assertActive();return response.job||response;},
    async retryJob(id,{signal,idempotencyKey=crypto.randomUUID(),retryItems,job:previousJob}={}){assertActive();const original=previousJob||await this.getJob(id,{signal});assertActive();const body={planId:original.planId,planDigest:original.planDigest,identity:original.identity,acceptedItems:original.acceptedItems,delivery:original.delivery,...(retryItems?{retryItems}:{})};const response=await request(`/v1/audio/jobs/${encodeURIComponent(id)}/retry`,{method:'POST',body,signal,headers:{'Idempotency-Key':idempotencyKey}});assertActive();return response.job||response;},
    async waitForJob(id,{signal,onUpdate=()=>{},intervalMs=1200,timeoutMs:jobTimeout=300000,until='all'}={}){
      assertActive();
      const start=Date.now();let failureCount=0;
      while(true){assertActive();if(signal?.aborted)throw abortError();if(Date.now()-start>jobTimeout)throw error('job-timeout','声音任务仍未完成，可稍后查询',{retryable:true});
        let job;try{job=await this.getJob(id,{signal});assertActive();failureCount=0;}catch(cause){assertActive();if(!cause.retryable||++failureCount>3)throw cause;const pause=combineSignal(signal,Math.min(10000,intervalMs*2**failureCount)+1000,ownerController.signal);try{await wait(Math.min(10000,intervalMs*2**failureCount),pause.signal);}catch{assertActive();throw abortError();}finally{pause.close();}continue;}
        await onUpdate(job);assertOperation(signal);
        if((until==='required'?job.requiredReady:job.allSelectedReady)||['completed','ready','failed','cancelled','partial-ready','partial_failed','partially-failed'].includes(job.status))return job;
        const pause=combineSignal(signal,intervalMs+1000,ownerController.signal);try{await wait(intervalMs,pause.signal);assertActive();}catch{assertActive();throw abortError();}finally{pause.close();}
      }
    },
    getManifest,downloadPackage,
    async decodePackage(bundle,audioContext,options={}){
      const check=()=>assertOperation(options.signal);check();await verifyManifest(bundle.manifest,options);check();const decoded=new Map();let used=0;
      for(const file of bundle.manifest.files){check();if(!file.mimeType.startsWith('audio/'))continue;if(options.signal?.aborted)throw abortError();const bytes=bundle.files.get(file.id),digest=bytes?await sha256(bytes):null;check();if(!bytes||digest!==file.sha256)throw error('hash-mismatch','本地音频完整性校验失败',{componentId:file.id});const key=`${file.sha256}:${audioContext.sampleRate}:${file.trim?.masterFrames??file.frames??''}`,buffer=memoryDecoded.get(key)||await decodeFile(audioContext,file,bytes,check);check();used+=buffer.length*buffer.numberOfChannels*4;if(used>(options.decodedBudget??maxDecodedPcmBytes))throw error('pcm-budget-exceeded','实际解码内存超过接收预算');decoded.set(file.id,buffer);memoryDecoded.set(key,buffer);}
      check();return{...bundle,decoded,decodedPcmBytes:used};
    },
    async dispose(){if(disposed)return;disposed=true;ownerController.abort('client-disposed');await persistent.close();},
    clearMemoryCache(){assertActive();memoryBytes.clear();memoryDecoded.clear();manifests.clear();},
    get cacheStats(){return{files:memoryBytes.size,decoded:memoryDecoded.size,manifests:manifests.size,encodedBytes:memoryBytes.bytes,decodedBytes:memoryDecoded.bytes,manifestBytes:manifests.bytes,maxEncodedBytes:memoryBytes.limit,maxDecodedBytes:memoryDecoded.limit};}
  };
}
