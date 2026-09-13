// Native WGSL functions are composed and bound through TSL. No private device pipelines.
import { wgsl, wgslFn } from 'three/tsl';

export const BASE_GRID=32;
export const FINE_GRID=BASE_GRID*2;
export const RAY_STRIDE=FINE_GRID+1;
// One directional field, as in the original geometry-traced CPU caustics.
export const RAY_COUNT=RAY_STRIDE*RAY_STRIDE;
export const RAY_RECORDS=5;
export const CELL_COUNT=BASE_GRID*BASE_GRID;
export const BEAM_COUNT=CELL_COUNT*8;
export const CAUSTIC_SIZE=384;

const common=wgsl(`
const J_GRID: u32 = ${FINE_GRID}u;
const J_STRIDE: u32 = ${RAY_STRIDE}u;
const J_BASE: u32 = ${BASE_GRID}u;
const J_EPS: f32 = 0.000002;
fn j_box(o:vec3f,d:vec3f,lo:vec3f,hi:vec3f,limit:f32)->bool {
  var near=0.0;var far=limit;
  for(var a=0u;a<3u;a++){
    if(abs(d[a])<1e-12){if(o[a]<lo[a] || o[a]>hi[a]){return false;}}
    else {let t0=(lo[a]-o[a])/d[a];let t1=(hi[a]-o[a])/d[a];near=max(near,min(t0,t1));far=min(far,max(t0,t1));}
  }
  return far>=near;
}
fn j_triangle(o:vec3f,d:vec3f,a:vec3f,b:vec3f,c:vec3f,limit:f32)->vec3f {
  let e=b-a;let f=c-a;let h=cross(d,f);let det=dot(e,h);
  if(abs(det)<1e-15){return vec3f(-1.0);}
  let s=o-a;let u=dot(s,h)/det;let q=cross(s,e);let v=dot(d,q)/det;let t=dot(f,q)/det;
  if(u<0.0 || v<0.0 || u+v>1.0 || t<=J_EPS*0.25 || t>=limit){return vec3f(-1.0);}
  return vec3f(t,u,v);
}
// xyz is the refracted direction; w is exact unpolarized Fresnel transmission.
fn j_refract(d:vec3f,n:vec3f,n1:f32,n2:f32)->vec4f {
  let c=clamp(-dot(d,n),0.0,1.0);let eta=n1/n2;let k=1.0-eta*eta*(1.0-c*c);
  if(k<=0.0){return vec4f(0.0);}
  let ct=sqrt(k);let rs=(n1*c-n2*ct)/max(n1*c+n2*ct,1e-12);let rp=(n2*c-n1*ct)/max(n2*c+n1*ct,1e-12);
  return vec4f(normalize(eta*d+(eta*c-ct)*n),1.0-(rs*rs+rp*rp)*0.5);
}
fn j_hit(o:vec3f,d:vec3f,limit:f32,vertices:ptr<storage,array<vec4f>,read_write>,tree:ptr<storage,array<vec4u>,read>,bounds:ptr<storage,array<vec4f>,read_write>,nodeCount:u32)->vec4f {
  var best=vec4f(limit,-1.0,0.0,0.0);var node=0u;
  loop {
    if(node>=nodeCount){break;}
    let record=(*tree)[node];
    if(!j_box(o,d,(*bounds)[node*2u].xyz,(*bounds)[node*2u+1u].xyz,best.x)){node=record.z;continue;}
    if(record.y==0u){node++;continue;}
    for(var i=0u;i<record.y;i++){
      let ids=(*tree)[record.x+i];let hit=j_triangle(o,d,(*vertices)[ids.x*2u].xyz,(*vertices)[ids.y*2u].xyz,(*vertices)[ids.z*2u].xyz,best.x);
      if(hit.x>0.0){best=vec4f(hit.x,f32(record.x+i),hit.y,hit.z);}
    }
    node=record.z;
  }
  return best;
}
fn j_normal(hit:vec4f,d:vec3f,vertices:ptr<storage,array<vec4f>,read_write>,tree:ptr<storage,array<vec4u>,read>)->vec3f {
  let ids=(*tree)[u32(hit.y)];let a=(*vertices)[ids.x*2u].xyz;let b=(*vertices)[ids.y*2u].xyz;let c=(*vertices)[ids.z*2u].xyz;
  let face=normalize(cross(b-a,c-a));
  var n=normalize((*vertices)[ids.x*2u+1u].xyz*(1.0-hit.z-hit.w)+(*vertices)[ids.y*2u+1u].xyz*hit.z+(*vertices)[ids.z*2u+1u].xyz*hit.w);
  if(dot(n,face)<0.0){n=-n;}
  if(dot(n,d)*dot(face,d)<=0.0 || abs(dot(n,d))<0.015){n=face;}
  return select(n,-n,dot(n,d)>0.0);
}
// Instances: world AABB (relative to body), inverse affine matrix, geometry range, stable receiver ID.
fn j_receiver(o:vec3f,d:vec3f,limit:f32,geometry:ptr<storage,array<vec4f>,read>,instances:ptr<storage,array<vec4f>,read>,count:u32)->mat2x4f {
  var best=limit;var normal=vec3f(0.0);var receiver=0.0;
  for(var mesh=0u;mesh<count;mesh++){
    let base=mesh*8u;let lo=(*instances)[base];let hi=(*instances)[base+1u];
    if(!j_box(o,d,lo.xyz,hi.xyz,best)){continue;}
    let r0=(*instances)[base+2u];let r1=(*instances)[base+3u];let r2=(*instances)[base+4u];
    let localO=vec3f(dot(r0,vec4f(o,1.0)),dot(r1,vec4f(o,1.0)),dot(r2,vec4f(o,1.0)));
    let localD=vec3f(dot(r0.xyz,d),dot(r1.xyz,d),dot(r2.xyz,d));
    let record=(*instances)[base+5u];let offset=u32(record.x);var node=0u;
    loop {
      if(node>=u32(record.y)){break;}
      let a=(*geometry)[offset+node];let b=(*geometry)[offset+node+1u];
      if(!j_box(localO,localD,a.xyz,b.xyz,best)){node=u32(b.w);continue;}
      if(a.w==0.0){node+=3u;continue;}
      let first=u32((*geometry)[offset+node+2u].x);
      for(var i=0u;i<u32(a.w);i++){
        let tri=offset+first+i*3u;let p=(*geometry)[tri].xyz;let q=(*geometry)[tri+1u].xyz;let r=(*geometry)[tri+2u].xyz;
        let hit=j_triangle(localO,localD,p,q,r,best);
        if(hit.x>0.0){
          best=hit.x;receiver=record.z;
          let n=cross(q-p,r-p);normal=normalize(r0.xyz*n.x+r1.xyz*n.y+r2.xyz*n.z);
          normal=select(normal,-normal,dot(normal,d)>0.0);
        }
      }
      node=u32(b.w);
    }
  }
  return mat2x4f(vec4f(o+d*best,receiver),vec4f(normal,best));
}
`);

