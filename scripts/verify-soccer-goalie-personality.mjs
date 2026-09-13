import assert from 'node:assert/strict';
import { GoaliePersonality } from '../src/worlds/soccer/goalie-personality.ts';

const always=()=>0;
const saved=new GoaliePersonality(always);
saved.notifySave(.8);
assert(saved.laughing,'a strong save can trigger a keeper laugh');
assert.equal(saved.step(.1,{mode:'set',ballZ:0,deadBall:false,grounded:true}),0,'queued personality hops never execute during live play');
const saveHop=saved.step(.1,{mode:'set',ballZ:0,deadBall:true,grounded:true});
assert(saveHop>=.23&&saveHop<=.28,'a queued save reaction may become a small hop once play is dead');

const conceded=new GoaliePersonality(always);
conceded.notifyGoal();
assert(conceded.crying,'conceding a goal triggers the keeper cry reaction');
assert.equal(conceded.step(.1,{mode:'set',ballZ:-1.4,deadBall:false,grounded:true}),0,'goal reaction hop remains suppressed until the scored ball is dead');
const frustrationHop=conceded.step(.2,{mode:'set',ballZ:-1.4,deadBall:true,grounded:true});
assert(frustrationHop>=.23&&frustrationHop<=.28,'conceding can add one small dead-ball frustration hop');

console.log('Goalie save laughter, conceded-goal crying, and dead-ball-only personality hops passed.');
