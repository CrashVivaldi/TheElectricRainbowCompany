"use strict";
/* ZODIAC DRIFT 0.16 — modular split, Phase 4a.
   Gravity fields (Neutron/Positron/Dock) and entities: ships, the
   disembark avatar, and the three passive test-rig entities. Entities
   carry continuous float position + velocity, are gravity-affected,
   collide with solid grid material.

   THREE DEPARTURES FROM THE PHASE 0 MODULE MAP, all the same shape —
   real code this module needs turned out to belong to a module that
   doesn't exist until a later phase, so each becomes a pluggable hook
   (same pattern as physics.js's onActionCommitted) instead of a forward
   import:

   1. onShipExitWorld / onShipLanded — the lattice-travel/founding
      functions (travelToNeighbor, applyGeneratedPreview,
      applyVisitedIslandData, checkUnfoundedFounding) were originally
      sketched into this module. Pulling the real code out, they're
      almost entirely server I/O and serialization — persistence.js
      (Phase 5) territory. stepEntities calls these two hooks at the
      exact points the original called the real functions inline.
      checkDockArrival stays a direct local call — it's genuinely light
      (isHome() + fields + homeSpawn, all pure state).
   2. myName() — a prompt()+localStorage identity lookup, also
      persistence.js's job. Defaults to "Anonymous" (the real file's own
      documented fallback) until persistence.js wires the real version in
      via setMyNameFn().
   3. stepStamp — stamps.js needs THIS module's E_GRAV/E_DRAG/applyFields,
      so this module can't import stepStamp back from stamps.js without a
      cycle. main.js wires it in via setStepStampFn() at startup. */
import { W, H, idx, inB, grid, camera, clampCamera, VIEW_W, VIEW_H,
         entities, setEntities, shipFlightState, setShipFlightState,
         shipDragging, px, py, homeSpawn, setHomeSpawn,
         fields, isHome,
         avatarMoveLevel, avatarJetpack,
         avatarJumpRequested, setAvatarJumpRequested,
         shipBlobs, setShipBlobs } from "./state.js";
import { EMPTY } from "./materials.js";
import { isSolidAt, shipBoxClear, SHIP_HITBOX_HALF, MIN_DEVICE_SPACING } from "./physics.js";

/* ================= gravity fields =================
   Neutron (attract) and Positron (repel): placed field emitters that tug
   or shove ENTITIES with a linear falloff. Dock also lives in this array
   despite emitting no force — same tap-to-place/delete/undo infra. */
