import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { existsSync } from 'node:fs';
import * as THREE from 'three/webgpu';
import { RefractiveLightField, SurfaceBVH } from '../src/graphics/optics/refractive-light.js';
import { CausticReceivers } from '../src/graphics/optics/caustic-receivers.ts';
import { buildOpticalBVH } from '../src/graphics/optics/optical-bvh.js';
import { CAUSTIC_SIZE, RAY_STRIDE, RAY_COUNT } from '../src/graphics/optics/caustic-kernels.js';
import { loadModel } from './load-model.mjs';
import { SoftBody } from '../src/physics/soft-body.js';
import { deformSurface } from '../src/physics/deform-surface.js';
import { STUDIO_ENVIRONMENT } from '../src/graphics/scene/studio-environment.generated.ts';
import { verifyReferencePaths, verifyReferenceBeams } from './verify-caustic-reference.mjs';

const model=loadModel(),surface=model.opticalSurface;
const hierarchy=buildOpticalBVH(surface.positions,surface.indices);
assert.equal(hierarchy.triangles.length,surface.indices.length/3);
assert.equal(new Set(hierarchy.triangles).size,hierarchy.triangles.length);
assert.equal(hierarchy.nodes[0].escape,hierarchy.nodes.length);
for(const [i,node] of hierarchy.nodes.entries()){
  assert(node.escape>i&&node.escape<=hierarchy.nodes.length);
  if(node.count===0)assert(node.right>i&&node.right<node.escape);
}

