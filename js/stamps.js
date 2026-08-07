"use strict";
/* ZODIAC DRIFT 0.16 — modular split, Phase 4b.
   A stamp is a small pixel design that drops as ONE rigid body and, on
   touching solid ground, dissolves into ordinary grid cells (via the
   solidified-twin materials, see materials.js). Mechanically it's an
   entity — the material system has no concept of "N cells move
   together" and entities already do.

   Render-only pieces (drawStampGhost/drawStamps/drawStampPreview) are
   NOT here — those belong to render.js (Phase 6), same split as the
   rest of this app: this module is data + physics only. */
import { W, H, idx, inB, grid, entities, temp, SPAWN_TEMP_DEFAULT,
         skeletonMask, skeletonPlacements, setSkeletonPlacements } from "./state.js";
import { MATS, MATBY, EMPTY, STONE, STAMP_TWIN, isBuiltAt } from "./materials.js";
import { beginAction, commitAction, recordCell, clearSettling, wake, hasPendingAction } from "./physics.js";
import { E_GRAV, E_DRAG, applyFields } from "./entities.js";

export const STAMP_SIZE=8;              // default size for a NEW stamp in the Forge
export const MAX_STAMP_DIM=32;          // sane upper bound per axis

/* Seed designs are authored as row-strings — one legend char per
   material, '.' = empty. Custom stamps made in the Forge live in
   localStorage, not here. */
export const STAMP_LEGEND={ "S":"Stone", "s":"Sand", "W":"Water", "A":"Phlogiston", "F":"Starfall", "G":"Ghost Tide", "w":"Wood", "C":"Crystal" };
export function stampFromRows(name, rows, opts){
  const h=rows.length, w=rows[0].length;
  const cells=new Array(w*h).fill(EMPTY);
  rows.forEach((row,y)=>{ [...row].forEach((ch,x)=>{
    if(ch===".") return;
    const M=MATS.find(m=>m.name===STAMP_LEGEND[ch]);
    if(M) cells[y*w+x]=M.id;
  });});
  return { name, cells, w, h, seed:true, ...opts };
}
export const SEED_STAMPS=[
  stampFromRows("Keystone",[      // a small stone arch
    "........",
    "..SSSS..",
    ".SS..SS.",
    ".S....S.",
    ".S....S.",
    ".S....S.",
    ".S....S.",
    "........"]),
  stampFromRows("Starcairn",[     // a marker tower, starfall-tipped
    "...F....",
    "...S....",
    "..SSS...",
    "..SsS...",
    "..SsS...",
    ".SSsSS..",
    ".SsssS..",
    "SSSSSSS."]),
  stampFromRows("Tidewell",[      // stone basin, pooled Water
    "........",
    "..SSSS..",
    ".SWWWWS.",
    ".SWWWWS.",
    ".SWWWWS.",
    ".SWWWWS.",
    ".SSSSSS.",
    "........"]),
  stampFromRows("Cinderbloom",[   // Starfall canopy, Stone trunk
    "..FFFF..",
    ".FFFFFF.",
    ".FFFFFF.",
    "..FFFF..",
    "...SS...",
    "...SS...",
    "...SS...",
    "........"]),
  stampFromRows("Veilrest",[      // Phlogiston dome on twin Stone pillars
    "........",
    "...AA...",
    "..AAAA..",
    ".AAAAAA.",
    ".S....S.",
    ".S....S.",
    ".SSSSSS.",
    "........"]),
];

/* ---- SKELETON SEEDS — same row-string authoring, flagged skeleton:true.
   Placeholder starter set, two pieces, just enough to build and test the
   landing path against; Crash names/designs the real roster himself per
   this project's standing convention. Deliberately small/simple (8x8,
   same footprint budget as the regular seeds) rather than sized to look
   "finished" — the point of this batch is to exercise placement/snapping/
   persistence, not to ship final architecture. */
