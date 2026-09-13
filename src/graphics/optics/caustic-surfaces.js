import * as THREE from 'three/webgpu';
import { positionWorld, storage, uniform, vec4 } from 'three/tsl';
import { packReceiverGeometry } from './optical-bvh.js';

function visible(mesh) {
  for(let object=mesh;object;object=object.parent)if(!object.visible)return false;
  return true;
}

function nextCapacity(value,min=32) {return 2**Math.ceil(Math.log2(Math.max(min,value)));}

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
    this.proxySets=new WeakMap();this.proxyList=[];
    this.geometryOffsets=new Map();this.geometryScratch=[];this.previousGeometry=[];
    this.instanceScratch=new Float32Array(32);this.previousInstances=new Float32Array(32);this.previousInstanceLength=32;
    this.box=new THREE.Box3();this.cropBounds=new THREE.Box3();this.inverse=new THREE.Matrix4();this.world=new THREE.Matrix4();this.instance=new THREE.Matrix4();
  }
  update(center,reach) {
    const geometries=this.geometryScratch;geometries.length=0;this.geometryOffsets.clear();this.cropBounds.makeEmpty();
    for(const proxy of this.proxyList)proxy.visible=false;
    let geometryFloats=0,activeCount=0;
    // The atlas only covers the same local X/Z neighborhood it covered before,
    // but its Y extent follows actual receiver surfaces instead of an empty cube.
    // This preserves the transport footprint while spending the fixed 384² atlas
    // on visible receivers, which is especially important at grazing view angles.
    const cropMinX=center.x-reach,cropMaxX=center.x+reach,cropMinY=Math.min(0,center.y-reach),cropMaxY=center.y+reach,cropMinZ=center.z-reach,cropMaxZ=center.z+reach;
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
      let proxies=this.proxySets.get(mesh);
      if(!proxies){proxies=[];this.proxySets.set(mesh,proxies);}
      for(let i=0;i<instances;i++){
        if(mesh.isInstancedMesh){mesh.getMatrixAt(i,this.instance);this.world.multiplyMatrices(mesh.matrixWorld,this.instance);}else this.world.copy(mesh.matrixWorld);
        this.box.copy(geometry.boundingBox).applyMatrix4(this.world);
        // Every outgoing ray is bounded to this distance; distant worlds never enter the trace.
        if(this.box.distanceToPoint(center)>reach*4)continue;
        const minX=Math.max(this.box.min.x,cropMinX),maxX=Math.min(this.box.max.x,cropMaxX);
        const minY=Math.max(this.box.min.y,cropMinY),maxY=Math.min(this.box.max.y,cropMaxY);
        const minZ=Math.max(this.box.min.z,cropMinZ),maxZ=Math.min(this.box.max.z,cropMaxZ);
        if(minX<=maxX&&minY<=maxY&&minZ<=maxZ){
          this.cropBounds.min.x=Math.min(this.cropBounds.min.x,minX);this.cropBounds.max.x=Math.max(this.cropBounds.max.x,maxX);
          this.cropBounds.min.y=Math.min(this.cropBounds.min.y,minY);this.cropBounds.max.y=Math.max(this.cropBounds.max.y,maxY);
          this.cropBounds.min.z=Math.min(this.cropBounds.min.z,minZ);this.cropBounds.max.z=Math.max(this.cropBounds.max.z,maxZ);
        }
        if(!cached.packed){cached.packed=packReceiverGeometry(geometry,cached.previous);cached.previous=null;}
        let geometryOffset=this.geometryOffsets.get(cached);
        if(geometryOffset===undefined){geometryOffset=geometryFloats/4;this.geometryOffsets.set(cached,geometryOffset);geometries.push(cached);geometryFloats+=cached.packed.data.length;}
        let proxy=proxies[i];
        if(!proxy){proxy=new THREE.Mesh(geometry,this.material);proxy.matrixAutoUpdate=false;proxy.frustumCulled=false;proxy.userData.causticIdentity=id;proxies[i]=proxy;this.proxyList.push(proxy);this.scene.add(proxy);}
        proxy.geometry=geometry;proxy.matrix.copy(this.world);proxy.matrixWorldNeedsUpdate=true;proxy.visible=true;
        this.inverse.copy(this.world).invert();const e=this.inverse.elements;
        const tx=e[0]*center.x+e[4]*center.y+e[8]*center.z+e[12];
        const ty=e[1]*center.x+e[5]*center.y+e[9]*center.z+e[13];
        const tz=e[2]*center.x+e[6]*center.y+e[10]*center.z+e[14];
        const required=(activeCount+1)*32;
        if(this.instanceScratch.length<required){const grown=new Float32Array(nextCapacity(required));grown.set(this.instanceScratch);this.instanceScratch=grown;}
        const record=this.instanceScratch,o=activeCount*32;
        record[o]=this.box.min.x-center.x;record[o+1]=this.box.min.y-center.y;record[o+2]=this.box.min.z-center.z;record[o+3]=0;
        record[o+4]=this.box.max.x-center.x;record[o+5]=this.box.max.y-center.y;record[o+6]=this.box.max.z-center.z;record[o+7]=0;
        record[o+8]=e[0];record[o+9]=e[4];record[o+10]=e[8];record[o+11]=tx;
        record[o+12]=e[1];record[o+13]=e[5];record[o+14]=e[9];record[o+15]=ty;
        record[o+16]=e[2];record[o+17]=e[6];record[o+18]=e[10];record[o+19]=tz;
        record[o+20]=geometryOffset;record[o+21]=cached.packed.nodeEnd;record[o+22]=id;
        record.fill(0,o+23,o+32);activeCount++;
      }
    }
    const geometryChanged=geometries.length!==this.previousGeometry.length||geometries.some((g,i)=>g!==this.previousGeometry[i]);
    if(geometryChanged){
      if(this.geometryNode.value.array.length<geometryFloats)this.geometryNode.value=new THREE.StorageBufferAttribute(new Float32Array(nextCapacity(geometryFloats,16)),4);
      const output=this.geometryNode.value.array;let offset=0;
      for(const g of geometries){output.set(g.packed.data,offset);offset+=g.packed.data.length;}
      this.geometryNode.value.needsUpdate=true;
    }
    const instanceLength=Math.max(32,activeCount*32);let moved=instanceLength!==this.previousInstanceLength;
    if(!moved)for(let i=0;i<instanceLength;i++)if(this.instanceScratch[i]!==this.previousInstances[i]){moved=true;break;}
    if(moved){
      if(this.instancesNode.value.array.length<instanceLength)this.instancesNode.value=new THREE.StorageBufferAttribute(new Float32Array(nextCapacity(instanceLength)),4);
      this.instancesNode.value.array.set(this.instanceScratch.subarray(0,instanceLength));this.instancesNode.value.needsUpdate=true;
      if(this.previousInstances.length<instanceLength)this.previousInstances=new Float32Array(nextCapacity(instanceLength));
      this.previousInstances.set(this.instanceScratch.subarray(0,instanceLength));this.previousInstanceLength=instanceLength;
    }
    const oldPrevious=this.previousGeometry;this.previousGeometry=geometries;this.geometryScratch=oldPrevious;
    this.countNode.value=activeCount;
    return geometryChanged||moved;
  }
  dispose(){this.material.dispose();this.scene.clear();this.proxyList.length=0;this.proxySets=new WeakMap();this.previousGeometry.length=0;this.geometryScratch.length=0;this.geometryOffsets.clear();}
}
