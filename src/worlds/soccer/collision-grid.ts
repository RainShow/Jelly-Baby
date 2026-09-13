import { boxBounds, bodyCollisionBounds } from '../../facilities/collision-bounds.ts';
import type { CollisionBox } from '../../facilities/collision.ts';
import type { SoftBody } from '../../physics/soft-body.js';

/** Static spatial bins keep the many fitted seat and gate pieces out of the
 * 240 Hz narrow phase unless the live, possibly stretched jelly can reach them.
 */
export class StadiumCollisionGrid {
  private readonly cells=new Map<number,Map<number,CollisionBox[]>>();
  private readonly candidates:CollisionBox[]=[];
  private readonly seen=new Set<CollisionBox>();
  private readonly bounds=new Float64Array(6);
  private readonly cellSize=.16;
  private magnitude=1;
  private error=0;
  constructor(boxes:readonly CollisionBox[],body:SoftBody) {
    const weights=body.surface.bindingWeights;
    for(let i=0;i<weights.length;i+=4){let sum=0,absolute=0;for(let j=0;j<4;j++){sum+=weights[i+j];absolute+=Math.abs(weights[i+j]);}this.magnitude=Math.max(this.magnitude,absolute);this.error=Math.max(this.error,Math.abs(sum-1));}
    for(const box of boxes){
      boxBounds(box,box.margin??.002,this.bounds);
      const minX=Math.floor(this.bounds[0]/this.cellSize),maxX=Math.floor(this.bounds[3]/this.cellSize);
      const minZ=Math.floor(this.bounds[2]/this.cellSize),maxZ=Math.floor(this.bounds[5]/this.cellSize);
      for(let x=minX;x<=maxX;x++){
        let column=this.cells.get(x);if(!column){column=new Map();this.cells.set(x,column);}
        for(let z=minZ;z<=maxZ;z++){let bucket=column.get(z);if(!bucket){bucket=[];column.set(z,bucket);}bucket.push(box);}
      }
    }
  }
  near(body:SoftBody) {
    // Exact binding bounds include stretched/extrapolated skin and swept throws;
    // another 15 mm covers contacts created by the first collision solve.
    bodyCollisionBounds(body,this.magnitude,this.error,this.bounds);for(let i=0;i<3;i++){this.bounds[i]-=.015;this.bounds[i+3]+=.015;}
    this.candidates.length=0;this.seen.clear();
    const minX=Math.floor(this.bounds[0]/this.cellSize),maxX=Math.floor(this.bounds[3]/this.cellSize);
    const minZ=Math.floor(this.bounds[2]/this.cellSize),maxZ=Math.floor(this.bounds[5]/this.cellSize);
    // Integer nested maps avoid creating `${x},${z}` strings and a callback on
    // every 240 Hz collision query while preserving the same cell membership.
    for(let x=minX;x<=maxX;x++){const column=this.cells.get(x);if(!column)continue;for(let z=minZ;z<=maxZ;z++){const bucket=column.get(z);if(!bucket)continue;for(const box of bucket)if(!this.seen.has(box)){this.seen.add(box);this.candidates.push(box);}}}
    return this.candidates;
  }
}
