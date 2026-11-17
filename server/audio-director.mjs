import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { directPrompt } from '../src/director.mjs';
import { apiError } from './audio-plan.mjs';
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';

/** Algorithm modules run only from an operator-configured local path, never request data. */
export async function loadDirectorOptions(env = process.env) {
  if (env.GAME_AUDIO_DIRECTOR_MODULE) {
    const module = await import(pathToFileURL(path.resolve(env.GAME_AUDIO_DIRECTOR_MODULE)).href);
    if (typeof module.directPrompt !== 'function' || (module.composeScore !== undefined && typeof module.composeScore !== 'function') || typeof module.version !== 'string' || !module.version) throw new Error('Director module requires version, directPrompt(), and optional composeScore()');
    const algorithmIdentity = {kind:'configured-algorithm-module',version:module.version,sourceHash:createHash('sha256').update(await fs.readFile(path.resolve(env.GAME_AUDIO_DIRECTOR_MODULE))).digest('hex')};
    return { options: { director: module.directPrompt, algorithmIdentity, ...(module.composeScore ? { composer: module.composeScore, composerVersion: module.version } : {}) },
      info: { kind: 'configured-algorithm-module', version: module.version, modelConnected: module.modelConnected === true } };
  }
  if (env.GAME_AUDIO_DIRECTOR_PROVIDER === 'openai-compatible') {
    const endpoint = env.GAME_AUDIO_DIRECTOR_URL, model = env.GAME_AUDIO_DIRECTOR_MODEL;
    if (!endpoint || !model) throw new Error('Remote director requires GAME_AUDIO_DIRECTOR_URL and GAME_AUDIO_DIRECTOR_MODEL');
    const url = new URL(endpoint);
    if (!['http:','https:'].includes(url.protocol) || url.username || url.password) throw new Error('Invalid operator-configured director endpoint');
    const timeout = Number(env.GAME_AUDIO_DIRECTOR_TIMEOUT_MS || 30000);
    if (!Number.isFinite(timeout) || timeout < 1000 || timeout > 120000) throw new Error('Invalid director timeout');
    const director = async (prompt, options = {}) => {
      const baseline = directPrompt(prompt, options);
      const properties = {
        style: { type:'string', enum:['cozy','neon','ruins'] }, mode:{type:'string',enum:['major','minor']},
        bpm:{type:'integer',minimum:60,maximum:180}, rootMidi:{type:'integer',minimum:36,maximum:84}
      };
      let response;
      try {
        response = await fetch(url, { method:'POST', signal:AbortSignal.timeout(timeout),
          headers:{'Content-Type':'application/json',...(env.GAME_AUDIO_DIRECTOR_KEY ? {Authorization:'Bearer '+env.GAME_AUDIO_DIRECTOR_KEY} : {})},
          body:JSON.stringify({model,temperature:.6,response_format:{type:'json_schema',json_schema:{name:'audio_direction',strict:true,schema:{type:'object',additionalProperties:false,properties,required:Object.keys(properties)}}},
            messages:[{role:'system',content:'Direct game music using only the supported palette. Return the requested JSON. cozy=warm mallets/keys, neon=electronic action, ruins=dark bells/pads. This does not generate audio. Do not include URLs or code.'},{role:'user',content:prompt}]}) });
      } catch { throw apiError(503,'director-unavailable','Configured music director timed out or could not be reached',true); }
      if (!response.ok) throw apiError(503,'director-rejected',`Configured music director returned HTTP ${response.status}`,response.status >= 500 || response.status === 429);
      let text;
      try {
        const reader=response.body.getReader(),chunks=[];let bytes=0;
        try{while(true){const{done,value}=await reader.read();if(done)break;bytes+=value.byteLength;if(bytes>131072){await reader.cancel();throw apiError(502,'director-response-too-large','Director response exceeds 128 KiB');}chunks.push(value);}}
        finally{reader.releaseLock();}
        const buffer=new Uint8Array(bytes);let offset=0;for(const chunk of chunks){buffer.set(chunk,offset);offset+=chunk.byteLength;}text=new TextDecoder().decode(buffer);
      }catch(error){if(error.status)throw error;throw apiError(503,'director-unavailable','Configured music director response was interrupted or timed out',true);}
      let result;
      try { result = JSON.parse(JSON.parse(text).choices[0].message.content); }
      catch { throw apiError(502,'invalid-director-output','Director did not return the required JSON object'); }
      if (!result || typeof result !== 'object' || Array.isArray(result) || Object.keys(result).some(key=>!Object.hasOwn(properties,key)) ||
        !['cozy','neon','ruins'].includes(result.style) || !['major','minor'].includes(result.mode) ||
        !Number.isInteger(result.bpm) || result.bpm<60 || result.bpm>180 || !Number.isInteger(result.rootMidi) || result.rootMidi<36 || result.rootMidi>84) throw apiError(502,'invalid-director-output','Director returned an invalid style, mode, tempo or key');
      return {...baseline,...result,seed:baseline.seed,bars:16,meter:4,director:{kind:'openai-compatible',model}};
    };
    return {options:{director,algorithmIdentity:{kind:'openai-compatible',model,version:'style-direction-v1',endpointHash:createHash('sha256').update(url.href).digest('hex')}},info:{kind:'openai-compatible',model,modelConnected:true,scope:'style-tempo-key-direction; seeded composer remains local'}};
  }
  if (env.GAME_AUDIO_DIRECTOR_PROVIDER && env.GAME_AUDIO_DIRECTOR_PROVIDER !== 'local') throw new Error('Unsupported director provider');
  return {options:{},info:{kind:'local-rule-based-research-prototype',modelConnected:false}};
}