export const DOCK_TRIGGER_R=6;   // cells — how close counts as "landed at the dock"
export const FIELD_RADIUS = 40;     // cells; falloff to zero here
export const FIELD_STRENGTH = 0.10; // peak accel scalar
export const FIELD_CORE = 8;        // inner deadzone radius: force stops climbing inside this
export const FIELD_SOLID_R = 3;     // Neutron only: a small SOLID core an entity lands ON
export const FIELD_R = 2;           // icon half-size — VISUAL size only
export const FIELD_HIT_R = 5;       // tap zone
export function tooCloseToField(x,y){
  for(const f of fields) if(Math.hypot(x-f.x, y-f.y) < MIN_DEVICE_SPACING) return true;
  return false;
}
export function stampField(cx,cy,kind){
  if(tooCloseToField(cx,cy)) return;
  fields.push({ x:cx, y:cy, kind, sign: kind==="neutron" ? +1 : kind==="positron" ? -1 : 0,
    active: kind==="tesla" ? false : undefined });
}
export function fieldAt(gx,gy){
  for(let i=fields.length-1;i>=0;i--){
    const f=fields[i];
    if(Math.abs(gx-f.x)<=FIELD_HIT_R && Math.abs(gy-f.y)<=FIELD_HIT_R) return i;
  }
  return -1;
}
export function checkDockArrival(ship){
  if(!ship) return;
  if(!isHome()) return;   // a dock on a visited island isn't yours to claim
  for(const f of fields){
    if(f.kind!=="dock") continue;
    if(Math.hypot(ship.x-f.x, ship.y-f.y) <= DOCK_TRIGGER_R){
      if(homeSpawn && homeSpawn.x===f.x && homeSpawn.y===f.y) return;
      if(confirm("Set this Dock as your spawn point?")) setHomeSpawn({x:f.x, y:f.y});
      return;
    }
  }
}
export function resolveFieldCores(e){
  for(const f of fields){
    if(f.kind!=="neutron") continue;
    const dx=e.x-f.x, dy=e.y-f.y;
    const d=Math.hypot(dx,dy);
    if(d < FIELD_SOLID_R && d>0.001){
      const nx=dx/d, ny=dy/d;
      e.x = f.x + nx*FIELD_SOLID_R;
      e.y = f.y + ny*FIELD_SOLID_R;
      const vin = e.vx*nx + e.vy*ny;
      if(vin<0){ e.vx -= vin*nx; e.vy -= vin*ny; }
    }
  }
}
export function applyFields(e){
  for(const f of fields){
    if(f.kind==="dock") continue;
    const dx=f.x-e.x, dy=f.y-e.y;
    const d=Math.hypot(dx,dy);
    if(d>FIELD_RADIUS || d<0.001) continue;
    let t = d/FIELD_RADIUS;
    const coreT = FIELD_CORE/FIELD_RADIUS;
    if(t < coreT) t = coreT;
    const u = 1 - t;
    const reach = u*u*(3 - 2*u);     // smoothstep(0,1,u)
    const a = FIELD_STRENGTH * reach * f.sign;
    e.vx += (dx/d)*a;
    e.vy += (dy/d)*a;
  }
}

/* ================= pluggable hooks (see file header) ================= */
let myNameFn = () => "Anonymous";
export function setMyNameFn(fn){ myNameFn = fn; }
function myName(){ return myNameFn(); }

let onShipExitWorld = () => {};
export function setOnShipExitWorld(fn){ onShipExitWorld = fn; }
let onShipLanded = () => {};
export function setOnShipLanded(fn){ onShipLanded = fn; }
let onFlightUIChanged = () => {};
export function setOnFlightUIChanged(fn){ onFlightUIChanged = fn; }
let stepStampFn = null;
export function setStepStampFn(fn){ stepStampFn = fn; }

/* ================= entities =================
   Continuous float position + velocity, gravity-affected, collide with
   solid grid material. `kind` distinguishes behavior/render, everything
   else is shared physics. */
export const E_GRAV=0.06;
export const E_DRAG=0.995;
const AVATAR_WANDER_FLIP_CHANCE=0.02;
/* ---- ship drag-to-guide (replaces angle+thrust piloting entirely).
   Damped spring instead of accel-toward-target-with-speedcap — the
   earlier version felt floaty (built speed, coasted, drifted past the
   finger). This snaps to the touch point instead: SHIP_SPRING_K is pull
   strength, SHIP_SPRING_DAMP is how hard that pull gets braked each
   tick. Damping ratio here (~0.65, computed from the two below) is
   deliberately under 1 — some overshoot at speed, correcting fast,
   rather than either a slow crawl-in (over damped) or a bouncy oscillation
   (under damped) — pick two: raise DAMP toward 2*sqrt(K) (~0.49 here) for
   a stiffer/less springy stop, lower it for more overshoot.
     SHIP_MAX_SPEED        hard cap regardless of spring force — "much
                            slower" per this session, was uncapped before
     SHIP_UNSTICK_SPEED    upward drift speed while working itself out of
                            solid material after being released inside it
   (still the "simple drift toward empty" version, not general buoyancy) */