export const deformKernel=wgslFn(`fn jelly_deform(id:u32,cage:ptr<storage,array<vec4f>,read>,bindings:ptr<storage,array<vec4f>,read>,vertices:ptr<storage,array<vec4f>,read_write>)->u32 {
  let ids=vec4u((*bindings)[id*3u]);let w=(*bindings)[id*3u+1u];let rest=(*bindings)[id*3u+2u].xyz;
  var p=vec3f(0.0);var r0=vec3f(0.0);var r1=vec3f(0.0);var r2=vec3f(0.0);
  for(var i=0u;i<4u;i++){let k=ids[i]*4u;p+=(*cage)[k].xyz*w[i];r0+=(*cage)[k+1u].xyz*w[i];r1+=(*cage)[k+2u].xyz*w[i];r2+=(*cage)[k+3u].xyz*w[i];}
  let n=vec3f(dot(cross(r1,r2),rest),dot(cross(r2,r0),rest),dot(cross(r0,r1),rest));
  (*vertices)[id*2u]=vec4f(p,1.0);(*vertices)[id*2u+1u]=vec4f(n/max(length(n),1e-12),0.0);return 0u;
}`);

export const refitKernel=wgslFn(`fn jelly_refit(id:u32,start:u32,vertices:ptr<storage,array<vec4f>,read_write>,tree:ptr<storage,array<vec4u>,read>,bounds:ptr<storage,array<vec4f>,read_write>)->u32 {
  let node=(*tree)[start+id].x;let record=(*tree)[node];var lo=vec3f(1e20);var hi=vec3f(-1e20);
  if(record.y>0u){for(var i=0u;i<record.y;i++){let ids=(*tree)[record.x+i];for(var c=0u;c<3u;c++){let p=(*vertices)[ids[c]*2u].xyz;lo=min(lo,p);hi=max(hi,p);}}}
  else {lo=min((*bounds)[(node+1u)*2u].xyz,(*bounds)[record.w*2u].xyz);hi=max((*bounds)[(node+1u)*2u+1u].xyz,(*bounds)[record.w*2u+1u].xyz);}
  (*bounds)[node*2u]=vec4f(lo,0.0);(*bounds)[node*2u+1u]=vec4f(hi,0.0);return 0u;
}`);

