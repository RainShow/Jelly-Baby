import * as THREE from 'three/webgpu';
import { loadEnvironment } from '../graphics/scene/environment.ts';

type Environment=Awaited<ReturnType<typeof loadEnvironment>>;
type Prepare=(light:Environment,signal:AbortSignal)=>void|Promise<void>;

/** Prepares every derived lighting resource offscreen, then commits one visible frame. */
export class LightingMode {
  private readonly button=document.querySelector<HTMLButtonElement>('#lighting-mode')!;
  private readonly abort=new AbortController();
  private readonly warmTarget=new THREE.RenderTarget(1,1);
  private readonly renderer:THREE.WebGPURenderer;
  private readonly scene:THREE.Scene;
  private readonly camera:THREE.PerspectiveCamera;
  private readonly prepare:Prepare;
  private readonly render:()=>void;
  private readonly fail:(error:unknown)=>void;
  private isNight=false;
  private disposed=false;
  private switchingValue=false;
  private readonly night:Environment;
  private readonly dayBackground:THREE.Color;
  private readonly dayFog:THREE.Color;
  private readonly nightBackground=new THREE.Color('#171c2a');

  constructor(renderer:THREE.WebGPURenderer,scene:THREE.Scene,camera:THREE.PerspectiveCamera,day:Environment,night:Environment,prepare:Prepare,render:()=>void,fail:(error:unknown)=>void) {
    this.renderer=renderer;this.scene=scene;this.camera=camera;this.night=night;this.prepare=prepare;this.render=render;this.fail=fail;
    this.dayBackground=(scene.background as THREE.Color).clone();
    this.dayFog=(scene.fog as THREE.Fog).color.clone();
    this.button.addEventListener('click',event=>{
      void this.switchMode(event,day);
    },{signal:this.abort.signal});
  }

  get switching(){return this.switchingValue;}

  private async switchMode(event:Event,day:Environment) {
    if(this.switchingValue||this.disposed)return;
    if((event as MouseEvent).detail>0)this.button.blur();
    this.switchingValue=true;this.button.disabled=true;this.button.setAttribute('aria-busy','true');
    try {
      const next=!this.isNight,light=next?this.night:day;
      // The animation loop observes `switching` before this first await, so the
      // last coherent canvas remains displayed while live resources are staged.
      light.apply();await this.prepare(light,this.abort.signal);
      if(this.disposed)return;
      const previous=this.renderer.getRenderTarget(),autoClear=this.renderer.autoClear;
      try {
        // Trigger any render-time PMREM/material updates without touching the
        // visible canvas, then fence all shadow, caustic and reflection work.
        this.renderer.autoClear=true;this.renderer.setRenderTarget(this.warmTarget);
        this.renderer.render(this.scene,this.camera);
      } finally {this.renderer.setRenderTarget(previous);this.renderer.autoClear=autoClear;}
      await (this.renderer.backend as unknown as {device:GPUDevice}).device.queue.onSubmittedWorkDone();
      if(this.disposed)return;
      (this.scene.background as THREE.Color).copy(next?this.nightBackground:this.dayBackground);
      (this.scene.fog as THREE.Fog).color.copy(next?this.nightBackground:this.dayFog);
      this.isNight=next;
      document.documentElement.classList.toggle('night-mode',next);
      this.button.setAttribute('aria-pressed',String(next));
      this.button.setAttribute('aria-label',next?'Switch to day mode':'Switch to night mode');
      this.button.title=next?'Switch to day mode':'Switch to night mode';
      this.render();
    } catch(error) {if(!this.disposed)this.fail(error);}
    finally {
      this.switchingValue=false;
      if(!this.disposed){this.button.disabled=false;this.button.removeAttribute('aria-busy');}
    }
  }

  dispose() {
    this.disposed=true;this.abort.abort();this.button.disabled=true;
    this.warmTarget.dispose();this.night.dispose();document.documentElement.classList.remove('night-mode');
  }
}