const SHIP_SPRING_K=0.06;
const SHIP_SPRING_DAMP=0.32;
const SHIP_MAX_SPEED=0.9;
const SHIP_UNSTICK_SPEED=0.5;
/* ---- idle bob (render-only, see render.js) and cosmetic guide blobs.
   Kept together since they're both pure decoration with zero physics
   coupling — see the visualOnly note by shipBlobs' declaration in
   state.js for why these never touch grid[].
   The touch-drag target and the rainbow zone's position are DECOUPLED
   on purpose this round: SHIP_DRAG_TARGET_OFFSET_Y controls where the
   ship sits above your finger (far enough down that the thumb never
   covers the ship); BLOB_RAINBOW_ANCHOR_Y is separate and much smaller —
   the rainbow cloud sits tight under the ship's belly, well above the
   actual touch spot, per this session's call. Smoke spawns close beneath
   that (nearly inside the rainbow zone) and both rise (Phlogiston-style:
   light gas, fast spread) toward the CEILING — an invisible parabolic
   "crescent" fixed just under the ship that specks collide with and
   spread out along, which is what actually produces the pooling look
   instead of just approximating it by having smoke drift through the
   rainbow zone. See the ceiling collision in stepShipBlobs. */
export const SHIP_BOB_AMPLITUDE=0.35;   // cells
export const SHIP_BOB_SPEED=0.045;      // radians/tick
export const SHIP_DRAG_TARGET_OFFSET_Y=29;
const BLOB_RAINBOW_ANCHOR_Y=9;    // rainbow spawn center, right under the ship
const BLOB_RAINBOW_R=15;          // 30 cells wide
// Big background rainbow blob ("Honeymire" — a second, separate zone
// from the "Phlogiston" one above/below despite both being the same
// Aether hue-cycle color; Crash's own naming for the two layers). Same
// anchor point as Phlogiston, much wider, drawn BEHIND it — see the
// bg flag on the speck object and the two-pass draw in render.js.
const BLOB_HONEYMIRE_R=20;        // 40 cells wide
const BLOB_HONEYMIRE_SPAWN_PER_TICK=28;
const BLOB_HONEYMIRE_LIFE=56;             // half Phlogiston's decay rate
const BLOB_HONEYMIRE_FALL=0.045;          // positive = down. Was reusing BLOB_RAINBOW_RISE (up) by mistake — Honeymire is the liquid one, it should drip, not rise like the gas does
// Smoke is now two narrow side blobs, not one central cloud — sitting at
// the rainbow zone's own bottom edge (BLOB_RAINBOW_ANCHOR_Y+BLOB_RAINBOW_R),
// offset left/right of center with a real gap between them.
const BLOB_SMOKE_R=2.5;                 // was 1.5 (3 wide) — up 2 cells across, now 5 wide
const BLOB_SMOKE_OFFSET_Y=BLOB_RAINBOW_ANCHOR_Y+BLOB_RAINBOW_R-12;   // was level with the rainbow zone's bottom edge, now raised 12 cells
const BLOB_SMOKE_SIDE_OFFSET_X=6;       // each zone's center, left/right of ship.x — leaves a ~9-cell gap between their edges
// Rainbow and smoke spawn rates are separate specifically so rainbow can
// be throttled independently — see spawnShipBlobs: full rate while
// dragging, a quarter of that while idle (halved, then halved again per
// this round).
const BLOB_RAINBOW_SPAWN_PER_TICK=16;
const BLOB_SMOKE_SPAWN_PER_TICK=1;      // ~1/8 of its earlier rate, per side blob
const BLOB_RAINBOW_LIFE=28;   // decays faster now
const BLOB_SMOKE_LIFE=64;     // decays slower now
const BLOB_JITTER=0.03;       // small horizontal wobble only; vertical motion is rise, below, not random
const BLOB_RAINBOW_RISE=-0.04;  // Phlogiston-style: faster/more energetic than smoke's rise
const BLOB_SMOKE_RISE=-0.028;   // slower, reads as heavier/lazier than the rainbow gas
export const BLOB_SPECK_SIZE=1.3;    // cells — solid square, no arc/alpha softness, see render.js's drawShipBlobs
const BLOB_SMOKE_RGB=[14,18,40];   // dark navy, almost black
/* ---- crescent ceiling (the actual pooling mechanic).
   Parabolic underside fixed to the ship: ceilY(dx) = ship.y +
   CEILING_OFFSET_Y + CEILING_CURVE*dx^2, valid for |dx|<=CEILING_RADIUS
   (outside that, no ceiling — a speck that drifts past the ship's sides
   just keeps rising and dies naturally, same as before). CEILING_CURVE
   is picked so the ceiling has dropped CEILING_EDGE_DROP cells by the
   time dx hits CEILING_RADIUS — a shallow dome, not a spike. Specks that
   reach it get clamped to the surface, lose their upward velocity, and
   get a small outward nudge so they visibly spread along the underside
   instead of just stacking at the center. */
