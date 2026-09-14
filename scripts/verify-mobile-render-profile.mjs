import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as THREE from 'three/webgpu';
import { platformProfile } from '../src/app/platform-profile.ts';
import { SurfaceShadows, MOBILE_SURFACE_SHADOW_SIZE, SURFACE_SHADOW_SIZE } from '../src/facilities/surface-shadows.ts';
import { RefractiveLightField } from '../src/graphics/optics/refractive-light.js';
import { OpticalTransportCadence } from '../src/graphics/optics/transport.ts';
import { LocalReflectionProbe } from '../src/graphics/scene/local-reflections.ts';
import { drawingBufferDpr } from '../src/graphics/scene/renderer.ts';
import { tableTextureURLs } from '../src/graphics/scene/table.ts';
import { loadModel } from './load-model.mjs';

const desktop=platformProfile(false),mobile=platformProfile(true);
assert.deepEqual(desktop,{mobile:false,maxDpr:1.7,reflectionFacesPerFrame:4,bloomResolutionScale:.5,surfaceShadowSize:2048,cameraOnlyOpticalHz:30});
assert.deepEqual(mobile,{mobile:true,maxDpr:1.5,reflectionFacesPerFrame:2,bloomResolutionScale:.4,surfaceShadowSize:1536,cameraOnlyOpticalHz:20});
assert.equal(desktop.surfaceShadowSize,SURFACE_SHADOW_SIZE);
assert.equal(mobile.surfaceShadowSize,MOBILE_SURFACE_SHADOW_SIZE);

const desktopWood=tableTextureURLs(false)[0],mobileWood=tableTextureURLs(true)[0];
assert.match(desktopWood,/wood_base\.jpg$/);assert.doesNotMatch(desktopWood,/wood_base_4k/);
assert.match(mobileWood,/wood_base_4k\.jpg$/);assert.notEqual(desktopWood,mobileWood);
const html=readFileSync('index.html','utf8');
assert(html.includes("matchMedia('(pointer: coarse)')"),'HTML locks the mobile platform before resource preloads');
assert(html.includes('data-jelly-platform="desktop"')&&html.includes('data-jelly-platform="mobile"'),'each wood preload belongs to one locked platform');
assert(html.includes("link.dataset.jellyPlatform!==document.documentElement.dataset.jellyPlatform)link.remove()"),'the unmatched preload is removed during parsing');

const scene=new THREE.Scene(),excluded=new THREE.Group(),environment=new THREE.Texture();scene.add(excluded);
const desktopProbe=new LocalReflectionProbe(scene,excluded,environment,desktop.reflectionFacesPerFrame);
const mobileProbe=new LocalReflectionProbe(scene,excluded,environment,mobile.reflectionFacesPerFrame);
assert.equal(desktopProbe.facesPerFrame,4);assert.equal(mobileProbe.facesPerFrame,2);
desktopProbe.dispose();mobileProbe.dispose();environment.dispose();

const incoming=new THREE.Vector3(.494,-.748,-.443).normalize();
const desktopSurfaces=new SurfaceShadows(incoming,.7,desktop.surfaceShadowSize);
const mobileSurfaces=new SurfaceShadows(incoming,.7,mobile.surfaceShadowSize);
assert.equal(desktopSurfaces.size,2048);assert.equal(desktopSurfaces.facilityTarget.width,2048);
assert.equal(mobileSurfaces.size,1536);assert.equal(mobileSurfaces.facilityTarget.width,1536);
desktopSurfaces.dispose();mobileSurfaces.dispose();

assert.equal(drawingBufferDpr(390,844,3,desktop.maxDpr),1.7);
assert.equal(drawingBufferDpr(390,844,3,mobile.maxDpr),1.5);
assert(drawingBufferDpr(4000,2200,2,mobile.maxDpr)<1,'the hard drawing-buffer cap can still lower mobile DPR below one');

const desktopCadence=new OpticalTransportCadence(desktop.cameraOnlyOpticalHz);
assert(desktopCadence.accept(0,true));assert(!desktopCadence.accept(20,false));assert(desktopCadence.accept(34,false),'desktop retains 30 Hz camera-only updates');
const mobileCadence=new OpticalTransportCadence(mobile.cameraOnlyOpticalHz);
assert(mobileCadence.accept(0,false));assert(!mobileCadence.accept(34,false));assert(mobileCadence.accept(51,false),'mobile camera-only updates are limited to 20 Hz');
mobileCadence.reset();assert(mobileCadence.accept(0,false));assert(mobileCadence.accept(34,true),'mobile camera throttling does not delay a 30 Hz shape update');assert(!mobileCadence.accept(70,false));assert(mobileCadence.accept(85,false));

const model=loadModel(),optics=new RefractiveLightField(model.opticalSurface,incoming,[1,1,1]);
assert.equal(optics.shadowTexture.format,THREE.RGFormat);
assert.equal(optics.shadowBytes.length,256*256*2);
optics.dispose();

const runtime=readFileSync('src/app/runtime.ts','utf8');
for(const field of ['mobile','reflectionFacesPerFrame','cameraOnlyOpticalHz','surfaceShadowSize','bloomResolutionScale','maxDpr'])assert(runtime.includes(`profile.${field}`),`runtime must route ${field} through the locked profile`);
console.log('Desktop render defaults remain canonical; mobile resources are isolated and two-channel masks use RG.');
