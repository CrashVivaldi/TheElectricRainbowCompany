"use strict";
/* ZODIAC DRIFT 0.16 — modular split, Phase 3 (the sticky one).
   Owns: chunk-wake bookkeeping, the undo/redo action log, the falling-
   sand simulation itself, powder decompression, generic solidity/
   collision queries (isSolidAt, shipBoxClear — placed here per the
   original physics author's call: both are physics-grid queries, not
   entity bookkeeping, even though shipBoxClear is ship-specific), placed
   devices (springs/vents), and their particle/emission physics.

   TWO DELIBERATE DEPARTURES FROM THE PHASE 0 MODULE MAP, found while
   actually extracting this code — both explained inline where they bite:

   1. Undo/redo lives HERE, not as a separate module. It wasn't its own
      bucket in the original map at all. It needs wake()/clearSettling()
      (this module) on every restore, and this module's own device
      functions (stampGenerator/rotateDevice/deleteDevice) need undo's
      beginAction/recordCell/commitAction. Splitting them into two files
      would create a two-file import cycle for no real benefit — they're
      already inseparable in practice (this is exactly the "wake() is
      called from everywhere" coupling flagged in the Phase 0 map).
      updateUndoRedoUI() itself (DOM) does NOT live here — see
      onActionCommitted below.

   2. isSolidAt moved here from its originally-planned home in
      entities.js. shipBoxClear (confirmed physics by its author) calls
      isSolidAt directly — keeping isSolidAt in entities.js would make
      physics.js depend on entities.js for shipBoxClear, while
      entities.js depends on physics.js for wake()/shipBoxClear itself —
      a real cross-module cycle. isSolidAt is pure grid-solidity math
      with zero entity-specific fields, so it's a clean, honest fit here
      instead. applyFields/resolveFieldCores stay in entities.js as
      already agreed — they don't have this coupling. */
import { W, H, CHUNK_SIZE, CHUNKS_X, CHUNKS_Y, idx, inB, grid, settleCounter,
         chunkAwake, chunkIdle, chunkTouched, chunkIndexAt, SLEEP_AFTER_IDLE,
         decompressQueue, isSettling, settlingByChunk,
         generators, setGenerators, fields, setFields, particles,
         role, identity, flow, jet,
         POWDER_COMPACT_CHANCE, SAND_SETTLE_TICKS,
         SAND_SLIDE_REACH, SAND_SLIDE_CHANCE, AETHER_MOVE_INTENSITY,
         GAS_UP_CHANCE, GAS_DIAG_CHANCE, GAS_DRIFT_CHANCE, LIQUID_COHESION_DEFAULT,
         P_GRAV, P_DRAG, P_SUBMERGE_DRAG, P_SUBMERGE_KICK,
         JET_SPEED_MIN, JET_SPEED_MAX, GEN_BFS_CAP,
         GEN_FIRE_BASE, GEN_FIRE_FLOW_MULT,
         PUSH_BURST_BASE, PUSH_BURST_FLOW_MULT,
         temp, DIFFUSION_RATE, SPAWN_TEMP_DEFAULT, TEMPERATURE_ENABLED,
         skySources, SKY_HEAT_RATE, AMBIENT_PULL_RATE, CHILL_PULL, TESLA_RADIUS,
         RADIANT_CHILL_RADIUS, RADIANT_CHILL_RATE,
         subchunkDirty, subchunkIndexAt, skeletonMask, onWorldExit, onDecayToEmpty } from "./state.js";
import { MATBY, EMPTY, FIRE, SOLID_TWIN, TWIN_OF_POWDER, canSink,
         reactTo, reactChanceOf } from "./materials.js";

/* ================= chunk-wake primitives =================
   Called from every subsystem that writes to `grid` — painting, stamps,
   device placement, undo/redo restoration, particles, and the
   simulation itself. See the Phase 0 module map's "headline finding":
   this is the one primitive whose coverage matters most and is hardest
   to verify by reading, since a missed call site doesn't error, it just
   leaves a chunk silently asleep. */
export function markSettling(i){
  if(isSettling[i]) return;
  isSettling[i]=1;
  settlingByChunk[chunkIndexAt(i%W, (i/W)|0)]++;
}
export function clearSettling(i){
  if(!isSettling[i]) return;
  isSettling[i]=0;
  settlingByChunk[chunkIndexAt(i%W, (i/W)|0)]--;
}
export function wake(x,y){
  if(!inB(x,y)) return;
  const ci = chunkIndexAt(x,y);
  chunkAwake[ci]=1;
  chunkTouched[ci]=1;
  // THE FIX. render.js's own comment on subchunkDirty already claimed
  // this line existed ("flipped by physics.js's wake() — see that
  // file") — it didn't. wake() is the one real chokepoint every grid
  // mutation in this file actually goes through (verified: every direct
  // grid[...]= assignment in physics.js sits next to a wake() call,
  // including trySwap's swap case two lines below its own wake(x,y);
  // wake(nx,ny);). Without this, subchunkDirty only ever got set at
  // the three bulk-write fallbacks (persistence load, terrain origin
  // paint, Sandbox wipe) and setSubchunkSize — meaning ordinary
  // simulation events (fire spreading, sand settling, a melt/freeze
  // conversion, a reaction) never marked their subchunk dirty at all.
  // The render cache would paint once after a load/wipe and then go
  // stale for anything except animated tiles (tracked separately via
  // subchunkAnimated, which is why fire's flicker kept looking "alive"
  // and made this easy to miss). One cell change can straddle a
  // subchunk boundary in visual effect (a neighbor read at the edge),
  // but never needs a SECOND subchunk marked — subchunks are painted
  // from the live grid each time, not diffed cell-by-cell, so marking
  // only the mutated cell's own subchunk is sufficient.
  subchunkDirty[subchunkIndexAt(x,y)]=1;
  // CHUNK-BOUNDARY WAKE. chunkAwake gates whether ANY physics pass even
  // visits a chunk's cells — nine separate passes check it (movement,
  // decay/onContact/emits, radiant heat, diffusion, generators,
  // particles, fields...). A cell in a sleeping chunk is never looked at,
  // no matter how reactable its neighbor one cell away is. Without this,
  // a signal correctly propagates within one chunk and then silently
  // stalls dead at the boundary into a chunk that happens to be asleep —
  // this is the "wires don't cross chunk boundaries" bug. Waking the
  // adjacent chunk whenever the changed cell sits on its own chunk's edge
  // closes the orthogonal-neighbor case (onContact only ever reads 1 cell
  // out, via neighbors4), which covers wire propagation, fire spread,
  // and every other onContact-driven reaction. NOTE: this does NOT cover
  // longer-reach effects like applyRadiantChill's 4-cell radius — a chill
  // source within radius 4 of a boundary but not sitting on the exact
  // edge cell can still fail to chill a sleeping neighbor chunk. Separate,
  // smaller issue, not fixed here. (This used to apply to radiant heat
  // too — that mechanism was removed entirely, see applyRadiantChill's
  // own comment for why.)
  const cx = x % CHUNK_SIZE, cy = y % CHUNK_SIZE;
  if(cx===0)              wakeChunkAt(x-1, y);
  if(cx===CHUNK_SIZE-1)   wakeChunkAt(x+1, y);
  if(cy===0)              wakeChunkAt(x, y-1);
  if(cy===CHUNK_SIZE-1)   wakeChunkAt(x, y+1);
  for(const [nx,ny] of [[x,y-1],[x-1,y],[x+1,y]]){
    if(!inB(nx,ny)) continue;
    if(TWIN_OF_POWDER[grid[idx(nx,ny)]]!==undefined) decompressQueue.add(idx(nx,ny));
  }
}
function wakeChunkAt(x,y){
  if(!inB(x,y)) return;
  const ci=chunkIndexAt(x,y);
  chunkAwake[ci]=1;
  chunkTouched[ci]=1;
}

/* ================= undo / redo =================
   Action-level, not per-pixel. Scope is deliberately the discrete things
   a player does on purpose: paint strokes, device place/rotate/delete,
   field place/delete, Reseed, Clear. Does NOT undo anything the live
   simulation does on its own — sand falling, particles landing,
   generators emitting aren't "actions."

   onActionCommitted is a pluggable hook, not a direct call to
   updateUndoRedoUI() — this module must stay DOM-free. ui.js calls
   setOnActionCommitted(updateUndoRedoUI) once at startup; every place
   the original monolith called updateUndoRedoUI() inline (end of
   commitAction/undo/redo), this calls the hook instead, at the exact
   same point in the logic. */
let onActionCommitted = () => {};
export function setOnActionCommitted(fn){ onActionCommitted = fn; }
// persistence.js clears undoStack/redoStack directly (a fresh load starts
// with clean undo history) but can't reach the private onActionCommitted
// binding to refresh the UI afterward — this is that one escape hatch.
export function notifyActionCommitted(){ onActionCommitted(); }

export const UNDO_MAX = 20;
export let undoStack = [];
export let redoStack = [];
let pendingAction = null;   // the action currently being built, or null