const CEILING_OFFSET_Y=5;      // how close to the ship the ceiling's center sits
const CEILING_RADIUS=24;       // was 17 — widened per this round
const CEILING_EDGE_DROP=11;    // cells the ceiling has sagged by at CEILING_RADIUS — same drop over a wider span reads as a shallower, flatter dome now
const CEILING_CURVE=CEILING_EDGE_DROP/(CEILING_RADIUS*CEILING_RADIUS);
const POOL_SPREAD=0.025;       // outward nudge applied each tick a speck is pressed against the ceiling
/* ---- on-foot avatar (platformer) tunables.
   The avatar used to be a passive wandering companion leashed to the ship
   (AVATAR_WANDER_ACCEL / AVATAR_LEASH_R, both gone) — it's now the
   player-controlled character. Movement is deliberately accel-based rather
   than a direct velocity write so it shares E_DRAG/E_GRAV with every other
   entity and inherits the same grid collision path (no special-casing in
   the movement/collision block below — a walking body and a falling rock
   resolve identically against isSolidAt). */
const AVATAR_MOVE_ACCEL=0.055;    // horizontal accel at full slider deflection
const AVATAR_MOVE_MAX=0.85;       // horizontal speed cap (cells/tick)
const AVATAR_GROUND_DRAG=0.72;    // extra horizontal damping when standing — stops the ice-skating feel E_DRAG alone gives
const AVATAR_JUMP_IMPULSE=0.95;   // one-shot upward velocity, tuned against E_GRAV=0.06 for roughly a 7-cell hop
const AVATAR_JETPACK_ACCEL=0.105; // continuous upward accel; must exceed E_GRAV to actually climb
const AVATAR_JETPACK_MAX_UP=1.25; // upward speed cap under jetpack
export const AVATAR_EMBARK_R=5;   // walk this close to the ship and you auto-board (see main.js's proximity check)
/* Standing check: one cell below the avatar's rounded position. Uses the
   same isSolidAt chokepoint as everything else, so skeleton buildings count
   as ground for free — same reasoning as the file header's note about
   collision routing through one function. */
export function avatarGrounded(e){
  return isSolidAt(Math.round(e.x), Math.round(e.y)+1);
}
const SHIP_HOVER_LEASH_R=4;

// LAND_SCAN_R/shipNearGroundBelow/shipSpawnPos live here (not ui.js,
// their original neighborhood) since stepEntities is the actual caller
// of the first, and both are pure grid logic ui.js AND persistence.js
// need to reach.
export const LAND_SCAN_R=20;
export let shipNearGround=false;
export function shipNearGroundBelow(ship){
  const cx=Math.round(ship.x);
  const y0=Math.round(ship.y)+1, y1=Math.min(H-1, y0+LAND_SCAN_R);
  for(let y=y0;y<=y1;y++){ if(isSolidAt(cx,y,true)) return true; }
  return false;
}
export function shipSpawnPos(){
  const cx=Math.round(W/2);
  for(let y=0;y<H;y++){
    if(isSolidAt(cx,y)) return {x:cx+0.5, y:Math.max(0, y-30)};
  }
  return {x:cx+0.5, y:H*0.3};
}

