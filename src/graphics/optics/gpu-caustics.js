import * as THREE from 'three/webgpu';
import { float, instanceIndex, ivec2, storage, texture, textureLoad, uint, uniform, vec2, vec3, vec4, positionWorld } from 'three/tsl';
import { buildOpticalBVH } from './optical-bvh.js';
import { CausticSurfaces, CausticSurfaceField } from './caustic-surfaces.js';
import { makeBeamRenderer } from './caustic-beams.js';
import { makeCausticReconstruction } from './caustic-reconstruction.js';
import { CAUSTIC_SIZE, FINE_GRID, RAY_COUNT, RAY_RECORDS, CELL_COUNT, deformKernel, refitKernel, traceKernel, refineKernel } from './caustic-kernels.js';

function buffer(data,type='vec4',readOnly=false) {
  const size=type==='uint'?1:4,node=storage(new THREE.StorageBufferAttribute(data,size),type,0);
  return readOnly?node.toReadOnly():node;
}
function target(type,depthBuffer) {
  const out=new THREE.RenderTarget(CAUSTIC_SIZE,CAUSTIC_SIZE,{type,depthBuffer,stencilBuffer:false});
  out.texture.colorSpace=THREE.NoColorSpace;out.texture.generateMipmaps=false;
  out.texture.minFilter=out.texture.magFilter=THREE.NearestFilter;return out;
}

