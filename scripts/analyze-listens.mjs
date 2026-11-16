import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const dir=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../artifacts');
const files=fs.readdirSync(dir).filter(name=>name.endsWith('.mp3'));
const results=files.map(file=>{
 const result=spawnSync(process.env.GAME_AUDIO_FFMPEG||'ffmpeg',['-hide_banner','-nostats','-i',path.join(dir,file),'-af','loudnorm=I=-22:TP=-1:LRA=11:print_format=json','-f','null',process.platform==='win32'?'NUL':'/dev/null'],{encoding:'utf8',windowsHide:true});
 if(result.status!==0)throw new Error(result.stderr);
 const values=JSON.parse(result.stderr.match(/\{\s*"input_i"[\s\S]*?\}/)?.[0]||'{}');
 return {file,bytes:fs.statSync(path.join(dir,file)).size,integratedLUFS:Number(values.input_i),truePeakDbTP:Number(values.input_tp)};
});
const report={createdAt:new Date().toISOString(),method:'MP3 full decode plus FFmpeg EBU R128 measurement; no listening rating implied.',results};
fs.writeFileSync(path.join(dir,'listen-analysis.json'),JSON.stringify(report,null,2));
console.log(JSON.stringify(report,null,2));