export const SEED_SKELETON_STAMPS=[
  stampFromRows("Cottage",[
    "..wwww..",
    ".wwwwww.",
    "wwwwwwww",
    "SSSSSSSS",
    "S.S..S.S",
    "S.S..S.S",
    "S.S..S.S",
    "SSSSSSSS"], {skeleton:true}),
  stampFromRows("Watchtower",[
    "...CC...",
    "...CC...",
    "..SSSS..",
    "..S..S..",
    "..S..S..",
    "..S..S..",
    ".SS..SS.",
    "SSS..SSS"], {skeleton:true}),
];

/* ---- library: seeds (code) + customs (localStorage) ---- */
export const STAMP_STORE_KEY="zodiacdrift.stamps.v1";
export function loadCustomStamps(){
  try{
    const raw=localStorage.getItem(STAMP_STORE_KEY);
    if(!raw) return [];
    const arr=JSON.parse(raw);
    if(!Array.isArray(arr)) return [];
    return arr.filter(s=>s && s.name && Array.isArray(s.cells))
      .map(s=>{ const w=s.w||8, h=s.h||8; return s.cells.length===w*h ? {name:s.name, cells:s.cells, w, h} : null; })
      .filter(Boolean);
  }catch(e){ return []; }   // storage blocked or corrupted — start empty, don't die
}
export let customStamps=loadCustomStamps();
export function persistCustomStamps(){
  try{ localStorage.setItem(STAMP_STORE_KEY, JSON.stringify(customStamps)); }
  catch(e){ /* private-mode/quota — customs live for this session only */ }
}
export function stampLibrary(){ return [...SEED_STAMPS, ...customStamps]; }

// mergeStampsIntoLibrary's DOM refreshes (rebuildStampButtons/
// rebuildForgeLib) are a single pluggable hook — both always fired
// together in the original, never independently — set by ui.js.
let onLibraryChanged = () => {};
export function setOnLibraryChanged(fn){ onLibraryChanged = fn; }

/* ---- skeleton library: same seed+custom shape as the regular stamp
   library above, own storage key so the two never collide. A skeleton
   design otherwise IS a stamp — same {name,cells,w,h} shape, same Forge
   authoring tools whenever those get pointed at it — the ONLY thing
   skeleton:true changes is which landing function a placement calls
   (landSkeletonStamp below, not spawnStamp/dissolveStamp). */
export const SKELETON_STAMP_STORE_KEY="zodiacdrift.skeletonstamps.v1";
export function loadCustomSkeletonStamps(){
  try{
    const raw=localStorage.getItem(SKELETON_STAMP_STORE_KEY);
    if(!raw) return [];
    const arr=JSON.parse(raw);
    if(!Array.isArray(arr)) return [];
    return arr.filter(s=>s && s.name && Array.isArray(s.cells))
      .map(s=>{ const w=s.w||8, h=s.h||8; return s.cells.length===w*h ? {name:s.name, cells:s.cells, w, h, skeleton:true} : null; })
      .filter(Boolean);
  }catch(e){ return []; }
}
export let customSkeletonStamps=loadCustomSkeletonStamps();
export function persistCustomSkeletonStamps(){
  try{ localStorage.setItem(SKELETON_STAMP_STORE_KEY, JSON.stringify(customSkeletonStamps)); }
  catch(e){ /* private-mode/quota — customs live for this session only */ }
}
export function skeletonLibrary(){ return [...SEED_SKELETON_STAMPS, ...customSkeletonStamps]; }
let onSkeletonLibraryChanged = () => {};
export function setOnSkeletonLibraryChanged(fn){ onSkeletonLibraryChanged = fn; }

/* Shared by .zdc import and .isl load — hand this a raw array of
   {name,cells,w,h} and get back how many actually landed. Name
   collisions get a numeric suffix rather than clobbering what's there. */
export function mergeStampsIntoLibrary(list){
  let added=0;
  for(const s of (list||[])){
    if(!s || !s.name || !Array.isArray(s.cells)) continue;
    const w=s.w||8, h=s.h||8;
    if(s.cells.length!==w*h) continue;
    let name=String(s.name).slice(0,24), n=2;
    while(stampLibrary().some(x=>x.name===name)) name=String(s.name).slice(0,20)+" ("+(n++)+")";
    customStamps.push({name, cells:s.cells.map(v=>MATBY[v]?v:EMPTY), w, h});
    added++;
  }
  if(added){ persistCustomStamps(); onLibraryChanged(); }
  return added;
}

