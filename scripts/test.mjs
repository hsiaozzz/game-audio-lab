import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import { createHash } from 'node:crypto';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const checks=['check-distribution.mjs', 'compose-check.mjs', 'check-pipeline.mjs', 'check-bridge.mjs', 'check-blind-api.mjs', 'check-server.mjs', 'check-audio-service.mjs', 'check-audio-jobs.mjs', 'check-api-spec.mjs', 'check-audio-client.mjs', 'check-render-concurrency.mjs'];
for (const script of checks) {
  const result = spawnSync(process.execPath, [path.join(root, 'scripts', script)], { cwd: root, stdio: 'inherit', windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}
const files=['package.json','scripts/server.mjs','scripts/test.mjs',...checks.map(file=>'scripts/'+file),...fs.readdirSync(path.join(root,'server')).filter(name=>name.endsWith('.mjs')).map(name=>'server/'+name),...fs.readdirSync(path.join(root,'src')).filter(name=>name.endsWith('.mjs')).map(name=>'src/'+name),'docs/openapi.json','docs/audio-service-types.d.ts'];
const report={createdAt:new Date().toISOString(),pass:true,scope:'Portable contract, queue, SDK, distribution and HTTP checks; no listening-quality claim.',checks,sourceHashes:Object.fromEntries(files.map(file=>[file,createHash('sha256').update(fs.readFileSync(path.join(root,file))).digest('hex')]))};
fs.writeFileSync(path.join(root,'artifacts/contract-validation.json'),JSON.stringify(report,null,2));
