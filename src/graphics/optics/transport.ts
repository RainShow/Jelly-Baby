import { Vector3 } from 'three/webgpu';
import type { PerspectiveCamera } from 'three/webgpu';
import type { SoftBody } from '../../physics/soft-body.js';
import type { RefractiveLightField } from './refractive-light.js';

export class OpticalTransportCadence {
  private nextRequestAt=0;
  private nextCameraOnlyRequestAt=0;
  private readonly cameraOnlyInterval:number;
  constructor(cameraOnlyHz=30) {
    if(!Number.isFinite(cameraOnlyHz)||cameraOnlyHz<=0)throw new Error('Optical transport cadence must be positive');
    this.cameraOnlyInterval=1000/cameraOnlyHz;
  }
  accept(now:number,shapeChanged:boolean) {
    if(now<this.nextRequestAt||(!shapeChanged&&now<this.nextCameraOnlyRequestAt))return false;
    this.nextRequestAt=now+1000/30;
    this.nextCameraOnlyRequestAt=now+this.cameraOnlyInterval;
    return true;
  }
  reset(){this.nextRequestAt=this.nextCameraOnlyRequestAt=0;}
}

/** View thickness and the legacy shadow/contact field stay asynchronous; caustics are GPU-frame-synchronous. */
export class OpticalTransport {
  private worker:Worker;
  private pending:{promise:Promise<void>;resolve:()=>void;reject:(e:Error)=>void}|null=null;
  private tracedCenter:number[]|null=null;
  private tracedOrigin=[0,0];
  private disposed=false;
  private lastRevision=-1;
  private lightingRevision=0;
  private readonly cadence:OpticalTransportCadence;
  private lastCamera=new Vector3(Infinity,Infinity,Infinity);
  readonly optics:RefractiveLightField;
  readonly body:SoftBody;
  readonly camera:PerspectiveCamera;
  constructor(optics:RefractiveLightField,body:SoftBody,camera:PerspectiveCamera,direction:Vector3,fail:(error:Error)=>void,cameraOnlyHz=30) {
    this.optics=optics;this.body=body;this.camera=camera;
    this.cadence=new OpticalTransportCadence(cameraOnlyHz);
    this.worker=new Worker(new URL('./transport.worker.ts',import.meta.url),{type:'module'});
    const surface=body.cage.opticalSurface;
    this.worker.postMessage({type:'init',indices:surface.indices,positions:surface.positions,
      restNormals:surface.restNormals,bindingIds:surface.bindingIds,bindingWeights:surface.bindingWeights,direction:direction.toArray()});
    this.worker.onmessage=({data})=>{
      if(this.disposed)return;
      if(data.error){const error=new Error(`Light transport: ${data.error}`);this.pending?.reject(error);this.pending=null;fail(error);return;}
      if(data.shadow) {
        if(data.lightingRevision!==this.lightingRevision)return;
        optics.shadowBytes.set(data.shadow);optics.shadowTexture.needsUpdate=true;
        optics.shadowSpan=data.span;optics.shadowSpanNode.value=data.span;
        this.tracedCenter=data.center;this.tracedOrigin=data.origin;this.follow();
        return;
      }
      const out=body.surface.geometry.attributes.opticalThickness.array,ids=body.cage.thicknessIds,weights=body.cage.thicknessWeights;
      for(let i=0,j=0;i<out.length;i++,j+=3)out[i]=data.thickness[ids[j]]*weights[j]+data.thickness[ids[j+1]]*weights[j+1]+data.thickness[ids[j+2]]*weights[j+2];
      body.surface.geometry.attributes.opticalThickness.needsUpdate=true;
      const pending=this.pending;this.pending=null;pending?.resolve();
    };
    this.worker.onerror=event=>{
      const error=new Error(`Light transport worker: ${event.message}`);
      const pending=this.pending;this.pending=null;pending?.reject(error);fail(error);
    };
  }
  setLightDirection(direction:Vector3) {
    this.lightingRevision++;this.lastRevision=-1;this.cadence.reset();
    this.tracedCenter=null;
    this.optics.shadowBytes.fill(0);this.optics.shadowTexture.needsUpdate=true;
    this.worker.postMessage({type:'lighting',direction:direction.toArray(),lightingRevision:this.lightingRevision});
  }
  /** Wait for a shadow/thickness response produced after the new light revision. */
  async refreshLighting(direction:Vector3) {
    const previous=this.pending?.promise;
    this.setLightDirection(direction);
    // Worker messages are FIFO. Let an older frame finish, then enqueue a
    // forced frame behind the lighting message so its shadow cannot be stale.
    if(previous)await previous;
    if(this.disposed)return;
    await this.update();
  }
  update():Promise<void> {
    if(this.pending)return this.pending.promise;
    if(this.disposed)return Promise.resolve();
    if(this.lastRevision===this.body.surfaceRevision&&this.lastCamera.distanceToSquared(this.camera.position)<1e-10)return Promise.resolve();
    const shapeChanged=this.lastRevision!==this.body.surfaceRevision;
    if(!this.cadence.accept(performance.now(),shapeChanged))return Promise.resolve();
    let resolve!:()=>void,reject!:(error:Error)=>void;
    const promise=new Promise<void>((accept,decline)=>{resolve=accept;reject=decline;});
    this.pending={promise,resolve,reject};
    {
      this.lastRevision=this.body.surfaceRevision;this.lastCamera.copy(this.camera.position);
      const particles=shapeChanged?this.body.x.slice():null,nodalF=shapeChanged?this.body.nodalF.slice():null;
      this.worker.postMessage({type:'frame',particles,nodalF,center:this.body.center.toArray(),camera:this.camera.position.toArray()},
        particles?[particles.buffer,nodalF!.buffer]:[]);
    }
    return promise;
  }
  follow() {
    if(!this.tracedCenter)return;
    const dx=this.body.center.x-this.tracedCenter[0],dz=this.body.center.z-this.tracedCenter[2];
    this.optics.contactOrigin.set(this.tracedOrigin[0]+dx,this.tracedOrigin[1]+dz);
    const dy=this.body.center.y-this.tracedCenter[1],d=this.optics.lightDirection;
    this.optics.shadowOrigin.copy(this.optics.contactOrigin).sub({x:dy*d.x/d.y,y:dy*d.z/d.y});
  }
  dispose(){this.disposed=true;const pending=this.pending;this.pending=null;pending?.resolve();this.worker.terminate();}
}
