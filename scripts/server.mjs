import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { handleBlindRequest } from './blind-api.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const port=Number(process.env.GAME_AUDIO_PORT||4178);
const mime={'.html':'text/html; charset=utf-8','.mjs':'text/javascript; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json; charset=utf-8','.wav':'audio/wav','.ogg':'audio/ogg','.mp3':'audio/mpeg','.png':'image/png','.md':'text/plain; charset=utf-8','.txt':'text/plain; charset=utf-8'};
const publicRoots=new Set(['src','assets','vendor','docs','artifacts']);
const publicFiles=new Set(['index.html','blind.html','listen.html','pipeline.html','README.md','REPORT.md','THIRD_PARTY_NOTICES.md']);
let soundBankPromise;
function soundBank(){
 if(!soundBankPromise)soundBankPromise=(async()=>{
  const manifest=JSON.parse(await fs.readFile(path.join(root,'assets/manifest.json'),'utf8'));
  const urls=[...manifest.samples.map(item=>item.url),...Object.values(manifest.instruments.marimbaSampled.urls)];
  const entries=await Promise.all(urls.map(async url=>[url,(await fs.readFile(path.join(root,url))).toString('base64')]));
  return Buffer.from(JSON.stringify({manifest,files:Object.fromEntries(entries)}));
 })().catch(error=>{soundBankPromise=undefined;throw error;});
 return soundBankPromise;
}
function reply(res,status,message,headers={}){res.writeHead(status,headers);res.end(message);}
function rangeFor(header,size){
 const match=/^bytes=(\d*)-(\d*)$/.exec(header);
 if(!match||(!match[1]&&!match[2]))return null;
 const start=match[1]?Number(match[1]):Math.max(0,size-Number(match[2]));
 const end=match[1]?(match[2]?Math.min(size-1,Number(match[2])):size-1):size-1;
 return Number.isSafeInteger(start)&&Number.isSafeInteger(end)&&start>=0&&start<=end&&start<size?{start,end}:null;
}
async function saveArtifact(req,res,url){
 const name=url.searchParams.get('name')||'';
 if(!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,100}\.(wav|json|png)$/.test(name)){reply(res,400,'Invalid artifact name');return;}
 const chunks=[];let total=0;
 for await(const chunk of req){total+=chunk.length;if(total>80*1024*1024){reply(res,413,'Artifact too large');return;}chunks.push(chunk);}
 const payload=Buffer.concat(chunks);let data=payload;
 if((req.headers['content-type']||'').includes('application/json')){
  let value;try{value=JSON.parse(payload.toString());}catch{reply(res,400,'Invalid JSON');return;}
  if(typeof value?.base64==='string')data=Buffer.from(value.base64,'base64');
  else if(!name.endsWith('.json')){reply(res,400,'Expected a base64 audio/image payload');return;}
 }
 await fs.mkdir(path.join(root,'artifacts'),{recursive:true});
 await fs.writeFile(path.join(root,'artifacts',name),data);
 reply(res,200,JSON.stringify({saved:name,bytes:data.length}),{'Content-Type':'application/json'});
}
const server=http.createServer(async(req,res)=>{
 try{
  const url=new URL(req.url,'http://127.0.0.1');
  if(url.pathname==='/api/audio/capabilities'&&req.method==='GET'){
   reply(res,200,JSON.stringify({schemaVersion:1,director:'local-rule-based-research-prototype',profiles:['cozy','neon','ruins'],rendering:'browser-web-audio-offline',eventBridge:'message-channel-v1'}),{'Content-Type':'application/json'});return;
  }
  if(url.pathname==='/api/audio/plan'){
   if(req.method!=='POST'){reply(res,405,'Use POST',{'Allow':'POST'});return;}
   const chunks=[];let size=0;
   for await(const chunk of req){size+=chunk.length;if(size>256*1024){reply(res,413,'Plan request too large');return;}chunks.push(chunk);}
   let input;try{input=JSON.parse(Buffer.concat(chunks).toString());}catch{reply(res,400,JSON.stringify({error:'Expected JSON'}),{'Content-Type':'application/json'});return;}
   try{
    const {createAudioPlan}=await import('../src/game-audio-pipeline.mjs');
    const plan=await createAudioPlan(input?.gameBrief,input?.eventContract,input?.options);
    reply(res,200,JSON.stringify({plan}),{'Content-Type':'application/json','Cache-Control':'no-store'});
   }catch(error){reply(res,400,JSON.stringify({error:error.message}),{'Content-Type':'application/json'});}
   return;
  }
  if(url.pathname==='/api/blind'||url.pathname.startsWith('/api/blind/')){await handleBlindRequest(req,res,url);return;}
  if(req.method==='GET'&&url.pathname==='/api/sound-bank'){
   const data=await soundBank();reply(res,200,data,{'Content-Type':'application/json','Content-Length':data.length,'Cache-Control':'no-store'});return;
  }
  if(req.method==='POST'&&url.pathname==='/api/artifacts'){await saveArtifact(req,res,url);return;}
  if(!['GET','HEAD'].includes(req.method)){reply(res,405,'Method not allowed',{'Allow':'GET, HEAD'});return;}
  let relative;try{relative=decodeURIComponent(url.pathname==='/'?'/index.html':url.pathname);}catch{reply(res,400,'Invalid path');return;}
  const segments=relative.slice(1).split(/[\\/]/),extension=path.extname(relative).toLowerCase();
  if(segments.some(segment=>segment.startsWith('.'))||segments.some(segment=>segment.toLowerCase()==='blind-sessions')||
     !(segments.length===1?publicFiles.has(segments[0]):publicRoots.has(segments[0]))||!mime[extension]){reply(res,403,'Not a public resource');return;}
  const file=path.resolve(root,'.'+relative);
  if(!file.startsWith(root+path.sep)){reply(res,403,'Not a public resource');return;}
  let stat;try{stat=await fs.stat(file);}catch(error){if(error.code==='ENOENT'){reply(res,404,'Not found');return;}throw error;}
  if(!stat.isFile()){reply(res,404,'Not found');return;}
  const headers={'Content-Type':mime[extension],'Cache-Control':'no-store','Accept-Ranges':'bytes','X-Content-Type-Options':'nosniff'};
  let range;if(req.headers.range){range=rangeFor(req.headers.range,stat.size);if(!range){reply(res,416,'',{'Content-Range':`bytes */${stat.size}`});return;}}
  const length=range?range.end-range.start+1:stat.size;
  headers['Content-Length']=length;
  if(range)headers['Content-Range']=`bytes ${range.start}-${range.end}/${stat.size}`;
  if(req.method==='HEAD'){reply(res,range?206:200,'',headers);return;}
  const data=await fs.readFile(file);reply(res,range?206:200,range?data.subarray(range.start,range.end+1):data,headers);
 }catch(error){if(!res.headersSent)reply(res,500,'Local server request failed');else res.end();console.error('[server]',error.message);}
});
server.listen(port,'127.0.0.1',()=>console.log(`GameAudioLab http://127.0.0.1:${server.address().port}`));
