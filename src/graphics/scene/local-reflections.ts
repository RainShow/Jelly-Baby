import * as THREE from 'three/webgpu';

const PROBE_SIZE=128;
const MOVE_THRESHOLD=.025;
const FACE_INTERVAL_MS=65;
const PROBE_NEAR=.006;
const PROBE_FAR=16;

/**
 * A small player-centred reflection probe. The static HDR remains the source in
 * open directions, while actual visible scene geometry replaces it where the
 * room/stadium blocks that direction. Gameplay refreshes are amortized one cube
 * face at a time; full six-face captures are reserved for loading transitions.
 */
export class LocalReflectionProbe {
  readonly texture:THREE.CubeTexture;
  private readonly scene:THREE.Scene;
  private readonly excluded:THREE.Object3D;
  private readonly target:THREE.CubeRenderTarget;
  private readonly camera:THREE.CubeCamera;
  private readonly capturePosition=new THREE.Vector3();
  private readonly completedPosition=new THREE.Vector3(Number.POSITIVE_INFINITY,Number.POSITIVE_INFINITY,Number.POSITIVE_INFINITY);
  private environment:THREE.Texture;
  private face=-1;
  private nextFaceTime=0;
  private dirty=true;

  constructor(scene:THREE.Scene,excluded:THREE.Object3D,environment:THREE.Texture) {
    this.scene=scene;this.excluded=excluded;this.environment=environment;
    this.target=new THREE.CubeRenderTarget(PROBE_SIZE,{type:THREE.HalfFloatType,format:THREE.RGBAFormat,depthBuffer:true});
    this.texture=this.target.texture;
    this.texture.colorSpace=THREE.LinearSRGBColorSpace;
    this.texture.generateMipmaps=true;
    this.texture.minFilter=THREE.LinearMipmapLinearFilter;
    this.texture.magFilter=THREE.LinearFilter;
    this.camera=new THREE.CubeCamera(PROBE_NEAR,PROBE_FAR,this.target);
  }

  setEnvironment(environment:THREE.Texture) {
    if(this.environment===environment)return;
    this.environment=environment;this.dirty=true;
  }

  /** Use while the loading card is visible so the first gameplay frame is hot. */
  captureNow(renderer:THREE.WebGPURenderer,position:THREE.Vector3) {
    this.capturePosition.copy(position);this.camera.position.copy(position);
    this.withCapture(()=>this.camera.update(renderer,this.scene));
    this.completedPosition.copy(position);this.face=-1;this.nextFaceTime=0;this.dirty=false;
  }

  /** Amortize moving-player probe refreshes so no frame renders six extra views. */
  update(renderer:THREE.WebGPURenderer,position:THREE.Vector3,time:number) {
    if(this.face<0) {
      if(!this.dirty&&this.completedPosition.distanceToSquared(position)<MOVE_THRESHOLD*MOVE_THRESHOLD)return;
      this.capturePosition.copy(position);this.camera.position.copy(position);this.camera.updateMatrixWorld(true);
      this.face=0;this.nextFaceTime=time;
    }
    if(time<this.nextFaceTime)return;
    this.renderFace(renderer,this.face);
    this.face++;
    if(this.face===6) {
      this.texture.needsPMREMUpdate=true;
      this.completedPosition.copy(this.capturePosition);this.face=-1;this.dirty=false;
    } else this.nextFaceTime=time+FACE_INTERVAL_MS;
  }

  private renderFace(renderer:THREE.WebGPURenderer,face:number) {
    if(this.camera.coordinateSystem!==renderer.coordinateSystem) {
      this.camera.coordinateSystem=renderer.coordinateSystem;this.camera.updateCoordinateSystem();
      this.camera.position.copy(this.capturePosition);this.camera.updateMatrixWorld(true);
    }
    const faceCamera=this.camera.children[face] as THREE.PerspectiveCamera;
    const previous=renderer.getRenderTarget(),autoClear=renderer.autoClear;
    // Mipmaps are generated only after the sixth face is complete, exactly as
    // CubeCamera.update() does, so partially refreshed cubes are never filtered.
    this.texture.generateMipmaps=face===5;
    try {
      renderer.autoClear=true;
      this.withCapture(()=>{renderer.setRenderTarget(this.target,face);renderer.render(this.scene,faceCamera);});
    } finally {
      renderer.setRenderTarget(previous);renderer.autoClear=autoClear;
    }
  }

  private withCapture(render:()=>void) {
    const visible=this.excluded.visible,background=this.scene.background,fog=this.scene.fog;
    const backgroundIntensity=this.scene.backgroundIntensity,backgroundBlurriness=this.scene.backgroundBlurriness;
    this.excluded.visible=false;
    // The visible scene intentionally uses a plain backdrop, but reflections
    // need the authored HDR beyond local geometry so blockers can actually
    // replace/occlude the distant environment rather than just dim it.
    this.scene.background=this.environment;this.scene.backgroundIntensity=1;this.scene.backgroundBlurriness=0;this.scene.fog=null;
    try {render();}
    finally {
      this.excluded.visible=visible;this.scene.background=background;this.scene.backgroundIntensity=backgroundIntensity;
      this.scene.backgroundBlurriness=backgroundBlurriness;this.scene.fog=fog;
    }
  }

  dispose(){this.target.dispose();}
}
