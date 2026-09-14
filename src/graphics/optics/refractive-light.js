import * as THREE from 'three/webgpu';
import { clamp } from '../../physics/constants.js';
export { RefractiveLightField } from './gpu-caustics.js';
const SHADOW_SIZE=256;
const IOR=1.35;

class SurfaceBVH {
  constructor(surface) {
    this.surface=surface;this.p=surface.positions;this.index=surface.indices;
    this.centroids=new Float32Array(this.index.length);
    for(let t=0;t<this.index.length/3;t++)for(let axis=0;axis<3;axis++) {
      this.centroids[t*3+axis]=(this.p[this.index[t*3]*3+axis]+this.p[this.index[t*3+1]*3+axis]+this.p[this.index[t*3+2]*3+axis])/3;
    }
    const build=ids=>{
      const node={min:[0,0,0],max:[0,0,0],left:null,right:null,ids:null};
      if(ids.length<=8)node.ids=ids;
      else {
        const ranges=[0,1,2].map(axis=>{
          let lo=Infinity,hi=-Infinity;
          for(const id of ids){const x=this.centroids[id*3+axis];lo=Math.min(lo,x);hi=Math.max(hi,x);}
          return hi-lo;
        });
        const axis=ranges.indexOf(Math.max(...ranges));
        ids.sort((a,b)=>this.centroids[a*3+axis]-this.centroids[b*3+axis]);
        const mid=ids.length>>1;node.left=build(ids.slice(0,mid));node.right=build(ids.slice(mid));
      }
      return node;
    };
    this.root=build(Array.from({length:this.index.length/3},(_,i)=>i));this.refit();
  }
  refit() {
    const p=this.p,ix=this.index;
    const visit=node=>{
      if(node.ids) {
        node.min.fill(Infinity);node.max.fill(-Infinity);
        for(const t of node.ids)for(let c=0;c<3;c++)for(let a=0;a<3;a++) {
          const v=p[ix[t*3+c]*3+a];node.min[a]=Math.min(node.min[a],v);node.max[a]=Math.max(node.max[a],v);
        }
      } else {
        visit(node.left);visit(node.right);
        for(let a=0;a<3;a++){node.min[a]=Math.min(node.left.min[a],node.right.min[a]);node.max[a]=Math.max(node.left.max[a],node.right.max[a]);}
      }
    };
    visit(this.root);
  }
  /** @returns {{t:number,u:number,v:number,distance:number}|null} */
  hit(o,d,maxDistance=Infinity,out=null) {
    const p=this.p,ix=this.index;let nearest=maxDistance,result=null;
    const box=node=>{
      let lo=0,hi=nearest;
      for(let a=0;a<3;a++) {
        if(Math.abs(d[a])<1e-12){if(o[a]<node.min[a]||o[a]>node.max[a])return false;}
        else {
          let t0=(node.min[a]-o[a])/d[a],t1=(node.max[a]-o[a])/d[a];
          if(t0>t1)[t0,t1]=[t1,t0];lo=Math.max(lo,t0);hi=Math.min(hi,t1);
          if(hi<lo)return false;
        }
      }
      return true;
    };
    const visit=node=>{
      if(!box(node))return;
      if(!node.ids){visit(node.left);visit(node.right);return;}
      for(const t of node.ids) {
        const a=ix[t*3]*3,b=ix[t*3+1]*3,c=ix[t*3+2]*3;
        const e1x=p[b]-p[a],e1y=p[b+1]-p[a+1],e1z=p[b+2]-p[a+2];
        const e2x=p[c]-p[a],e2y=p[c+1]-p[a+1],e2z=p[c+2]-p[a+2];
        const hx=d[1]*e2z-d[2]*e2y,hy=d[2]*e2x-d[0]*e2z,hz=d[0]*e2y-d[1]*e2x;
        const det=e1x*hx+e1y*hy+e1z*hz;if(Math.abs(det)<1e-14)continue;
        const inv=1/det,sx=o[0]-p[a],sy=o[1]-p[a+1],sz=o[2]-p[a+2];
        const u=(sx*hx+sy*hy+sz*hz)*inv;if(u<0||u>1)continue;
        const qx=sy*e1z-sz*e1y,qy=sz*e1x-sx*e1z,qz=sx*e1y-sy*e1x;
        const v=(d[0]*qx+d[1]*qy+d[2]*qz)*inv;if(v<0||u+v>1)continue;
        const distance=(e2x*qx+e2y*qy+e2z*qz)*inv;
        if(distance>1e-7&&distance<nearest){
          nearest=distance;
          if(out){out.t=t;out.u=u;out.v=v;out.distance=distance;result=out;}else result={t,u,v,distance};
        }
      }
    };
    visit(this.root);return result;
  }
  normal(hit,d,entering) {
    const ix=this.index,p=this.p,n=this.surface.geometry.attributes.normal.array;
    const a=ix[hit.t*3]*3,b=ix[hit.t*3+1]*3,c=ix[hit.t*3+2]*3,w=1-hit.u-hit.v;
    let x=n[a]*w+n[b]*hit.u+n[c]*hit.v,y=n[a+1]*w+n[b+1]*hit.u+n[c+1]*hit.v,z=n[a+2]*w+n[b+2]*hit.u+n[c+2]*hit.v;
    const ex=p[b]-p[a],ey=p[b+1]-p[a+1],ez=p[b+2]-p[a+2];
    const fx=p[c]-p[a],fy=p[c+1]-p[a+1],fz=p[c+2]-p[a+2];
    const gx=ey*fz-ez*fy,gy=ez*fx-ex*fz,gz=ex*fy-ey*fx;
    const sign=entering?1:-1;
    if((x*d[0]+y*d[1]+z*d[2])*sign>-.015){x=gx;y=gy;z=gz;}
    const len=Math.hypot(x,y,z)||1;
    x=x/len*sign;y=y/len*sign;z=z/len*sign;
    if(x*d[0]+y*d[1]+z*d[2]>0){x=-x;y=-y;z=-z;}
    return [x,y,z];
  }
}