// stamps.js's dissolveStamp needs to know whether it's landing mid-stroke
// (an action already open elsewhere) or needs to wrap itself in its own —
// pendingAction itself stays private, this is just the boolean check.
export function hasPendingAction(){ return pendingAction !== null; }
export function beginAction(kind){
  pendingAction = { kind, cellsBefore:new Map(), cellsAfter:null,
    gensBefore:null, gensAfter:null, fieldsBefore:null, fieldsAfter:null,
    gridBefore:null, gridAfter:null };
}
// call BEFORE writing grid[i] during an undoable action — records the
// pre-action value once per cell, no matter how many times that cell
// gets touched again later in the same action.
export function recordCell(i){
  if(pendingAction && !pendingAction.cellsBefore.has(i)) pendingAction.cellsBefore.set(i, grid[i]);
}
export function snapshotDevicesBefore(){ if(pendingAction) pendingAction.gensBefore = generators.map(g=>({...g})); }
export function snapshotFieldsBefore(){ if(pendingAction) pendingAction.fieldsBefore = fields.map(f=>({...f})); }
export function beginFullGridAction(kind){
  beginAction(kind);
  pendingAction.gridBefore = grid.slice();       // full copy — Reseed/Clear only
  pendingAction.gensBefore = generators.map(g=>({...g}));
}
export function commitAction(){
  if(!pendingAction) return;
  const a = pendingAction; pendingAction=null;
  if(a.gridBefore){
    a.gridAfter = grid.slice();
    a.gensAfter = generators.map(g=>({...g}));
  } else {
    a.cellsAfter = new Map();
    for(const i of a.cellsBefore.keys()) a.cellsAfter.set(i, grid[i]);
    if(a.gensBefore) a.gensAfter = generators.map(g=>({...g}));
    if(a.fieldsBefore) a.fieldsAfter = fields.map(f=>({...f}));
    // A snapshot existing isn't proof anything changed — compare content,
    // not just presence, or every rejected tap pollutes the undo stack.
    const gensChanged = a.gensBefore && JSON.stringify(a.gensBefore)!==JSON.stringify(a.gensAfter);
    const fieldsChanged = a.fieldsBefore && JSON.stringify(a.fieldsBefore)!==JSON.stringify(a.fieldsAfter);
    if(a.cellsBefore.size===0 && !gensChanged && !fieldsChanged) return;
  }
  undoStack.push(a);
  if(undoStack.length>UNDO_MAX) undoStack.shift();
  redoStack.length=0;   // any new action invalidates redo history
  onActionCommitted();
}
export function applyAction(a, dir){   // dir: 'undo' | 'redo'
  if(a.gridBefore){
    grid.set(dir==='undo' ? a.gridBefore : a.gridAfter);
    chunkAwake.fill(1); chunkIdle.fill(0);
    isSettling.fill(0); settlingByChunk.fill(0);
  } else {
    const m = dir==='undo' ? a.cellsBefore : a.cellsAfter;
    for(const [i,v] of m){ grid[i]=v; clearSettling(i); wake(i%W, Math.floor(i/W)); }
  }
  if(a.gensBefore) setGenerators((dir==='undo'? a.gensBefore : a.gensAfter).map(g=>({...g})));
  if(a.fieldsBefore) setFields((dir==='undo'? a.fieldsBefore : a.fieldsAfter).map(f=>({...f})));
}
export function undo(){
  if(role==="guest") return;   // look, don't touch
  if(!undoStack.length) return;
  const a=undoStack.pop();
  applyAction(a,'undo');
  redoStack.push(a);
  if(redoStack.length>UNDO_MAX) redoStack.shift();
  onActionCommitted();
}
export function redo(){
  if(role==="guest") return;
  if(!redoStack.length) return;
  const a=redoStack.pop();
  applyAction(a,'redo');
  undoStack.push(a);
  onActionCommitted();
}

/* ================= collision / solidity queries ================= */
export function isSolidAt(x,y,edgeOpen){
  // edgeOpen (default false): when true, an out-of-bounds coordinate is
  // NOT solid — open space beyond the world edge, not a wall. Only the
  // ship passes edgeOpen=true.
  if(!inB(x,y)) return !edgeOpen;
  // Skeleton structures block movement exactly like a solid material,
  // checked BEFORE grid[] since a skeleton cell's underlying grid cell
  // is always EMPTY (skeleton lives outside grid[] entirely) — this is
  // the one chokepoint every entity's collision already runs through
  // (shipBoxClear, entities.js's own on-foot movement), so nothing
  // downstream needs its own separate skeleton check.
  if(skeletonMask[idx(x,y)]) return true;
  const m=grid[idx(x,y)];
  return MATBY[m].behavior==="solid" || MATBY[m].behavior==="generator";
}
export const SHIP_HITBOX_HALF=1;   // cells — half-width; checks a 3x3 footprint
export function shipBoxClear(cx, cy, half){
  const x0=Math.round(cx-half), x1=Math.round(cx+half);
  const y0=Math.round(cy-half), y1=Math.round(cy+half);
  for(let yy=y0; yy<=y1; yy++){
    for(let xx=x0; xx<=x1; xx++){
      if(isSolidAt(xx, yy, true)) return false;   // edgeOpen always true here — only ships use this check
    }
  }
  return true;
}

/* ================= simulation ================= */
export let frame=0;
// ELECTRIC VIVID RAINBOW FORK — domino-relay fix, diagnosed 2026-08-02.
// A whole stack of denser material sitting directly on a liquid could
// punch straight through to the surface in ONE tick: each row's own
// single, legitimate canSink swap left newly-arrived liquid directly
// below the row above it, which then had its own equally-legitimate
// turn to sink into THAT — a relay completing within one bottom-to-top
// pass, proportional to stack height, not a bug in any single cell's
// movement. Scoped narrowly to vertical canSink swaps specifically (see
// trySwap below) so normal falling-into-empty-space and the horizontal
// pressure-slide mechanic are both untouched.
let sinkTouched = new Uint8Array(W*H);
export function trySwap(x,y,nx,ny){
  if((ny>=H || ny<0) && nx>=0 && nx<W){ grid[idx(x,y)]=EMPTY; settleCounter[idx(x,y)]=0; clearSettling(idx(x,y)); wake(x,y); if(onWorldExit) onWorldExit(x,y); return true; } // left the world top or bottom — gone. onWorldExit is an optional site hook (state.js) — real game code leaves it null, costs one branch when unset
  if(!inB(nx,ny)) return false;
  const a=grid[idx(x,y)], b=grid[idx(nx,ny)];
  const sinking = b!==EMPTY && canSink(a,b);
  if(sinking && ny!==y && (sinkTouched[idx(x,y)] || sinkTouched[idx(nx,ny)])) return false;
  if(b===EMPTY || sinking){
    grid[idx(nx,ny)]=a; grid[idx(x,y)]=b;
    // heat travels WITH the material, not just between fixed positions —
    // without this, a falling hot cell would leave its temperature
    // behind at the old cell while the material itself moved away,
    // marking where something used to be instead of where it now is.
    // diffuseTemp (below) is what actually spreads heat outward; this
    // is the other half, advection, and it has to live here rather than
    // in the diffusion pass since it's tied to material movement, not
    // adjacency.
    const t=temp[idx(x,y)]; temp[idx(x,y)]=temp[idx(nx,ny)]; temp[idx(nx,ny)]=t;
    settleCounter[idx(x,y)]=0; settleCounter[idx(nx,ny)]=0;
    clearSettling(idx(x,y)); clearSettling(idx(nx,ny));
    if(sinking && ny!==y){ sinkTouched[idx(x,y)]=1; sinkTouched[idx(nx,ny)]=1; }
    wake(x,y); wake(nx,ny); return true;
  }
  return false;
}
function slideDownhill(x,y){
  for(const dir of (Math.random()<0.5?[1,-1]:[-1,1])){
    for(let s=1; s<=SAND_SLIDE_REACH; s++){
      const nx=x+s*dir;
      if(!inB(nx,y) || !inB(nx,y+1)) break;
      if(grid[idx(nx,y)]!==EMPTY) break;       // path blocked — stop searching this direction
      if(grid[idx(nx,y+1)]===EMPTY) return trySwap(x,y,nx,y);   // found a real step down
    }
  }
  return false;
}
// Shared by decompression's hasLateralSupport AND creep's surface-hugging
// check below — pure predicate, no state, safe to use from both places.
const isBehaviorSolid = b => b==="solid" || b==="generator";
// ---- the rule for spawnTemp: material genuinely NEW to a cell (paint,
// a device placing its icon, a particle landing, passive emission, grow
// duplicating) gets that material's own spawnTemp. Material that's just
// CONVERTING in place (decay, onContact reactions, powder compaction/
// decompression) keeps whatever temp[i] already holds — it's the same
// physical substance changing state, not new mass appearing, so Magma
// quenching to Stone stays hot instead of resetting to ambient. This
// helper is only ever called at introduction sites, never conversion
// ones — see each call site's own comment for which category it is.
/* ---- heat capacity. THE missing piece that made temperature-driven
   materials inert: every cell previously changed temperature at exactly
   the same rate, so a magma pool cooled as fast as a single snowflake and
   dumped its heat to ambient long before it could boil the water sitting
   on it (measured: water at a lava interface peaked at 33 against a boil
   threshold that had to be well above ambient to be safe — no steam, ever).
   Real thermal mass is what makes a heat SOURCE a source rather than a
   brief flash, and nothing here modelled it.
     One optional field, default 1, dividing every temperature change a
   cell undergoes — conduction AND the ambient thermostat both. It is
   deliberately NOT applied to heatOutput/chillOutput (those are floors and
   pulls a material asserts about itself, not heat arriving from outside)
   nor to radiant injection (which has its own, much larger, calibration
   problem — see materials.js's calibration note).
     Note the asymmetry this creates and why it's correct: a high-capacity
   cell resists change but still DRIVES its neighbours at full strength,
   because the neighbour's own capacity governs how fast it accepts heat.
   That's exactly the behaviour a lava pool should have. */
function capOf(matId){
  const c = MATBY[matId].heatCapacity;
  return c!==undefined && c>0 ? c : 1;
}
function spawnTempFor(matId){
  const m=MATBY[matId];
  return m.spawnTemp!==undefined ? m.spawnTemp : SPAWN_TEMP_DEFAULT;
}

/* ---- reactions: "one material converts another" (Crash's call — the
   OTHER material is never touched, only the reacting cell itself). A
   flat pairwise table on the material: onContact:{ [otherMatId]: resultMatId }.
   Checked before movement so a cell that reacts this tick doesn't also
   try to move as its old self in the same tick. reactChance defaults to
   1 (instant on contact) if unset — materials should set their own to
   taste; the sandbox is exactly the place to find a number that doesn't
   look like a jarring instant pop across a whole boundary. */