/* 90° clockwise on a w x h grid -> output is h x w. Rotation is baked
   into the entity's cells at spawn; stamps do not tumble in flight. */
export function rotateCells(cells, w, h){
  const outW=h;
  const out=new Array(w*h).fill(EMPTY);
  for(let y=0;y<h;y++)for(let x=0;x<w;x++)
    out[x*outW+(h-1-y)]=cells[y*w+x];
  return out;
}

/* footprint helpers — e.x/e.y is the stamp's center; grid anchor is the
   rounded top-left. All collision asks the same question the ship asks
   (solid or generator), cell by occupied cell. */
export function stampAnchor(x,y,w,h){ return [Math.round(x)-w/2, Math.round(y)-h/2]; }
export function stampBlockInfo(cells, w, h, x, y){
  const [gx,gy]=stampAnchor(x,y,w,h);
  let blocked=false, solid=false;
  for(let cy=0;cy<h;cy++)for(let cx=0;cx<w;cx++){
    if(cells[cy*w+cx]===EMPTY) continue;
    const wx=gx+cx, wy=gy+cy;
    if(!inB(wx,wy)){ blocked=true; if(wy>=H) solid=true; continue; }   // world floor sticks; walls/ceiling just block
    const b=MATBY[grid[idx(wx,wy)]].behavior;
    if(b==="solid"){ blocked=true; solid=true; }
    else if(b==="generator"){ blocked=true; }   // collide, don't stick
  }
  return {blocked, solid};
}
export function spawnStamp(design, x, y, rot){
  let cells=design.cells, w=design.w, h=design.h;
  for(let i=0;i<(rot%4);i++){ cells=rotateCells(cells,w,h); [w,h]=[h,w]; }
  if(stampBlockInfo(cells, w, h, x, y).blocked) return false;   // won't spawn inside stone/a generator/off-world
  entities.push({ kind:"stamp", x, y, vx:0, vy:0, angle:0, target:null, w, h, cells });
  return true;
}

export const STAMP_SNAP_MARGIN=6;   // cells past each footprint edge to search for built structure to snap flush against
export function snappedStampPos(design, rot, x, y){
  let cells=design.cells, w=design.w, h=design.h;
  for(let i=0;i<(rot%4);i++){ cells=rotateCells(cells,w,h); [w,h]=[h,w]; }
  const [gx,gy]=stampAnchor(x,y,w,h);
  let bestGap=Infinity, bestDX=0, bestDY=0;
  const tryEdge=(dx,dy,scan)=>{
    for(let d=1; d<=STAMP_SNAP_MARGIN; d++){
      if(scan(d)){ if(d-1<bestGap){ bestGap=d-1; bestDX=dx*(d-1); bestDY=dy*(d-1); } return; }
    }
  };
  tryEdge(-1,0, d=>{ for(let cy=0;cy<h;cy++) if(isBuiltAt(gx-d,gy+cy)) return true; return false; });
  tryEdge(1,0,  d=>{ for(let cy=0;cy<h;cy++) if(isBuiltAt(gx+w-1+d,gy+cy)) return true; return false; });
  tryEdge(0,-1, d=>{ for(let cx=0;cx<w;cx++) if(isBuiltAt(gx+cx,gy-d)) return true; return false; });
  tryEdge(0,1,  d=>{ for(let cx=0;cx<w;cx++) if(isBuiltAt(gx+cx,gy+h-1+d)) return true; return false; });
  if(bestGap===Infinity) return [x,y];
  return [x+bestDX, y+bestDY];
}

/* is there a resting-in-its-grace-window stamp under this world point? */
export function landedStampAt(x,y){
  for(const e of entities){
    if(e.kind!=="stamp" || !e.landed) continue;
    const [gx,gy]=stampAnchor(e.x,e.y,e.w,e.h);
    if(x>=gx && x<gx+e.w && y>=gy && y<gy+e.h) return e;
  }
  return null;
}

