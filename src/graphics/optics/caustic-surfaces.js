import * as THREE from 'three/webgpu';
import { positionWorld, storage, uniform, vec4 } from 'three/tsl';
import { packReceiverGeometry } from './optical-bvh.js';

function visible(mesh) {
  for(let object=mesh;object;object=object.parent)if(!object.visible)return false;
  return true;
}

/** Shared opt-in registry. BLAS geometry is cached; moving instances update only affine records. */
export class CausticSurfaces {
  constructor() {
    this.meshes=new Map();this.cache=new WeakMap();this.nextId=1;
  }
  register(mesh) {
    if(this.meshes.has(mesh))return;
    this.meshes.set(mesh,{id:this.nextId++,mesh});
  }
  dispose(){this.meshes.clear();}
}

/** Per-source nearby receiver set, also used to rasterize receiver identity in the caustic atlas. */
export class CausticSurfaceField {
  constructor(registry,centerNode) {
    this.registry=registry;
    this.geometryNode=storage(new THREE.StorageBufferAttribute(4,4),'vec4',0).toReadOnly();
    this.instancesNode=storage(new THREE.StorageBufferAttribute(8,4),'vec4',0).toReadOnly();
    this.countNode=uniform(0,'uint');
    this.scene=new THREE.Scene();this.scene.background=new THREE.Color(0);
    this.material=new THREE.MeshBasicNodeMaterial({side:THREE.DoubleSide,toneMapped:false});
    const identity=uniform(0).onObjectUpdate(({object})=>object.userData.causticIdentity);
    // Data output bypasses the lit color path, which clamps negative positions
    // and forces opaque alpha to one (destroying receiver identities).
    this.material.fragmentNode=vec4(positionWorld.sub(centerNode),identity);
    this.proxies=new Map();this.previousInstances=new Float32Array();this.previousGeometry=[];
    this.box=new THREE.Box3();this.inverse=new THREE.Matrix4();this.world=new THREE.Matrix4();this.instance=new THREE.Matrix4();
  }
  update(center,reach) {
    const active=[],geometries=[],unique=new Map();
    for(const {mesh,id} of this.registry.meshes.values()){
      if(!visible(mesh)||mesh.receiveCaustics===false)continue;
      mesh.updateWorldMatrix(true,false);
      const geometry=mesh.geometry,position=geometry.attributes.position;
      if(!position)continue;
      let cached=this.registry.cache.get(geometry);
      const version=position.version,indexVersion=geometry.index?.version??0;
      if(!cached||cached.version!==version||cached.indexVersion!==indexVersion||cached.start!==geometry.drawRange.start||cached.count!==geometry.drawRange.count){
        const reusable=cached&&cached.indexVersion===indexVersion&&cached.vertexCount===position.count&&cached.start===geometry.drawRange.start&&cached.count===geometry.drawRange.count?cached.packed:null;
        geometry.computeBoundingBox();cached={version,indexVersion,packed:null,previous:reusable,vertexCount:position.count,start:geometry.drawRange.start,count:geometry.drawRange.count};this.registry.cache.set(geometry,cached);
      }
      const instances=mesh.isInstancedMesh?mesh.count:1;
      for(let i=0;i<instances;i++){
        if(mesh.isInstancedMesh){mesh.getMatrixAt(i,this.instance);this.world.multiplyMatrices(mesh.matrixWorld,this.instance);}else this.world.copy(mesh.matrixWorld);
        this.box.copy(geometry.boundingBox).applyMatrix4(this.world);
        // Every outgoing ray is bounded to this distance; distant worlds never enter the trace.
        if(this.box.distanceToPoint(center)>reach*4)continue;
        if(!cached.packed){cached.packed=packReceiverGeometry(geometry,cached.previous);cached.previous=null;}
        if(!unique.has(cached)){unique.set(cached,geometries.reduce((n,g)=>n+g.packed.data.length/4,0));geometries.push(cached);}
        const key=mesh.isInstancedMesh?`${id}:${i}`:id;
        let proxy=this.proxies.get(key);
        if(!proxy){proxy=new THREE.Mesh(geometry,this.material);proxy.matrixAutoUpdate=false;proxy.frustumCulled=false;proxy.userData.causticIdentity=id;this.proxies.set(key,proxy);this.scene.add(proxy);}
        proxy.geometry=geometry;proxy.matrix.copy(this.world);proxy.matrixWorldNeedsUpdate=true;
        this.inverse.copy(this.world).invert();const e=this.inverse.elements;
        const tx=e[0]*center.x+e[4]*center.y+e[8]*center.z+e[12];
        const ty=e[1]*center.x+e[5]*center.y+e[9]*center.z+e[13];
        const tz=e[2]*center.x+e[6]*center.y+e[10]*center.z+e[14];
        active.push({proxy,record:[
          this.box.min.x-center.x,this.box.min.y-center.y,this.box.min.z-center.z,0,
          this.box.max.x-center.x,this.box.max.y-center.y,this.box.max.z-center.z,0,
          e[0],e[4],e[8],tx,e[1],e[5],e[9],ty,e[2],e[6],e[10],tz,
          unique.get(cached),cached.packed.nodeEnd,id,0,0,0,0,0,0,0,0,0,
        ]});
      }
    }
    const geometryChanged=geometries.length!==this.previousGeometry.length||geometries.some((g,i)=>g!==this.previousGeometry[i]);
    if(geometryChanged){
      const data=new Float32Array(Math.max(16,geometries.reduce((n,g)=>n+g.packed.data.length,0)));let offset=0;
      for(const g of geometries){data.set(g.packed.data,offset);offset+=g.packed.data.length;}
      if(this.geometryNode.value.array.length<data.length)this.geometryNode.value=new THREE.StorageBufferAttribute(new Float32Array(2**Math.ceil(Math.log2(data.length))),4);
      this.geometryNode.value.array.set(data);this.geometryNode.value.needsUpdate=true;this.previousGeometry=geometries;
    }
    const instances=new Float32Array(Math.max(32,active.length*32));active.forEach((item,i)=>instances.set(item.record,i*32));
    const moved=instances.length!==this.previousInstances.length||instances.some((v,i)=>v!==this.previousInstances[i]);
    if(moved){
      if(this.instancesNode.value.array.length<instances.length)this.instancesNode.value=new THREE.StorageBufferAttribute(new Float32Array(2**Math.ceil(Math.log2(instances.length))),4);
      this.instancesNode.value.array.set(instances);this.instancesNode.value.needsUpdate=true;
      this.previousInstances=instances;
    }
    for(const proxy of this.proxies.values())proxy.visible=false;
    for(const {proxy} of active)proxy.visible=true;
    this.countNode.value=active.length;
    return geometryChanged||moved;
  }
  dispose(){this.material.dispose();this.scene.clear();this.proxies.clear();this.previousGeometry=[];}
}
