import assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import { LocalReflectionProbe } from '../src/graphics/scene/local-reflections.ts';

const scene=new THREE.Scene(),excluded=new THREE.Group(),environment=new THREE.Texture();
scene.add(excluded);
const probe=new LocalReflectionProbe(scene,excluded,environment);
assert(probe.texture.isCubeTexture,'player local reflection source is a cube map');
for(const image of probe.texture.image){assert.equal(image.width,128);assert.equal(image.height,128);}
assert.equal(probe.texture.type,THREE.HalfFloatType,'probe keeps HDR range for the studio window');
assert.equal(probe.texture.generateMipmaps,true,'probe supports PMREM prefiltering after a complete cube refresh');
probe.dispose();environment.dispose();
console.log('Player reflection probe keeps an HDR 128² cube source for local scene occlusion.');
