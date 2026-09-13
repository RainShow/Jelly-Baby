import * as THREE from 'three/webgpu';
import { attribute, instanceIndex, screenCoordinate, uniform, varying, wgsl, wgslFn } from 'three/tsl';
import { BASE_GRID, RAY_STRIDE, BEAM_COUNT, CAUSTIC_SIZE } from './caustic-kernels.js';

const beamCode=wgsl(`
const B_SIZE:f32=${CAUSTIC_SIZE}.0;
fn b_ids(id:u32,flags:ptr<storage,array<u32>,read>)->vec4u {
  let cell=id/8u;let part=id%8u;
  let root=(cell/${BASE_GRID}u)*2u*${RAY_STRIDE}u+(cell%${BASE_GRID}u)*2u;
  let refined=(*flags)[cell]>0u;
  if(!refined && part>=2u){return vec4u(0u);}
  let step=select(2u,1u,refined);let sub=select(0u,part/2u,refined);
  let a=root+(sub/2u)*${RAY_STRIDE}u+sub%2u;let b=a+step;let c=a+step*${RAY_STRIDE}u;let d=c+step;
  return select(vec4u(a,b,d,step),vec4u(a,d,c,step),(part&1u)>0u);
}
fn b_project(p:vec3f,matrix:mat4x4f)->vec3f {
  let clip=matrix*vec4f(p,1.0);let ndc=clip.xy/max(clip.w,1e-8);
  return vec3f(vec2f(ndc.x*0.5+0.5,0.5-ndc.y*0.5)*B_SIZE,clip.w);
}
fn b_valid(ids:vec4u,rays:ptr<storage,array<vec4f>,read>)->bool {
  if(ids.w==0u){return false;}
  let a=(*rays)[ids.x*5u];let b=(*rays)[ids.y*5u];let c=(*rays)[ids.z*5u];
  if(a.w<=0.0 || a.w!=b.w || a.w!=c.w){return false;}
  let identity=(*rays)[ids.x*5u+1u].w;
  if(identity!=(*rays)[ids.y*5u+1u].w || identity!=(*rays)[ids.z*5u+1u].w){return false;}
  let na=(*rays)[ids.x*5u+2u].xyz;let nb=(*rays)[ids.y*5u+2u].xyz;let nc=(*rays)[ids.z*5u+2u].xyz;
  // Optical folds may reverse winding. Receiver creases and disconnected paths may not be bridged.
  return dot(na,nb)>0.75 && dot(na,nc)>0.75;
}
fn b_cross(a:vec2f,b:vec2f)->f32{return a.x*b.y-a.y*b.x;}
// Exact triangle / pixel-square overlap; all scratch storage is invocation-local.
fn b_coverage(a:vec2f,b:vec2f,c:vec2f,pixel:vec2f)->f32 {
  var poly:array<vec2f,8>;var next:array<vec2f,8>;poly[0]=a;poly[1]=b;poly[2]=c;var count=3u;
  let lo=floor(pixel);let hi=lo+1.0;
  for(var edge=0u;edge<4u;edge++){
    if(count<3u){return 0.0;}var n=0u;let axis=edge/2u;let lower=(edge&1u)==0u;let bound=select(hi[axis],lo[axis],lower);
    for(var i=0u;i<count;i++){
      let p=poly[i];let q=poly[(i+1u)%count];let pin=select(p[axis]<=bound,p[axis]>=bound,lower);let qin=select(q[axis]<=bound,q[axis]>=bound,lower);
      if(pin){next[n]=p;n++;}
      if(pin!=qin){next[n]=mix(p,q,(bound-p[axis])/(q[axis]-p[axis]));n++;}
    }
    count=n;for(var i=0u;i<count;i++){poly[i]=next[i];}
  }
  var area=0.0;for(var i=1u;i+1u<count;i++){area+=b_cross(poly[i]-poly[0],poly[i+1u]-poly[0]);}
  return min(1.0,abs(area)*0.5);
}
`);

