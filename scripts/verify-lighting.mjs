import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { readFileSync } from 'node:fs';
import { setImmediate } from 'node:timers';
import { URL } from 'node:url';
import * as THREE from 'three/webgpu';
import { EXRLoader } from 'three/addons/loaders/EXRLoader.js';
import { measureWindow } from '../src/graphics/scene/environment-measure.ts';
import { STUDIO_ENVIRONMENT } from '../src/graphics/scene/studio-environment.generated.ts';
import { NIGHT_ENVIRONMENT } from '../src/graphics/scene/night-environment.generated.ts';
import { shapeStudioLight } from '../src/graphics/scene/studio-light.ts';
import { FacilityShadows } from '../src/facilities/shadows.ts';
import { LightingMode } from '../src/app/lighting-mode.ts';


const dayBytes=readFileSync(new URL('../dev-assets/environment/bg_room.exr',import.meta.url));
const daySource=new EXRLoader().setDataType(THREE.HalfFloatType).parse(dayBytes.buffer.slice(dayBytes.byteOffset,dayBytes.byteOffset+dayBytes.byteLength));
const originalDay=measureWindow(daySource);
const shapedDay=shapeStudioLight(daySource,originalDay.incoming.clone().negate());
const runtimeDay=readFileSync(new URL('../src/assets/bg_room_studio.rgba16f',import.meta.url));
assert.equal(runtimeDay.length,shapedDay.data.byteLength,'generated studio map keeps the exact RGBA16F dimensions');
assert(runtimeDay.equals(Buffer.from(shapedDay.data.buffer,shapedDay.data.byteOffset,shapedDay.data.byteLength)),
  'generated runtime studio map must exactly match the authored HDR relighting pass');
const measuredDay=measureWindow(shapedDay);
const close=(actual,expected,label)=>assert(Math.abs(actual-expected)<1e-12,`${label} metadata is stale`);
for(let i=0;i<3;i++) {
  close(STUDIO_ENVIRONMENT.incoming[i],measuredDay.incoming.getComponent(i),`incoming[${i}]`);
  close(STUDIO_ENVIRONMENT.color[i],[measuredDay.color.r,measuredDay.color.g,measuredDay.color.b][i],`color[${i}]`);
  close(STUDIO_ENVIRONMENT.sourceSpread[i],measuredDay.sourceSpread.getComponent(i),`sourceSpread[${i}]`);
}
close(STUDIO_ENVIRONMENT.windowFraction,measuredDay.windowFraction,'windowFraction');
close(STUDIO_ENVIRONMENT.irradiance,measuredDay.irradiance,'irradiance');

const nightBytes=readFileSync(new URL('../dev-assets/environment/night.exr',import.meta.url));
const nightImage=new EXRLoader().setDataType(THREE.HalfFloatType).parse(nightBytes.buffer.slice(nightBytes.byteOffset,nightBytes.byteOffset+nightBytes.byteLength));
const runtimeNight=readFileSync(new URL('../src/assets/night.rgba16f',import.meta.url));
assert.equal(runtimeNight.length,nightImage.data.byteLength,'generated night map keeps the exact RGBA16F dimensions');
assert(runtimeNight.equals(Buffer.from(nightImage.data.buffer,nightImage.data.byteOffset,nightImage.data.byteLength)),
  'generated runtime night map must exactly match the authored HDR pixels');
const night=measureWindow(nightImage,true);
for(let i=0;i<3;i++) {
  close(NIGHT_ENVIRONMENT.incoming[i],night.incoming.getComponent(i),`night incoming[${i}]`);
  close(NIGHT_ENVIRONMENT.color[i],[night.color.r,night.color.g,night.color.b][i],`night color[${i}]`);
  close(NIGHT_ENVIRONMENT.sourceSpread[i],night.sourceSpread.getComponent(i),`night sourceSpread[${i}]`);
}
close(NIGHT_ENVIRONMENT.windowFraction,night.windowFraction,'night windowFraction');
close(NIGHT_ENVIRONMENT.irradiance,night.irradiance,'night irradiance');
assert(night.incoming.y<-.01,'night HDR supplies a downward source for receiver projection');
assert(night.windowFraction>0&&night.windowFraction<1,'night retains both directional shadows and ambient fill');
assert(night.irradiance>0&&Number.isFinite(night.irradiance));
assert(night.color.r>night.color.b,'preserve the supplied night environment’s warm emitter');