function reactAt(x,y,M){
  for(const [nx,ny] of neighbors4(x,y)){
    if(!inB(nx,ny)) continue;
    const rule=M.onContact[grid[idx(nx,ny)]];
    if(rule===undefined) continue;
    // SETTLED-GATE. rule.settled===true means this reaction only rolls
    // once the reacting cell has actually come to rest — settleCounter is
    // zeroed every tick a cell moves (see trySwap/growInto/etc.), so a
    // still-falling cell can never pass this check. Added for Bloomspore's
    // germination rules (materials.js) so a spore can't sprout mid-air by
    // being briefly adjacent to fertile ground while passing it. Ordinary
    // instant reactions (fire spread, etc.) don't set this and are
    // unaffected — falling fuel should still catch fire immediately.
    if(rule.settled && settleCounter[idx(x,y)] < SAND_SETTLE_TICKS) continue;
    // PER-REACTION RATES. An onContact entry is EITHER a bare result id
    // (the original form — uses the material's own reactChance, so every
    // pre-existing rule behaves exactly as before) OR a {to, chance}
    // object that overrides the rate for that one pairing. This is the
    // fix for the limitation the previous handoff flagged and left open:
    // Oil's Magma->Smoke and Fire->Fire were forced to share one rate
    // because reactAt only ever read M.reactChance. Wood should catch
    // slowly off an ember and instantly off magma; that was impossible
    // to express until now. reactTo/reactChanceOf (materials.js) are the
    // one place that normalizes the two forms — the sandbox's rule editor
    // reads through the same helpers, so neither has to know the shape.
    const result=reactTo(rule);
    if(Math.random() >= reactChanceOf(M, rule)) continue;
    grid[idx(x,y)]=result;
    settleCounter[idx(x,y)]=0; clearSettling(idx(x,y));
    wake(x,y);
    return true;
  }
  return false;
}
/* ---- passive emission: emits:{matId, chance}. Independent of movement —
   a cell can emit AND still run its own behavior the same tick (a
   smoldering ember drifting while it puffs smoke). Picks one random
   EMPTY orthogonal neighbor; no candidates this tick just means no
   emission this tick, not a queued/deferred one. */
function emitFrom(x,y,M){
  const opts=[];
  for(const [nx,ny] of neighbors4(x,y)) if(inB(nx,ny) && grid[idx(nx,ny)]===EMPTY) opts.push(nx,ny);
  if(!opts.length) return;
  const pick=(Math.random()*(opts.length/2)|0)*2;
  const ex=opts[pick], ey=opts[pick+1];
  grid[idx(ex,ey)]=M.emits.matId;
  temp[idx(ex,ey)]=spawnTempFor(M.emits.matId);   // introduction: fresh material appearing from nothing
  wake(ex,ey);
}
/* ---- grow: DUPLICATES, doesn't relocate — the source cell stays put,
   forever, same as a real vine doesn't un-grow its base when it extends.
   That's deliberate and different from every other behavior here, which
   all move mass around via trySwap. Straight up first; blocked by
   anything that isn't itself, deflect sideways (left before right,
   fixed order, no per-cell memory needed); boxed in on all three,
   stalls until something nearby changes. No cap on how far it can grow
   besides world bounds and growChance's pace — flagging that here since
   it's the one open question if unbounded growth ever becomes a
   problem: decayTo composes on top of a grow material for free if a
   natural die-back/cap is ever wanted later. */
function growInto(x,y,nx,ny){
  const self=grid[idx(x,y)];
  grid[idx(nx,ny)]=self;
  temp[idx(nx,ny)]=spawnTempFor(self);   // introduction: new mass, even though same material as its parent — doesn't inherit the parent cell's exact current temp
  settleCounter[idx(nx,ny)]=0; clearSettling(idx(nx,ny));
  wake(nx,ny); wake(x,y);
}
/* ---- creep: hugs solid surfaces instead of falling freely — the one
   behavior here that's genuinely new shape, not a variation on
   trySwap's existing fall/slide pattern. climbBias (-1..+1, default 0)
   weights the random pick among still-surface-adjacent empty
   neighbors: negative favors downward steps (creeps along the ground),
   positive favors upward (climbs walls). My own call, flagged plainly:
   a cell painted with NO adjacent solid at all (floating in open space)
   falls via plain gravity until it finds a surface to hug, rather than
   sitting inert forever — seemed better than a silently-frozen material
   the first time someone paints it away from a wall. */
