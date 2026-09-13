import assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import { positionWorld, storage, texture, vec4 } from 'three/tsl';
import { SurfaceBVH } from '../src/graphics/optics/refractive-light.js';
import { depositBeam } from '../src/graphics/optics/beam-raster.js';
import { makeBeamRenderer } from '../src/graphics/optics/caustic-beams.js';
import { BASE_GRID, CAUSTIC_SIZE, RAY_STRIDE } from '../src/graphics/optics/caustic-kernels.js';

// Reference equations from src/graphics/refractive-light.js at df52c92^.
// Kept in the audit only: one direction, smooth surface normals, four TIR
// events, Fresnel transmission and absorption, then a planar receiver hit.
function refract(d,n,n1,n2) {
  const cosine=Math.min(1,Math.max(0,-d.dot(n))),eta=n1/n2;
  const k=1-eta*eta*(1-cosine*cosine);if(k<0)return null;
  const ct=Math.sqrt(k),rs=(n1*cosine-n2*ct)/(n1*cosine+n2*ct),rp=(n2*cosine-n1*ct)/(n2*cosine+n1*ct);
  return {direction:d.clone().multiplyScalar(eta).addScaledVector(n,eta*cosine-ct),transmission:1-(rs*rs+rp*rp)/2};
}

export function verifyReferencePaths(optics,body,floor,rays) {
  const bvh=new SurfaceBVH(optics.surface),source=optics.sourceNode.value,D=optics.lightDirection;
  let compared=0,maxLandingError=0,maxThroughputError=0;
  for(let y=0;y<RAY_STRIDE;y+=4)for(let x=0;x<RAY_STRIDE;x+=4){
    const id=(y*RAY_STRIDE+x)*20;
    const origin=body.center.clone().addScaledVector(optics.rightNode.value,(x/(RAY_STRIDE-1)-.5)*source.x)
      .addScaledVector(optics.upNode.value,(y/(RAY_STRIDE-1)-.5)*source.y).addScaledVector(D,-optics.reachNode.value);
    const entry=bvh.hit(origin.toArray(),D.toArray());if(!entry)continue;
    const normal=new THREE.Vector3(...bvh.normal(entry,D.toArray(),true));
    const first=refract(D,normal,1,1.35);if(!first)continue;
    let direction=first.direction,power=first.transmission,path=0,escaped=false;
    const start=origin.addScaledVector(D,entry.distance).addScaledVector(direction,2e-6);
    for(let event=0;event<4;event++){
      const hit=bvh.hit(start.toArray(),direction.toArray());if(!hit)break;
      path+=hit.distance;start.addScaledVector(direction,hit.distance);
      const n=new THREE.Vector3(...bvh.normal(hit,direction.toArray(),false));
      const exit=refract(direction,n,1.35,1);
      if(exit){power*=exit.transmission;direction=exit.direction;start.addScaledVector(direction,2e-6);escaped=true;break;}
      direction.reflect(n);start.addScaledVector(direction,2e-6);
    }
    if(!escaped||direction.y>=-1e-5||power<.002)continue;
    const distance=(floor.position.y-start.y)/direction.y;
    if(distance<=0||bvh.hit(start.toArray(),direction.toArray(),distance))continue;
    assert(rays[id+3]>0,'GPU retains the original CPU reference path');
    const landing=start.addScaledVector(direction,distance);
    maxLandingError=Math.max(maxLandingError,landing.distanceTo(new THREE.Vector3(...rays.subarray(id,id+3)).add(body.center)));
    for(let c=0;c<3;c++)maxThroughputError=Math.max(maxThroughputError,
      Math.abs(power*Math.exp(-optics.absorptionNode.value.getComponent(c)*path)-rays[id+4+c]));
    compared++;
  }
  assert(compared>20,'reference covers entry, refraction, exit and receiver landing');
  assert(maxLandingError<2e-5,'GPU landing preserves the original refracted shape');
  assert(maxThroughputError<.002,'GPU focused flux matches original Fresnel and absorption');
  console.log('PASS — original CPU optical paths',{compared,maxLandingError,maxThroughputError});
}

