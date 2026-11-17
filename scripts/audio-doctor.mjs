import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectMediaDependencies } from '../server/audio-media.mjs';
import { loadDirectorOptions } from '../server/audio-director.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const dataDir=path.resolve(process.env.GAME_AUDIO_DATA_DIR||path.join(root,'.data/audio-service'));
const report={node:process.version,platform:process.platform,pass:false};
try{
  await fs.mkdir(dataDir,{recursive:true});
  const file=path.join(dataDir,`.write-probe-${process.pid}`);await fs.writeFile(file,'ok',{flag:'wx'});await fs.unlink(file);
  report.storageWritable=true;report.toolchain=await inspectMediaDependencies();
  report.director=(await loadDirectorOptions()).info;
  report.pass=report.toolchain.available===true;
}catch(error){report.error=error.message;}
console.log(JSON.stringify(report,null,2));if(!report.pass)process.exitCode=1;