function hasAdjacentSolid(x,y){
  for(const [nx,ny] of neighbors4(x,y)) if(inB(nx,ny) && isBehaviorSolid(MATBY[grid[idx(nx,ny)]].behavior)) return true;
  return false;
}
function hasReactableNeighbor(x,y,M){
  for(const [nx,ny] of neighbors4(x,y)){
    if(!inB(nx,ny)) continue;
    const rule=M.onContact[grid[idx(nx,ny)]];
    if(rule===undefined) continue;
    if(rule.settled && settleCounter[idx(x,y)] < SAND_SETTLE_TICKS) continue;
    return true;
  }
  return false;
}
function hasEmptyNeighbor(x,y){
  for(const [nx,ny] of neighbors4(x,y)) if(inB(nx,ny) && grid[idx(nx,ny)]===EMPTY) return true;
  return false;
}
// Fire's own flicker check: does (x,y) touch ANYTHING non-empty? Used to
// stop a flickering Fire cell from hopping into a spot that would leave
// it floating free — real fire clings to fuel/surface, it doesn't drift
// off into open air the way Smoke does.
function hasNonEmptyNeighbor(x,y){
  for(const [nx,ny] of neighbors4(x,y)) if(inB(nx,ny) && grid[idx(nx,ny)]!==EMPTY) return true;
  return false;
}
// same-material orthogonal neighbor count — feeds liquid()'s cohesion
// bias below. 4-connected, matching neighbors4/wake's own adjacency
// convention, not 8 — a diagonal-only touch doesn't count as "supported."
function sameMatCount(x,y,selfId){
  let n=0;
  for(const [nx,ny] of neighbors4(x,y)) if(inB(nx,ny) && grid[idx(nx,ny)]===selfId) n++;
  return n;
}
export const BEHAVIORS = {
  grow(x,y){
    const i=idx(x,y);
    const self=grid[i];
    const M=MATBY[self];
    const upOpen = inB(x,y-1) && grid[idx(x,y-1)]===EMPTY;
    const upIsSelf = inB(x,y-1) && grid[idx(x,y-1)]===self;
    const leftOpen = inB(x-1,y) && grid[idx(x-1,y)]===EMPTY;
    const rightOpen = inB(x+1,y) && grid[idx(x+1,y)]===EMPTY;
    // "already grown straight up" (upIsSelf) is the normal interior-of-
    // the-vine case and should NOT also branch sideways — only a cell
    // that's actually blocked by something else gets to consider a
    // detour. A cell with genuinely nothing pending (boxed in on all
    // three sides, or upIsSelf) is allowed to sleep — see the comment
    // by markSettling below for why that's safe.
    const canAct = upOpen || (!upIsSelf && inB(x,y-1) && (leftOpen || rightOpen));
    if(!canAct){ clearSettling(i); return; }
    // Bug found via headless testing, not by inspection: a FAILED
    // growChance roll used to do nothing at all — no wake(), no
    // markSettling — so after SLEEP_AFTER_IDLE (12) quiet ticks the
    // chunk went to sleep, and a sleeping chunk is never even looked at
    // again by step()'s outer loop. A vine that could still succeed on
    // its next roll would just freeze forever the moment nothing else
    // in its chunk happened to be active. Same idiom powder-settle
    // already uses while stuck-but-still-counting toward
    // SAND_SETTLE_TICKS: mark the chunk as having a pending action so
    // it can't go idle, independent of whether THIS tick's roll hits.
    markSettling(i);
    if(Math.random()>=(M.growChance!==undefined ? M.growChance : 0.02)) return;
    if(upOpen){ growInto(x,y,x,y-1); return; }
    if(leftOpen){ growInto(x,y,x-1,y); return; }
    if(rightOpen){ growInto(x,y,x+1,y); return; }
  },
  creep(x,y){
    const i=idx(x,y);
    const M=MATBY[grid[i]];
    const bias = M.climbBias!==undefined ? M.climbBias : 0;
    const candidates=[];
    for(const [dx,dy] of [[0,1],[0,-1],[1,0],[-1,0]]){
      const nx=x+dx, ny=y+dy;
      if(!inB(nx,ny) || grid[idx(nx,ny)]!==EMPTY) continue;
      if(!hasAdjacentSolid(nx,ny)) continue;   // only step to spots still touching a surface — this is what makes it creep, not wander
      let w=1;
      if(dy>0) w += Math.max(0,-bias);
      if(dy<0) w += Math.max(0, bias);
      candidates.push([nx,ny,w]);
    }
    if(candidates.length){
      const total=candidates.reduce((s,c)=>s+c[2],0);
      let r=Math.random()*total;
      for(const c of candidates){ r-=c[2]; if(r<=0){ trySwap(x,y,c[0],c[1]); return; } }
      return;
    }
    if(trySwap(x,y,x,y+1)) return;   // touching nothing at all — fall like plain gravity until it finds a surface to hug
    markSettling(i);   // same starvation fix as grow — genuinely stuck this tick (no surface move, can't even fall), but might not stay stuck if something nearby changes; trySwap's own success paths already clearSettling both endpoints, so this only needs to cover the pure-failure case
  },
  powder(x,y){
    if(trySwap(x,y,x,y+1)) return;
    const d=Math.random()<0.5?1:-1;
    if(trySwap(x,y,x+d,y+1)) return;
    if(trySwap(x,y,x-d,y+1)) return;
    const i=idx(x,y);
    markSettling(i);
    if(Math.random()<POWDER_COMPACT_CHANCE){
      const mat=grid[i];
      grid[i]=SOLID_TWIN[mat];
      clearSettling(i);
      wake(x,y);
    }
  },
  "powder-settle"(x,y){
    if(trySwap(x,y,x,y+1)) return;
    const d=Math.random()<0.5?1:-1;
    if(trySwap(x,y,x+d,y+1)) return;
    if(trySwap(x,y,x-d,y+1)) return;
    if(Math.random()<SAND_SLIDE_CHANCE && slideDownhill(x,y)) return;
    const i=idx(x,y);
    markSettling(i);
    if(++settleCounter[i] > SAND_SETTLE_TICKS){
      const mat=grid[i];
      if(!MATBY[mat].needsLateralSupport || hasLateralSupport(x,y)){
        grid[i]=SOLID_TWIN[mat];
        settleCounter[i]=0;
        clearSettling(i);
        wake(x,y);
      }
    }
  },
  liquid(x,y){
    // Cohesion / surface tension. visc alone (a flat per-cell-per-tick
    // coin flip, independent of every neighbor) is fine for a THICK
    // LIQUID'S BULK — real honey does fall and advance sluggishly as a
    // mass. But applied uniformly it also throttles the sideways
    // leveling move that's what makes a liquid's surface read as
    // connected rather than granular: at low visc, surface cells correct
    // an uneven pour one desynced cell at a time instead of settling as
    // a sheet, which is exactly the "disperses into a powder" look.
    // Fix: a cell with 3+ same-material orthogonal neighbors (interior /
    // well-supported) uses the material's configured visc as-is — that's
    // still the right "how thick is it" dial for bulk motion. A cell
    // with fewer same-material neighbors (the liquid's own surface, an
    // edge, a bump) gets its effective chance boosted toward 1 by
    // `cohesion` (0..1, per-material, default COHESION_DEFAULT) — thick
    // liquids still keep a smooth surface even while slow overall.
    // cohesion:0 disables this and falls back to plain visc everywhere,
    // reproducing the old behavior exactly.
    const i=idx(x,y);
    const self=grid[i];
    const M=MATBY[self];
    const visc = M.visc!==undefined ? M.visc : 1;
    const cohesion = M.cohesion!==undefined ? M.cohesion : LIQUID_COHESION_DEFAULT;
    const n = sameMatCount(x,y,self);
    const effVisc = n>=3 ? visc : visc + (1-visc)*cohesion;
    if(Math.random()>=effVisc) return;
    if(trySwap(x,y,x,y+1)) return;
    const d=Math.random()<0.5?1:-1;
    if(trySwap(x,y,x+d,y+1)) return;
    if(trySwap(x,y,x-d,y+1)) return;
    if(trySwap(x,y,x+d,y)) return;
    trySwap(x,y,x-d,y);
  },
  pressured(x,y){
    if(trySwap(x,y,x,y+1)) return;
    const d=Math.random()<0.5?1:-1;
    if(trySwap(x,y,x+d,y+1)) return;
    if(trySwap(x,y,x-d,y+1)) return;
    // ELECTRIC VIVID RAINBOW FORK — water-streak fix. Was SLIDE=6 with a
    // deterministic walk (each step attempted unconditionally until
    // blocked), diagnosed 2026-08-02: one cell's single turn could chain
    // up to 6 sequential swaps in one tick, and many adjacent water
    // cells resolving this in the same tick (a pool disturbed by a pour,
    // or spilling over an edge) drew visible straight multi-cell
    // horizontal streaks. Shortened max reach + a per-step continuation
    // chance (pressure dissipating with distance, not a hard cutoff)
    // makes a full-length slide rare instead of automatic whenever nothing
    // blocks it, without losing "pressured disperses faster than a lazy
    // liquid" as a real, felt difference from Honeymire/Oil's plain
    // liquid() behavior above.
    const SLIDE=4;
    const SLIDE_CONTINUE=0.6;
    for(const dir of (Math.random()<0.5?[d,-d]:[-d,d])){
      let moved=false;
      for(let s=0;s<SLIDE;s++){
        if(s>0 && Math.random()>=SLIDE_CONTINUE) break;
        if(trySwap(x+ s*dir, y, x+(s+1)*dir, y)) moved=true; else break;
      }
      if(moved) return;
    }
  },
  gas(x,y){
    if(Math.random()<GAS_UP_CHANCE && trySwap(x,y,x,y-1)) return;
    const d=Math.random()<0.5?1:-1;
    if(Math.random()<GAS_DIAG_CHANCE && trySwap(x,y,x+d,y-1)) return;
    if(Math.random()<GAS_DRIFT_CHANCE) trySwap(x,y,x+d,y);
  },
  diffuse(x,y){
    // Whole part of AETHER_MOVE_INTENSITY = guaranteed attempts, fractional
    // part = one further probabilistic attempt (see state.js). At the old
    // [0,1] range this reduces to exactly the original single-roll
    // behavior; values above 1 chain multiple swaps in one tick, each from
    // wherever the cell ended up after the last one, so a high setting
    // visibly races across the screen instead of crawling one cell/tick.
    let attempts = Math.floor(AETHER_MOVE_INTENSITY);
    if(Math.random() < AETHER_MOVE_INTENSITY - attempts) attempts++;
    let cx=x, cy=y;
    for(let a=0; a<attempts; a++){
      const dirs=[[1,0],[-1,0],[0,1],[0,-1],[1,1],[1,-1],[-1,1],[-1,-1]];
      for(let i=dirs.length-1;i>0;i--){
        const j=(Math.random()*(i+1))|0, t=dirs[i]; dirs[i]=dirs[j]; dirs[j]=t;
      }
      let moved=false;
      for(const [dx,dy] of dirs){ if(trySwap(cx,cy,cx+dx,cy+dy)){ cx+=dx; cy+=dy; moved=true; break; } }
      if(!moved) break;   // boxed in on every side — further attempts from the same dead spot would just repeat the same failure
    }
  },
  // ---- fire: "kinda like gas, but stuck to the surface." Gas floats
  // freely up and away — wrong for flame, which needs to stay attached
  // to whatever it's burning. This behavior itself does almost nothing:
  // the outer visc gate (step()'s movement pass, same mechanism every
  // other behavior already uses) already controls HOW OFTEN a fire cell
  // even attempts to flicker — Fire's own visc (materials.js) is its
  // flicker-frequency dial, live-tunable in the sandbox same as any
  // other material's viscosity. When it does get a turn, it only ever
  // tries to lick upward (up / up-left / up-right, flame's natural
  // direction) into an EMPTY cell, and only if that spot would still
  // touch something non-empty afterward — otherwise it's declining to
  // drift into open air like Smoke would. Actual fire SPREAD (igniting
  // more fuel) isn't this function's job at all — that's the onContact/
  // ignitionTemp pair on the fuel materials themselves (materials.js),
  // checked elsewhere in the tick. This function only governs the
  // flame's own flicker-in-place motion.
  fire(x,y){
    const candidates=[[x,y-1],[x-1,y-1],[x+1,y-1]];
    for(const [nx,ny] of candidates){
      if(!inB(nx,ny) || grid[idx(nx,ny)]!==EMPTY) continue;
      if(!hasNonEmptyNeighbor(nx,ny)) continue;
      trySwap(x,y,nx,ny);
      return;
    }
  },
  // 'void' and 'solid' materials do nothing on step — no entry needed.
};

