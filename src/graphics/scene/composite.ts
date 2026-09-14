import { RenderPipeline } from 'three/webgpu';
import type { WebGPURenderer, Scene, PerspectiveCamera } from 'three/webgpu';
import { pass, screenUV, float, vec3, vec4 } from 'three/tsl';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';

/** Linear HDR scene → restrained lens glow → filmic contrast grade → one AgX/output transform. */
export function createComposite(renderer:WebGPURenderer,scene:Scene,camera:PerspectiveCamera,bloomResolutionScale=.5) {
  const scenePass=pass(scene,camera);
  const color=scenePass.getTextureNode('output');
  const glow=bloom(color,.075,.18,1.6);
  glow.setResolutionScale(bloomResolutionScale);
  const vignette=screenUV.sub(.5).length().smoothstep(.24,.73).mul(.065);
  const balanced=color.rgb.add(glow.rgb).mul(vec3(.985,1.01,1.015));
  // High-contrast filmic pre-grade around linear 18% gray. Keep highlights HDR for AgX.
  const contrasted=balanced.sub(.18).mul(1.03).add(.18).max(0);
  const graded=contrasted.mul(float(1).sub(vignette));
  const pipeline=new RenderPipeline(renderer,vec4(graded,color.a));
  return {render:()=>pipeline.render(),dispose:()=>{glow.dispose();scenePass.dispose();pipeline.dispose();}};
}