const day=new THREE.Vector3(.494,-.748,-.443).normalize();
const shadows=new FacilityShadows(day,.7);
const group=new THREE.Group(),mesh=new THREE.Mesh(new THREE.BoxGeometry(.04,.1,.04),new THREE.MeshPhysicalNodeMaterial());
mesh.position.y=.05;group.add(mesh);
const envelope=new THREE.Box3(new THREE.Vector3(-.1,0,-.1),new THREE.Vector3(.1,.3,.1));
shadows.add(group,envelope);shadows.surfaces.addBaby(mesh);
const originalUV=shadows.worldToUVNode.value.clone(),originalMatrix=shadows.surfaces.matrixNode.value.clone();
let count=0;
const renderer={target:null,autoClear:false,getRenderTarget(){return this.target;},setRenderTarget(target){this.target=target;},render(){count++;}};
let shadowSyncRevision=shadows.update(renderer);shadows.surfaces.update(renderer,shadowSyncRevision);
assert.equal(count,3);
for(const [direction,fraction] of [[night.incoming,night.windowFraction],[day,.7]]) {
  shadows.setLighting(direction,fraction);
  const before=count;
  shadowSyncRevision=shadows.update(renderer);shadows.surfaces.update(renderer,shadowSyncRevision);
  assert.equal(count-before,3,'a lighting change invalidates all three shadow maps even with stationary geometry');
  shadowSyncRevision=shadows.update(renderer);shadows.surfaces.update(renderer,shadowSyncRevision);
  assert.equal(count-before,3,'unchanged lighting and geometry remain cached');
  assert.equal(shadows.surfaces.windowFraction.value,fraction);
  assert(shadows.surfaces.directionNode.value.clone().negate().distanceTo(direction)<1e-12);
  for(const x of [-.1,.1])for(const y of [0,.3])for(const z of [-.1,.1]) {
    const world=new THREE.Vector3(x,y,z),projected=world.clone().applyMatrix4(shadows.projection);
    const t=(-.00005-y)/direction.y;
    assert(Math.abs(projected.x-(x+direction.x*t))<1e-12);
    assert(Math.abs(projected.y-(z+direction.z*t))<1e-12);
    const uv=new THREE.Vector3(projected.x,projected.y,1).applyMatrix3(shadows.worldToUVNode.value);
    assert(uv.x>0&&uv.x<1&&uv.y>0&&uv.y<1,'new direction keeps the entire swept shadow inside the receiver target');
    const clip=world.applyMatrix4(shadows.surfaces.matrixNode.value);
    assert(Math.abs(clip.x)<1&&Math.abs(clip.y)<1&&clip.z>0&&clip.z<1,'raised shadow bounds are refitted to the new direction');
  }
}
assert(shadows.worldToUVNode.value.equals(originalUV),'returning to day restores the ground mapping exactly');
assert(shadows.surfaces.matrixNode.value.equals(originalMatrix),'returning to day restores the raised mapping exactly');
const baselineWidth=shadows.target.width,baselineHeight=shadows.target.height,wideWorld=new THREE.Group();
shadows.add(wideWorld,new THREE.Box3(new THREE.Vector3(-1,0,-1),new THREE.Vector3(1,.3,1)));
assert(shadows.target.width>baselineWidth||shadows.target.height>baselineHeight,'larger active footprints raise ground shadow resolution');
wideWorld.visible=false;
shadowSyncRevision=shadows.update(renderer);shadows.surfaces.update(renderer,shadowSyncRevision);
assert.equal(shadows.target.width,baselineWidth,'returning to the main footprint restores ground shadow width');
assert.equal(shadows.target.height,baselineHeight,'returning to the main footprint restores ground shadow height');
shadows.dispose();mesh.geometry.dispose();mesh.material.dispose();
console.log('Generated day/night environment parity, shadow reprojection, cache invalidation and exact day restoration passed');

