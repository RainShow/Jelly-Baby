/** Static, depth-first triangle hierarchy. Escape links permit bounded stackless GPU traversal. */
export function buildOpticalBVH(positions,indices,leafSize=8) {
  const nodes=[],triangles=[],levels=[];
  const centroid=t=>[0,1,2].map(a=>(positions[indices[t*3]*3+a]+positions[indices[t*3+1]*3+a]+positions[indices[t*3+2]*3+a])/3);
  const centers=Array.from({length:indices.length/3},(_,t)=>centroid(t));
  const build=(ids,depth)=>{
    const id=nodes.length,node={first:0,count:0,right:0,escape:0,min:[Infinity,Infinity,Infinity],max:[-Infinity,-Infinity,-Infinity]};
    nodes.push(node);(levels[depth]??=[]).push(id);
    for(const t of ids)for(let v=0;v<3;v++)for(let a=0;a<3;a++){
      const p=positions[indices[t*3+v]*3+a];node.min[a]=Math.min(node.min[a],p);node.max[a]=Math.max(node.max[a],p);
    }
    if(ids.length<=leafSize){node.first=triangles.length;node.count=ids.length;triangles.push(...ids);}
    else {
      const lo=[Infinity,Infinity,Infinity],hi=[-Infinity,-Infinity,-Infinity];
      for(const t of ids)for(let a=0;a<3;a++){lo[a]=Math.min(lo[a],centers[t][a]);hi[a]=Math.max(hi[a],centers[t][a]);}
      const extent=hi.map((v,a)=>v-lo[a]),axis=extent.indexOf(Math.max(...extent));
      ids.sort((a,b)=>centers[a][axis]-centers[b][axis]);
      const mid=ids.length>>1;build(ids.slice(0,mid),depth+1);node.right=build(ids.slice(mid),depth+1);
    }
    node.escape=nodes.length;return id;
  };
  build(Array.from({length:indices.length/3},(_,i)=>i),0);
  const order=levels.flat(),topology=new Uint32Array((nodes.length+triangles.length+order.length)*4);
  const bounds=new Float32Array(nodes.length*8);
  for(let i=0;i<nodes.length;i++){
    const n=nodes[i];topology.set([nodes.length+n.first,n.count,n.escape,n.right],i*4);
    bounds.set([...n.min,0,...n.max,0],i*8);
  }
  for(let i=0;i<triangles.length;i++)topology.set([...indices.slice(triangles[i]*3,triangles[i]*3+3),triangles[i]],(nodes.length+i)*4);
  const orderOffset=nodes.length+triangles.length;
  order.forEach((id,i)=>{topology[(orderOffset+i)*4]=id;});
  let start=orderOffset;
  const refitLevels=levels.map(level=>{const result={start,count:level.length};start+=level.length;return result;}).reverse();
  return {nodes,triangles,topology,bounds,refitLevels,nodeCount:nodes.length};
}

/** Receiver BLAS records: three vec4s per node, three positions per triangle. */
export function packReceiverGeometry(geometry,previous=null) {
  const attribute=geometry.attributes.position;
  const positions=new Float32Array(attribute.count*3);
  for(let i=0;i<attribute.count;i++)positions.set([attribute.getX(i),attribute.getY(i),attribute.getZ(i)],i*3);
  const index=geometry.index?Uint32Array.from(geometry.index.array):Uint32Array.from({length:attribute.count},(_,i)=>i);
  const start=Math.max(0,geometry.drawRange.start),end=Math.min(index.length,start+geometry.drawRange.count);
  const indices=index.slice(start,end-end%3),bvh=previous?.bvh??buildOpticalBVH(positions,indices);
  if(previous){
    // Dynamic receiver meshes retain their partition: refit in linear time,
    // rather than sorting/rebuilding a triangle tree on each cloth update.
    for(let i=bvh.nodes.length-1;i>=0;i--){
      const n=bvh.nodes[i];n.min.fill(Infinity);n.max.fill(-Infinity);
      if(n.count){for(let t=0;t<n.count;t++)for(let v=0;v<3;v++)for(let a=0;a<3;a++){
        const p=positions[indices[bvh.triangles[n.first+t]*3+v]*3+a];n.min[a]=Math.min(n.min[a],p);n.max[a]=Math.max(n.max[a],p);
      }}else {for(let a=0;a<3;a++){n.min[a]=Math.min(bvh.nodes[i+1].min[a],bvh.nodes[n.right].min[a]);n.max[a]=Math.max(bvh.nodes[i+1].max[a],bvh.nodes[n.right].max[a]);}}
    }
  }
  const data=new Float32Array((bvh.nodes.length+bvh.triangles.length)*12);
  bvh.nodes.forEach((n,i)=>{
    data.set([...n.min,n.count,...n.max,n.escape*3,(bvh.nodes.length+n.first)*3,0,0,0],i*12);
  });
  bvh.triangles.forEach((t,i)=>{
    for(let v=0;v<3;v++)data.set([...positions.slice(indices[t*3+v]*3,indices[t*3+v]*3+3),0],(bvh.nodes.length+i)*12+v*4);
  });
  return {data,nodeEnd:bvh.nodes.length*3,bvh};
}