export function step(){
  frame++;
  const ltr = frame&1;
  chunkTouched.fill(0);
  sinkTouched.fill(0);
  // PASS 1 — decay / onContact / emits. In-place conversions only, never
  // movement, so scan order genuinely doesn't matter here. That's the
  // whole fix: found via testing that with this interleaved into the
  // movement pass, 3 of 4 real reactions never fired under normal
  // painting — whichever material sat below (always processed first in
  // a single bottom-to-top pass) had already moved away via its own
  // movement behavior before the material above it got a turn to check
  // contact. Doing conversions as their own pass, before any movement
  // happens this tick, means every cell reacts against its neighbors'
  // actual start-of-tick state instead of whatever a lower neighbor
  // already relocated itself into moments earlier in the same tick.
  for(let cyi=0; cyi<CHUNKS_Y; cyi++){
    for(let cxi=0; cxi<CHUNKS_X; cxi++){
      const ci = cyi*CHUNKS_X+cxi;
      if(!chunkAwake[ci]) continue;
      const x0=cxi*CHUNK_SIZE, x1=x0+CHUNK_SIZE;
      const y0=cyi*CHUNK_SIZE, y1=y0+CHUNK_SIZE;
      for(let y=y0;y<y1;y++){
        for(let x=x0;x<x1;x++){
          const M = MATBY[grid[idx(x,y)]];
          if(M.decay && Math.random()<M.decay){
            const dest = M.decayTo!==undefined ? M.decayTo : EMPTY;
            grid[idx(x,y)]=dest;
            settleCounter[idx(x,y)]=0; clearSettling(idx(x,y));
            wake(x,y);
            if(dest===EMPTY && onDecayToEmpty) onDecayToEmpty(x,y);
            continue;
          }
          if(M.onContact){
            if(reactAt(x,y,M)) continue;
            if(hasReactableNeighbor(x,y,M)) markSettling(idx(x,y)); else clearSettling(idx(x,y));
          }
          if(M.emits){
            if(hasEmptyNeighbor(x,y)){
              if(Math.random()<M.emits.chance) emitFrom(x,y,M); else markSettling(idx(x,y));
            } else clearSettling(idx(x,y));
          }
        }
      }
    }
  }
  // PASS 2 — movement. Bottom-to-top, alternating left/right per frame,
  // exactly as before this fix — that ordering IS load-bearing for
  // movement (sand falling through the cell below it within one tick,
  // water leveling sideways) in a way pass 1 above deliberately isn't.
  // CHUNK-ROW ORDER FIX: cyi now runs CHUNKS_Y-1 downto 0 (bottom chunk
  // row first), not 0 upward. The within-chunk scan below was already
  // correctly bottom-to-top (a cell only falls into a row that's already
  // had its turn this tick, so it can't also move THAT row again this
  // same tick) — but that guarantee broke at every chunk-row seam, since
  // the old top-down chunk order meant an upper chunk's own bottom row
  // (right against the boundary) got processed, and fell material into
  // the chunk below, BEFORE that lower chunk had been touched at all
  // this tick. That lower chunk's own bottom-to-top scan then reached
  // its own top row — the exact row that just received material a
  // moment earlier in the same tick — last, giving it a second move.
  // Net effect: any cell crossing a chunk-row boundary while falling
  // could move twice in one tick, visibly desyncing from material one
  // row over that stayed fully inside a single chunk and only got one
  // move — a discontinuity at the seam, invisible on a static pile,
  // visible only while something is actively falling through it. This
  // affected every movement behavior identically (powder-settle, liquid,
  // pressured) since they all go through this one pass. Processing chunk
  // rows bottom-to-top globally makes the guarantee hold across seams
  // the same way it already held within a single chunk.
  // CHUNK-COLUMN ORDER FIX (ELECTRIC VIVID RAINBOW FORK, 2026-08-02) —
  // the horizontal mirror of the chunk-row fix documented above, which
  // was never applied to the other axis. The within-chunk scan already
  // alternates direction per frame (`ltr` in the x loop below), but the
  // chunk COLUMN loop was hardcoded ascending (cxi 0 -> CHUNKS_X-1)
  // regardless. On !ltr frames the two directions therefore DISAGREE,
  // and the no-double-move guarantee breaks at every chunk-column seam
  // exactly as it used to break at row seams: chunk col N scans
  // right-to-left, a cell at its rightmost column moves right into
  // chunk col N+1, and chunk col N+1 — processed next, also scanning
  // right-to-left — reaches that just-arrived cell LAST and moves it a
  // second time in the same tick. Material one column over, staying
  // inside a single chunk, only ever gets one move. That per-seam
  // asymmetry, alternating every other frame, is what produced
  // liquid piles with vertical walls and staircase edges landing
  // exactly on chunk boundaries (measured: wall segments sitting on
  // x mod CHUNK_SIZE == 0 at ~15x chance rate, and step transitions
  // landing exactly on chunk-row boundaries). Making chunk-column order
  // follow `ltr` makes the whole world one coherent directional sweep
  // per frame, so the guarantee holds across seams the same way it
  // already holds within a chunk.
  // ROW-MAJOR SCAN FIX (ELECTRIC VIVID RAINBOW FORK, 2026-08-02).
  // Pass 2 used to process one whole CHUNK_SIZE x CHUNK_SIZE block at a
  // time (for each chunk row, for each chunk column, scan that block's
  // 64 rows). That makes a cell's update order depend on WHICH BLOCK it
  // sits in, not just its position: two horizontally adjacent cells one
  // column apart, but in different chunks, are processed a whole block
  // apart in time, so one sees its neighbor's pre-move state and the
  // other sees its post-move state. The inconsistency lands exactly on
  // block edges and accumulates into visible geometry — measured: a
  // continuously-poured liquid pile developed vertical walls pinned to
  // x mod CHUNK_SIZE == 0, with the steps between them landing exactly
  // on chunk-ROW boundaries. Confirmed causal by rebuilding with
  // CHUNK_SIZE=32: new walls appeared at multiples of 32 (160/224/288)
  // that were not walls at 64, and every wall's row span re-aligned to
  // multiples of 32. Not a sleep bug — reproduced identically with
  // sleeping fully disabled.
  //   Fix: make the ROW the outer loop, so the whole world is swept
  // bottom-to-top in one coherent pass with a single consistent
  // horizontal direction per frame, exactly as an unchunked sim would.
  // Chunk granularity is kept ONLY for the sleep skip (still O(1) per
  // chunk-row-segment, ~4k checks/tick instead of 66 — negligible), so
  // the performance benefit of sleeping is fully retained while the
  // block-order artifact disappears.
  for(let y=H-1; y>=0; y--){
    const cyi = (y/CHUNK_SIZE)|0;
    for(let cxj=0; cxj<CHUNKS_X; cxj++){
      const cxi = ltr ? cxj : CHUNKS_X-1-cxj;
      const ci = cyi*CHUNKS_X+cxi;
      if(!chunkAwake[ci]) continue;
      const x0=cxi*CHUNK_SIZE;
      for(let i=0;i<CHUNK_SIZE;i++){
        const x = x0 + (ltr? i : CHUNK_SIZE-1-i);
        const M = MATBY[grid[idx(x,y)]];
        const fn = BEHAVIORS[M.behavior];
        // liquid rolls its own effective-visc chance internally now
        // (cohesion-aware, see BEHAVIORS.liquid) — gating it again out
        // here would apply visc twice and undo the whole point of the
        // fix. Every other behavior is unaffected, same gate as before.
        if(!fn) continue;
        if(M.behavior==="liquid") fn(x,y);
        else if(M.visc===undefined || Math.random()<M.visc) fn(x,y);
      }
    }
  }
  // idle bookkeeping: an awake chunk nothing touched this tick gets
  // sleepier; touched chunks reset. A chunk holding cells still counting
  // toward SAND_SETTLE_TICKS or rolling POWDER_COMPACT_CHANCE does not
  // get to sleep on idleness alone — settlingByChunk is O(1) to check.
  for(let ci=0; ci<chunkAwake.length; ci++){
    if(!chunkAwake[ci]) continue;
    if(chunkTouched[ci] || settlingByChunk[ci]>0) chunkIdle[ci]=0;
    else if(++chunkIdle[ci] > SLEEP_AFTER_IDLE) chunkAwake[ci]=0;
  }
  processDecompression();
}

// POWDER DECOMPRESSION, loosening half. Vertical check: only directly
// below, not the diagonals powder() uses to fall — undermining a
// compacted floor only lets go exactly where you actually dug. Lateral:
// opt-in per material via `needsLateralSupport` (Sand; Starfall
// deliberately does NOT get this, its tower behavior is a kept feature).
// (isBehaviorSolid itself now lives earlier in this file — creep's
// hasAdjacentSolid needed it too, so it moved up rather than duplicating.)
function hasLateralSupport(x,y){
  const leftB  = inB(x-1,y) ? MATBY[grid[idx(x-1,y)]].behavior : null;
  const rightB = inB(x+1,y) ? MATBY[grid[idx(x+1,y)]].behavior : null;
  return isBehaviorSolid(leftB) || isBehaviorSolid(rightB);
}
function processDecompression(){
  if(decompressQueue.size===0) return;
  for(const i of decompressQueue){
    const srcId = TWIN_OF_POWDER[grid[i]];
    if(srcId===undefined) continue;   // no longer a compacted-powder cell (erased/overwritten since queued)
    const x=i%W, y=(i/W)|0;
    let loose = false;
    if(y+1<H){
      const belowB = MATBY[grid[idx(x,y+1)]].behavior;
      if(!isBehaviorSolid(belowB)) loose = true;
    }
    if(!loose && MATBY[srcId].needsLateralSupport && !hasLateralSupport(x,y)) loose = true;
    if(loose){
      grid[i]=srcId;
      wake(x,y);
    }
  }
  decompressQueue.clear();
}

/* ================= sky heat sources =================
   Two branches sharing one data shape (state.js's skySources), on
   whether heatRadius is finite — but as of this session, BOTH are the
   same kind of thing: a proportional PULL toward heatStrength, not an
   injection. A pull is self-limiting by construction (it asymptotically
   approaches its target and can never overshoot it), so neither branch
   needs a safety-cap constant the way the old additive version did.
     REAL suns (finite heatRadius): pull strength is scaled by linear
   distance falloff (full SKY_HEAT_RATE at the sun's own position, zero
   at heatRadius) — strong pull toward heatStrength near the source,
   negligible at the edge, same qualitative feel as the old additive
   version, just converging instead of accumulating.
     The default ambient entry (heatRadius:Infinity, isDefaultAmbient):
   unchanged — a flat pull toward heatStrength using AMBIENT_PULL_RATE,
   no falloff since it applies everywhere equally. A thermostat, not a
   heater.
   Both branches are gated by chunkAwake — sleeping chunks get no heat
   from either mechanism, same freeze-in-place as diffusion. Runs BEFORE
   diffuseTemp each tick (see main.js/sandbox loops) so whatever a sun
   pulls this tick immediately starts spreading the same tick. */
function applySkyHeat(){
  if(!TEMPERATURE_ENABLED) return;
  for(const s of skySources){
    if(s.kind!=="sun") continue;
    if(s.heatRadius===Infinity){
      for(let cyi=0; cyi<CHUNKS_Y; cyi++) for(let cxi=0; cxi<CHUNKS_X; cxi++){
        const ci=cyi*CHUNKS_X+cxi; if(!chunkAwake[ci]) continue;
        const x0=cxi*CHUNK_SIZE, x1=x0+CHUNK_SIZE, y0=cyi*CHUNK_SIZE, y1=y0+CHUNK_SIZE;
        for(let y=y0;y<y1;y++) for(let x=x0;x<x1;x++){
          const i=idx(x,y);
          if(grid[i]===EMPTY) continue;   // void stays pinned to 0 by diffuseTemp's own pass — a thermostat has nothing to warm there
          // heatCapacity divides the thermostat's grip the same way it
          // divides conduction — see the note in diffuseTemp. Without it
          // here too, a high-capacity material would resist its
          // neighbours but still get yanked to ambient in a second flat,
          // which is the exact failure this field exists to fix.
          temp[i] += (s.heatStrength-temp[i]) * AMBIENT_PULL_RATE / capOf(grid[i]);
        }
      }
      continue;
    }
    const r=s.heatRadius, r2=r*r;
    for(let cyi=0; cyi<CHUNKS_Y; cyi++) for(let cxi=0; cxi<CHUNKS_X; cxi++){
      const ci=cyi*CHUNKS_X+cxi; if(!chunkAwake[ci]) continue;
      const x0=cxi*CHUNK_SIZE, x1=x0+CHUNK_SIZE, y0=cyi*CHUNK_SIZE, y1=y0+CHUNK_SIZE;
      // cheap bounding check: skip this whole chunk if it can't possibly
      // be within range, before touching a single cell
      const ccx=x0+CHUNK_SIZE/2, ccy=y0+CHUNK_SIZE/2;
      const chunkHalfDiag=Math.SQRT2*CHUNK_SIZE/2;
      if(Math.hypot(ccx-s.x, ccy-s.y) > r+chunkHalfDiag) continue;
      for(let y=y0;y<y1;y++) for(let x=x0;x<x1;x++){
        const i=idx(x,y);
        if(grid[i]===EMPTY) continue;
        const dx=x-s.x, dy=y-s.y, d2=dx*dx+dy*dy;
        if(d2>r2) continue;
        const falloff=1-Math.sqrt(d2)/r;   // linear falloff, 1 at the sun's own position, 0 at heatRadius
        // PULL, not injection — was Math.min(SKY_HEAT_CEILING, temp[i] +
        // s.heatStrength*falloff*SKY_HEAT_RATE), an additive-with-a-cap
        // shape that (a) needed an emergency ceiling to stay bounded at
        // all, and (b) is the exact same failure shape the material
        // radiant-heat system had, just with a wide enough cap that it
        // hadn't visibly bitten anyone yet. Converging pull instead:
        // self-limiting by construction, no ceiling constant needed.
        temp[i] += (s.heatStrength-temp[i]) * SKY_HEAT_RATE * falloff / capOf(grid[i]);
      }
    }
  }
}
export { applySkyHeat };