/* ================= ship guide blobs (cosmetic only) =================
   Two emitters riding every ship entity: a big "rainbow" cloud (rises
   fast, Phlogiston-style — light gas, quick spread) spawned tight under
   the ship's belly, and a dark "smoke" cloud spawned just beneath that,
   overlapping it. Both rise toward the crescent ceiling fixed just under
   the ship and pool/spread against it there — that's the actual look,
   see stepShipBlobs. Pure decoration — no grid reads or writes, no
   material identity, can't ever leak into the world the way a real
   particle or generator can. Rainbow color still borrows Aether's actual
   dynamic hue-cycle formula from render.js (the material that's really
   flagged `rainbow:true`). Two separate rainbow-colored zones now,
   Crash's own names for them: "Phlogiston" (the original, tighter one)
   and "Honeymire" (new this round — bigger, drawn behind it, off
   entirely when the ship isn't moving). The `bg` flag is what keeps
   Honeymire behind Phlogiston/smoke regardless of spawn order — see the
   two-pass draw in render.js. */
function spawnShipBlobSpeck(cx,cy,r,rgb,grav,shipRef,life,bg){
  const ang=Math.random()*Math.PI*2, rad=Math.random()*r;
  shipBlobs.push({
    x:cx+Math.cos(ang)*rad, y:cy+Math.sin(ang)*rad,
    vx:(Math.random()-0.5)*BLOB_JITTER, vy:(Math.random()-0.5)*BLOB_JITTER,
    life, maxLife:life, rgb, rainbow:!rgb, grav, shipRef, bg
  });
}
export function spawnShipBlobs(){
  for(const e of entities){
    if(e.kind!=="ship") continue;
    const mine = (e.ownerId===undefined || e.ownerId===myName());
    const dragging = mine && shipDragging;
    // Phlogiston: full rate while dragging, a QUARTER of that while idle
    // (halved, then halved again per this round — was a plain half).
    const rainbowRate = dragging ? BLOB_RAINBOW_SPAWN_PER_TICK : BLOB_RAINBOW_SPAWN_PER_TICK/4;
    for(let i=0;i<rainbowRate;i++){
      spawnShipBlobSpeck(e.x, e.y+BLOB_RAINBOW_ANCHOR_Y, BLOB_RAINBOW_R, null, BLOB_RAINBOW_RISE, e, BLOB_RAINBOW_LIFE, false);   // null rgb -> rainbow formula at render time
    }
    // Honeymire: same spot, much wider, drawn behind, falls instead of
    // rising (see BLOB_HONEYMIRE_FALL above). Was fully off when not
    // dragging — now a quarter rate instead of zero.
    const honeymireRate = dragging ? BLOB_HONEYMIRE_SPAWN_PER_TICK : BLOB_HONEYMIRE_SPAWN_PER_TICK/4;
    for(let i=0;i<honeymireRate;i++){
      spawnShipBlobSpeck(e.x, e.y+BLOB_RAINBOW_ANCHOR_Y, BLOB_HONEYMIRE_R, null, BLOB_HONEYMIRE_FALL, e, BLOB_HONEYMIRE_LIFE, true);
    }
    // Two narrow smoke blobs, left/right of center, level with the
    // rainbow zone's bottom edge — not one central cloud anymore.
    for(const side of [-1,1]){
      for(let i=0;i<BLOB_SMOKE_SPAWN_PER_TICK;i++){
        spawnShipBlobSpeck(e.x+side*BLOB_SMOKE_SIDE_OFFSET_X, e.y+BLOB_SMOKE_OFFSET_Y, BLOB_SMOKE_R, BLOB_SMOKE_RGB, BLOB_SMOKE_RISE, e, BLOB_SMOKE_LIFE, false);
      }
    }
  }
}
export function stepShipBlobs(){
  for(let i=shipBlobs.length-1;i>=0;i--){
    const b=shipBlobs[i];
    b.vy+=b.grav;
    b.x+=b.vx; b.y+=b.vy; b.life--;
    if(b.shipRef){
      const dx=b.x-b.shipRef.x;
      if(Math.abs(dx)<=CEILING_RADIUS){
        const ceilY=b.shipRef.y+CEILING_OFFSET_Y+CEILING_CURVE*dx*dx;
        if(b.y<=ceilY){
          b.y=ceilY;
          b.vy=0;
          b.vx+=Math.sign(dx||(Math.random()<0.5?-1:1))*POOL_SPREAD;
        }
      }
    }
    if(b.life<=0){ shipBlobs.splice(i,1); }
  }
}

