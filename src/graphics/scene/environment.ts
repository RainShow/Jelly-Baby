import * as THREE from 'three/webgpu';
import { NIGHT_ENVIRONMENT } from './night-environment.generated.ts';
import { STUDIO_ENVIRONMENT } from './studio-environment.generated.ts';


type BakedEnvironmentMetadata={
  readonly width:number;
  readonly height:number;
  readonly incoming:readonly [number,number,number];
  readonly color:readonly [number,number,number];
  readonly sourceSpread:readonly [number,number,number];
  readonly windowFraction:number;
  readonly irradiance:number;
};

async function loadBakedEnvironment(url:URL,metadata:BakedEnvironmentMetadata,label:string) {
  const response=await fetch(url);
  if(!response.ok)throw new Error(`Could not load the ${label} environment (${response.status})`);
  const bytes=await response.arrayBuffer(),expected=metadata.width*metadata.height*4*2;
  if(bytes.byteLength!==expected)throw new Error(`${label} environment has ${bytes.byteLength} bytes; expected ${expected}`);
  const source=new THREE.DataTexture(new Uint16Array(bytes),metadata.width,metadata.height,THREE.RGBAFormat,THREE.HalfFloatType);
  source.minFilter=source.magFilter=THREE.LinearFilter;source.generateMipmaps=false;source.flipY=false;source.needsUpdate=true;
  return {
    source,
    lighting:{
      incoming:new THREE.Vector3(...metadata.incoming),
      color:new THREE.Color().setRGB(...metadata.color,THREE.LinearSRGBColorSpace),
      sourceSpread:new THREE.Vector3(...metadata.sourceSpread),
      windowFraction:metadata.windowFraction,irradiance:metadata.irradiance,
    },
  };
}

export async function loadEnvironment(renderer:THREE.WebGPURenderer,scene:THREE.Scene,night=false) {
  const metadata=night?NIGHT_ENVIRONMENT:STUDIO_ENVIRONMENT;
  const url=night
    ? new URL('../../assets/night.rgba16f',import.meta.url)
    : new URL('../../assets/bg_room_studio.rgba16f',import.meta.url);
  const {source,lighting}=await loadBakedEnvironment(url,metadata,night?'night':'studio');
  source.mapping=THREE.EquirectangularReflectionMapping;
  source.colorSpace=THREE.LinearSRGBColorSpace;
  const intensity=night?.45:.9;
  lighting.irradiance*=intensity/.9;
  const pmrem=new THREE.PMREMGenerator(renderer);
  const target=pmrem.fromEquirectangular(source);pmrem.dispose();
  const apply=()=>{scene.environment=target.texture;scene.environmentIntensity=intensity;};
  if(!night)apply();
  return {...lighting,intensity,reflectionTexture:source,apply,dispose:()=>{target.dispose();source.dispose();}};
}