function refractRay(d,n,n1,n2,out=null) {
  const cosine=clamp(-(d[0]*n[0]+d[1]*n[1]+d[2]*n[2]),0,1),eta=n1/n2;
  const k=1-eta*eta*(1-cosine*cosine);
  if(k<0)return null;
  const ct=Math.sqrt(k),a=eta*cosine-ct;
  const rs=(n1*cosine-n2*ct)/(n1*cosine+n2*ct+1e-20);
  const rp=(n2*cosine-n1*ct)/(n2*cosine+n1*ct+1e-20);
  const result=out??{direction:[0,0,0],transmission:0},direction=result.direction;
  direction[0]=eta*d[0]+a*n[0];direction[1]=eta*d[1]+a*n[1];direction[2]=eta*d[2]+a*n[2];
  result.transmission=1-(rs*rs+rp*rp)/2;return result;
}

/** Keep the existing view-thickness algorithm independent from caustic generation. */
function updateViewThickness(surface,bvh,camera) {
  const p=surface.positions,n=surface.geometry.attributes.normal.array;
  const thickness=surface.geometry.attributes.opticalThickness;
  // This runs over every optical vertex in the worker. Reuse ray/refraction
  // scratch instead of creating several arrays/objects per vertex.
  const ray=[0,0,0],normal=[0,0,0],origin=[0,0,0];
  const refracted={direction:[0,0,0],transmission:0},hitScratch={t:0,u:0,v:0,distance:0};
  for(let i=0;i<p.length;i+=3) {
    let dx=p[i]-camera.position.x,dy=p[i+1]-camera.position.y,dz=p[i+2]-camera.position.z;
    const length=Math.hypot(dx,dy,dz)||1;dx/=length;dy/=length;dz/=length;
    normal[0]=n[i];normal[1]=n[i+1];normal[2]=n[i+2];
    if(dx*normal[0]+dy*normal[1]+dz*normal[2]>-.01)continue;
    ray[0]=dx;ray[1]=dy;ray[2]=dz;
    const refraction=refractRay(ray,normal,1,IOR,refracted);if(!refraction)continue;
    const dir=refraction.direction;origin[0]=p[i]+dir[0]*2e-6;origin[1]=p[i+1]+dir[1]*2e-6;origin[2]=p[i+2]+dir[2]*2e-6;
    const hit=bvh.hit(origin,dir,Infinity,hitScratch);
    thickness.array[i/3]=hit?clamp(hit.distance,.0002,.16):.002;
  }
  thickness.needsUpdate=true;
}