/* dissolve: fold the stamp into the plain grid as solidified-twin cells.
   Wrapped in its own undo action when possible — if an action is
   already open (a paint stroke in flight), the dissolve just isn't
   undoable that one time, never clobber someone else's pending action. */
export function dissolveStamp(e){
  const wrap=!hasPendingAction();
  if(wrap) beginAction('stamp-land');
  const [gx,gy]=stampAnchor(e.x,e.y,e.w,e.h);
  for(let cy=0;cy<e.h;cy++)for(let cx=0;cx<e.w;cx++){
    const cm=e.cells[cy*e.w+cx];
    if(cm===EMPTY) continue;
    const wx=gx+cx, wy=gy+cy;
    if(!inB(wx,wy)) continue;
    const b=MATBY[grid[idx(wx,wy)]].behavior;
    if(b==="solid"||b==="generator") continue;   // never eat terrain or devices; loose material gets buried
    recordCell(idx(wx,wy));
    grid[idx(wx,wy)]=STAMP_TWIN[cm] ?? STONE;   // permanent built-structure twin, immune to decompression
    // introduction: cm is the ORIGINAL source material for this cell
    // (the design's own paint, not the built-twin id it's becoming) —
    // spawnTempFor reads its spawnTemp directly, no need to go through
    // STAMP_ORIGIN's reverse lookup here since we already have it.
    temp[idx(wx,wy)] = MATBY[cm]?.spawnTemp!==undefined ? MATBY[cm].spawnTemp : SPAWN_TEMP_DEFAULT;
    clearSettling(idx(wx,wy));
    wake(wx,wy);
  }
  if(wrap) commitAction();
  e.dead=true;
}

/* ---- SKELETON LANDING PATH ----
   No entity, no gravity, no drop-and-dissolve — Build mode places a
   skeleton design directly where it's confirmed (see index.html's Build
   panel). "Landing" here just means: mark the footprint solid in
   skeletonMask, and tell render.js to bake the pixels into its own
   canvas. Nothing about this ever gets removed at runtime — matches
   "we probably don't ever need this layer destructible" — so there's
   no skeleton counterpart to dissolveStamp's undo wrapping; a skeleton
   placement is deliberately NOT part of the undo/redo stack. */

// Called by render.js (via setOnSkeletonPlaced) whenever a footprint
// actually lands, so it can paint those cells into its own baked
// canvas — kept as a pluggable hook rather than an import so stamps.js
// stays data+physics only, same discipline dissolveStamp's neighbors
// already follow (this file never imports render.js).
let onSkeletonPlaced = () => {};
export function setOnSkeletonPlaced(fn){ onSkeletonPlaced = fn; }
// Fired once at the START of rebuildSkeletonFromPlacements, before any
// cell gets replayed — render.js wires this to clearSkeletonCanvas so a
// freshly loaded island doesn't inherit the PREVIOUS island's baked
// pixels (paintSkeletonFootprint only ever draws, it never erases).
let onSkeletonReset = () => {};
export function setOnSkeletonReset(fn){ onSkeletonReset = fn; }

/* Blocking check for a skeleton footprint: blocked by world edges, any
   existing solid/generator grid content, AND any already-placed
   skeleton cell (two buildings can't overlap). Deliberately its own
   function rather than reusing stampBlockInfo — that one's "solid"
   flag means "stick here," which has no meaning for something that
   never falls in the first place. */
export function skeletonBlockInfo(cells, w, h, x, y){
  const [gx,gy]=stampAnchor(x,y,w,h);
  let blocked=false;
  for(let cy=0;cy<h;cy++)for(let cx=0;cx<w;cx++){
    if(cells[cy*w+cx]===EMPTY) continue;
    const wx=gx+cx, wy=gy+cy;
    if(!inB(wx,wy)){ blocked=true; continue; }
    if(skeletonMask[idx(wx,wy)]){ blocked=true; continue; }
    const b=MATBY[grid[idx(wx,wy)]].behavior;
    if(b==="solid"||b==="generator") blocked=true;
  }
  return {blocked};
}