export const beamVertex=wgslFn(`fn jelly_beam_vertex(id:u32,corner:vec2f,rays:ptr<storage,array<vec4f>,read>,flags:ptr<storage,array<u32>,read>,matrix:mat4x4f)->vec4f {
  let ids=b_ids(id,flags);if(!b_valid(ids,rays)){return vec4f(2.0,2.0,0.0,1.0);}
  let a=b_project((*rays)[ids.x*5u].xyz,matrix);let b=b_project((*rays)[ids.y*5u].xyz,matrix);let c=b_project((*rays)[ids.z*5u].xyz,matrix);
  if(min(a.z,min(b.z,c.z))<=0.0){return vec4f(2.0,2.0,0.0,1.0);}
  let lo=max(vec2f(0.0),floor(min(a.xy,min(b.xy,c.xy)))-1.0);let hi=min(vec2f(B_SIZE),ceil(max(a.xy,max(b.xy,c.xy)))+1.0);
  let pixel=mix(lo,hi,corner);return vec4f(pixel.x/B_SIZE*2.0-1.0,1.0-pixel.y/B_SIZE*2.0,0.0,1.0);
}`,[beamCode]);

export const beamFragment=wgslFn(`fn jelly_beam_fragment(id:u32,pixel:vec2f,rays:ptr<storage,array<vec4f>,read>,flags:ptr<storage,array<u32>,read>,matrix:mat4x4f,receiver:texture_2d<f32>,sourceArea:f32)->vec4f {
  let sample=textureLoad(receiver,vec2i(pixel),0);
  let px=dpdx(sample.xyz);let py=dpdy(sample.xyz);let pixelArea=max(length(cross(px,py)),1e-12);
  let ids=b_ids(id,flags);if(!b_valid(ids,rays)){discard;}
  let pa=(*rays)[ids.x*5u].xyz;let pb=(*rays)[ids.y*5u].xyz;let pc=(*rays)[ids.z*5u].xyz;
  let a=b_project(pa,matrix).xy;let b=b_project(pb,matrix).xy;let c=b_project(pc,matrix).xy;
  let identity=(*rays)[ids.x*5u+1u].w;
  if(abs(sample.w-identity)>0.1){discard;}
  let area=length(cross(pb-pa,pc-pa))*0.5;
  let screenArea=abs(b_cross(b-a,c-a))*0.5;
  let power=((*rays)[ids.x*5u+1u].xyz+(*rays)[ids.y*5u+1u].xyz+(*rays)[ids.z*5u+1u].xyz)/3.0*sourceArea*f32(ids.w*ids.w);
  // A singular beam still owns finite power. Deposit it in its containing pixel.
  // Pixel area is measured from the actual receiver, never from a capped Jacobian.
  var energy=vec3f(0.0);
  if(screenArea<1e-5 || area<1e-14){
    if(any(vec2i(pixel)!=vec2i((a+b+c)/3.0))){discard;}energy=power/pixelArea;
  }else {
    let coverage=b_coverage(a,b,c,pixel);if(coverage<=0.0){discard;}
    energy=power/area*coverage;
  }
  // Identity plus the receiver plane prevents light crossing folded parts of one mesh.
  let n=(*rays)[ids.x*5u+2u].xyz;let tolerance=max(sqrt(pixelArea)*2.5,0.00015);
  if(abs(dot(sample.xyz-pa,n))>tolerance){discard;}
  return vec4f(min(energy,vec3f(60000.0)),0.0);
}`,[beamCode]);

export function makeBeamRenderer(rays,flags,receiverTexture) {
  const geometry=new THREE.InstancedBufferGeometry();
  geometry.setAttribute('position',new THREE.Float32BufferAttribute([0,0,0,1,0,0,1,1,0,0,1,0],3));
  geometry.setAttribute('corner',new THREE.Float32BufferAttribute([0,0,1,0,1,1,0,1],2));
  geometry.setIndex([0,1,2,0,2,3]);geometry.instanceCount=BEAM_COUNT;
  const matrixNode=uniform(new THREE.Matrix4()),sourceAreaNode=uniform(1);
  const material=new THREE.MeshBasicNodeMaterial({depthTest:false,depthWrite:false,transparent:true,side:THREE.DoubleSide,toneMapped:false,
    blending:THREE.CustomBlending,blendEquation:THREE.AddEquation,blendSrc:THREE.OneFactor,blendDst:THREE.OneFactor});
  material.vertexNode=beamVertex({id:instanceIndex,corner:attribute('corner','vec2'),rays,flags,matrix:matrixNode});
  material.fragmentNode=beamFragment({id:varying(instanceIndex),pixel:screenCoordinate,rays,flags,matrix:matrixNode,receiver:receiverTexture,sourceArea:sourceAreaNode});
  const scene=new THREE.Scene();scene.background=new THREE.Color(0);const mesh=new THREE.Mesh(geometry,material);mesh.frustumCulled=false;scene.add(mesh);
  return {scene,matrixNode,sourceAreaNode,geometry,material,dispose(){geometry.dispose();material.dispose();}};
}
