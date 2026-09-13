import { MeshBasicNodeMaterial, QuadMesh } from 'three/webgpu';
import { screenCoordinate, texture, wgslFn } from 'three/tsl';

// Small positive 3x3 kernel. Its normal [1,4,1] axis weights broaden toward
// [1,1,1] only along a strongly anisotropic receiver footprint, suppressing
// grazing-angle row/column aliasing without adding taps or filtering resolved axes.
const reconstruct=wgslFn(`fn jelly_reconstruct_caustics(pixel:vec2f,raw:texture_2d<f32>,receivers:texture_2d<f32>)->vec4f {
  let coord=vec2i(pixel);let limit=vec2i(textureDimensions(raw))-vec2i(1);
  let center=textureLoad(receivers,coord,0);
  let dx=dpdx(center.xyz);let dy=dpdy(center.xyz);
  let dxWidth=max(length(dx),1e-12);let dyWidth=max(length(dy),1e-12);
  let areaNormal=cross(dx,dy);let n=areaNormal/max(length(areaNormal),1e-12);
  let pixelWidth=max(dxWidth,dyWidth);
  // At grazing angles one screen axis spans much more receiver area per atlas
  // texel. Broaden only that axis, using the same nine samples as the base filter.
  let widenX=smoothstep(1.25,3.0,dxWidth/dyWidth);
  let widenY=smoothstep(1.25,3.0,dyWidth/dxWidth);
  let centerWeightX=mix(4.0,1.0,widenX);let centerWeightY=mix(4.0,1.0,widenY);
  var sum=vec3f(0.0);var total=0.0;
  for(var y=-1;y<=1;y++){for(var x=-1;x<=1;x++){
    let tap=clamp(coord+vec2i(x,y),vec2i(0),limit);
    let surface=textureLoad(receivers,tap,0);let delta=surface.xyz-center.xyz;
    // Match identity and local surface continuity, including disconnected
    // portions of a single mesh. Zero-light taps still contribute their weight.
    let same=abs(surface.w-center.w)<0.1 && length(delta)<=max(pixelWidth*2.5,0.00015)
      && abs(dot(delta,n))<=max(pixelWidth*0.5,0.00005);
    if(same){
      let weight=select(1.0,centerWeightX,x==0)*select(1.0,centerWeightY,y==0);
      sum+=textureLoad(raw,tap,0).rgb*weight;total+=weight;
    }
  }}
  return vec4f(sum/max(total,1.0),0.0);
}`);

export function makeCausticReconstruction(raw,receivers) {
  const material=new MeshBasicNodeMaterial({depthTest:false,depthWrite:false,toneMapped:false});
  material.fragmentNode=reconstruct({pixel:screenCoordinate,raw:texture(raw),receivers:texture(receivers)});
  const quad=new QuadMesh(material);
  return {render(renderer){quad.render(renderer);},dispose(){material.dispose();}};
}