/** Frame-synchronous geometric light transport, independent of the worker shadow/thickness fields. */
export class RefractiveLightField {
  constructor(surface,lightDirection,sigma) {
    this.surface=surface;this.lightDirection=lightDirection.clone().normalize();this.lightDirectionNode=uniform(this.lightDirection);
    this.absorptionNode=uniform(new THREE.Vector3(...sigma));this.spreadNode=uniform(new THREE.Vector3());
    this.centerNode=uniform(new THREE.Vector3());this.sourceNode=uniform(new THREE.Vector4());this.reachNode=uniform(.3);
    this.rightNode=uniform(new THREE.Vector3());this.upNode=uniform(new THREE.Vector3());
    this.span=.22;this.origin=new THREE.Vector2();this.originNode=uniform(this.origin);this.spanNode=uniform(this.span);
    this.shadowSpan=.22;this.shadowSpanNode=uniform(this.shadowSpan);
    this.shadowOrigin=new THREE.Vector2();this.shadowOriginNode=uniform(this.shadowOrigin);
    this.contactOrigin=new THREE.Vector2();this.contactOriginNode=uniform(this.contactOrigin);
    this.shadowBytes=new Uint8Array(256*256*4);
    this.shadowTexture=new THREE.DataTexture(this.shadowBytes,256,256,THREE.RGBAFormat,THREE.UnsignedByteType);
    this.shadowTexture.minFilter=this.shadowTexture.magFilter=THREE.LinearFilter;
    this.shadowTexture.generateMipmaps=false;this.shadowTexture.colorSpace=THREE.NoColorSpace;this.shadowTexture.needsUpdate=true;

    this.hierarchy=buildOpticalBVH(surface.positions,surface.indices);
    this.topologyNode=buffer(this.hierarchy.topology,'uvec4',true);this.boundsNode=buffer(this.hierarchy.bounds);
    this.verticesNode=buffer(new Float32Array(surface.positions.length/3*8));
    const bindings=new Float32Array(surface.positions.length/3*12);
    for(let i=0;i<surface.positions.length/3;i++){
      bindings.set(surface.bindingIds.subarray(i*4,i*4+4),i*12);
      bindings.set(surface.bindingWeights.subarray(i*4,i*4+4),i*12+4);
      bindings.set(surface.restNormals.subarray(i*3,i*3+3),i*12+8);
    }
    this.bindingsNode=buffer(bindings,'vec4',true);
    const nodeCount=surface.bindingIds.reduce((m,id)=>Math.max(m,id),0)+1;
    this.cageNode=buffer(new Float32Array(nodeCount*16),'vec4',true);
    this.raysNode=buffer(new Float32Array(RAY_COUNT*RAY_RECORDS*4));
    this.flagsNode=buffer(new Uint32Array(CELL_COUNT),'uint');
    this.registry=new CausticSurfaces();this.surfaceField=new CausticSurfaceField(this.registry,this.centerNode);
    this.receiverTarget=target(THREE.FloatType,true);this.rawCausticTarget=target(THREE.HalfFloatType,false);this.causticTarget=target(THREE.HalfFloatType,false);
    this.reconstruction=makeCausticReconstruction(this.rawCausticTarget.texture,this.receiverTarget.texture);
    this.lightTexture=this.causticTarget.texture;
    // Separate read-only bindings are required in the vertex/fragment stages.
    this.beams=makeBeamRenderer(storage(this.raysNode.value,'vec4',0).toReadOnly(),storage(this.flagsNode.value,'uint',0).toReadOnly(),texture(this.receiverTarget.texture));
    this.lookupMatrixNode=uniform(new THREE.Matrix4());
    this.camera=null;this.atlasCamera=new THREE.PerspectiveCamera();this.crop=new THREE.Matrix4();
    this.lastRevision=-1;this.lastCamera=new THREE.Matrix4().makeScale(0,0,0);this.lastCenter=new THREE.Vector3(Infinity,Infinity,Infinity);
    this.dirty=true;this.pixelNode=uniform(.001);
    this.makeKernels();
  }
  makeKernels() {
    const shared={vertices:this.verticesNode,tree:this.topologyNode,bounds:this.boundsNode};
    this.deform=deformKernel({id:instanceIndex,cage:this.cageNode,bindings:this.bindingsNode,vertices:this.verticesNode}).compute(this.surface.positions.length/3).setName('Caustics: deform optical proxy');
    this.refits=this.hierarchy.refitLevels.map(level=>refitKernel({id:instanceIndex,start:uint(level.start),...shared}).compute(level.count).setName('Caustics: refit BVH'));
    const args={...shared,rays:this.raysNode,flags:this.flagsNode,geometry:this.surfaceField.geometryNode,instances:this.surfaceField.instancesNode,
      nodeCount:uint(this.hierarchy.nodeCount),receiverCount:this.surfaceField.countNode,source:this.sourceNode,right:this.rightNode,up:this.upNode,
      incoming:this.lightDirectionNode,spread:this.spreadNode,sigma:this.absorptionNode,reach:this.reachNode};
    this.traces=[0,1,2].map(phase=>traceKernel({id:instanceIndex,phase:uint(phase),...args}).compute(RAY_COUNT).setName(`Caustics: trace ${phase}`));
    this.refine=refineKernel({id:instanceIndex,rays:this.raysNode,flags:this.flagsNode,pixel:this.pixelNode}).compute(CELL_COUNT).setName('Caustics: classify optical curvature');
  }
  setCamera(camera){this.camera=camera;this.dirty=true;}
  setRegistry(registry){this.registry=registry;this.surfaceField.registry=registry;this.dirty=true;}
  registerReceiver(mesh){this.registry.register(mesh);this.dirty=true;}
  setAbsorption(sigma){this.absorptionNode.value.set(...sigma);this.dirty=true;}
  setLightDirection(direction){this.lightDirection.copy(direction).normalize();this.dirty=true;}
  setSourceSpread(spread){this.spreadNode.value.copy(spread??new THREE.Vector3());this.dirty=true;}