export function spawnShip(x,y){
  const me=myName();
  setEntities(entities.filter(e=>!(e.kind==="ship" && (e.ownerId===undefined || e.ownerId===me))));
  entities.push({ kind:"ship", ownerId:me, x, y, vx:0, vy:0, angle:0, target:null, r:3.5, ignoreGravity:true, _inWorld:true });
}
export function spawnFallenStar(x,y){
  entities.push({ kind:"fallenstar", x, y, vx:0, vy:0, angle:0, target:null, r:3, ignoreGravity:false, ignoreFields:false });
}
export function spawnSatellite(x,y){
  entities.push({ kind:"satellite", x, y, vx:0, vy:0, angle:0, target:null, r:3, ignoreGravity:true, ignoreFields:false });
}
export function spawnAnchor(x,y){
  entities.push({ kind:"anchor", x, y, vx:0, vy:0, angle:0, target:null, r:3, ignoreGravity:false, ignoreFields:true });
}
export function spawnAvatar(x,y){
  setEntities(entities.filter(e=>e.kind!=="avatar"));
  // ignoreGravity:false — the avatar is a body now, it falls. ignoreFields
  // stays true: getting yanked around by placed Neutron/Positron emitters
  // while trying to walk would fight the player for control of their own
  // character, which is a different (and deliberate) design choice from the
  // ship, which IS field-affected.
  entities.push({ kind:"avatar", x, y, vx:0, vy:0, angle:0, target:null, r:2, ignoreGravity:false, ignoreFields:true, _facing:1 });
}
export function activeShip(){
  const me=myName();
  return entities.find(e=>e.kind==="ship" && (e.ownerId===undefined || e.ownerId===me)) || null;
}

export const WARP_RADIUS=128;
export function attemptWarp(){
  const ship=activeShip();
  if(!ship) return;
  const cx=Math.round(ship.x), cy=Math.round(ship.y), r=WARP_RADIUS, r2=r*r;
  const x0=Math.max(0,cx-r), x1=Math.min(W-1,cx+r);
  const y0=Math.max(0,cy-r), y1=Math.min(H-1,cy+r);
  const candidates=[];
  for(let y=y0;y<=y1;y++){
    const dy=y-cy;
    for(let x=x0;x<=x1;x++){
      const dx=x-cx;
      if(dx*dx+dy*dy>r2) continue;
      if(grid[idx(x,y)]===EMPTY){ candidates.push(x,y); }
    }
  }
  if(!candidates.length) return;
  const pick=(Math.random()*(candidates.length/2)|0)*2;
  ship.x=candidates[pick]+0.5; ship.y=candidates[pick+1]+0.5;
  ship.vx=0; ship.vy=0; ship.target=null;
  if(shipFlightState==="pilot"){
    camera.x=ship.x-VIEW_W*camera.scale/2;
    camera.y=ship.y-VIEW_H*camera.scale/2;
    clampCamera();
  }
}

