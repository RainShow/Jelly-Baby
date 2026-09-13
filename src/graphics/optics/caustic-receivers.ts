import * as THREE from 'three/webgpu';
import { float, uniform, vec3 } from 'three/tsl';
import type Node from 'three/src/nodes/core/Node.js';
import type { RefractiveLightField } from './refractive-light.js';
import type { FacilityShadows } from '../../facilities/shadows.ts';
import { groundReceiver } from '../scene/ground-receiver.ts';

export type CausticLighting={color:THREE.Color;irradiance:number;sourceSpread?:THREE.Vector3};
type ReceiverOptions={albedo?:Node<'vec3'>;visibility?:Node<'float'>};
type CausticMaterial=THREE.MeshStandardNodeMaterial|THREE.MeshPhysicalNodeMaterial;

/** Scene-wide opt-in binding for geometric GPU caustics. */
export class CausticReceivers {
  readonly irradianceNode=uniform(0);
  readonly colorNode=uniform(new THREE.Color());
  readonly optics:RefractiveLightField;
  private readonly materials=new Set<THREE.Material>();
  private readonly meshes=new Map<THREE.Mesh,ReceiverOptions>();
  private readonly sources:CausticReceivers[]=[];
  readonly enabledNode=uniform(1);
  private readonly grounds:{mesh:THREE.Mesh;albedo:Node<'vec3'>;facilities:FacilityShadows;fraction:Node<'float'>;height:number}[]=[];

  constructor(optics:RefractiveLightField,light:CausticLighting) {
    this.optics=optics;this.setLighting(light);
  }

  /** Register opted-in meshes under a root. The caustic generator itself is unchanged. */
  add(root:THREE.Object3D,options:ReceiverOptions={}) {
    root.traverse(object=>{if(object instanceof THREE.Mesh&&object.receiveCaustics)this.register(object,options);});
  }

  /** Register one mesh after setting `mesh.receiveCaustics = true`. */
  register(mesh:THREE.Mesh,options:ReceiverOptions={}) {
    if(!mesh.receiveCaustics)return;
    if(!this.meshes.has(mesh)){this.meshes.set(mesh,options);this.optics.registerReceiver(mesh);}
    for(const material of Array.isArray(mesh.material)?mesh.material:[mesh.material])this.registerMaterial(material,options);
    for(const source of this.sources)source.register(mesh,options);
  }

  addSource(optics:RefractiveLightField) {
    optics.setRegistry(this.optics.registry);
    if(this.optics.camera)optics.setCamera(this.optics.camera);
    optics.setSourceSpread(this.optics.spreadNode.value);
    const source=new CausticReceivers(optics,{color:this.colorNode.value,irradiance:this.irradianceNode.value*Math.PI,sourceSpread:this.optics.spreadNode.value});
    for(const [mesh,options] of this.meshes)source.register(mesh,options);
    this.sources.push(source);
    for(const ground of this.grounds)this.bindGround(ground);
    return source;
  }

  registerGround(mesh:THREE.Mesh,albedo:Node<'vec3'>,facilities:FacilityShadows,fraction:Node<'float'>,height=0) {
    const ground={mesh,albedo,facilities,fraction,height};this.grounds.push(ground);
    this.bindGround(ground);
    // Outgoing rays now test actual opaque occlusion. The incoming-light shadow
    // mask belongs only to ground shading, not to refracted irradiance.
    mesh.receiveCaustics=true;this.register(mesh,{albedo});
  }

  private bindGround(ground:typeof this.grounds[number]) {
    const result=groundReceiver(ground.albedo,this.optics,ground.facilities,ground.fraction,ground.height,this.sources);
    const material=ground.mesh.material as THREE.MeshPhysicalNodeMaterial;
    material.colorNode=result.color;material.needsUpdate=true;return result.visibility;
  }

  private registerMaterial(material:THREE.Material,options:ReceiverOptions) {
    if(this.materials.has(material))return;
    if(!(material instanceof THREE.MeshStandardNodeMaterial)&&!(material instanceof THREE.MeshPhysicalNodeMaterial))return;
    const lit=material as CausticMaterial;
    // NodeMaterial's public typings intentionally expose colorNode/emissiveNode
    // as broad Node unions. For lit materials both slots are RGB-valued at
    // runtime, so normalize that boundary once instead of feeding the union
    // back through vec3(), whose overloads reject color/generic Node types.
    const materialColor=(lit.colorNode??uniform(lit.color)) as Node<'vec3'>;
    const albedo=options.albedo??materialColor;
    const visibility=options.visibility??float(1);
    // The landing surface and its incidence are already part of beam transport.
    // Applying the incoming-light floor projection here would bend the light twice.
    const sample=this.optics.sampleIrradiance() as unknown as Node<'vec3'>;
    const strength=this.irradianceNode.mul(this.enabledNode).mul(visibility);
    // Keep RGB products component-wise. @types/three's fluent mul overloads
    // are scalar-biased for vec3 nodes even though TSL supports vec3*vec3.
    const caustic=vec3(
      albedo.x.mul(sample.r).mul(this.colorNode.r),
      albedo.y.mul(sample.g).mul(this.colorNode.g),
      albedo.z.mul(sample.b).mul(this.colorNode.b),
    ).mul(strength);
    const emissive=lit.emissiveNode as Node<'vec3'>|null;
    lit.emissiveNode=emissive?emissive.add(caustic):caustic;
    lit.needsUpdate=true;this.materials.add(material);
  }

  setLighting(light:CausticLighting) {
    this.irradianceNode.value=light.irradiance/Math.PI;this.colorNode.value.copy(light.color);
    this.optics.setSourceSpread(light.sourceSpread);
    for(const source of this.sources)source.setLighting(light);
  }

  dispose(){for(const source of this.sources)source.dispose();this.sources.length=0;this.grounds.length=0;this.meshes.clear();this.materials.clear();}
}