  /** A normalized receiver irradiance node; public receiver opt-in remains independent of transport. */
  sampleIrradiance() {
    const local=positionWorld.sub(this.centerNode),clip=this.lookupMatrixNode.mul(vec4(local,1));
    const uv=vec3(clip.x.div(clip.w).mul(.5).add(.5),clip.y.div(clip.w).mul(-.5).add(.5),clip.z.div(clip.w));
    const identity=uniform(0).onObjectUpdate(({object})=>this.registry.meshes.get(object)?.id??0);
    const inside=uv.x.greaterThan(0).and(uv.x.lessThan(1)).and(uv.y.greaterThan(0)).and(uv.y.lessThan(1)).and(clip.w.greaterThan(0));
    // Bilinear reconstruction accepts only taps on this object's nearby surface.
    // At grazing camera angles a single atlas row spans much farther in world
    // space than span/CAUSTIC_SIZE. Derive that footprint from the current
    // surface and the atlas UV Jacobian instead of using a fixed world-distance
    // gate; otherwise valid adjacent rows get rejected and appear as stripes.
    const localDx=local.dFdx(),localDy=local.dFdy(),uvDx=uv.xy.dFdx(),uvDy=uv.xy.dFdy();
    const det=uvDx.x.mul(uvDy.y).sub(uvDy.x.mul(uvDx.y)).abs().max(1e-9);
    const atlasScale=float(1/CAUSTIC_SIZE).div(det);
    const atlasStepU=localDx.mul(uvDy.y).sub(localDy.mul(uvDx.y)).mul(atlasScale);
    const atlasStepV=localDy.mul(uvDx.x).sub(localDx.mul(uvDy.x)).mul(atlasScale);
    const continuityRadius=vec2(atlasStepU.length(),atlasStepV.length()).length().mul(1.25).max(this.pixelNode.mul(4));
    // Integer loads also avoid requiring float32-filterable for the position atlas.
    const pixel=uv.xy.mul(CAUSTIC_SIZE).sub(.5),base=pixel.floor(),fraction=pixel.fract();
    let result=vec3(0),weightSum=float(0);
    for(let y=0;y<2;y++)for(let x=0;x<2;x++){
      const coord=ivec2(base.add(vec2(x,y)).clamp(0,CAUSTIC_SIZE-1));
      const receiver=textureLoad(this.receiverTarget.texture,coord);
      const valid=inside.and(identity.greaterThan(0)).and(receiver.a.equal(identity)).and(receiver.xyz.distance(local).lessThan(continuityRadius));
      const weight=(x?fraction.x:float(1).sub(fraction.x)).mul(y?fraction.y:float(1).sub(fraction.y)).mul(float(valid));
      result=result.add(textureLoad(this.lightTexture,coord).rgb.mul(weight));weightSum=weightSum.add(weight);
    }
    return result.div(weightSum.max(1e-6));
  }

