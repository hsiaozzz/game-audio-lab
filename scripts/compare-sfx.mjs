import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const directory=path.join(root,'artifacts');
const input=JSON.parse(fs.readFileSync(path.join(directory,'sfx-comparison-raw.json'),'utf8'));
const ffmpeg=process.env.GAME_AUDIO_FFMPEG||'ffmpeg';
function run(args){
 const result=spawnSync(ffmpeg,['-hide_banner','-nostats',...args],{encoding:'utf8',windowsHide:true});
 if(result.status!==0)throw new Error(result.stderr||result.error?.message||'ffmpeg failed');
 return result.stderr;
}
function measure(file,start,duration){
 const seek=start===undefined?[]:['-ss',String(start),'-t',String(duration)];
 const text=run([...seek,'-i',file,'-af','loudnorm=I=-23:TP=-3:LRA=11:print_format=json','-f','null',process.platform==='win32'?'NUL':'/dev/null']);
 const result=JSON.parse(text.match(/\{\s*"input_i"[\s\S]*?\}/)?.[0]||'{}');
 const integratedLUFS=Number(result.input_i),truePeakDbTP=Number(result.input_tp);
 if(!Number.isFinite(integratedLUFS)||!Number.isFinite(truePeakDbTP))throw new Error(`Invalid loudness result: ${file}`);
 return {integratedLUFS,truePeakDbTP};
}
const modes=['synth','reference','hybrid'],spacing=input.spacingSeconds;
const sourceFiles=Object.fromEntries(modes.map(mode=>[mode,path.join(directory,`sfx-${mode}-raw.wav`)]));
const events=input.ids.map((id,index)=>{
 const measures=Object.fromEntries(modes.map(mode=>[mode,measure(sourceFiles[mode],index*spacing,spacing)]));
 // A common target for all three variants, lowered when any crest would exceed -3 dBTP.
 const targetLUFS=Math.min(-23,...Object.values(measures).map(m=>-3.3-m.truePeakDbTP+m.integratedLUFS));
 return {id,start:index*spacing,onset:index*spacing+input.onsetSeconds,duration:spacing,targetLUFS,
  variants:Object.fromEntries(modes.map(mode=>[mode,{...measures[mode],gainDb:targetLUFS-measures[mode].integratedLUFS}]))};
});
function renderMatched(mode){
 const filters=events.map((event,index)=>`[0:a]atrim=start=${event.start}:duration=${spacing},asetpts=PTS-STARTPTS,volume=${event.variants[mode].gainDb}dB[s${index}]`);
 filters.push(events.map((_,index)=>`[s${index}]`).join('')+`concat=n=${events.length}:v=0:a=1[out]`);
 const wav=path.join(directory,`sfx-${mode}-matched.wav`);
 run(['-y','-i',sourceFiles[mode],'-filter_complex',filters.join(';'),'-map','[out]','-ar','44100','-c:a','pcm_s16le',wav]);
 for(const event of events)event.variants[mode].matched=measure(wav,event.start,spacing);
}
let matchingPasses=0;
for(let pass=0;pass<4;pass++){
 for(const mode of modes)renderMatched(mode);
 matchingPasses++;
 const needsCorrection=events.some(event=>modes.some(mode=>Math.abs(event.variants[mode].matched.integratedLUFS-event.targetLUFS)>.08||event.variants[mode].matched.truePeakDbTP>-3.05));
 if(!needsCorrection||pass===3)break;
 // Short SFX can change EBU gating after gain; correct using the measured output.
 for(const event of events){
  event.targetLUFS-=Math.max(0,...modes.map(mode=>event.variants[mode].matched.truePeakDbTP+3.3));
  for(const mode of modes)event.variants[mode].gainDb+=event.targetLUFS-event.variants[mode].matched.integratedLUFS;
 }
}
const outputs={};
for(const mode of modes){
 const wav=path.join(directory,`sfx-${mode}-matched.wav`),mp3=path.join(directory,`sfx-${mode}-listen.mp3`);
 run(['-y','-i',wav,'-c:a','libmp3lame','-q:a','2',mp3]);
 outputs[mode]={wav:path.basename(wav),mp3:path.basename(mp3),sha256:createHash('sha256').update(fs.readFileSync(wav)).digest('hex'),...measure(mp3)};
}
const maxLoudnessSpreadLU=Math.max(...events.map(event=>{
 const levels=modes.map(mode=>event.variants[mode].matched.integratedLUFS);return Math.max(...levels)-Math.min(...levels);
}));
const report={createdAt:new Date().toISOString(),method:'Each event: FFmpeg EBU R128 measured, common LUFS target across three variants, constant gain only. Target <= -23 LUFS and predicted true peak <= -3 dBTP; no limiter or dynamics processing.',
 caveat:'Reference is the prepared Kenney sample alone. Hybrid deliberately reuses that sample. Similarity is not evidence of independent synthesis quality. This is a listening comparison, not a subjective quality score.',
 spacingSeconds:spacing,onsetSeconds:input.onsetSeconds,brief:input.brief,matchingPasses,events,outputs,maxLoudnessSpreadLU,
 pass:maxLoudnessSpreadLU<=.2};
fs.writeFileSync(path.join(directory,'sfx-comparison.json'),JSON.stringify(report,null,2));
console.log(JSON.stringify({pass:report.pass,maxLoudnessSpreadLU,outputs},null,2));