/* ================= Tesla coils =================
   Wireless switch, not a network — no propagation, no BFS, no per-cell
   powered state. An active coil (fields, kind:"tesla", toggled by tap —
   see main.js) checks every cell within TESLA_RADIUS once per tick and
   self-converts any material carrying `teslaReact` (same semantics as
   onContact's reactChance: a result id + optional chance, defaults to
   1). The receiving material never has to know it's near a coil versus
   near a live wire versus anything else — teslaReact is just another
   conversion rule sitting on the material, same registry pattern as
   onContact/decay.
   Deliberately a plain bounding-box scan, not applySkyHeat's chunk-wide
   pattern — TESLA_RADIUS is small by design (a switch, not a sun), so
   scanning its own small box every tick is cheaper and simpler than
   chunk bookkeeping built for a source that can cover the whole map. */
function applyTeslaFields(){
  for(const f of fields){
    if(f.kind!=="tesla" || !f.active) continue;
    const r=TESLA_RADIUS, r2=r*r;
    const x0=Math.max(0,Math.floor(f.x-r)), x1=Math.min(W-1,Math.ceil(f.x+r));
    const y0=Math.max(0,Math.floor(f.y-r)), y1=Math.min(H-1,Math.ceil(f.y+r));
    for(let y=y0;y<=y1;y++) for(let x=x0;x<=x1;x++){
      const dx=x-f.x, dy=y-f.y;
      if(dx*dx+dy*dy>r2) continue;
      const i=idx(x,y);
      const M=MATBY[grid[i]];
      if(M.teslaReact===undefined) continue;
      if(Math.random() >= (M.teslaChance!==undefined ? M.teslaChance : 1)) continue;
      grid[i]=M.teslaReact;
      wake(x,y);
    }
  }
}
export { applyTeslaFields };

/* ================= combustion heat =================
   A burning cell (anything with heatOutput set — currently only Fire)
   needs to actively radiate heat, not just passively hold whatever temp
   it inherited from the fuel it ignited from (see spawnTempFor's comment
   on conversions keeping their existing temp — a Fire cell converted
   from Wood keeps Wood's temp at the moment of ignition, which could be
   barely above ignitionTemp). Without this pass a Fire cell would cool
   via diffuseTemp before ever spreading real heat to its neighbors,
   which would strangle the radiant-ignition path (materials.js's
   ignitionTemp) almost immediately.
   Same shape as applySkyHeat on purpose: a separate pass, called before
   diffuseTemp (see main.js/Sandbox.html loops), so whatever a burning
   cell injects this tick starts spreading the very same tick. Math.max,
   not a forced set — a Fire cell that's ALSO sitting in a Magma pool
   isn't cooled down to match its own heatOutput. */
// CHILL_PULL now lives in state.js as a live Tuning-panel value (was a
// hardcoded local const here at 0.25 — see state.js's comment for why that
// number made contact-melting mathematically impossible, not just slow).
function applyCombustionHeat(){
  if(!TEMPERATURE_ENABLED) return;
  for(let cyi=0; cyi<CHUNKS_Y; cyi++) for(let cxi=0; cxi<CHUNKS_X; cxi++){
    const ci=cyi*CHUNKS_X+cxi; if(!chunkAwake[ci]) continue;
    const x0=cxi*CHUNK_SIZE, x1=x0+CHUNK_SIZE, y0=cyi*CHUNK_SIZE, y1=y0+CHUNK_SIZE;
    for(let y=y0;y<y1;y++) for(let x=x0;x<x1;x++){
      const i=idx(x,y);
      if(grid[i]===EMPTY) continue;
      const M=MATBY[grid[i]];
      // ---- heatOutput: was a FLOOR (Math.max) — raised temp[i] up to
      // heatOutput if it was below, but did nothing once temp[i] climbed
      // ABOVE it. Combined with a since-REMOVED radiant-heat mechanism
      // (a dense pool of same-type self-heating cells — Lava, but also
      // Fire/Ember/Starfall in bulk — used to mutually irradiate itself
      // with no occlusion), the floor never pushed back against that
      // climb, and temp banked upward tick over tick until it hit an
      // emergency 4000-degree safety clamp that was never meant to be a
      // resting temperature. Measured: a 17x17 Lava pool ran 20->4000 in
      // under 150 ticks under the old floor-plus-radiant combination.
      // That whole radiant-at-a-distance mechanism is gone now (see
      // applyRadiantChill's comment for the full story) — this pin is
      // the other half of the fix, and stays regardless:
      //   A PIN, not a floor: temp[i] is forced to exactly heatOutput
      // every tick, unconditionally — can't bank heat from neighbors
      // (conduction, since this runs before diffuseTemp each tick and
      // gets re-applied next tick regardless of what diffuseTemp did),
      // and can't be pushed hotter by an external source either (a Lava
      // cell sitting near a sun still
      // just sits at its own heatOutput). It can still freely warm or
      // cool everything else around it via ordinary conduction (the only
      // channel heat moves through now) — this pin only removes the
      // self-heating cell's own ability to receive and retain heat from
      // anything else.
      if(M.heatOutput!==undefined) temp[i]=M.heatOutput;
      // ---- chillOutput: the cold mirror, and the one addition here with
      // no precedent elsewhere in this file, so it gets a real
      // justification rather than a one-liner.
      //   THE PROBLEM IT SOLVES: AMBIENT_PULL_RATE drags every cell to
      // DEFAULT_AMBIENT_HEAT (20) unconditionally. That means a cold
      // material has no way to STAY cold — Snow spawns at 2 and is at 20
      // within a couple of seconds, at which point it is thermally
      // identical to a rock and cannot chill anything next to it. Fire
      // has heatOutput to hold its own temp up; nothing held anything
      // down, so the entire cold half of the phase system (Water ->
      // Snow, Aether -> Aetherfrost) was unreachable in practice without
      // dragging the global Ambient dial down and freezing the whole map.
      //   WHY IT'S A PULL, NOT A CLAMP: heatOutput is a hard floor
      // (Math.max) and gets away with it because Fire dies on a decay
      // timer, never on a threshold. A hard ceiling here would make Snow
      // permanently 4 degrees and therefore UNMELTABLE — its meltPoint
      // could never be reached no matter how big the fire, because the
      // clamp would undo the heat every tick. Exactly the heatOutput-vs-
      // freezePoint trap documented in materials.js, mirrored. So this
      // pulls toward chillOutput at CHILL_PULL instead: strong enough to
      // hold a snowbank cold against ambient indefinitely, weak enough
      // that a real heat source still wins and melts it.
      if(M.chillOutput!==undefined && temp[i]>M.chillOutput){
        temp[i] += (M.chillOutput - temp[i]) * CHILL_PULL;
      }
    }
  }
}
export { applyCombustionHeat };

/* ================= radiant chill =================
   Ordinary diffuseTemp conduction needs unbroken material contact — void
   has zero conductivity there, deliberately (see the note on that in
   diffuseTemp below), so temperature can't hop across even one empty
   cell that way. This is the other kind of transfer: a cold cell
   chilling something a few cells away with nothing but open space
   between them, the way a snowbank chills your face without the air in
   between cooling first. Scoped to chillOutput materials, same reasoning
   real radiative transfer only matters for genuinely (here, stylized)
   cold sources.
   Same bounding-box-scan shape as applyTeslaFields on purpose — cheap,
   and already the established pattern for "a point effect with a small
   fixed radius" in this file. Floored at 0 — temp's own documented
   floor, used everywhere else, not a special case invented here.
   Void cells are skipped as both source and target — they never
   receive, store, or forward radiant temperature, exactly like they
   don't for ordinary diffusion. Deliberately NOT line-of-sight-checked
   (no raycast) — same call Tesla's radius scan already makes: simplicity
   over realism for an effect this small.
     THE HEAT HALF OF THIS USED TO EXIST HERE TOO, AND IT'S GONE ON
   PURPOSE. Same function, opposite sign, used to also radiate heatOutput
   outward with no occlusion — a dense pool of same-type self-heating
   cells (Lava) mutually irradiated itself with nothing to stop the sum
   from climbing, hit an emergency 4000-degree safety clamp that was
   never meant to be a resting place, and cooked anything sitting next to
   the pool along with it. The chill half never had this problem — it's
   floored at 0, a real bound already used everywhere, not an emergency
   value — so it's kept, unmodified, on its own. Heat-at-a-distance
   through open space no longer exists anywhere in this file; only
   conduction (diffuseTemp) and each self-heating cell's own hard-pinned
   temp (applyCombustionHeat) do that job now. Practical consequence: a
   flammable material can no longer ignite purely from being NEAR a fire
   with nothing touching it — ignition now requires an actual unbroken
   conductive path, same as everything else. */