export const traceKernel=wgslFn(`fn jelly_trace(id:u32,phase:u32,vertices:ptr<storage,array<vec4f>,read_write>,tree:ptr<storage,array<vec4u>,read>,bounds:ptr<storage,array<vec4f>,read_write>,rays:ptr<storage,array<vec4f>,read_write>,flags:ptr<storage,array<u32>,read_write>,geometry:ptr<storage,array<vec4f>,read>,instances:ptr<storage,array<vec4f>,read>,nodeCount:u32,receiverCount:u32,source:vec4f,right:vec3f,up:vec3f,incoming:vec3f,sigma:vec3f,reach:f32)->u32 {
  let x=id%J_STRIDE;let y=id/J_STRIDE;
  let oddX=(x&1u)!=0u;let oddY=(y&1u)!=0u;
  if(phase==0u && (oddX || oddY)){return 0u;}
  if(phase==1u && !(oddX && oddY)){return 0u;}
  if(phase==2u){
    if(oddX==oddY){return 0u;}
    let cx=min(x/2u,J_BASE-1u);let cy=min(y/2u,J_BASE-1u);
    var needed=(*flags)[cy*J_BASE+cx]>0u;
    if(oddX && y>0u){needed=needed || (*flags)[(y/2u-1u)*J_BASE+cx]>0u;}
    if(oddY && x>0u){needed=needed || (*flags)[cy*J_BASE+x/2u-1u]>0u;}
    if(!needed){for(var k=0u;k<5u;k++){(*rays)[id*5u+k]=vec4f(0.0);}return 0u;}
  }
  let out=id*5u;for(var k=0u;k<5u;k++){(*rays)[out+k]=vec4f(0.0);}
  let d=incoming;
  let o=right*((f32(x)/f32(J_GRID)-0.5)*source.x+source.z)+up*((f32(y)/f32(J_GRID)-0.5)*source.y+source.w)-d*reach;
  let entry=j_hit(o,d,reach*3.0,vertices,tree,bounds,nodeCount);if(entry.y<0.0){return 0u;}
  let en=j_normal(entry,d,vertices,tree);let refracted=j_refract(d,en,1.0,1.35);
  if(refracted.w<=0.0){return 0u;}
  var direction=refracted.xyz;var throughput=refracted.w;var path=0.0;
  let ep=o+d*entry.x;var origin=ep+direction*J_EPS;var branch=1u;var escaped=false;var exitPoint=ep;
  // A finite boundary budget covers TIR and re-entry without exponential Fresnel branching.
  var inside=true;
  for(var event=0u;event<8u;event++){
    let hit=j_hit(origin,direction,reach*4.0,vertices,tree,bounds,nodeCount);
    if(hit.y<0.0){if(!inside){escaped=true;}break;}
    // Outside, an opaque receiver before the next jelly surface terminates transport.
    if(!inside){let obstruction=j_receiver(origin,direction,hit.x,geometry,instances,receiverCount);if(obstruction[0].w>0.0){escaped=true;break;}}
    if(inside){path+=hit.x;}
    exitPoint=origin+direction*hit.x;
    let n=j_normal(hit,direction,vertices,tree);
    let eta1=select(1.0,1.35,inside);let eta2=select(1.35,1.0,inside);let refraction=j_refract(direction,n,eta1,eta2);
    if(refraction.w>0.0){throughput*=refraction.w;direction=refraction.xyz;inside=!inside;branch=branch*3u+1u;}
    else {direction=reflect(direction,n);branch=branch*3u+2u;}
    origin=exitPoint+direction*J_EPS;
    if(throughput*exp(-min(sigma.x,min(sigma.y,sigma.z))*path)<0.0001){break;}
  }
  if(!escaped || inside){return 0u;}
  let receiver=j_receiver(origin,direction,reach*4.0,geometry,instances,receiverCount);
  if(receiver[0].w<=0.0){return 0u;}
  (*rays)[out]=vec4f(receiver[0].xyz,f32(branch));
  (*rays)[out+1u]=vec4f(exp(-sigma*path)*throughput,receiver[0].w);
  (*rays)[out+2u]=vec4f(receiver[1].xyz,entry.x);
  (*rays)[out+3u]=vec4f(exitPoint,path);
  (*rays)[out+4u]=vec4f(direction,0.0);
  return 0u;
}`,[common]);

export const refineKernel=wgslFn(`fn jelly_refine(id:u32,rays:ptr<storage,array<vec4f>,read_write>,flags:ptr<storage,array<u32>,read_write>,pixel:f32)->u32 {
  let x=id%J_BASE;let y=id/J_BASE;
  var refine=false;var anyValid=false;
  let threshold=pixel*select(0.6,0.35,(*flags)[id]>0u);
  let a=y*2u*J_STRIDE+x*2u;let center=a+J_STRIDE+1u;
  let ids=array<u32,4>(a,a+2u,a+J_STRIDE*2u,a+J_STRIDE*2u+2u);
  let c=(*rays)[center*5u];let cr=(*rays)[center*5u+1u];var mean=vec3f(0.0);anyValid=anyValid || c.w>0.0;
  for(var i=0u;i<4u;i++){let p=(*rays)[ids[i]*5u];let t=(*rays)[ids[i]*5u+1u];mean+=p.xyz*0.25;anyValid=anyValid || p.w>0.0;
    refine=refine || p.w!=c.w || t.w!=cr.w || distance(t.xyz,cr.xyz)>0.12;
  }
  refine=refine || distance(mean,c.xyz)>threshold;
  refine=anyValid && refine;
  (*flags)[id]=select(0u,1u,refine);return 0u;
}`,[common]);

export { common as causticCommon };
