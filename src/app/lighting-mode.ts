import * as THREE from 'three/webgpu';
import { loadEnvironment } from '../graphics/scene/environment.ts';

type Environment=Awaited<ReturnType<typeof loadEnvironment>>;

/** Owns the prewarmed night environment and commits each lighting change together. */
export class LightingMode {
  private readonly button=document.querySelector<HTMLButtonElement>('#lighting-mode')!;
  private readonly abort=new AbortController();
  private isNight=false;
  private disposed=false;
  private readonly night:Environment;

  constructor(scene:THREE.Scene,day:Environment,night:Environment,apply:(light:Environment)=>void,fail:(error:unknown)=>void) {
    this.night=night;
    const background=(scene.background as THREE.Color).clone();
    const fog=(scene.fog as THREE.Fog).color.clone();
    const nightBackground=new THREE.Color('#171c2a');
    this.button.addEventListener('click',event=>{
      if(this.button.disabled||this.disposed)return;
      if((event as MouseEvent).detail>0)this.button.blur();
      try {
        const next=!this.isNight,light=next?this.night:day;
        light.apply();apply(light);
        (scene.background as THREE.Color).copy(next?nightBackground:background);
        (scene.fog as THREE.Fog).color.copy(next?nightBackground:fog);
        this.isNight=next;
        document.documentElement.classList.toggle('night-mode',next);
        this.button.setAttribute('aria-pressed',String(next));
        this.button.setAttribute('aria-label',next?'Switch to day mode':'Switch to night mode');
        this.button.title=next?'Switch to day mode':'Switch to night mode';
      } catch(error) { fail(error); }
    },{signal:this.abort.signal});
  }

  dispose() {
    this.disposed=true;this.abort.abort();this.button.disabled=true;
    this.night.dispose();document.documentElement.classList.remove('night-mode');
  }
}