  update(renderer,body,force=false) {
    const c=body.center,changed=force||this.lastRevision!==body.surfaceRevision||!this.lastCenter.equals(c);
    this.centerNode.value.copy(c);
    const box=body.surface.geometry.boundingBox,size=box.getSize(new THREE.Vector3());
    this.span=Math.max(.22,size.x*2+.04,size.z*2+.04,Math.max(0,box.max.y)*Math.max(Math.abs(this.lightDirection.x/this.lightDirection.y),Math.abs(this.lightDirection.z/this.lightDirection.y))*2+.12);
    this.spanNode.value=this.span;this.origin.set(c.x-this.span/2,c.z-this.span/2);
    this.reachNode.value=Math.max(.15,this.span);
    const receiversChanged=this.surfaceField.update(c,this.reachNode.value);
    const transportChanged=changed||receiversChanged||this.dirty;
    if(transportChanged){
      const D=this.lightDirection;
      this.rightNode.value.crossVectors(D,Math.abs(D.z)>.96?new THREE.Vector3(0,1,0):new THREE.Vector3(0,0,1)).normalize();
      this.upNode.value.crossVectors(this.rightNode.value,D).normalize();
      const r=this.rightNode.value,u=this.upNode.value;
      // Tight source bounds independent of the receiving footprint. Enclose all four angular views.
      let width=0,height=0;
      for(let i=0;i<8;i++){
        const p=new THREE.Vector3(i&1?box.max.x:box.min.x,i&2?box.max.y:box.min.y,i&4?box.max.z:box.min.z).sub(c);
        width=Math.max(width,Math.abs(p.dot(r)));height=Math.max(height,Math.abs(p.dot(u)));
      }
      const angular=this.spreadNode.value.length(),margin=size.length()*angular+.001;
      this.sourceNode.value.set((width+margin)*2,(height+margin)*2,0,0);
      this.beams.sourceAreaNode.value=this.sourceNode.value.x*this.sourceNode.value.y/(2*FINE_GRID*FINE_GRID*4*Math.abs(D.y));
      this.pixelNode.value=this.span/CAUSTIC_SIZE;
      if(changed){
        const packed=this.cageNode.value.array,x=body.x,f=body.nodalF;
        for(let i=0;i<packed.length/16;i++){
          packed.set([x[i*3]-c.x,x[i*3+1]-c.y,x[i*3+2]-c.z,0],i*16);
          for(let row=0;row<3;row++)packed.set([f[i*9+row*3],f[i*9+row*3+1],f[i*9+row*3+2],0],i*16+4+row*4);
        }
        this.cageNode.value.needsUpdate=true;
        renderer.compute([this.deform,...this.refits]);
      }
      renderer.compute([this.traces[0],this.traces[1],this.refine,this.traces[2]]);
    }
    if(this.camera){
      this.camera.updateMatrixWorld();const viewProjection=new THREE.Matrix4().multiplyMatrices(this.camera.projectionMatrix,this.camera.matrixWorldInverse);
      if(transportChanged||!this.lastCamera.equals(viewProjection)){
        this.renderAtlas(renderer,c,viewProjection);this.lastCamera.copy(viewProjection);
      }
    }
    this.lastRevision=body.surfaceRevision;this.lastCenter.copy(c);this.dirty=false;
  }
  renderAtlas(renderer,center,viewProjection) {
    // Crop to the actual nearby receiver surfaces. The previous center±reach
    // cube wasted most atlas rows on empty vertical space at grazing angles,
    // turning a smooth floor caustic into visible horizontal texel bands.
    const receiverBounds=this.surfaceField.cropBounds,reach=this.span;
    const bounds=receiverBounds.isEmpty()?new THREE.Box3(
      new THREE.Vector3(center.x-reach,Math.min(0,center.y-reach),center.z-reach),
      new THREE.Vector3(center.x+reach,center.y+reach,center.z+reach),
    ):receiverBounds;
    let minX=1,minY=1,maxX=-1,maxY=-1;
    for(let i=0;i<8;i++){
      const p=new THREE.Vector4(i&1?bounds.max.x:bounds.min.x,i&2?bounds.max.y:bounds.min.y,i&4?bounds.max.z:bounds.min.z,1).applyMatrix4(viewProjection);
      if(p.w<=0){minX=-1;minY=-1;maxX=1;maxY=1;break;}
      minX=Math.min(minX,p.x/p.w);maxX=Math.max(maxX,p.x/p.w);minY=Math.min(minY,p.y/p.w);maxY=Math.max(maxY,p.y/p.w);
    }
    minX=Math.max(-1,minX);maxX=Math.min(1,maxX);minY=Math.max(-1,minY);maxY=Math.min(1,maxY);
    // Keep two atlas texels of guard band for beam expansion/reconstruction.
    let w=Math.max(.001,maxX-minX),h=Math.max(.001,maxY-minY);
    const guard=2/(CAUSTIC_SIZE-4),padX=w*guard,padY=h*guard;
    minX=Math.max(-1,minX-padX);maxX=Math.min(1,maxX+padX);minY=Math.max(-1,minY-padY);maxY=Math.min(1,maxY+padY);
    w=Math.max(.001,maxX-minX);h=Math.max(.001,maxY-minY);
    this.crop.set(2/w,0,0,-(maxX+minX)/w,0,2/h,0,-(maxY+minY)/h,0,0,1,0,0,0,0,1);
    this.atlasCamera.copy(this.camera);this.atlasCamera.projectionMatrix.premultiply(this.crop);
    this.atlasCamera.projectionMatrixInverse.copy(this.atlasCamera.projectionMatrix).invert();
    const localMatrix=new THREE.Matrix4().multiplyMatrices(this.crop,viewProjection).multiply(new THREE.Matrix4().makeTranslation(center.x,center.y,center.z));
    this.beams.matrixNode.value.copy(localMatrix);this.lookupMatrixNode.value.copy(localMatrix);
    const previous=renderer.getRenderTarget();
    try {
      renderer.setRenderTarget(this.receiverTarget);renderer.render(this.surfaceField.scene,this.atlasCamera);
      renderer.setRenderTarget(this.rawCausticTarget);renderer.render(this.beams.scene,this.atlasCamera);
      renderer.setRenderTarget(this.causticTarget);this.reconstruction.render(renderer);
    }finally {renderer.setRenderTarget(previous);}
  }
  dispose() {
    for(const kernel of [this.deform,...this.refits,...this.traces,this.refine])kernel.dispose();
    this.surfaceField.dispose();this.beams.dispose();this.reconstruction.dispose();this.receiverTarget.dispose();this.rawCausticTarget.dispose();this.causticTarget.dispose();this.shadowTexture.dispose();
  }
}
