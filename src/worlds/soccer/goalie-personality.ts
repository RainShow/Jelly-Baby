import { clamp } from '../../physics/constants.js';
import type { GoalieMode } from './goalie-brain.ts';

export type GoaliePersonalityObservation={
  mode:GoalieMode;
  ballZ:number;
  deadBall:boolean;
  grounded:boolean;
};

/** Cosmetic keeper reactions. Live-ball goalkeeping targets remain owned by GoalieBrain. */
export class GoaliePersonality {
  private readonly random:()=>number;
  private laughFor=0;
  private cryFor=0;
  private idleIn=0;
  private hopDelay=-1;
  private hopWindow=0;
  constructor(random:()=>number=Math.random) {this.random=random;this.reset();}

  get laughing(){return this.laughFor>0&&this.cryFor<=0;}
  get crying(){return this.cryFor>0;}

  reset() {
    this.laughFor=this.cryFor=this.hopWindow=0;this.hopDelay=-1;
    this.idleIn=6+this.random()*8;
  }

  notifySave(strength:number) {
    if(this.cryFor>0)return;
    const confidence=clamp((strength-.05)/.55,0,1);
    if(this.random()<.34+.42*confidence)this.laughFor=.42+this.random()*.70;
    if(strength>.16&&this.random()<.42) {
      // A save-hop is queued but may only execute if play subsequently becomes dead.
      this.hopWindow=1.7;this.hopDelay=.08+this.random()*.18;
    }
    this.idleIn=5+this.random()*9;
  }

  notifyGoal() {
    this.cryFor=1.25+this.random()*.95;this.laughFor=0;
    // Occasionally add one tiny frustrated bounce while the scored ball is dead.
    this.hopWindow=1.2;
    this.hopDelay=this.random()<.48?.16+this.random()*.30:-1;
    this.idleIn=7+this.random()*10;
  }

  step(h:number,o:GoaliePersonalityObservation) {
    this.laughFor=Math.max(0,this.laughFor-h);this.cryFor=Math.max(0,this.cryFor-h);
    this.hopWindow=Math.max(0,this.hopWindow-h);if(this.hopWindow<=0)this.hopDelay=-1;

    // Rare cocky chuckles only while the keeper is calmly set and the ball is well upfield.
    const idleSafe=!o.deadBall&&o.mode==='set'&&o.ballZ>-.48;
    if(idleSafe&&this.cryFor<=0&&this.laughFor<=0) {
      this.idleIn-=h;
      if(this.idleIn<=0) {
        if(this.random()<.38)this.laughFor=.28+this.random()*.42;
        this.idleIn=7+this.random()*11;
      }
    }

    if(this.hopDelay>=0&&o.deadBall) {
      this.hopDelay-=h;
      if(this.hopDelay<=0&&o.grounded) {
        this.hopDelay=-1;this.hopWindow=0;
        return .23+this.random()*.05;
      }
    }
    return 0;
  }
}