class TestButton extends globalThis.EventTarget {
  disabled=false;title='';attributes=new Map();blurred=false;
  setAttribute(name,value){this.attributes.set(name,value);}
  removeAttribute(name){this.attributes.delete(name);}
  blur(){this.blurred=true;}
}
class TestClassList {
  values=new Set();
  toggle(name,force){if(force)this.values.add(name);else this.values.delete(name);}
  remove(name){this.values.delete(name);}
  contains(name){return this.values.has(name);}
}

const originalDocument=globalThis.document,button=new TestButton(),classList=new TestClassList();
globalThis.document={querySelector:selector=>selector==='#lighting-mode'?button:null,documentElement:{classList}};
const modeScene=new THREE.Scene();modeScene.background=new THREE.Color('#e8d9c3');modeScene.fog=new THREE.Fog('#e8d9c3',2,12);
const modeCamera=new THREE.PerspectiveCamera(),events=[];
const modeRenderer={target:'screen',autoClear:false,getRenderTarget(){return this.target;},setRenderTarget(target){this.target=target;},render(){events.push('warm');},
  backend:{device:{queue:{onSubmittedWorkDone:async()=>{events.push('fence');}}}}};
let releasePreparation;
const preparationGate=new Promise(resolve=>{releasePreparation=resolve;});
const light=(name)=>({apply(){events.push(`apply-${name}`);},dispose(){events.push(`dispose-${name}`);},name});
const dayMode=light('day'),nightMode=light('night'),failures=[];
const lightingMode=new LightingMode(modeRenderer,modeScene,modeCamera,dayMode,nightMode,async selected=>{
  events.push(`prepare-${selected.name}`);await preparationGate;events.push(`prepared-${selected.name}`);
},()=>events.push('commit'),error=>failures.push(error));
button.dispatchEvent(new globalThis.Event('click'));button.dispatchEvent(new globalThis.Event('click'));
await Promise.resolve();
assert(lightingMode.switching&&button.disabled,'the animation gate and control become busy before preparation yields');
assert.equal(button.attributes.get('aria-busy'),'true');
assert.deepEqual(events,['apply-night','prepare-night'],'duplicate activation cannot start a second transition');
assert(!classList.contains('night-mode'),'the visible mode remains day while derived resources prepare');
releasePreparation();await new Promise(resolve=>setImmediate(resolve));
assert.deepEqual(events,['apply-night','prepare-night','prepared-night','warm','fence','commit'],'offscreen warmup and its GPU fence complete before the visible commit');
assert(!lightingMode.switching&&!button.disabled&&!button.attributes.has('aria-busy'));
assert(classList.contains('night-mode'));assert.equal(button.attributes.get('aria-pressed'),'true');
assert.equal(modeRenderer.target,'screen');assert.equal(modeRenderer.autoClear,false,'offscreen warmup restores renderer state');
button.dispatchEvent(new globalThis.Event('click'));await new Promise(resolve=>setImmediate(resolve));
assert.deepEqual(events.slice(-6),['apply-day','prepare-day','prepared-day','warm','fence','commit'],'returning to day uses the same atomic preparation path');
assert(!classList.contains('night-mode'));assert.equal(failures.length,0);
lightingMode.dispose();assert(events.includes('dispose-night'));globalThis.document=originalDocument;
console.log('Day/night switching gates animation, warms offscreen, fences GPU work and commits once.');