/** Existing projected shadow/contact field, retained so the caustic rewrite cannot alter it. */
class OpticalShadowField {
  constructor(surface,lightDirection) {
    this.size=SHADOW_SIZE;this.span=.22;this.origin=new THREE.Vector2();
    this.surface=surface;this.lightDirection=lightDirection;
    this.shadow=new Float32Array(this.size*this.size);
    this.contact=new Float32Array(this.size*this.size);
    this.blurScratch=new Float32Array(this.size*this.size);
    this.shadowBytes=new Uint8Array(this.size*this.size*2);
    this.triangleA=[0,0];this.triangleB=[0,0];this.triangleC=[0,0];
  }
  rasterTriangle(a,b,c,buffer,value) {
    const n=this.size,scale=n/this.span;
    const ax=(a[0]-this.origin.x)*scale,ay=(a[1]-this.origin.y)*scale;
    const bx=(b[0]-this.origin.x)*scale,by=(b[1]-this.origin.y)*scale;
    const cx=(c[0]-this.origin.x)*scale,cy=(c[1]-this.origin.y)*scale;
    const area=(bx-ax)*(cy-ay)-(by-ay)*(cx-ax);if(Math.abs(area)<1e-9)return;
    const minX=clamp(Math.floor(Math.min(ax,bx,cx)),0,n-1),maxX=clamp(Math.ceil(Math.max(ax,bx,cx)),0,n-1);
    const minY=clamp(Math.floor(Math.min(ay,by,cy)),0,n-1),maxY=clamp(Math.ceil(Math.max(ay,by,cy)),0,n-1);
    for(let y=minY;y<=maxY;y++)for(let x=minX;x<=maxX;x++) {
      const px=x+.5,py=y+.5;
      const u=((bx-px)*(cy-py)-(by-py)*(cx-px))/area;
      const v=((cx-px)*(ay-py)-(cy-py)*(ax-px))/area;
      if(u>=0&&v>=0&&u+v<=1)buffer[y*n+x]=Math.max(buffer[y*n+x],value);
    }
  }
  blur(buffer) {
    const n=this.size,tmp=this.blurScratch;
    for(let y=0;y<n;y++)for(let x=0;x<n;x++) {
      let sum=0;for(let k=-2;k<=2;k++)sum+=buffer[y*n+clamp(x+k,0,n-1)]*(3-Math.abs(k));tmp[y*n+x]=sum/9;
    }
    for(let y=0;y<n;y++)for(let x=0;x<n;x++) {
      let sum=0;for(let k=-2;k<=2;k++)sum+=tmp[clamp(y+k,0,n-1)*n+x]*(3-Math.abs(k));buffer[y*n+x]=sum/9;
    }
  }
  update(body) {
    this.shadow.fill(0);this.contact.fill(0);
    const dx=this.lightDirection.x,dy=this.lightDirection.y,dz=this.lightDirection.z;
    const p=this.surface.positions,ix=this.surface.indices,box=this.surface.geometry.boundingBox;
    const cx=body.center.x,cz=body.center.z;
    this.span=Math.max(.22,(box.max.x-box.min.x)*2+.04,(box.max.z-box.min.z)*2+.04,
      box.max.y*Math.max(Math.abs(dx/dy),Math.abs(dz/dy))*2+.12);
    const projectedX=cx-body.center.y*dx/dy,projectedZ=cz-body.center.y*dz/dy;
    this.origin.set((cx+projectedX)/2-this.span/2,(cz+projectedZ)/2-this.span/2);
    const a=this.triangleA,b=this.triangleB,c=this.triangleC;
    for(let t=0;t<ix.length;t+=3) {
      const ia=ix[t]*3,ib=ix[t+1]*3,ic=ix[t+2]*3;
      a[0]=p[ia]-p[ia+1]*dx/dy;a[1]=p[ia+2]-p[ia+1]*dz/dy;
      b[0]=p[ib]-p[ib+1]*dx/dy;b[1]=p[ib+2]-p[ib+1]*dz/dy;
      c[0]=p[ic]-p[ic+1]*dx/dy;c[1]=p[ic+2]-p[ic+1]*dz/dy;
      this.rasterTriangle(a,b,c,this.shadow,1);
      const height=(p[ia+1]+p[ib+1]+p[ic+1])/3;
      if(height<.016){a[0]=p[ia];a[1]=p[ia+2];b[0]=p[ib];b[1]=p[ib+2];c[0]=p[ic];c[1]=p[ic+2];this.rasterTriangle(a,b,c,this.contact,Math.exp(-height/.0028));}
    }
    this.blur(this.shadow);this.blur(this.contact);
    for(let i=0;i<this.size*this.size;i++) {
      this.shadowBytes[i*2]=Math.round(this.shadow[i]*255);
      this.shadowBytes[i*2+1]=Math.round(this.contact[i]*255);
    }
  }
}

export { OpticalShadowField, SurfaceBVH, updateViewThickness };
