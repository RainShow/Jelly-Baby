import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, URL } from 'node:url';

const required=[
  new URL('../src/assets/bg_room_studio.rgba16f',import.meta.url),
  new URL('../src/graphics/scene/studio-environment.generated.ts',import.meta.url),
  new URL('../src/assets/night.rgba16f',import.meta.url),
  new URL('../src/graphics/scene/night-environment.generated.ts',import.meta.url),
];
const missing=required.filter(url=>!existsSync(url));
if(missing.length===0)process.exit(0);

console.log(`Missing ${missing.length} prebaked environment asset${missing.length===1?'':'s'}; generating them before the production build.`);
const script=fileURLToPath(new URL('./build-studio-environment.mjs',import.meta.url));
const result=spawnSync(process.execPath,['--experimental-strip-types',script],{stdio:'inherit'});
if(result.error)throw result.error;
if(result.status!==0)process.exit(result.status??1);

for(const url of required) {
  if(!existsSync(url))throw new Error(`Environment generation did not create ${fileURLToPath(url)}`);
}