// Render the actual jelly's ray field onto a planar orthographic atlas, then
// compare every texel to the original conservative CPU beam integrator. This
// catches broadened blobs and displaced copies, not merely nonzero light.
export async function verifyReferenceBeams(renderer,optics,body,floor,rays) {
  const flags=new Uint32Array(await renderer.getArrayBufferAsync(optics.flagsNode.value));
  const size=CAUSTIC_SIZE,span=optics.span,origin=new THREE.Vector2(-span/2,-span/2),pixelArea=(span/size)**2;
  const reference=new Float32Array(size*size*3);
  let triangles=0;
  for(let cell=0;cell<BASE_GRID*BASE_GRID;cell++){
    const root=Math.floor(cell/BASE_GRID)*2*RAY_STRIDE+(cell%BASE_GRID)*2;
    const step=flags[cell]?1:2;
    for(let part=0;part<(flags[cell]?8:2);part++){
      const sub=flags[cell]?Math.floor(part/2):0,a=root+Math.floor(sub/2)*RAY_STRIDE+sub%2,b=a+step,c=a+step*RAY_STRIDE,d=c+step;
      const ids=(part&1)?[a,d,c]:[a,b,d];
      if(ids.some(id=>rays[id*20+3]<=0||rays[id*20+3]!==rays[ids[0]*20+3]||rays[id*20+7]!==1))continue;
      const landing=ids.map(id=>[rays[id*20],rays[id*20+2]]);
      const flux=[0,1,2].map(c=>ids.reduce((sum,id)=>sum+rays[id*20+4+c],0)/3*optics.beams.sourceAreaNode.value*step*step);
      depositBeam(reference,size,origin,span,landing,0,flux);triangles++;
    }
  }
  assert(triangles>100,'reference contains the jelly’s connected beam pattern');
  const receiver=new THREE.RenderTarget(size,size,{type:THREE.FloatType,depthBuffer:false});
  const output=new THREE.RenderTarget(size,size,{type:THREE.HalfFloatType,depthBuffer:false});
  receiver.texture.colorSpace=output.texture.colorSpace=THREE.NoColorSpace;
  const camera=new THREE.OrthographicCamera(-span/2,span/2,span/2,-span/2,.001,2);
  camera.position.set(0,.5,0);camera.up.set(0,0,-1);camera.lookAt(0,0,0);camera.updateMatrixWorld();
  const material=new THREE.MeshBasicNodeMaterial({side:THREE.DoubleSide,toneMapped:false});
  material.fragmentNode=vec4(positionWorld,1);
  const plane=new THREE.Mesh(new THREE.PlaneGeometry(span,span),material);plane.rotation.x=-Math.PI/2;plane.position.y=floor.position.y-body.center.y;
  const scene=new THREE.Scene();scene.add(plane);
  const beams=makeBeamRenderer(storage(optics.raysNode.value,'vec4',0).toReadOnly(),storage(optics.flagsNode.value,'uint',0).toReadOnly(),texture(receiver.texture));
  beams.matrixNode.value.multiplyMatrices(camera.projectionMatrix,camera.matrixWorldInverse);beams.sourceAreaNode.value=optics.beams.sourceAreaNode.value;
  const previous=renderer.getRenderTarget();
  try {
    renderer.setRenderTarget(receiver);renderer.render(scene,camera);
    renderer.setRenderTarget(output);renderer.render(beams.scene,camera);
    const pixels=await renderer.readRenderTargetPixelsAsync(output,0,0,size,size);
    let total=0,error=0,gpuTotal=0,peak=0,lit=0;
    for(let i=0;i<size*size;i++){
      const expected=reference[i*3],actual=THREE.DataUtils.fromHalfFloat(pixels[i*4]);
      assert(Number.isFinite(actual)&&actual>=0);total+=expected;gpuTotal+=actual;error+=Math.abs(expected-actual);
      peak=Math.max(peak,actual);if(actual>.01)lit++;
    }
    assert(error/total<.015,'GPU preserves the original CPU beam shape texel by texel');
    assert(Math.abs(gpuTotal/total-1)<.01,'single pattern carries the full incident power');
    assert(peak>4*gpuTotal/lit,'focused pattern retains bright rims rather than uniform illumination');
    console.log('PASS — original CPU beam shape and flux',{triangles,relativeError:error/total,power:gpuTotal*pixelArea,peak});
  }finally {
    renderer.setRenderTarget(previous);beams.dispose();receiver.dispose();output.dispose();plane.geometry.dispose();material.dispose();
  }
}