function radiateChill(x, y, ci, magnitude, radius, rate){
  const r=radius, r2=r*r;
  const bx0=Math.max(0,x-r), bx1=Math.min(W-1,x+r);
  const by0=Math.max(0,y-r), by1=Math.min(H-1,y+r);
  for(let yy=by0; yy<=by1; yy++) for(let xx=bx0; xx<=bx1; xx++){
    if(xx===x && yy===y) continue;
    const dx=xx-x, dy=yy-y, d2=dx*dx+dy*dy;
    if(d2>r2) continue;
    const j=idx(xx,yy);
    if(grid[j]===EMPTY) continue;   // void neither receives nor forwards this
    const falloff = 1 - Math.sqrt(d2)/r;
    temp[j] = Math.max(0, temp[j] - magnitude*falloff*rate);   // 0 floor — same documented floor state.js's temp array uses everywhere else
    // CHUNK-BOUNDARY WAKE. Same family as wake()'s fix and Pass 2's
    // chunk-row fix elsewhere in this file — this write can land in a
    // cell whose own chunk is asleep, leaving a stuck-cold pocket if
    // nothing wakes it.
    if(chunkIndexAt(xx,yy)!==ci) wake(xx,yy);
  }
}
function applyRadiantChill(){
  if(!TEMPERATURE_ENABLED) return;
  for(let cyi=0; cyi<CHUNKS_Y; cyi++) for(let cxi=0; cxi<CHUNKS_X; cxi++){
    const ci=cyi*CHUNKS_X+cxi; if(!chunkAwake[ci]) continue;
    const x0=cxi*CHUNK_SIZE, x1=x0+CHUNK_SIZE, y0=cyi*CHUNK_SIZE, y1=y0+CHUNK_SIZE;
    for(let y=y0;y<y1;y++) for(let x=x0;x<x1;x++){
      const i=idx(x,y);
      if(grid[i]===EMPTY) continue;
      const M=MATBY[grid[i]];
      if(M.chillOutput!==undefined) radiateChill(x,y,ci,M.chillOutput,RADIANT_CHILL_RADIUS,RADIANT_CHILL_RATE);
    }
  }
}
export { applyRadiantChill };

/* ================= temperature diffusion =================
   Three passes, all gated by chunkAwake exactly like the movement pass
   above — a sleeping chunk's heat freezes along with everything else in
   it, seams at its boundary with an awake neighbor included on purpose.
   Advection (heat moving WITH material) is handled separately, in
   trySwap — this pass is purely about heat spreading between cells that
   AREN'T moving.
     Pass 0 pins every void cell to 0 immediately, before any exchange
   math runs this tick — "space is absolute zero," and pinning it first
   (rather than as part of the exchange pass) means a neighbor checking
   an adjacent void cell sees true zero the same tick material there
   left/decayed away, not one tick stale.
     Pass 1 computes each awake cell's new temperature into a scratch
   buffer rather than mutating `temp` in place — an in-place pass would
   bias heat flow toward whichever scan direction runs first, same class
   of bug the movement pass already avoids with its left/right frame
   alternation; diffusion has no direction to alternate, so double-
   buffering is the only fix available.
     Pass 2 copies the buffer back — only for awake chunks, so a
   sleeping chunk's temp is simply never touched, not zeroed or
   recomputed. */
// How close to an unmet threshold a cell has to be before it keeps its
// chunk awake. Small on purpose — this is a stranding guard, not a
// general "temperature keeps things simulating" policy, and the sim's
// sleep system is load-bearing for performance.
const THRESHOLD_WAKE_BAND = 4;
const tempBuf = new Float32Array(W*H);
export function diffuseTemp(){
  if(!TEMPERATURE_ENABLED) return;
  for(let cyi=0; cyi<CHUNKS_Y; cyi++) for(let cxi=0; cxi<CHUNKS_X; cxi++){
    const ci=cyi*CHUNKS_X+cxi; if(!chunkAwake[ci]) continue;
    const x0=cxi*CHUNK_SIZE, x1=x0+CHUNK_SIZE, y0=cyi*CHUNK_SIZE, y1=y0+CHUNK_SIZE;
    for(let y=y0;y<y1;y++) for(let x=x0;x<x1;x++){ const i=idx(x,y); if(grid[i]===EMPTY) temp[i]=0; }
  }
  for(let cyi=0; cyi<CHUNKS_Y; cyi++) for(let cxi=0; cxi<CHUNKS_X; cxi++){
    const ci=cyi*CHUNKS_X+cxi; if(!chunkAwake[ci]) continue;
    const x0=cxi*CHUNK_SIZE, x1=x0+CHUNK_SIZE, y0=cyi*CHUNK_SIZE, y1=y0+CHUNK_SIZE;
    for(let y=y0;y<y1;y++){
      for(let x=x0;x<x1;x++){
        const i=idx(x,y);
        if(grid[i]===EMPTY){ tempBuf[i]=0; continue; }
        const M=MATBY[grid[i]];
        const condA = M.conductivity!==undefined ? M.conductivity : 0;
        const capA = capOf(grid[i]);
        let t=temp[i];
        if(condA>0){
          for(const [nx,ny] of neighbors4(x,y)){
            if(!inB(nx,ny)) continue;
            const j=idx(nx,ny);
            // void (open space) no longer conducts at all — condB=0 makes
            // Math.min(condA,condB) zero regardless of the material's own
            // conductivity, so this term drops out of the sum entirely.
            // Previously void acted as a perfect conductor of COLD
            // (condB=1), which meant exposed material always lost heat to
            // open space regardless of ambient — including outrunning
            // Ambient Temperature at max. Deliberate tradeoff (Crash's
            // call): exposed hot material now holds its heat indefinitely
            // unless ambient pulls it down on purpose; "insulated bulk
            // retains heat better than an exposed edge" no longer exists
            // as emergent behavior — temperature is fully ambient-dial-
            // controlled now, not exposure-controlled. NOTE, updated:
            // meltPoint/freezePoint ARE read now (see the copy-back pass
            // below), so this tradeoff has teeth it didn't before —
            // exposed material no longer bleeds heat to open space, which
            // means a magma flow in open air cools only as fast as
            // ambient pulls it, not faster at its exposed edge. If lava
            // ever needs to crust from the outside in, THIS is the line
            // to revisit, not the phase-change code.
            const otherM = grid[j]===EMPTY ? null : MATBY[grid[j]];
            const condB = grid[j]===EMPTY ? 0 : (otherM.conductivity!==undefined ? otherM.conductivity : 0);
            const rate = DIFFUSION_RATE * Math.min(condA, condB);
            t += (temp[j]-temp[i]) * rate * 0.25 / capA;   // 0.25 = share across up to 4 neighbors, keeps total per-tick exchange bounded regardless of how many directions are open
          }
        }
        tempBuf[i]=t;
      }
    }
  }
  for(let cyi=0; cyi<CHUNKS_Y; cyi++) for(let cxi=0; cxi<CHUNKS_X; cxi++){
    const ci=cyi*CHUNKS_X+cxi; if(!chunkAwake[ci]) continue;
    const x0=cxi*CHUNK_SIZE, x1=x0+CHUNK_SIZE, y0=cyi*CHUNK_SIZE, y1=y0+CHUNK_SIZE;
    for(let y=y0;y<y1;y++) for(let x=x0;x<x1;x++){
      const i=idx(x,y);
      temp[i]=tempBuf[i];
      // RADIANT IGNITION: a flammable material crossing its own
      // ignitionTemp converts to Fire right here, on its just-diffused
      // temp — this is the "heat conducted through the material itself"
      // path, distinct from (and in addition to) direct Fire-contact
      // ignition (an ordinary onContact rule on the fuel material, rolled
      // in step()'s PASS 1). A conversion, not an introduction, so it
      // deliberately does NOT reset to Fire's own spawnTemp — same rule
      // spawnTempFor's comment lays out for every other in-place
      // conversion (decay, onContact, compaction).
      const M=MATBY[grid[i]];
      // SECOND heatOutput PIN, deliberately. applyCombustionHeat already
      // pins self-heating cells at the START of the tick, but conduction
      // above (tempBuf) runs AFTER that and can push a pinned cell back
      // up from its own now-hot neighbors before the tick ends — the
      // very same-tick pileup that caused the original radiant-runaway
      // bug, just smaller in scope now. Re-pinning HERE, after
      // conduction and before the threshold checks below, is what makes
      // "self-heating cells hold exactly their labeled number" actually
      // true at the point anything inspects temp[i] — not just true for
      // one instant at the top of the tick. Confirmed via headless test:
      // without this second pin, a dense same-type pool still settles
      // into a stable-but-elevated equilibrium well above its own
      // heatOutput (measured ~143 for an 80-heatOutput Lava pool) rather
      // than sitting at the number on the label.
      if(M.heatOutput!==undefined) temp[i]=M.heatOutput;
      // THRESHOLD STRANDING GUARD. Found by headless test, not inspection:
      // a lava pool cooled all the way to 30.0-31.4 against a freezePoint
      // of 30, then stopped moving — at which point every chunk around it
      // went to sleep, and since diffuseTemp skips sleeping chunks those
      // cells were frozen in time one tenth of a degree from converting,
      // permanently. It is a general hazard for the whole phase system,
      // not a magma quirk: ANYTHING that comes to rest near a threshold
      // gets marooned just short of it, because nothing else in the
      // neighbourhood is left to keep the chunk awake.
      //   Fix is the same idiom grow/creep already use for their own
      // starvation problem — declare a pending action so the chunk can't
      // idle out — but scoped tightly to cells actually APPROACHING a
      // threshold, not every cell that merely has one. Stone carries a
      // meltPoint of 88 and sits at ambient 20; it is nowhere near, so it
      // sleeps normally and costs nothing.
      //   FOOTGUN FOR FUTURE MATERIALS: a threshold set within
      // THRESHOLD_WAKE_BAND of a temperature the material RESTS at will
      // keep its chunk awake forever. Every threshold in the current
      // roster clears that band comfortably — check it if you add one
      // near ambient.
      if((M.meltPoint!==undefined   && temp[i] > M.meltPoint   - THRESHOLD_WAKE_BAND) ||
         (M.freezePoint!==undefined && temp[i] < M.freezePoint + THRESHOLD_WAKE_BAND)){
        markSettling(i);
      }
      if(M.ignitionTemp!==undefined && temp[i]>=M.ignitionTemp){
        grid[i]=FIRE;
        wake(x,y);
      }
      // PHASE CHANGE. meltPoint/freezePoint were reserved schema for
      // several sessions — nothing read them, so every state change in
      // the roster was a hand-wired onContact pair impersonating
      // temperature (Snow/Magma, Magma/Water). This is that, for
      // real. Despite the names these are simply an UPPER and a LOWER
      // threshold: `meltPoint`/`meltTo` fires on crossing above,
      // `freezePoint`/`freezeTo` on crossing below. Water's upper
      // threshold is a boil, Sand's is vitrification, Clay's is firing —
      // "melt" is just the shortest word for the general case, and the
      // names were already reserved so they stay.
      //   Conversions, not introductions: temp is deliberately NOT reset
      // to the target's spawnTemp, same rule spawnTempFor's comment lays
      // out for decay/onContact/compaction. Steam boiled off a pool
      // carries the 92 it boiled at and cools from there.
      //   else-if throughout: one cell does at most one thing per tick,
      // and a material carrying both thresholds can never satisfy both.
      //   TWO TUNING TRAPS worth knowing, both live and both useful:
      //   1. Ambient. AMBIENT_PULL_RATE drags every cell toward
      //      DEFAULT_AMBIENT_HEAT (20) forever, so a threshold INSIDE
      //      that band converts spontaneously everywhere, with no heat
      //      source involved. Every threshold in materials.js sits
      //      outside it on purpose — which is what makes the Ambient
      //      Temperature slider a climate dial: drop it under 10 and the
      //      world's Water freezes on its own; push it past 26 and
      //      the snow goes.
      //   2. heatOutput vs freezePoint. applyCombustionHeat floors a
      //      radiating cell's temp at its own heatOutput every tick, so
      //      heatOutput ABOVE freezePoint means the cell can never reach
      //      its freeze threshold — it burns forever. Below it, it
      //      radiates on the way down and still solidifies. That's a
      //      feature, not a hazard: it's the difference between Magma
      //      (50 vs 60 — crusts over on its own) and an eternal flame.
      else if(M.meltPoint!==undefined && temp[i]>=M.meltPoint){
        grid[i] = M.meltTo!==undefined ? M.meltTo : EMPTY;
        settleCounter[i]=0; clearSettling(i);
        wake(x,y);
      }
      else if(M.freezePoint!==undefined && temp[i]<=M.freezePoint){
        grid[i] = M.freezeTo!==undefined ? M.freezeTo : EMPTY;
        settleCounter[i]=0; clearSettling(i);
        wake(x,y);
      }
    }
  }
}

