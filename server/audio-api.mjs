import fs from 'node:fs/promises';
import path from 'node:path';
import { timingSafeEqual, createHash } from 'node:crypto';
import { createDeliveryPlan, FORMATS, LIMITS, SERVICE_VERSION, apiError } from './audio-plan.mjs';
import { loadDirectorOptions } from './audio-director.mjs';

const send = (res,status,value,headers={}) => {
  res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff',...headers});
  res.end(JSON.stringify(value));
};
const secureEqual=(a,b)=>{const left=Buffer.from(a),right=Buffer.from(b);return left.length===right.length&&timingSafeEqual(left,right);};
export async function readAudioJson(req) {
  if (!(req.headers['content-type'] || '').toLowerCase().includes('application/json')) throw apiError(415,'unsupported-content-type','Use application/json');
  const chunks=[];let size=0;
  for await(const chunk of req){size+=chunk.length;if(size>LIMITS.requestBytes)throw apiError(413,'request-too-large','Audio request exceeds 256 KiB');chunks.push(chunk);}
  try{return JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw apiError(400,'invalid-json','Expected valid JSON');}
}

export async function createAudioApi({root,dataDir=path.join(root,'.data/audio-service'),env=process.env,store:providedStore,renderItem}={}) {
  const {createAudioJobStore}=await import('./audio-jobs.mjs');
  const director=await loadDirectorOptions(env);
  const concurrency=Number(env.GAME_AUDIO_CONCURRENCY || 1);
  if(!Number.isInteger(concurrency)||concurrency<1||concurrency>4)throw new Error('GAME_AUDIO_CONCURRENCY must be 1..4');
  const origins=new Set((env.GAME_AUDIO_ALLOWED_ORIGINS||'').split(',').map(value=>value.trim()).filter(Boolean));
  let credentials=[];
  if(env.GAME_AUDIO_API_TOKEN)credentials.push(['service',env.GAME_AUDIO_API_TOKEN]);
  if(env.GAME_AUDIO_API_TOKENS_JSON){
    const entries=JSON.parse(env.GAME_AUDIO_API_TOKENS_JSON);
    if(!entries||Array.isArray(entries)||typeof entries!=='object')throw new Error('GAME_AUDIO_API_TOKENS_JSON must map owner IDs to tokens');
    credentials.push(...Object.entries(entries));
  }
  if(credentials.some(([owner,token])=>!/^[A-Za-z0-9_-]{1,64}$/.test(owner)||typeof token!=='string'||token.length<24))throw new Error('Service tokens require safe owner IDs and at least 24 characters');
  if(new Set(credentials.map(([owner])=>owner)).size!==credentials.length || new Set(credentials.map(([,token])=>token)).size!==credentials.length)throw new Error('Service token owners and tokens must be unique');
  if(!['127.0.0.1','localhost','::1'].includes(env.GAME_AUDIO_HOST||'127.0.0.1')&&!credentials.length)throw new Error('A non-loopback service requires GAME_AUDIO_API_TOKEN or GAME_AUDIO_API_TOKENS_JSON');
  const store=providedStore || await createAudioJobStore({dataDir,concurrency,...(renderItem?{renderItem}:{})});
  if(store.initialize)await store.initialize();
  const buckets=new Map();let healthCache;
  function authorize(req) {
    if(!credentials.length)return 'local-development';
    const token=(req.headers.authorization||'').match(/^Bearer ([^\s]+)$/)?.[1];
    if(!token)throw apiError(401,'unauthorized','A service bearer token is required');
    const owner=credentials.find(([,expected])=>secureEqual(token,expected))?.[0];
    if(!owner)throw apiError(401,'unauthorized','Invalid service credentials');
    return owner;
  }
  function limit(owner,method) {
    if(method==='GET'||method==='HEAD')return;
    const now=Date.now();for(const [key,value]of buckets)if(now-value.at>60000)buckets.delete(key);
    const key=createHash('sha256').update(owner).digest('hex'),entry=buckets.get(key)||{at:now,count:0};
    if(++entry.count>60)throw apiError(429,'rate-limited','Audio service write rate exceeded; retry after one minute',true);
    buckets.set(key,entry);
  }
  async function health(){
    if(healthCache&&Date.now()-healthCache.at<10000)return healthCache.value;
    let renderer;
    try{const media=await import('./audio-media.mjs');const status=await media.inspectMediaDependencies();renderer={...status,ready:status.available===true};}
    catch(error){renderer={ready:false,reason:'renderer-dependencies-unavailable'};}
    const value={schemaVersion:1,serviceVersion:SERVICE_VERSION,status:renderer.ready===false?'degraded':'ok',renderer,director:director.info,persistence:'local-filesystem-single-service-process'};
    healthCache={at:Date.now(),value};return value;
  }
  async function fileResponse(req,res,entry,relative){
    if(!relative||relative.includes('\\')||relative.split('/').some(part=>!part||part==='.'||part==='..'||part.startsWith('.')))throw apiError(400,'invalid-resource-path','Invalid package file path');
    const listed=entry.manifest.files.find(file=>file.path===relative);
    if(!listed)throw apiError(404,'file-not-found','Resource is not listed in this package');
    const resolved=path.resolve(entry.directory,relative);
    if(!resolved.startsWith(path.resolve(entry.directory)+path.sep))throw apiError(400,'invalid-resource-path','Resource escapes package');
    const bytes=await fs.readFile(resolved);
    if(bytes.length!==listed.bytes||createHash('sha256').update(bytes).digest('hex')!==listed.sha256)throw apiError(503,'package-corrupted','Stored package resource failed integrity verification',false);
    const etag='"'+listed.sha256+'"',headers={'Content-Type':listed.mimeType,'X-Content-Type-Options':'nosniff','Cache-Control':'private, max-age=31536000, immutable','ETag':etag,'Accept-Ranges':'bytes'};
    if(req.headers['if-none-match']===etag&&!req.headers.range){res.writeHead(304,headers);res.end();return;}
    let start=0,end=bytes.length-1,status=200;
    if(req.headers.range){
      const match=/^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
      if(!match||(!match[1]&&!match[2])){res.writeHead(416,{...headers,'Content-Range':`bytes */${bytes.length}`});res.end();return;}
      start=match[1]?Number(match[1]):Math.max(0,bytes.length-Number(match[2]));end=match[1]?(match[2]?Math.min(bytes.length-1,Number(match[2])):bytes.length-1):bytes.length-1;
      if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start>end||start<0||start>=bytes.length){res.writeHead(416,{...headers,'Content-Range':`bytes */${bytes.length}`});res.end();return;}
      status=206;headers['Content-Range']=`bytes ${start}-${end}/${bytes.length}`;
    }
    headers['Content-Length']=end-start+1;res.writeHead(status,headers);res.end(req.method==='HEAD'?undefined:bytes.subarray(start,end+1));
  }
  return {
    store,
    async handle(req,res,url){
      if(!url.pathname.startsWith('/v1/audio/'))return false;
      try{
        const origin=req.headers.origin;
        // Same-origin requests need no CORS grants. Cross-origin calls require an exact allowlist.
        const hostOrigin=`http://${req.headers.host}`;
        if(origin&&origin!==hostOrigin){if(!origins.has(origin))throw apiError(403,'origin-not-allowed','Origin is not allowed');res.setHeader('Access-Control-Allow-Origin',origin);res.setHeader('Access-Control-Expose-Headers','ETag, Content-Length, Content-Range, Location');res.setHeader('Vary','Origin');}
        if(req.method==='OPTIONS'){res.writeHead(204,{'Access-Control-Allow-Methods':'GET, HEAD, POST, DELETE, OPTIONS','Access-Control-Allow-Headers':'Authorization, Content-Type, Idempotency-Key, Range','Access-Control-Expose-Headers':'ETag, Content-Length, Content-Range','Access-Control-Max-Age':'600'});res.end();return true;}
        const owner=authorize(req);limit(owner,req.method);
        const route=url.pathname;
        if(route==='/v1/audio/health'&&req.method==='GET'){const value=await health();send(res,200,value);return true;}
        if(route==='/v1/audio/capabilities'&&req.method==='GET'){const value=await health();send(res,200,{schemaVersion:1,apiVersion:'v1',serviceVersion:SERVICE_VERSION,formats:FORMATS,profiles:['cozy','neon','ruins'],spatialCapability:'optional-HRTF-distance-panning-without-occlusion',legacyBridgeSpatialCapability:'stereo-pan-only',musicPolicy:'shared-theme-per-plan',director:director.info,renderer:value.renderer,limits:LIMITS});return true;}
        if(route==='/v1/audio/plans'&&req.method==='POST'){
          const input=await readAudioJson(req),plan=await createDeliveryPlan(input,{directorOptions:director.options});
          await store.savePlan(plan,{owner});send(res,201,{plan});return true;
        }
        const planMatch=/^\/v1\/audio\/plans\/(plan-[a-f0-9]{64})$/.exec(route);
        if(planMatch&&req.method==='GET'){send(res,200,{plan:await store.getPlan(planMatch[1],{owner})});return true;}
        if(route==='/v1/audio/jobs'&&req.method==='POST'){
          const result=await store.createJob(await readAudioJson(req),{owner,idempotencyKey:req.headers['idempotency-key']});send(res,result.replayed?200:202,result,{'Location':result.job.statusUrl});return true;
        }
        const jobMatch=/^\/v1\/audio\/jobs\/([A-Za-z0-9_-]+)(\/retry)?$/.exec(route);
        if(jobMatch){
          if(!jobMatch[2]&&req.method==='GET'){send(res,200,{job:await store.getJob(jobMatch[1],{owner})});return true;}
          if(!jobMatch[2]&&req.method==='DELETE'){send(res,200,{job:await store.cancelJob(jobMatch[1],{owner})});return true;}
          if(jobMatch[2]&&req.method==='POST'){const result=await store.retryJob(jobMatch[1],await readAudioJson(req),{owner,idempotencyKey:req.headers['idempotency-key']});send(res,result.replayed?200:202,result);return true;}
        }
        const packageMatch=/^\/v1\/audio\/packages\/([a-f0-9]{64})\/(manifest|files\/(.+))$/.exec(route);
        if(packageMatch&&['GET','HEAD'].includes(req.method)){
          const entry=await store.getPackage(packageMatch[1],{owner});
          if(packageMatch[2]==='manifest'){if(req.method==='HEAD'){res.writeHead(200,{'Content-Type':'application/json'});res.end();}else send(res,200,entry.manifest);}
          else{let relative;try{relative=decodeURIComponent(packageMatch[3]);}catch{throw apiError(400,'invalid-resource-path','Malformed resource path');}await fileResponse(req,res,entry,relative);}
          return true;
        }
        throw apiError(404,'route-not-found','Unknown audio API resource or method');
      }catch(error){
        if(!res.headersSent)send(res,error.status||500,{error:{code:error.code||'internal-error',message:error.status?error.message:'Audio service could not complete the request',retryable:error.retryable===true,...(error.componentId?{componentId:error.componentId}:{})}});
        else res.end();return true;
      }
    },
    close:()=>store.close()
  };
}
