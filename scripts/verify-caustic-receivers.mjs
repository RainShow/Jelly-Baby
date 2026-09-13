import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as THREE from 'three/webgpu';
import { color, uniform, vec3 } from 'three/tsl';
import { CausticReceivers } from '../src/graphics/optics/caustic-receivers.ts';
import { CausticSurfaces, CausticSurfaceField } from '../src/graphics/optics/caustic-surfaces.js';

const lightTexture=new THREE.Texture();
const registered=new Set();
const optics={
  lightTexture,
  originNode:uniform(new THREE.Vector2(-.1,-.1)),
  spanNode:uniform(new THREE.Vector2(.2,.2)),
  shadowSpanNode:uniform(.2),
  shadowOriginNode:uniform(new THREE.Vector2(-.1,-.1)),
  contactOriginNode:uniform(new THREE.Vector2(-.1,-.1)),
  shadowTexture:new THREE.Texture(),
  lightDirectionNode:uniform(new THREE.Vector3(.494,-.748,-.443).normalize()),
  registerReceiver(mesh){registered.add(mesh);},
  setSourceSpread(){},
  sampleIrradiance(){return vec3(1);},
};
const light={color:new THREE.Color(.8,.7,.6),irradiance:4};

const receiverSource=readFileSync('src/graphics/optics/caustic-receivers.ts','utf8');
const reconstructionSource=readFileSync('src/graphics/optics/caustic-reconstruction.js','utf8');
const gpuSource=readFileSync('src/graphics/optics/gpu-caustics.js','utf8');
assert(reconstructionSource.includes('select(1.0,4.0,x==0)')&&reconstructionSource.includes('for(var y=-1;y<=1;y++){for(var x=-1;x<=1;x++){'),
  'caustic reconstruction keeps the established 3x3 [1,4,1] quality filter');
assert(gpuSource.includes('const atlasStepU=')&&gpuSource.includes('const atlasStepV=')&&gpuSource.includes('continuityRadius'),
  'material lookup derives receiver continuity from the atlas-to-world Jacobian at grazing angles');
assert(gpuSource.includes('receiver.xyz.distance(local).lessThan(continuityRadius)'),
  'adaptive grazing tolerance still preserves world-space disconnected-surface rejection');
assert(gpuSource.includes('this.surfaceField.cropBounds'),'atlas projection uses nearby receiver bounds instead of only an empty body-sized cube');
assert(receiverSource.includes('sampleIrradiance()')&&!receiverSource.includes('floorDistance'),
  'receivers use surface-specific irradiance without back-projecting along the unrefracted direction');
const receivers=new CausticReceivers(optics,light);

const material=new THREE.MeshPhysicalNodeMaterial({color:0x6f8f60});
const mesh=new THREE.Mesh(new THREE.BoxGeometry(.02,.02,.02),material);
assert.equal(mesh.receiveCaustics,undefined,'caustic reception is opt-in for arbitrary meshes');
receivers.register(mesh);
assert.equal(material.emissiveNode,null,'an unmarked mesh is not modified');
mesh.receiveCaustics=true;receivers.register(mesh);
assert(registered.has(mesh),'the same opt-in registers geometry for actual outgoing-ray interception');
assert(material.emissiveNode,'receiveCaustics enables the shared material caustic term');
const once=material.emissiveNode;receivers.register(mesh);
assert.equal(material.emissiveNode,once,'registering the same material twice never doubles caustic energy');

const glowingMaterial=new THREE.MeshPhysicalNodeMaterial({color:0xffffff});
const originalGlow=color(0x203040);glowingMaterial.emissiveNode=originalGlow;
const glowing=new THREE.Mesh(new THREE.SphereGeometry(.01,8,6),glowingMaterial);glowing.receiveCaustics=true;
receivers.register(glowing);
assert.notEqual(glowingMaterial.emissiveNode,originalGlow,'caustics add to an existing emissive node instead of replacing it');

const group=new THREE.Group(),standard=new THREE.MeshStandardNodeMaterial({color:0xbb8844});
const child=new THREE.Mesh(new THREE.BoxGeometry(.01,.01,.01),standard);child.receiveCaustics=true;group.add(child);
receivers.add(group);assert(standard.emissiveNode,'root registration finds opted-in descendant PBR meshes');


const groundMaterial=new THREE.MeshPhysicalNodeMaterial({color:0x668844});
const ground=new THREE.Mesh(new THREE.PlaneGeometry(2,2),groundMaterial);
const facilityTexture=new THREE.Texture();
const facilities={
  worldToUVNode:uniform(new THREE.Matrix3()),
  shadowTexelNode:uniform(new THREE.Vector2(1/512,1/512)),
  target:{texture:facilityTexture},
};
receivers.registerGround(ground,uniform(new THREE.Color(0x668844)),facilities,uniform(.7));
const groundOptions=receivers.meshes.get(ground);
assert(groundOptions?.visibility,'ground caustics reuse the existing filtered facility-shadow visibility');
assert(receiverSource.includes('this.register(mesh,{albedo,visibility})'),
  'ground caustic registration applies facility visibility to refracted irradiance');

const registry=new CausticSurfaces(),centerNode=uniform(new THREE.Vector3());
const field=new CausticSurfaceField(registry,centerNode);
const cropPlane=new THREE.Mesh(new THREE.PlaneGeometry(4,4),new THREE.MeshBasicMaterial());
cropPlane.rotation.x=-Math.PI/2;cropPlane.position.y=.012;cropPlane.receiveCaustics=true;registry.register(cropPlane);
field.update(new THREE.Vector3(0,.07,0),.22);
assert(Math.abs(field.cropBounds.min.y-.012)<1e-6&&Math.abs(field.cropBounds.max.y-.012)<1e-6,
  'caustic atlas crop follows the actual flat receiver height instead of the old empty vertical cube');
assert(Math.abs(field.cropBounds.min.x+.22)<1e-6&&Math.abs(field.cropBounds.max.x-.22)<1e-6,
  'receiver-aware crop preserves the established local X/Z transport footprint');
field.dispose();registry.dispose();cropPlane.geometry.dispose();cropPlane.material.dispose();

const night={color:new THREE.Color(.25,.4,.9),irradiance:1.5};receivers.setLighting(night);
assert.equal(receivers.irradianceNode.value,night.irradiance/Math.PI);
assert(receivers.colorNode.value.equals(night.color),'lighting switches update the shared receiver color without rebuilding materials');

receivers.dispose();
for(const item of [mesh,glowing,child,ground]){item.geometry.dispose();item.material.dispose();}
facilityTexture.dispose();optics.shadowTexture.dispose();lightTexture.dispose();
console.log('Universal caustic receiver opt-in, deduplication, emissive preservation and lighting updates passed');