/* ================= placed devices (springs/vents) =================
   Tracked separately from the grid so they can emit from a fixed point
   regardless of how many pixels their icon occupies. */
export const GEN_R = 2; // icon half-size — VISUAL size only
export const GEN_HIT_R = 5; // tap zone — much bigger than the icon, well inside MIN_DEVICE_SPACING
export const MIN_DEVICE_SPACING = 10; // cells, center-to-center
export function tooCloseToDevice(x,y){
  for(const g of generators) if(Math.hypot(x-g.x, y-g.y) < MIN_DEVICE_SPACING) return true;
  return false;
}
export function genFireChance(){ return GEN_FIRE_BASE + flow*GEN_FIRE_FLOW_MULT; }
export function pushBurst(){ return PUSH_BURST_BASE + Math.round(flow*PUSH_BURST_FLOW_MULT); }

// Direction vectors, indexed 0..3 = up, right, down, left. Tap-to-rotate
// cycles through these.
export const DIR = [[0,-1],[1,0],[0,1],[-1,0]];

export function stampGenerator(cx,cy,matId){
  if(tooCloseToDevice(cx,cy)) return;   // near-miss on a rotate tap: no-op, not a duplicate
  const st=spawnTempFor(matId);   // introduction: device icon painted in fresh
  for(let dy=-GEN_R;dy<=GEN_R;dy++)for(let dx=-GEN_R;dx<=GEN_R;dx++){
    const x=cx+dx, y=cy+dy; if(!inB(x,y)) continue;
    recordCell(idx(x,y)); grid[idx(x,y)]=matId; temp[idx(x,y)]=st; clearSettling(idx(x,y)); wake(x,y);
  }
  generators.push({x:cx, y:cy, spawnId:MATBY[matId].spawnId, matId,
    emit:MATBY[matId].emit, dir:0, placedBy:identity});   // springs start pointing up
}

export function neighbors4(x,y){ return [[x,y-1],[x-1,y],[x+1,y],[x,y+1]]; }

/* hit-test: which placed device (if any) covers grid cell (gx,gy)? */
export function deviceAt(gx,gy){
  for(let i=generators.length-1;i>=0;i--){
    const g=generators[i];
    if(Math.abs(gx-g.x)<=GEN_HIT_R && Math.abs(gy-g.y)<=GEN_HIT_R) return i;
  }
  return -1;
}
export function rotateDevice(i){ generators[i].dir=(generators[i].dir+1)&3; }
export function deleteDevice(i){
  const g=generators[i];
  for(let dy=-GEN_R;dy<=GEN_R;dy++)for(let dx=-GEN_R;dx<=GEN_R;dx++){
    const x=g.x+dx, y=g.y+dy; if(inB(x,y)&&grid[idx(x,y)]===g.matId){ recordCell(idx(x,y)); grid[idx(x,y)]=EMPTY; wake(x,y); }
  }
  generators.splice(i,1);
}

/* ---- momentum particles: a spring's jet ----
   P_GRAV/P_DRAG/P_SUBMERGE_DRAG/P_SUBMERGE_KICK now live in state.js's
   tunable block (imported above) — same values, just live-editable. */
export function spawnParticle(x,y,vx,vy,mat){
  if(particles.length>4000) return;   // safety cap
  particles.push({x,y,vx,vy,mat,life:60,submerged:false});
}
export function stepParticles(){
  for(let i=particles.length-1;i>=0;i--){
    const p=particles[i];
    p.vy+=P_GRAV; p.vx*=P_DRAG; p.vy*=P_DRAG; p.life--;
    const nx=p.x+p.vx, ny=p.y+p.vy;
    const cx=Math.round(nx), cy=Math.round(ny);
    if(cx<0||cx>=W||cy>=H||cy<0){ particles.splice(i,1); continue; }
    const cell=grid[idx(cx,cy)];

    if(cell===p.mat){
      if(!p.submerged){
        p.vx*=P_SUBMERGE_KICK; p.vy*=P_SUBMERGE_KICK;
        p.submerged=true;
      } else {
        p.vx*=P_SUBMERGE_DRAG; p.vy*=P_SUBMERGE_DRAG;
      }
      if((p.vx*p.vx+p.vy*p.vy)<0.04 || p.life<=0){ particles.splice(i,1); continue; }
      p.x=nx; p.y=ny;
      continue;
    }
    p.submerged=false;

    const slow = (p.vx*p.vx+p.vy*p.vy) < 0.04;
    if(cell!==EMPTY || slow || p.life<=0){
      const lx=Math.round(p.x), ly=Math.round(p.y);
      // introduction: the particle's carried material is landing/settling fresh
      if(inB(lx,ly) && grid[idx(lx,ly)]===EMPTY){ grid[idx(lx,ly)]=p.mat; temp[idx(lx,ly)]=spawnTempFor(p.mat); wake(lx,ly); }
      else if(inB(cx,cy) && grid[idx(cx,cy)]===EMPTY){ grid[idx(cx,cy)]=p.mat; temp[idx(cx,cy)]=spawnTempFor(p.mat); wake(cx,cy); }
      particles.splice(i,1); continue;
    }
    p.x=nx; p.y=ny;
  }
}

/* SEEP (vents, squares): BFS floods from the core through the vent's own
   material to the nearest reachable empty cell and emits there. */
// GEN_BFS_CAP now lives in state.js's tunable block (imported above).
const genVisited = new Uint16Array(W*H); let genStamp=0;
export function emitSeep(g){
  genStamp++;
  const spawn=g.spawnId, ownIcon=g.matId;
  const q=[idx(g.x,g.y)]; genVisited[q[0]]=genStamp;
  let head=0, seen=1;
  while(head<q.length && seen<GEN_BFS_CAP){
    const p=q[head++]; const x=p%W, y=(p-x)/W;
    for(const [nx,ny] of neighbors4(x,y)){
      if(!inB(nx,ny)) continue;
      const np=idx(nx,ny);
      if(genVisited[np]===genStamp) continue;
      genVisited[np]=genStamp; seen++;
      const m=grid[np];
      if(m===EMPTY){ grid[np]=spawn; temp[np]=spawnTempFor(spawn); wake(nx,ny); return true; }  // reached an opening — emit (introduction)
      if(m===spawn || m===ownIcon) q.push(np);              // flood through own body
    }
  }
  return false;
}

/* SPRING (triangles): fire a momentum jet out the point.
   JET_SPEED_MIN/MAX now live in state.js's tunable block (imported above). */
export function emitSpring(g){
  const [dx,dy]=DIR[g.dir];
  const speed = JET_SPEED_MIN + jet*(JET_SPEED_MAX-JET_SPEED_MIN);
  const originX=g.x+dx*(GEN_R+1), originY=g.y+dy*(GEN_R+1); // just past the tip
  const n=pushBurst();
  for(let i=0;i<n;i++){
    const spread=(Math.random()-0.5)*0.5;
    const vx=dx*speed - dy*spread + (Math.random()-0.5)*0.15;
    const vy=dy*speed + dx*spread + (Math.random()-0.5)*0.15;
    spawnParticle(originX, originY, vx, vy, g.spawnId);
  }
}

export function tickGenerators(){
  const fire=genFireChance();
  for(const g of generators){
    if(Math.random()>fire) continue;
    if(g.emit==="push"){ emitSpring(g); }
    else { const b=pushBurst(); for(let i=0;i<b;i++) if(!emitSeep(g)) break; }
  }
}