export function stepEntities(){
  if(shipFlightState==="pilot"){
    const ship=activeShip();
    const wasNearGround=shipNearGround;
    shipNearGround = ship ? shipNearGroundBelow(ship) : false;
    if(shipNearGround!==wasNearGround) onFlightUIChanged();
  }
  for(const e of entities){
    if(e.kind==="stamp"){ if(stepStampFn) stepStampFn(e); continue; }
    const mine = e.kind==="ship" && (e.ownerId===undefined || e.ownerId===myName());
    // Drag-to-guide steering + embedded-release recovery. bypassCollision
    // covers both: dragging explicitly disables collision per the brief
    // ("finger actively guiding it" can pass through solid terrain);
    // unstick recovery also needs it, or a ship dragged deep into solid
    // could never resolve its way back out again.
    let bypassCollision=false;
    if(mine && shipFlightState==="pilot"){
      if(shipDragging){
        e._settleFired=false;
        // Target is offset above the touch point by
        // SHIP_DRAG_TARGET_OFFSET_Y — no longer tied to where the
        // rainbow blob renders (that's its own, much smaller offset now,
        // see the blob constants above) — this one's just "keep the
        // ship clear of the thumb."
        const dx=e.x-px, dy=e.y-(py-SHIP_DRAG_TARGET_OFFSET_Y);
        e.vx += -dx*SHIP_SPRING_K - e.vx*SHIP_SPRING_DAMP;
        e.vy += -dy*SHIP_SPRING_K - e.vy*SHIP_SPRING_DAMP;
        const sp=Math.hypot(e.vx,e.vy);
        if(sp>SHIP_MAX_SPEED){ e.vx*=SHIP_MAX_SPEED/sp; e.vy*=SHIP_MAX_SPEED/sp; }
        bypassCollision=true;
      } else if(!shipBoxClear(e.x, e.y, SHIP_HITBOX_HALF)){
        // Released inside solid material — simple drift-to-open-cell
        // version confirmed this session (not full buoyancy yet).
        e.vx=0; e.vy=-SHIP_UNSTICK_SPEED;
        bypassCollision=true;
      } else {
        // Released (or just idle) in the clear: snap to an immediate
        // halt rather than coasting off on E_DRAG's slow decay. This is
        // also what makes a settled ship stay immobile tick after tick —
        // it re-zeroes every frame until dragging resumes — and combined
        // with normal per-axis collision below (which already stops the
        // ship dead at a solid boundary rather than letting it overlap),
        // that's "lands on a surface -> snaps there and stays put" too,
        // without touching the collision-bypass that active dragging
        // still gets (that bypass was deliberate, for free navigation
        // mid-drag — flagging in case you actually want contact to
        // interrupt an active drag too, which is a bigger change).
        e.vx=0; e.vy=0;
      }
    }
    if(e.kind==="avatar"){
      const grounded = avatarGrounded(e);
      // Horizontal: analog slider deflection -> accel, speed-capped.
      if(avatarMoveLevel!==0){
        e.vx += avatarMoveLevel*AVATAR_MOVE_ACCEL;
        if(e.vx >  AVATAR_MOVE_MAX) e.vx =  AVATAR_MOVE_MAX;
        if(e.vx < -AVATAR_MOVE_MAX) e.vx = -AVATAR_MOVE_MAX;
        e._facing = avatarMoveLevel<0 ? -1 : 1;
      } else if(grounded){
        e.vx *= AVATAR_GROUND_DRAG;   // no input + on the ground = come to a stop, not a long slide
      }
      // Jump: one-shot latch, consumed here so it can only ever fire once
      // per press regardless of how many ticks the button stays held.
      if(avatarJumpRequested){
        setAvatarJumpRequested(false);
        if(grounded) e.vy = -AVATAR_JUMP_IMPULSE;
      }
      // Jetpack: continuous, works mid-air (that's the point) — capped so
      // holding it doesn't accelerate into orbit.
      if(avatarJetpack){
        e.vy -= AVATAR_JETPACK_ACCEL;
        if(e.vy < -AVATAR_JETPACK_MAX_UP) e.vy = -AVATAR_JETPACK_MAX_UP;
      }
    }
    // Ships stay ignoreGravity:true always now — no more landing-state
    // special case forcing gravity on. Idle "holds position and bobs" is
    // a render-only effect (see render.js); nothing here needs to fake it.
    if(!e.ignoreGravity) e.vy+=E_GRAV;
    const shipFieldsOff = mine && shipFlightState==="hover";
    if(!e.ignoreFields && !shipFieldsOff) applyFields(e);
    e.vx*=E_DRAG; e.vy*=E_DRAG;
    const shipEdgeOpen = e.kind==="ship";
    let nx=e.x+e.vx, ny=e.y+e.vy;
    if(e.kind==="ship"){
      if(bypassCollision || shipBoxClear(nx, ny, SHIP_HITBOX_HALF)){
        e.x=nx; e.y=ny;
      } else {
        const xClear=shipBoxClear(nx, e.y, SHIP_HITBOX_HALF);
        const yClear=shipBoxClear(e.x, ny, SHIP_HITBOX_HALF);
        if(xClear) e.x=nx; else e.vx=0;
        if(yClear) e.y=ny; else e.vy=0;
      }
    } else {
      if(isSolidAt(Math.round(nx), Math.round(e.y), shipEdgeOpen)){ e.vx=0; nx=e.x; }
      if(isSolidAt(Math.round(e.x), Math.round(ny), shipEdgeOpen)){ e.vy=0; ny=e.y; }
      e.x=nx; e.y=ny;
    }
    resolveFieldCores(e);
    if(mine){
      const nowIn = inB(Math.round(e.x), Math.round(e.y));
      if(e._inWorld && !nowIn){
        const overX = e.x<0 ? -e.x : (e.x>=W ? e.x-(W-1) : 0);
        const overY = e.y<0 ? -e.y : (e.y>=H ? e.y-(H-1) : 0);
        const dir = (overX>=overY) ? (e.x<0?"west":"east") : (e.y<0?"north":"south");
        onShipExitWorld(dir, e);
      }
      e._inWorld = nowIn;
    }
    // Founding-check relocation: used to fire once when the old landing
    // auto-transition completed (near ground + vy settled). That state's
    // gone, so this fires once per release, the first tick the ship is
    // both clear of solid and near a surface below it — same intent
    // ("you set down near ground"), no visible sequence needed to get
    // there anymore. checkDockArrival's own hover-entry call (main.js) is
    // untouched; this only covers what onShipLanded used to gate.
    if(mine && shipFlightState==="pilot" && !shipDragging && !e._settleFired
       && shipBoxClear(e.x, e.y, SHIP_HITBOX_HALF) && shipNearGroundBelow(e)){
      e._settleFired=true;
      onShipLanded(e);
    }
    // (The avatar's old ship leash lived here — it snapped the wandering
    // companion back whenever it drifted past AVATAR_LEASH_R. Removed with
    // the wander behavior: a player-controlled character that gets yanked
    // backward for walking too far is not a character you control. Getting
    // back to the ship is now proximity auto-embark instead, see main.js.)
    if(mine && shipFlightState==="hover" && e._hoverAnchor){
      const ax=e._hoverAnchor.x, ay=e._hoverAnchor.y;
      const dx=e.x-ax, dy=e.y-ay, dist=Math.hypot(dx,dy);
      if(dist>SHIP_HOVER_LEASH_R && dist>0.0001){
        const ux=dx/dist, uy=dy/dist;
        e.x=ax+ux*SHIP_HOVER_LEASH_R; e.y=ay+uy*SHIP_HOVER_LEASH_R;
        const vOut=e.vx*ux+e.vy*uy;
        if(vOut>0){ e.vx-=vOut*ux; e.vy-=vOut*uy; }
      }
    }
    if(e.kind!=="ship"){
      e.x=Math.max(0,Math.min(W-1,e.x));
      e.y=Math.max(0,Math.min(H-1,e.y));
    }
  }
  if(entities.some(e=>e.dead)) setEntities(entities.filter(e=>!e.dead));
}