// Opt-in native Dawn runtime keeps browser/dev-server inspection out of this audit.
const runtime=process.env.JELLY_WEBGPU_MODULE;
if(!runtime||!existsSync(runtime)){
  console.log('PASS — optical hierarchy topology. GPU execution requires JELLY_WEBGPU_MODULE pointing to webgpu/index.js.');
}else {
  const {create,globals}=await import(pathToFileURL(runtime).href);
  Object.assign(globalThis,globals);
  globalThis.self={requestAnimationFrame(){return 0;},cancelAnimationFrame(){}};
  const gpu=create(['backend=metal']);
  Object.defineProperty(globalThis,'navigator',{configurable:true,value:{gpu}});
  const adapter=await gpu.requestAdapter();assert(adapter,'headless GPU adapter is available');
  const features=['float32-filterable','timestamp-query','core-features-and-limits'].filter(f=>adapter.features.has(f));
  const device=await adapter.requestDevice({requiredFeatures:features});
  const context={configure(){},unconfigure(){},getCurrentTexture(){return device.createTexture({size:[64,64],format:'bgra8unorm',usage:globals.GPUTextureUsage.RENDER_ATTACHMENT});}};
  const canvas={width:64,height:64,style:{},addEventListener(){},removeEventListener(){},getContext(){return context;}};
  const renderer=new THREE.WebGPURenderer({canvas,context,device,antialias:false});
  await renderer.init();
  const errors=[];renderer.onError=error=>{errors.push(error.message);console.error(error.message);};
  const body=new SoftBody(model);body.updateSurface();
  const optics=new RefractiveLightField(surface,new THREE.Vector3(.49,-.75,-.44).normalize(),[12,45,70]);
  optics.setSourceSpread(new THREE.Vector3(...STUDIO_ENVIRONMENT.sourceSpread));
  const camera=new THREE.PerspectiveCamera(36,1,.001,10);camera.position.set(.11,.17,.256);camera.lookAt(body.center);camera.updateMatrixWorld();optics.setCamera(camera);
  const receivers=new CausticReceivers(optics,{color:new THREE.Color(1,1,1),irradiance:1});
  const floor=new THREE.Mesh(new THREE.PlaneGeometry(4,4),new THREE.MeshPhysicalNodeMaterial({color:0xffffff}));
  floor.rotation.x=-Math.PI/2;floor.position.y=-.00005;floor.receiveCaustics=true;receivers.register(floor);
  const scene=new THREE.Scene();scene.add(floor);
  optics.update(renderer,body,true);
  await device.queue.onSubmittedWorkDone();
  assert.deepEqual(errors,[],'all production caustic shaders compile and execute');
  const vertices=new Float32Array(await renderer.getArrayBufferAsync(optics.verticesNode.value));
  deformSurface(surface,body.x,body.nodalF);let maxPositionError=0,maxNormalError=0;
  for(let i=0;i<surface.positions.length/3;i++)for(let a=0;a<3;a++){
    maxPositionError=Math.max(maxPositionError,Math.abs(vertices[i*8+a]+body.center.getComponent(a)-surface.positions[i*3+a]));
    maxNormalError=Math.max(maxNormalError,Math.abs(vertices[i*8+4+a]-surface.geometry.attributes.normal.array[i*3+a]));
  }
  assert(maxPositionError<1e-6);assert(maxNormalError<1e-4);
  const rays=new Float32Array(await renderer.getArrayBufferAsync(optics.raysNode.value));
  let valid=0,maxLandingY=0;
  for(let i=0;i<rays.length;i+=20)if(rays[i+3]>0){valid++;maxLandingY=Math.max(maxLandingY,Math.abs(rays[i+1]+body.center.y-floor.position.y));}
  assert(valid>100,'geometric transport reaches the table');assert(maxLandingY<1e-5,'rays land on the actual table plane');
  // CPU geometric reference: sample the same coherent primary source entry rays.
  const bvh=new SurfaceBVH(surface);let compared=0,maxEntryError=0;
  const D=optics.lightDirection.toArray(),r=optics.rightNode.value,u=optics.upNode.value,s=optics.sourceNode.value;
  for(let y=0;y<RAY_STRIDE;y+=8)for(let x=0;x<RAY_STRIDE;x+=8){
    const id=y*RAY_STRIDE+x;if(rays[id*20+3]===0)continue;
    const o=body.center.clone().addScaledVector(r,(x/(RAY_STRIDE-1)-.5)*s.x).addScaledVector(u,(y/(RAY_STRIDE-1)-.5)*s.y).addScaledVector(optics.lightDirection,-optics.reachNode.value);
    const hit=bvh.hit(o.toArray(),D);assert(hit);maxEntryError=Math.max(maxEntryError,Math.abs(hit.distance-rays[id*20+11]));compared++;
  }
  assert(compared>3);assert(maxEntryError<1e-5);
  verifyReferencePaths(optics,body,floor,rays);
  await verifyReferenceBeams(renderer,optics,body,floor,rays);
  const pixels=await renderer.readRenderTargetPixelsAsync(optics.causticTarget,0,0,CAUSTIC_SIZE,CAUSTIC_SIZE);
  let lit=0;for(let i=0;i<pixels.length;i+=4)if(pixels[i]>0)lit++;
  assert(lit>10,'conservative beams deposit nonzero irradiance');
  const output=new THREE.RenderTarget(64,64);renderer.setRenderTarget(output);renderer.render(scene,camera);await device.queue.onSubmittedWorkDone();
  assert.deepEqual(errors,[],'registered receiver materials compile and execute');
  // A raised opaque receiver must intercept rays before the table.
  const raised=new THREE.Mesh(new THREE.BoxGeometry(.12,.004,.12),new THREE.MeshStandardNodeMaterial());
  raised.position.set(body.center.x,.005,body.center.z);raised.receiveCaustics=true;receivers.register(raised);scene.add(raised);
  optics.update(renderer,body);await device.queue.onSubmittedWorkDone();
  const elevated=new Float32Array(await renderer.getArrayBufferAsync(optics.raysNode.value));
  let raisedHits=0;for(let i=0;i<RAY_COUNT;i++)if(elevated[i*20+7]===2)raisedHits++;
  assert(raisedHits>0,'new opted-in geometry intercepts outgoing rays');
  raised.visible=false;optics.update(renderer,body);await device.queue.onSubmittedWorkDone();
  const hidden=new Float32Array(await renderer.getArrayBufferAsync(optics.raysNode.value));
  assert(!hidden.some((v,i)=>i%20===7&&v===2),'hidden worlds/receivers leave no stale light interception');
  assert.deepEqual(errors,[]);
  console.log('PASS — production GPU deformation, BVH tracing, beam rasterization, receiver material, dynamic registration and visibility',
    {valid,lit,maxPositionError,maxNormalError,maxEntryError,raisedHits});
  optics.dispose();receivers.dispose();output.dispose();floor.geometry.dispose();floor.material.dispose();raised.geometry.dispose();raised.material.dispose();renderer.dispose();device.destroy();
}
