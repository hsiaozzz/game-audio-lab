import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createAudioServiceClient} from '../src/audio-service-client.mjs';
import {verifyDeliveryPlan} from '../server/audio-plan.mjs';

// Run from the repository: node examples/backend-orchestrator.mjs [request.json]
// The token stays on the backend. Serve the verified output through your game's asset host.
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const destination=path.resolve(process.env.GAME_AUDIO_EXPORT_DIR||path.join(root,'.data/host-export'));
const stateFile=path.join(destination,'host-job.json');
const client=createAudioServiceClient({baseUrl:process.env.GAME_AUDIO_SERVICE_URL||'http://127.0.0.1:4178',token:process.env.GAME_AUDIO_API_TOKEN||null});
const controller=new AbortController();process.once('SIGINT',()=>controller.abort());
try{
  await fs.mkdir(destination,{recursive:true});
  let job;
  if(process.env.GAME_AUDIO_RESUME_JOB){job=await client.getJob(process.env.GAME_AUDIO_RESUME_JOB);}
  else{
    const input=JSON.parse(await fs.readFile(process.argv[2]||path.join(root,'examples/audio-service-request.json'),'utf8'));
    const plan=await client.createPlan(input,{signal:controller.signal});
    verifyDeliveryPlan(plan);
    // This sample host accepts required items only. Replace this decision with your review UI/policy.
    const acceptedItems=plan.items.filter(item=>item.required).map(item=>item.id);
    if(!acceptedItems.length)throw new Error('Host policy selected no required audio');
    const key=process.env.GAME_AUDIO_CONFIRMATION_KEY||plan.planDigest+'-required-only';
    job=await client.submitJob(plan,{acceptedItems,idempotencyKey:key,signal:controller.signal});
    await fs.writeFile(stateFile,JSON.stringify({jobId:job.id,planId:job.planId,planDigest:job.planDigest},null,2));
  }
  job=await client.waitForJob(job.id,{signal:controller.signal,onUpdate:update=>console.log(JSON.stringify({jobId:update.id,status:update.status,progress:update.progress,requiredReady:update.requiredReady,manifestUrl:update.manifestUrl}))});
  if(!job.manifestUrl)throw new Error('No audio delivered: '+job.status);
  const bundle=await client.downloadPackage(job.manifestUrl,{expectedIdentity:job.identity,planId:job.planId,planDigest:job.planDigest,selectionDigest:job.selectionDigest,signal:controller.signal});
  const packageDirectory=path.join(destination,bundle.manifest.packageId);await fs.mkdir(packageDirectory,{recursive:true});
  for(const file of bundle.manifest.files){const target=path.join(packageDirectory,...file.path.split('/'));await fs.mkdir(path.dirname(target),{recursive:true});await fs.writeFile(target,new Uint8Array(bundle.files.get(file.id)));}
  await fs.writeFile(path.join(packageDirectory,'manifest.json'),JSON.stringify(bundle.manifest,null,2));
  console.log(JSON.stringify({directory:packageDirectory,packageId:bundle.manifest.packageId,requiredReady:job.requiredReady,allSelectedReady:job.allSelectedReady,transferBytes:bundle.transferBytes},null,2));
  if(!job.requiredReady)process.exitCode=2; // Preserve partial assets, but do not mark the game ready.
}catch(error){console.error(JSON.stringify({code:error.code||'host-error',message:error.message,retryable:error.retryable===true}));process.exitCode=1;}
finally{await client.dispose();}
