import * as THREE from 'three/webgpu';

const PROBE_SIZE=128;
const MOVE_THRESHOLD=.0015;
const FACES_PER_FRAME=4;
const PROBE_NEAR=.006;
const PROBE_FAR=16;

/**
 * A small player-centred reflection probe. The static HDR remains the source in
 * open directions, while actual visible scene geometry replaces it where the
 * room/stadium blocks that direction. Gameplay refreshes are amortized across
 * frames, but several faces are captured per rendered frame so a complete PMREM
 * advances at interactive cadence without a six-view spike on one frame.
 */
export class LocalReflectionProbe {
  readonly texture:THREE.CubeTexture;
  private readonly scene:THREE.Scene;
  private readonly excluded:THREE.Object3D;
  private readonly target:THREE.CubeRenderTarget;
  private readonly captureTarget:THREE.CubeRenderTarget;
  private readonly camera:THREE.CubeCamera;
  private readonly copyRegion=new THREE.Box3(new THREE.Vector3(0,0,0),new THREE.Vector3(PROBE_SIZE,PROBE_SIZE,6));
  private readonly copyOrigin=new THREE.Vector3();
  private readonly capturePosition=new THREE.Vector3();
  private readonly completedPosition=new THREE.Vector3(Number.POSITIVE_INFINITY,Number.POSITIVE_INFINITY,Number.POSITIVE_INFINITY);
  private environment:THREE.Texture;
  private face=-1;
  private targetInitialized=false;
  private dirty=true;

  constructor(scene:THREE.Scene,excluded:THREE.Object3D,environment:THREE.Texture) {
    this.scene=scene;this.excluded=excluded;this.environment=environment;
    this.target=new THREE.CubeRenderTarget(PROBE_SIZE,{type:THREE.HalfFloatType,format:THREE.RGBAFormat,depthBuffer:false});
    this.captureTarget=new THREE.CubeRenderTarget(PROBE_SIZE,{type:THREE.HalfFloatType,format:THREE.RGBAFormat,depthBuffer:true});
    this.texture=this.target.texture;
    this.texture.colorSpace=THREE.LinearSRGBColorSpace;
    this.texture.generateMipmaps=true;
    this.texture.minFilter=THREE.LinearMipmapLinearFilter;
    this.texture.magFilter=THREE.LinearFilter;
    this.captureTarget.texture.colorSpace=THREE.LinearSRGBColorSpace;
    this.captureTarget.texture.generateMipmaps=false;
    this.captureTarget.texture.minFilter=THREE.LinearFilter;
    this.captureTarget.texture.magFilter=THREE.LinearFilter;
    this.camera=new THREE.CubeCamera(PROBE_NEAR,PROBE_FAR,this.captureTarget);
  }

  setEnvironment(environment:THREE.Texture) {
    if(this.environment===environment)return;
    this.environment=environment;this.dirty=true;
  }

  /** Use while the loading card is visible so the first gameplay frame is hot. */
  captureNow(renderer:THREE.WebGPURenderer,position:THREE.Vector3) {
    this.capturePosition.copy(position);this.camera.position.copy(position);
    this.withCapture(()=>this.camera.update(renderer,this.scene));
    this.commitCapture(renderer);
    this.completedPosition.copy(position);this.face=-1;this.dirty=false;
  }

  /**
   * Keep parallax responsive while bounding probe work. The old wall-clock face
   * throttle made a given direction update only a few times per second because a
   * PMREM cannot advance until all six faces are complete. Capture several tiny
   * 128² faces each game frame instead; the displayed reflection still changes
   * only on complete cubes, so there are no mixed-position PMREM seams.
   */
  update(renderer:THREE.WebGPURenderer,position:THREE.Vector3) {
    let budget=FACES_PER_FRAME;
    while(budget-->0) {
      if(this.face<0) {
        if(!this.dirty&&this.completedPosition.distanceToSquared(position)<MOVE_THRESHOLD*MOVE_THRESHOLD)return;
        this.capturePosition.copy(position);this.camera.position.copy(position);this.camera.updateMatrixWorld(true);
        this.face=0;
      }
      this.renderFace(renderer,this.face++);
      if(this.face===6) {
        this.commitCapture(renderer);
        this.completedPosition.copy(this.capturePosition);this.face=-1;this.dirty=false;
      }
    }
  }

  private renderFace(renderer:THREE.WebGPURenderer,face:number) {
    if(this.camera.coordinateSystem!==renderer.coordinateSystem) {
      this.camera.coordinateSystem=renderer.coordinateSystem;this.camera.updateCoordinateSystem();
      this.camera.position.copy(this.capturePosition);this.camera.updateMatrixWorld(true);
    }
    const faceCamera=this.camera.children[face] as THREE.PerspectiveCamera;
    const previous=renderer.getRenderTarget(),autoClear=renderer.autoClear;
    try {
      renderer.autoClear=true;
      this.withCapture(()=>{renderer.setRenderTarget(this.captureTarget,face);renderer.render(this.scene,faceCamera);});
    } finally {
      renderer.setRenderTarget(previous);renderer.autoClear=autoClear;
    }
  }

  private commitCapture(renderer:THREE.WebGPURenderer) {
    if(!this.targetInitialized) {renderer.initRenderTarget(this.target);this.targetInitialized=true;}
    // Keep the material bound to one stable cube. A complete scratch cube is a
    // sub-megabyte GPU copy, so the next staged capture can begin immediately
    // without overwriting the coherent cube that PMREM will read this frame.
    renderer.copyTextureToTexture(this.captureTarget.texture,this.texture,this.copyRegion,this.copyOrigin);
    this.texture.needsPMREMUpdate=true;
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

  dispose(){this.captureTarget.dispose();this.target.dispose();}
}