/* The actual write: flips mask cells and fires the render hook. Shared
   by landSkeletonStamp (a fresh player placement) and
   rebuildSkeletonFromPlacements (replaying a save) — the two differ
   only in whether skeletonPlacements gets appended to, so that's the
   one thing NOT done in here. */
function applySkeletonPlacement(design, x, y, rot){
  let cells=design.cells, w=design.w, h=design.h;
  for(let i=0;i<(rot%4);i++){ cells=rotateCells(cells,w,h); [w,h]=[h,w]; }
  const [gx,gy]=stampAnchor(x,y,w,h);
  for(let cy=0;cy<h;cy++)for(let cx=0;cx<w;cx++){
    if(cells[cy*w+cx]===EMPTY) continue;
    const wx=gx+cx, wy=gy+cy;
    if(!inB(wx,wy)) continue;
    skeletonMask[idx(wx,wy)]=1;
  }
  onSkeletonPlaced(cells, w, h, gx, gy);
}

/* Public entry point for a live placement (Build panel's confirm
   button). Returns false without touching anything if the footprint is
   blocked, same contract as spawnStamp. */
export function landSkeletonStamp(design, x, y, rot){
  let cells=design.cells, w=design.w, h=design.h;
  for(let i=0;i<((rot||0)%4);i++){ cells=rotateCells(cells,w,h); [w,h]=[h,w]; }
  if(skeletonBlockInfo(cells, w, h, x, y).blocked) return false;
  applySkeletonPlacement(design, x, y, rot||0);
  skeletonPlacements.push({ name:design.name, x:Math.round(x), y:Math.round(y), rot:(rot||0)%4 });
  return true;
}

/* Load-time replay: rebuild skeletonMask + render.js's canvas from a
   saved placement list, WITHOUT re-appending to skeletonPlacements
   (setSkeletonPlacements below does that wholesale). Looks a design up
   by name across both libraries — a placement references its design by
   name, not by object identity, so this is the one place a renamed or
   deleted seed design would silently drop a placement; not handled
   specially here, same "warn and move on" spirit as decodeGridRLE's
   missing-material fallback, just without a warning surface to write
   to at load time yet. */
export function rebuildSkeletonFromPlacements(placements){
  skeletonMask.fill(0);
  onSkeletonReset();
  const lib=[...stampLibrary(), ...skeletonLibrary()];
  for(const p of (placements||[])){
    const design=lib.find(d=>d.name===p.name);
    if(!design) continue;
    applySkeletonPlacement(design, p.x, p.y, p.rot||0);
  }
  setSkeletonPlacements(placements||[]);
}

/* per-frame physics for one stamp — called from entities.js's
   stepEntities via setStepStampFn. Gravity, field tug, near-vacuum
   coast: same forces as a ship, but collision is the whole footprint,
   not a point, and downward-blocked-by-solid means land-and-dissolve
   instead of rest. */
export const STAMP_GRACE_MS=5000;   // how long a landed-but-undissolved stamp stays pickable before it dissolves on its own
export function stepStamp(e){
  if(e.held) return;   // being long-press-dragged — position set directly by the input handler
  if(e.landed){         // resting in its post-landing grace window
    if(performance.now()-e.landedAt > STAMP_GRACE_MS) dissolveStamp(e);
    return;
  }
  if(!e.ignoreGravity) e.vy+=E_GRAV;
  if(!e.ignoreFields) applyFields(e);
  e.vx*=E_DRAG; e.vy*=E_DRAG;
  let nx=e.x+e.vx, ny=e.y+e.vy;
  if(stampBlockInfo(e.cells, e.w, e.h, nx, e.y).blocked){ e.vx=0; nx=e.x; }
  const down=stampBlockInfo(e.cells, e.w, e.h, nx, ny);
  if(down.blocked){
    if(e.vy>0 && down.solid){ e.x=nx; e.vx=0; e.vy=0; e.landed=true; e.landedAt=performance.now(); return; }
    e.vy=0; ny=e.y;
  }
  e.x=nx; e.y=ny;
  e.x=Math.max(e.w/2, Math.min(W-e.w/2, e.x));
  e.y=Math.max(e.h/2, Math.min(H-e.h/2, e.y));
}
