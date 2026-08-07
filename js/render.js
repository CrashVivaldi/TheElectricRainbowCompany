"use strict";
/* ZODIAC DRIFT 0.16 — modular split, Phase 6.
   Everything that draws to the two canvases (base/glow),
   plus camera-follow. Reads state, never writes gameplay state — the one
   exception is camera-follow's own clamp, same as the original.

   Grabs its own canvas elements directly (base/glow, by ID) —
   a minimal, intrinsic DOM touch (you need a canvas to draw to), not
   worth hook-injecting the way updateRoleUI/updateFlightUI were. index.html
   (Phase 7) provides those three canvas elements with the same IDs the
   original file used. */
import { W, H, VIEW_W, VIEW_H, camera, clampCamera, clampCameraScale, inB,
         idx, grid, hash2i, shipFlightState, generators, fields, entities,
         particles, stampMode, stampPlacing, px, py,
         temp, TEMPERATURE_ENABLED, skySources, TESLA_RADIUS,
         TEMP_COLD_START, TEMP_COLD_FULL, TEMP_HOT_START, TEMP_HOT_FULL,
         TEMP_GLOW_START, TEMP_GLOW_FULL, GAS_BLUR_FACTOR,
         FIRE_FLICKER_TICKS_PER_FRAME, FIRE_FLICKER_MIN, FIRE_FLICKER_RANGE, FIRE_FLICKER_YELLOW,
         SUBCHUNK_SIZE, SUBCHUNKS_X, SUBCHUNKS_Y, subchunkDirty, subchunkIndexAt,
         skeletonMask, buildMode, buildPlacing,
         beamActive, BEAM_RADIUS_LEVELS, beamRadiusLevel, shipBlobs,
         BLOB_BLUR_PX, BLOB_GLOW_BRIGHTNESS, BLOB_GLOW_SATURATION,
         BEAM_BLUR_PX, BEAM_GLOW_BRIGHTNESS, BEAM_GLOW_SATURATION,
         NONEMISSIVE_GLOW_MULT } from "./state.js";
import { MATS, MATBY, EMPTY, STAMP_TWIN_IDS } from "./materials.js";
import { frame, GEN_R } from "./physics.js";
import { activeShip, FIELD_R, FIELD_SOLID_R, SHIP_BOB_AMPLITUDE, SHIP_BOB_SPEED, BLOB_SPECK_SIZE } from "./entities.js";
import { rotateCells, stampAnchor, stampBlockInfo, snappedStampPos,
         setOnSkeletonPlaced, setOnSkeletonReset, skeletonBlockInfo } from "./stamps.js";

/* ================= starfield backdrop =================
   World-space so stars stay put as you pan, rather than sliding with
   the screen. */
const stars=[];
const STAR_COUNT = Math.round(120 * (W*H)/(VIEW_W*VIEW_H));
for(let i=0;i<STAR_COUNT;i++) stars.push([Math.floor(Math.random()*W), Math.floor(Math.random()*H), 30+Math.random()*70]);

/* ================= camera follow =================
   PILOT tracks the ship — a state where it's moving under something
   other than manual pan. HOVER/DISEMBARK leave the camera fully manual
   so a two-finger pan never fights a lerp trying to recenter every tick. */
const CAMERA_FOLLOW_LERP=0.08;
export function updateCameraFollow(){
  if(shipFlightState!=="pilot") return;
  const ship=activeShip();
  if(!ship) return;
  const targetX=ship.x-VIEW_W*camera.scale/2, targetY=ship.y-VIEW_H*camera.scale/2;
  camera.x += (targetX-camera.x)*CAMERA_FOLLOW_LERP;
  camera.y += (targetY-camera.y)*CAMERA_FOLLOW_LERP;
  // Full clamp only while the ship is still over the world — past an
  // edge there's nothing to clamp position against.
  if(inB(Math.round(ship.x), Math.round(ship.y))) clampCamera();
  else clampCameraScale();
}

/* ================= tile prototype =================
   PROTOTYPE — see figgy-handoff.md / project chat "let's talk tiles".
   REWRITE: tiles are now anchored to WORLD cells, not view cells. The
   first version wrote a fixed TILE_PX×TILE_PX block per VIEW-cell (a
   screen-space unit that never changes size) — that's wrong once zoom
   departs from 1:1, because a world cell can span MORE than one view-cell
   (zoomed in) or LESS than one (zoomed out). Screen-space blocks don't
   track that, so a zoomed-in world cell got several view-cells each
   independently re-stamping the same small tile — tessellation, not
   scaling. The fix: figure out which world cells are actually visible,
   and drawImage() each one's tile bitmap stretched to fill exactly that
   cell's current on-screen footprint. One tile per cell, always, sized
   by zoom automatically via drawImage's own dest-rect scaling.
   This only matters for things with actual internal PATTERN (tile art).
   Flat computed colors (void, edge glow, rainbow, glow bloom, gas haze,
   particles, stars, sky) don't tessellate — a solid color block looks
   identical whether you draw it in one piece or ten, so those all stay
   on the cheap per-view-cell raw-pixel path below, untouched.
   Trade-off from this rewrite: per-cell temp-tint recoloring and shimmer
   no longer apply to the crisp tile art itself (drawImage can't cheaply
   do the old per-pixel additive blend). Heat GLOW (the bloom layer) is
   unaffected — it's computed independently and still works normally in
   both modes. Flat/legacy mode (zoomed out past threshold) also keeps
   full tint+shimmer, since it never used tile art in the first place.
   TILE_PX is the fixed size tile ART is authored/generated at (8x8).
   `renderScale` toggles between 1 (legacy flat, exact pre-tile behavior)
   and TILE_PX (tiled detail active), based on zoom — this is really just
   "how big is the base pixel buffer," now separate from tile placement. */
const TILE_PX = 8;
export let tileZoomThreshold = 1.2;
export function setTileZoomThreshold(v){ tileZoomThreshold=v; }
export let tilesEnabled = false;              // master on/off — false always uses the legacy flat path regardless of zoom. Off by default (was true) — quick-access drawer + Tuning sheet both let it be flipped back on.
export function setTilesEnabled(v){ tilesEnabled=!!v; }
export let gasHazeOnly = true;                // true: gas cells skip the crisp tile draw entirely, relying only on the blurred haze layer below
export function setGasHazeOnly(v){ gasHazeOnly=!!v; }
export let tileAnimationsEnabled = false;      // false pins every animated tile to its frame 0, static tiles unaffected either way. Off by default (was true), same reasoning as tilesEnabled above.
export function setTileAnimationsEnabled(v){ tileAnimationsEnabled=!!v; }
// Vector-overlay resolution multiplier — RELATIVE to renderScale, not an
// independent basis. vecOverlay's actual buffer size each frame is
// VIEW_W*renderScale*VECTOR_SCALE (see resizeVecOverlay below), so
// VECTOR_SCALE=1 is a true no-op: pixel-identical crispness to what
// bctx already provides today, in EITHER zoom mode (flat renderScale=1
// or tiled renderScale=TILE_PX). This is deliberate — it's meant as a
// live A/B slider ("how much sharper than today"), not a fixed target
// resolution, so 1 has to mean "unchanged" in both zoom states or the
// comparison lies. No clamp against renderScale compounding with this
// (e.g. TILE_PX=8 tiled mode * VECTOR_SCALE=4 = 32x/axis, 1024x the
// pixel area of flat mode) — deliberately left open since Crash is
// testing this live on-device and wants to see the real cost, not a
// pre-guessed ceiling. Flagged, not solved.
export let VECTOR_SCALE = 1;
export function setVectorScale(v){ VECTOR_SCALE=v; resizeVecOverlay(); }
let renderScale = TILE_PX;                          // current active base-buffer pixels-per-view-cell (1 or TILE_PX)
let BW = VIEW_W*renderScale, BH = VIEW_H*renderScale;

const tileCache = new Map();   // matIndex -> {frames:[HTMLCanvasElement TILE_PX×TILE_PX], frameCount, ticksPerFrame}
function clamp255(v){ return v<0?0:v>255?255:v; }
// Wraps a raw pixel buffer into a small offscreen canvas so it can be used
// as a drawImage() source — drawImage is what does the actual per-world-
// cell scaling now, so tile "frames" need to be image-like, not raw arrays.
function pixelsToCanvas(buf){
  const c=document.createElement("canvas"); c.width=TILE_PX; c.height=TILE_PX;
  c.getContext("2d").putImageData(new ImageData(buf, TILE_PX, TILE_PX), 0, 0);
  return c;
}
function makeFlatTile(rgb){
  const buf=new Uint8ClampedArray(TILE_PX*TILE_PX*4);
  for(let i=0;i<TILE_PX*TILE_PX;i++){ const o=i*4; buf[o]=rgb[0]; buf[o+1]=rgb[1]; buf[o+2]=rgb[2]; buf[o+3]=255; }
  return pixelsToCanvas(buf);
}
// Simulated translucency for materials flagged M.translucent — blends the
// material's own color toward a light neutral tone rather than actually
// compositing against whatever's behind the cell. Still a fully opaque
// baked tile (alpha 255 like every other tile), so this needs zero changes
// to the dirty-rect/subchunk-cache system. NOT real see-through — a true
// alpha-composited version would need paintSubchunk to know what's
// genuinely behind a dirty cell each repaint, which the current
// "just overwrite" dirty-rect contract doesn't guarantee. That's a
// separate, bigger project if ever wanted.
const TRANSLUCENT_BLEND = 0.45;   // 0 = material's own color, 1 = fully the neutral tone
const TRANSLUCENT_NEUTRAL = [225,228,232];
function makeTranslucentTile(rgb){
  const blended = [
    rgb[0]+(TRANSLUCENT_NEUTRAL[0]-rgb[0])*TRANSLUCENT_BLEND,
    rgb[1]+(TRANSLUCENT_NEUTRAL[1]-rgb[1])*TRANSLUCENT_BLEND,
    rgb[2]+(TRANSLUCENT_NEUTRAL[2]-rgb[2])*TRANSLUCENT_BLEND,
  ];
  return makeFlatTile(blended);
}
function makeConcentricTile(rgb){
  const buf=new Uint8ClampedArray(TILE_PX*TILE_PX*4);
  // Three nested squares, outer to inner: base (Stone's actual color, no
  // tint), a lighter square inset by a 2px border of base, and a center
  // square sitting tonally between the two. Not meant as final art — this
  // just replaces the diagnostic checkerboard with something structured
  // enough to actually judge how tile detail reads while zooming, without
  // the checker's own repeating-noise texture fighting that judgment.
  const base=rgb;
  const light=[Math.min(255,rgb[0]*1.9+30), Math.min(255,rgb[1]*1.9+30), Math.min(255,rgb[2]*1.9+30)];
  const mid=[(base[0]+light[0])/2, (base[1]+light[1])/2, (base[2]+light[2])/2];
  const BORDER=2;
  const centerInset=BORDER+Math.floor((TILE_PX-2*BORDER)/4);
  for(let ty=0;ty<TILE_PX;ty++)for(let tx=0;tx<TILE_PX;tx++){
    let c;
    if(tx<BORDER||tx>=TILE_PX-BORDER||ty<BORDER||ty>=TILE_PX-BORDER) c=base;
    else if(tx<centerInset||tx>=TILE_PX-centerInset||ty<centerInset||ty>=TILE_PX-centerInset) c=light;
    else c=mid;
    const o=(ty*TILE_PX+tx)*4;
    buf[o]=c[0]; buf[o+1]=c[1]; buf[o+2]=c[2]; buf[o+3]=255;
  }
  return pixelsToCanvas(buf);
}
// ---- Fire's flicker frames: irregular baked-once flicker, not
// Water's smooth sine — fire should read as erratic, not liquid.
// Math.random() here only runs when this is called (module load, or a
// tuning-slider rebuild), so the flicker pattern is fixed until the next
// rebuild, same as every other cached tile — never re-rolled live per
// actual render frame. Reads the live FIRE_FLICKER_* tunables so the
// Sandbox's own sliders (which call rebuildFireTile() below on change)
// take effect immediately.
function buildFireTileEntry(M){
  const frames=[]; const FRAME_COUNT=6;
  for(let f=0; f<FRAME_COUNT; f++){
    const k = FIRE_FLICKER_MIN + FIRE_FLICKER_RANGE*Math.random();
    const y = Math.random()*FIRE_FLICKER_YELLOW;
    frames.push(makeFlatTile([
      Math.min(255,M.rgb[0]*k),
      Math.min(255,M.rgb[1]*(k+y)),
      Math.min(255,M.rgb[2]*k*0.8),
    ]));
  }
  return {frames, frameCount:FRAME_COUNT, ticksPerFrame:FIRE_FLICKER_TICKS_PER_FRAME};
}
/* Keyed by M.id, NOT by array position. These used to be the same number
   for every material, so writing with the forEach index and reading with
   `tileCache.get(gridCellValue)` worked by coincidence — nothing enforced
   the invariant. Twin ids now allocate downward from 255 (see the twin
   block in materials.js), so position and id genuinely diverge and the
   index form would hand back the wrong artwork, or none. */
/* One material's tile art, factored out of buildTileCache so a single
   material can be regenerated after an edit (see rebuildTileFor) rather
   than rebuilding all 118. Tiles were previously baked once at load and
   never touched again, which was fine when nothing could recolor a
   material at runtime — the material editor can, so a color change would
   otherwise be invisible at any zoom where tiles are drawn. */
function buildTileEntryFor(M){
  if(M.name==="Stone"){
    return {frames:[makeConcentricTile(M.rgb)], frameCount:1, ticksPerFrame:1};
  } else if(M.name==="Water"){
    const frames=[];
    for(let f=0; f<4; f++){
      const k=0.85+0.3*Math.sin(f/4*Math.PI*2);
      frames.push(makeFlatTile([Math.min(255,M.rgb[0]*k),Math.min(255,M.rgb[1]*k),Math.min(255,M.rgb[2]*k)]));
    }
    return {frames, frameCount:4, ticksPerFrame:6};
  } else if(M.name==="Fire"){
    return buildFireTileEntry(M);
  } else if(M.translucent){
    return {frames:[makeTranslucentTile(M.rgb)], frameCount:1, ticksPerFrame:1};
  }
  return {frames:[makeFlatTile(M.rgb)], frameCount:1, ticksPerFrame:1};
}
/* Regenerate the tile art for one material id (and nothing else). Safe
   to call on a void/generator id or an unknown one — no-ops. */
export function rebuildTileFor(id){
  const M = MATBY[id];
  if(!M || M.behavior==="void" || M.behavior==="generator") return;
  tileCache.set(M.id, buildTileEntryFor(M));
}
function buildTileCache(){
  MATS.forEach(M=>{
    if(M.behavior==="void"||M.behavior==="generator") return;
    if(M.name==="Stone"){
      tileCache.set(M.id,{frames:[makeConcentricTile(M.rgb)], frameCount:1, ticksPerFrame:1});
    } else if(M.name==="Water"){
      const frames=[];
      for(let f=0; f<4; f++){
        const k=0.85+0.3*Math.sin(f/4*Math.PI*2);
        frames.push(makeFlatTile([Math.min(255,M.rgb[0]*k),Math.min(255,M.rgb[1]*k),Math.min(255,M.rgb[2]*k)]));
      }
      tileCache.set(M.id,{frames, frameCount:4, ticksPerFrame:6});
    } else if(M.name==="Fire"){
      tileCache.set(M.id, buildFireTileEntry(M));
    } else if(M.translucent){
      tileCache.set(M.id,{frames:[makeTranslucentTile(M.rgb)], frameCount:1, ticksPerFrame:1});
    } else {
      tileCache.set(M.id,{frames:[makeFlatTile(M.rgb)], frameCount:1, ticksPerFrame:1});
    }
  });
}
buildTileCache();
// Regenerates only Fire's cached frames — called by the Sandbox's own
// flicker sliders after they change a FIRE_FLICKER_* tunable, so the
// change is visible immediately without rebuilding every other
// material's tile (which never change after load).
export function rebuildFireTile(){
  const M = MATS.find(m=>m.name==="Fire");
  if(M) tileCache.set(M.id, buildFireTileEntry(M));
}

/* ================= subchunk render cache (HANDOFF #8) =================
   The actual fix for the tile-draw-call cost: instead of one drawImage()
   per visible WORLD CELL every single frame (the render() loop below used
   to do this directly), each SUBCHUNK_SIZE×SUBCHUNK_SIZE block of world
   cells gets its own small offscreen canvas, painted once and reused
   across frames until something in it actually changes — one drawImage()
   per SUBCHUNK instead of per cell. state.js's subchunkDirty (flipped by
   physics.js's wake() — see that file) tells us WHEN a block changed.
   That alone isn't sufficient, though: animated tiles (Fire's flicker,
   Water's shimmer) change their VISIBLE frame every few real frames
   with no grid mutation and thus no wake() call at all — a block holding
   any animated material has to keep repainting on its own cadence
   regardless of dirty state, tracked here as subchunkAnimated. This is
   deliberately re-derived every time a block actually repaints (not
   maintained incrementally) — cheap, and self-correcting the moment a
   Fire cell finally burns out and the block stops needing it. */
export let subchunksEnabled = true;   // false: falls back to the old exact per-cell path, for direct on-device A/B against this cache
export function setSubchunksEnabled(v){ subchunksEnabled=!!v; }
let subchunkCanvases = new Map();     // subchunk index -> HTMLCanvasElement, (bw*TILE_PX)×(bh*TILE_PX)
let subchunkAnimated = new Uint8Array(SUBCHUNKS_X*SUBCHUNKS_Y);
export let subchunkPaintsLastFrame = 0;   // diagnostic only — Sandbox HUD reads this to judge cache effectiveness on-device
// Called by the Sandbox slider right after state.js's setSubchunkSize()
// reshapes the dirty-bit grid — this module's canvases and animated-flag
// array are keyed to the OLD block boundaries and would misdraw against
// the new ones, so they're thrown away rather than reused. subchunkDirty
// itself is already fresh-and-fully-dirty from setSubchunkSize, so
// everything visible just repaints once, same cost as a fresh load.
export function resetSubchunkCache(){
  subchunkCanvases.clear();
  subchunkAnimated = new Uint8Array(SUBCHUNKS_X*SUBCHUNKS_Y);
}
function paintSubchunk(sci, bx0, by0, bw, bh){
  const wpx=bw*TILE_PX, hpx=bh*TILE_PX;
  let canvas=subchunkCanvases.get(sci);
  if(!canvas){
    canvas=document.createElement("canvas"); canvas.width=wpx; canvas.height=hpx;
    subchunkCanvases.set(sci,canvas);
  } else if(canvas.width!==wpx || canvas.height!==hpx){
    canvas.width=wpx; canvas.height=hpx;   // only hit for an edge block when SUBCHUNK_SIZE doesn't evenly divide W/H — defensive, not the common case at 8/12/16
  }
  const cctx=canvas.getContext("2d");
  cctx.imageSmoothingEnabled=false;
  cctx.clearRect(0,0,wpx,hpx);
  let animated=false;
  for(let ly=0; ly<bh; ly++){
    const wy=by0+ly;
    for(let lx=0; lx<bw; lx++){
      const wx=bx0+lx;
      const m=grid[idx(wx,wy)];
      if(m===EMPTY) continue;
      const M=MATBY[m];
      if(M.behavior==="generator"||M.rainbow) continue;   // no tile art — already fully drawn by the view-cell pass in render()
      if(M.behavior==="gas" && gasHazeOnly) continue;      // haze-only mode: the blurred layer IS the gas, no crisp tile under it
      const tile=tileCache.get(m);
      if(tileAnimationsEnabled && tile.frameCount>1) animated=true;
      const tf=(tileAnimationsEnabled && tile.frameCount>1) ? tile.frames[Math.floor(frame/tile.ticksPerFrame)%tile.frameCount] : tile.frames[0];
      cctx.drawImage(tf, 0,0,TILE_PX,TILE_PX, lx*TILE_PX, ly*TILE_PX, TILE_PX, TILE_PX);
    }
  }
  subchunkAnimated[sci]=animated?1:0;
  subchunkDirty[sci]=0;
  subchunkPaintsLastFrame++;
}
// Draws every visible subchunk into bctx, repainting first whichever ones
// are dirty or animated. Same coordinate math as the old per-cell loop
// (cell-space dest under bctx's active renderScale transform), just
// blitting a whole cached block per call instead of one cell.
function drawSubchunks(wx0,wx1,wy0,wy1,sc){
  subchunkPaintsLastFrame=0;
  const scx0=Math.max(0, Math.floor(wx0/SUBCHUNK_SIZE));
  const scx1=Math.min(SUBCHUNKS_X-1, Math.floor(Math.max(wx0,wx1-1)/SUBCHUNK_SIZE));
  const scy0=Math.max(0, Math.floor(wy0/SUBCHUNK_SIZE));
  const scy1=Math.min(SUBCHUNKS_Y-1, Math.floor(Math.max(wy0,wy1-1)/SUBCHUNK_SIZE));
  for(let scy=scy0; scy<=scy1; scy++){
    for(let scx=scx0; scx<=scx1; scx++){
      const sci=scy*SUBCHUNKS_X+scx;
      const bx0=scx*SUBCHUNK_SIZE, by0=scy*SUBCHUNK_SIZE;
      const bw=Math.min(SUBCHUNK_SIZE, W-bx0), bh=Math.min(SUBCHUNK_SIZE, H-by0);
      if(subchunkDirty[sci] || subchunkAnimated[sci]) paintSubchunk(sci,bx0,by0,bw,bh);
      const canvas=subchunkCanvases.get(sci);
      if(!canvas) continue;   // block never had anything paintable in it (all EMPTY/generator/rainbow/hazed-gas) — nothing to blit
      // Both edges computed via the SAME formula shape used for bx0/by0
      // itself, not derived as sx+width — this is what makes adjacent
      // subchunks agree exactly on their shared border. bx0+bw of this
      // subchunk is numerically the same value as bx0 of its neighbor
      // (both equal scx*SUBCHUNK_SIZE for consecutive scx), so computing
      // "(that same value - camera.x)/sc" here and again as the
      // neighbor's own left edge gives bit-identical floats. Deriving the
      // width as a separate bw*cellSpan multiplication instead — the
      // previous version — does NOT guarantee that, since floating-point
      // (a-c)/s + b/s isn't bit-identical to (a+b-c)/s in general; the
      // resulting sub-pixel drift was invisible on the old per-cell path
      // (blended into a whole grid of tiny 1-cell seams) but became a
      // hard, visible line at 8-cell subchunk scale with
      // imageSmoothingEnabled off. This was the "lines at chunk borders
      // when stuff falls through them" bug.
      const sxL=(bx0-camera.x)/sc, sxR=((bx0+bw)-camera.x)/sc;
      const syT=(by0-camera.y)/sc, syB=((by0+bh)-camera.y)/sc;
      bctx.drawImage(canvas, 0,0, bw*TILE_PX, bh*TILE_PX, sxL, syT, sxR-sxL, syB-syT);
    }
  }
}

// flat block write — used for void/edge/generator/rainbow/glow layers/gas
// haze/particles/stars, AND for the material base fallback fill (both
// renderScale modes — the world-cell tile pass below draws crisp texture
// on TOP of this in tiled mode; this is just the safety-net color under
// it). Block size follows the current renderScale, not a fixed constant.
function fillBlock(arr, vx, vy, r,g,b,a){
  const ox=vx*renderScale, oy=vy*renderScale;
  for(let ty=0; ty<renderScale; ty++){
    let o=((oy+ty)*BW+ox)*4;
    for(let tx=0; tx<renderScale; tx++, o+=4){ arr[o]=r; arr[o+1]=g; arr[o+2]=b; arr[o+3]=a; }
  }
}
// additive/blend write for sky sources — reads existing block content (already
// painted by the main cell pass) and blends toward a target color, same math
// the old per-pixel version did, just repeated across the block.
function blendBlock(arr, vx, vy, color, a){
  const ox=vx*renderScale, oy=vy*renderScale;
  for(let ty=0; ty<renderScale; ty++){
    let o=((oy+ty)*BW+ox)*4;
    for(let tx=0; tx<renderScale; tx++, o+=4){
      arr[o]  +=(color[0]-arr[o])  *a;
      arr[o+1]+=(color[1]-arr[o+1])*a;
      arr[o+2]+=(color[2]-arr[o+2])*a;
    }
  }
}

/* ================= canvases ================= */
const base=document.getElementById("base"), glow=document.getElementById("glow");

/* ================= skeleton layer =================
   The whole point: a static canvas, baked once per placement, positioned
   with CSS transform instead of redrawn via drawImage every frame — zero
   per-frame draw cost regardless of how much is built. See state.js's
   skeleton-layer block for the data side (skeletonMask/skeletonPlacements)
   and stamps.js's landSkeletonStamp/rebuildSkeletonFromPlacements for how
   a placement gets here.
     Sized to the FULL WORLD at TILE_PX resolution (W*TILE_PX x H*TILE_PX
     — 2560x1536 at current W/H), not the viewport — panning/zooming never
   touches these pixels again after they're painted, only the CSS
   transform on the element wrapping them changes.
     document.getElementById returns null under any host page that hasn't
   added the #skeleton element yet (Game.html, at time of writing) —
   every function below no-ops gracefully in that case rather than
   throwing, so importing render.js never breaks a host that simply
   hasn't opted in to this layer yet. */
const skeletonCanvas = document.getElementById("skeleton");
const skeletonCtx = skeletonCanvas ? skeletonCanvas.getContext("2d") : null;
if(skeletonCanvas){
  skeletonCanvas.width = W*TILE_PX;
  skeletonCanvas.height = H*TILE_PX;
  skeletonCtx.imageSmoothingEnabled = false;
}
// Paints one placed footprint's cells into the bake canvas — called by
// stamps.js via setOnSkeletonPlaced, once per placement, never per
// frame. Uses the SAME tileCache art as the live grid (buildTileCache
// above), always frame 0 (a skeleton building doesn't animate — Water/
// Fire tile flicker would be pure per-frame cost for something that's
// supposed to cost nothing) — matches the "reuse the tiles we already
// have" ask directly.
export function paintSkeletonFootprint(cells, w, h, gx, gy){
  if(!skeletonCtx) return;
  for(let cy=0; cy<h; cy++) for(let cx=0; cx<w; cx++){
    const cm=cells[cy*w+cx];
    if(cm===EMPTY) continue;
    const tile=tileCache.get(cm);
    if(!tile) continue;
    const wx=gx+cx, wy=gy+cy;
    if(wx<0||wx>=W||wy<0||wy>=H) continue;
    skeletonCtx.drawImage(tile.frames[0], wx*TILE_PX, wy*TILE_PX);
  }
}
setOnSkeletonPlaced(paintSkeletonFootprint);
// Full repaint from scratch — used once, right after
// rebuildSkeletonFromPlacements (persistence.js's load path) replays
// every saved placement through applySkeletonPlacement/onSkeletonPlaced
// already, so in practice this clear is defensive (covers a re-load
// into an already-painted canvas) rather than load-bearing on a fresh
// page load, where the canvas starts blank anyway.
export function clearSkeletonCanvas(){
  if(!skeletonCtx) return;
  skeletonCtx.clearRect(0,0,skeletonCanvas.width, skeletonCanvas.height);
}
setOnSkeletonReset(clearSkeletonCanvas);
// Positions the (never-redrawn) skeleton canvas to match the live
// camera, purely via CSS transform — no pixel work here at all, just a
// style string, cheap enough to call every frame same as
// updateCameraFollow. transform-origin is set once, in CSS (index.html/
// Game.html's #skeleton rule), to "0 0" — required for this translate/
// scale math to land correctly.
//   Baseline size (set once, below, independent of camera) makes 1
// skeleton-canvas CSS pixel-per-TILE_PX-block equal exactly 1 world
// cell at camera.scale===1, matched to how #box's own children already
// fill it 1:1 at VIEW_W x VIEW_H. Scale then does the zoom, translate
// (applied AFTER scale in CSS's left-to-right transform-function order,
// i.e. added in the PARENT's unscaled pixel space) does the pan.
export function initSkeletonSizing(){
  if(!skeletonCanvas) return;
  skeletonCanvas.style.width  = (W/VIEW_W*100)+"%";
  skeletonCanvas.style.height = (H/VIEW_H*100)+"%";
}
initSkeletonSizing();
export function updateSkeletonTransform(){
  if(!skeletonCanvas) return;
  const box=skeletonCanvas.parentElement;
  if(!box) return;
  const boxW=box.clientWidth, boxH=box.clientHeight;
  if(!boxW || !boxH) return;   // not laid out yet (display:none, or before first paint)
  const zoom=1/camera.scale;
  const txPx = -(camera.x/camera.scale)/VIEW_W * boxW;
  const tyPx = -(camera.y/camera.scale)/VIEW_H * boxH;
  skeletonCanvas.style.transform = `translate(${txPx}px, ${tyPx}px) scale(${zoom})`;
}
const blobglow=document.getElementById("blobglow");
const laserglow=document.getElementById("laserglow");
const vecOverlay=document.getElementById("vecOverlay");
const bctx=base.getContext("2d"), gctx=glow.getContext("2d"),
      bgCtx=blobglow.getContext("2d"), lgCtx=laserglow.getContext("2d"),
      vecCtx=vecOverlay.getContext("2d");
let bimg, gimg;
let bd, gd, gasD;   // .data of bimg/gimg/gasImg — module-level (not per-call const) so paintCell/paintEdgeCell/zeroBlockRect below can reference them directly, same pattern renderScale/BW already use
// Gas blur layer — NOT attached to the DOM, just a compositing scratchpad.
// Gas cells get drawn here (transparent everywhere else), then this whole
// layer gets drawImage'd onto `base` with a native canvas blur filter, on
// top of the crisp tile pass. This is a real GPU-side blur, not a manual
// per-pixel JS convolution — cost is one drawImage call/frame, not a loop.
const gasCanvas=document.createElement("canvas");
const gasCtx=gasCanvas.getContext("2d");
let gasImg;
// Setting canvas.width/height clears content AND resets any transform, so
// this re-does both the size and the vector-overlay scale together. Only
// called when renderScale actually changes (i.e. crossing the zoom
// threshold), not per frame — resizing every frame would be wasteful and
// pointless since nothing here depends on anything but zoom level.
function resizeBuffers(newScale){
  renderScale=newScale;
  BW=VIEW_W*renderScale; BH=VIEW_H*renderScale;
  base.width=glow.width=blobglow.width=laserglow.width=BW;
  base.height=glow.height=blobglow.height=laserglow.height=BH;
  gasCanvas.width=BW; gasCanvas.height=BH;
  bimg=bctx.createImageData(BW,BH); gimg=gctx.createImageData(BW,BH);
  gasImg=gasCtx.createImageData(BW,BH);
  // Vector overlays (devices/fields/entities/stamps below) are all coded in
  // cell-space coordinates (0..VIEW_W/H) and don't know about renderScale at
  // all — putImageData ignores canvas transforms, so it's safe to just scale
  // these two contexts up, rather than editing every draw call.
  bctx.scale(renderScale,renderScale); gctx.scale(renderScale,renderScale);
  bgCtx.scale(renderScale,renderScale);   // #blobglow draws in the same cell-space coords as bctx/gctx
  lgCtx.scale(renderScale,renderScale);   // #laserglow, same deal
  // Resizing a canvas resets imageSmoothingEnabled too — needs reapplying
  // every time, same as the transform above. This is what keeps the new
  // world-cell drawImage tile pass crisp (nearest-neighbor) instead of
  // blurry when a tile gets stretched to fill a zoomed-in cell.
  bctx.imageSmoothingEnabled=false;
  resizeVecOverlay();
}
// #vecOverlay — the crisp vector layer (devices/fields/entities/stamps/
// ghosts, plus the crisp halves of the harvest beam and ship blobs), split
// out from bctx so it can carry its own resolution independent of the
// grid's. Deliberately sized as renderScale*VECTOR_SCALE, not an
// independent constant — VECTOR_SCALE=1 must be pixel-identical to
// today's bctx crispness in EITHER zoom mode for the tuning slider to be
// a real A/B comparison (see VECTOR_SCALE's own comment above). Called
// both from resizeBuffers (renderScale changed) and directly from
// setVectorScale (slider moved, renderScale unchanged) — unlike
// resizeBuffers itself, this can't wait for a zoom-threshold crossing.
function resizeVecOverlay(){
  const mult = renderScale*VECTOR_SCALE;
  vecOverlay.width = VIEW_W*mult;
  vecOverlay.height = VIEW_H*mult;
  vecCtx.scale(mult,mult);   // same cell-space coordinate convention as bctx/gctx — draw calls below don't change
}
resizeBuffers(TILE_PX);

// EDGE WARNING GRADIENT — no hard cut to void at a world edge, a red glow
// instead, strongest right at the boundary, fading out with distance.
const EDGE_RED=[196,26,38];
const EDGE_GLOW_FALLOFF=120;   // world cells of runway before it's fully faded to plain void

/* ================= temperature tint =================
   Deliberately on an ABSOLUTE scale, not relative to each material's own
   spawnTemp — two different materials mid-diffusion at the same actual
   temperature should read as the same warmth, since that's exactly what
   diffuseTemp (physics.js) is doing: treating heat as one universal
   currency between materials, not a per-material relative wobble. This
   is what makes the tint actually visualize the underlying system —
   watch a hot cell cool and you're watching the same numbers diffuseTemp
   is computing, not a cosmetic approximation of them.
   Cold and hot each have their own explicit start/full pair
   (TEMP_COLD_START/FULL, TEMP_HOT_START/FULL) — same shape as
   TEMP_GLOW_START/FULL below, deliberately NOT anchored to
   SPAWN_TEMP_DEFAULT/ambient. A cell between the two starts (e.g.
   ambient 20 sitting between hot-start 50 and cold-start 5) reads with
   zero tint — a real "neutral band," not a single neutral point.
   Incandescence (TEMP_GLOW_START/FULL below) is separate from tint: any
   material gets an emissive glow once hot enough, independent of its own
   `em` flag — a heated Stone wall genuinely glowing is the point, not
   a bug. Combines with an already-emissive material's own glow via max,
   never double-brightens it.
   Scoped OUT of the rainbow (Aether) branch below — that path already
   has its own dynamic hue cycle; layering a second, unrelated color
   system on top of it would just muddy both. */
const COLD_TINT = [90,150,255];
const HOT_TINT = [255,120,30];
function tempTint(r,g,b,t){
  if(t>=TEMP_HOT_START){
    const f=Math.min(1, (t-TEMP_HOT_START)/(TEMP_HOT_FULL-TEMP_HOT_START));
    return [r+(HOT_TINT[0]-r)*f, g+(HOT_TINT[1]-g)*f, b+(HOT_TINT[2]-b)*f];
  }
  if(t<=TEMP_COLD_START){
    const f=Math.min(1, (TEMP_COLD_START-t)/(TEMP_COLD_START-TEMP_COLD_FULL));
    return [r+(COLD_TINT[0]-r)*f, g+(COLD_TINT[1]-g)*f, b+(COLD_TINT[2]-b)*f];
  }
  return [r,g,b];
}

/* ================= FLAT-PATH DIRTY RECTS (site perf pass) =================
   The tile path above already has its own subchunk cache (paintSubchunk/
   drawSubchunks) — this is the equivalent for the plain per-cell color/
   shimmer/glow pass, which runs UNCONDITIONALLY on this site since
   tilesEnabled=false here (so renderScale is always 1, the tile path never
   engages). ON-DEVICE VERIFIED (Crash, this session): reproducing the
   heat/near-freeze symptom from heavy multi-material coverage got
   dramatically harder with this flag on — consistent with the KEY
   FINDING below (full always-repaint cost scales with how much of the
   visible world is covered in emissive/shimmering material, and this
   is what bounds that cost to the actually-active subchunks instead of
   the whole always-visible world). Default flipped ON on the strength
   of that test, same pattern subchunksEnabled already established.
     KEY FINDING that shaped this (now partially superseded — see below):
   this site's 18-item rainbow palette originally had sh>0 (shimmer,
   26-30 across the board) on every material, all also em:true (full
   glow) — checked directly against materials.js, not assumed. Shimmer
   was ZEROED OUT on all 18 in a later pass (Crash's call — not needed
   for the aesthetic), which turned out to matter far more than
   expected: `paintCell`'s animated-detection return is `s!==0 ||
   heatGlowF>0` — driven ONLY by shimmer and temperature-glow, NOT by
   em/glow itself, and TEMPERATURE_ENABLED is false on this site. With
   sh:0 across the whole palette, a settled subchunk now returns
   animated=false and stops costing anything at all past this frame,
   dirty-rects or not — glow was never actually the expensive part,
   shimmer's per-pixel Math.random() re-roll (and the animated-forever
   flag it forced) was. Dirty-rects is still real and still helps
   (bounds cost to genuinely-dirty subchunks even during active
   movement), but with shimmer gone it's doing much less work than it
   was written to do.
   is the second signal — re-derived every time a subchunk actually
   repaints, same self-correcting pattern the tile path's own
   subchunkAnimated already uses, just tracking different animation
   sources (shimmer/rainbow/heat-glow instead of multi-frame tile art).
   Bounded by MAX_LIVE_SAND (sand-bg.js) regardless: at most
   ~4000/SUBCHUNK_SIZE² subchunks can ever hold painted material, so the
   "always repaint" cost stays small even though it's real.
     SCOPED TO camera.scale===1 AND integer camera.x/y. At sc===1 with an
   integer camera origin, world-cell <-> screen-cell is an exact 1:1
   lattice (vx=wx-camera.x, invertible both ways with no rounding). At any
   other scale or a fractional camera position, the original per-screen-
   pixel Math.round(camera.x+vx*sc) mapping isn't cleanly invertible
   (multiple world cells can round to one screen pixel or vice versa) — a
   world-cell-driven loop would either duplicate or miss pixels. This site
   always uses scale=1 with a floored camera (sand-bg.js), so the fast
   path engages; anything else falls back to the legacy loop automatically
   rather than silently producing wrong output. */
export let flatDirtyRectsEnabled = true;
export function setFlatDirtyRectsEnabled(v){ flatDirtyRectsEnabled=!!v; }
let flatSubchunkAnimated = new Uint8Array(SUBCHUNKS_X*SUBCHUNKS_Y);
// Defensive symmetry with resetSubchunkCache — nothing on this site calls
// setSubchunkSize (that's the Sandbox dev-harness slider, not this site),
// so this never actually fires here, but a future caller reshaping
// SUBCHUNKS_X/Y without knowing to also reset THIS array would otherwise
// index it with stale dimensions.
export function resetFlatSubchunkCache(){
  flatSubchunkAnimated = new Uint8Array(SUBCHUNKS_X*SUBCHUNKS_Y);
}

// Extracted from the flat loop's old per-cell body so the dirty-rects path
// and the legacy full-repaint fallback share ONE implementation — nothing
// to drift between them, which is the whole point of using the legacy
// path as a trustworthy on-device A/B baseline. wx,wy must already be
// validated in-bounds (0<=wx<W, 0<=wy<H); the out-of-world edge-glow case
// is handled separately by paintEdgeCell below, it's screen-space, not a
// grid cell. Returns true if this cell's OWN visible output changes every
// frame with NO grid mutation (and thus no wake()/subchunkDirty signal) —
// shimmer, M.rainbow, or a temperature-driven heat-glow — which the
// dirty-rects path needs to know to keep a subchunk repainting even once
// nothing in it is physically moving.
function paintCell(vx, vy, wx, wy){
  const m=grid[idx(wx,wy)];
  if(m===EMPTY){
    // A skeleton building's footprint sits at otherwise-EMPTY grid cells
    // by construction (skeleton lives outside grid[] entirely — see
    // state.js). Leave base transparent there (alpha 0) instead of the
    // usual opaque void fill, so the skeleton canvas — painted once,
    // sitting behind base in the DOM, never redrawn — shows through.
    if(skeletonMask[idx(wx,wy)]){
      fillBlock(bd, vx, vy, 0,0,0, 0);
    } else {
      fillBlock(bd, vx, vy, 13,10,20, 255);
    }
    return false;
  }
  const M=MATBY[m];
  if(M.behavior==="generator"){
    fillBlock(bd, vx, vy, 13,10,20, 255);
    return false;
  }
  if(M.rainbow){
    // ELECTRIC RAINBOW MAGIC FORK — used to also feed a separate
    // aetherglow bloom layer here (fillBlock(agd,...)). Cut: agd was
    // written from exactly this one branch, gated on M.rainbow, and the
    // only material anywhere in materials.js with rainbow:true is Aether
    // itself — which isn't in this site's 10-item palette. The whole
    // aetherglow canvas/buffer/CSS-filter/tuning-sliders stack was
    // guaranteed-empty on this site, every frame, forever — not
    // redundant, actually dead. This base-color cycling stays; it's the
    // material's own paint color, unrelated to that separate bloom layer,
    // and costs nothing extra to leave working for whatever rainbow
    // material might get added to the palette later.
    const t=wx*0.05+wy*0.05+frame*0.02;
    let r=Math.sin(t)*110+140, g=Math.sin(t+2.094)*110+140, b=Math.sin(t+4.189)*110+140;
    const hsh=hash2i(wx,wy);
    if(hsh%40===0){
      const pulse=(Math.sin(frame*0.05+(hsh%1000)/1000*6.283)+1)/2;
      r+=(255-r)*pulse; g+=(255-g)*pulse; b+=(255-b)*pulse;
    }
    r=Math.max(0,Math.min(255,r)); g=Math.max(0,Math.min(255,g)); b=Math.max(0,Math.min(255,b));
    fillBlock(bd, vx, vy, r,g,b, 255);
    return true;   // hue cycles with `frame` every frame regardless of grid state
  }
  // per-cell shimmer + temp-tint computed ONCE, same as before. This flat
  // fill is now the FALLBACK/base color in both modes — in flat mode it's
  // the whole picture (unchanged from pre-tile behavior). Dissolved stamps
  // (STAMP_TWIN) skip shimmer entirely — built structure should read as
  // inert/static-free.
  const s = (STAMP_TWIN_IDS.has(m) || M.behavior==="solid") ? 0 : (Math.random()*2-1)*M.sh;
  const t=temp[idx(wx,wy)];
  const [tr,tg,tb]=TEMPERATURE_ENABLED ? tempTint(M.rgb[0],M.rgb[1],M.rgb[2],t) : M.rgb;
  const tileCoversThis = renderScale===TILE_PX && M.behavior!=="generator" && !(M.behavior==="gas" && gasHazeOnly);
  if(!tileCoversThis){
    fillBlock(bd, vx, vy, clamp255(tr+s), clamp255(tg+s), clamp255(tb+s), 255);
  }
  if(M.behavior==="gas"){
    fillBlock(gasD, vx, vy, clamp255(tr+s), clamp255(tg+s), clamp255(tb+s), 150);
    if(gasHazeOnly) fillBlock(bd, vx, vy, 13,10,20, 255);
  }
  const heatGlowF = (TEMPERATURE_ENABLED && t>TEMP_GLOW_START) ? Math.min(1, (t-TEMP_GLOW_START)/(TEMP_GLOW_FULL-TEMP_GLOW_START)) : 0;
  const emStrength = M.em ? 1 : (M.emAmt ? M.emAmt * NONEMISSIVE_GLOW_MULT : 0);
  if(emStrength>0 || heatGlowF>0){
    fillBlock(gd, vx, vy, tr, tg, tb, Math.max(Math.round(emStrength*255), Math.round(heatGlowF*255)));
  }
  // s!==0 iff M.sh!==0 and non-solid/non-stamp-twin (Math.random()*2-1
  // landing on EXACTLY 0 has ~zero real-world probability) — re-derived
  // every repaint same as the rainbow case above, so a rare miss just
  // self-corrects next frame rather than sticking wrong.
  return s!==0 || heatGlowF>0;
}

// Out-of-world edge-glow pixel — pure screen-space, no grid cell backs it,
// so it can never be subchunk-tracked; always needs repainting every frame
// regardless of dirty state (the pulse term below is frame-driven). pulse
// is passed in rather than recomputed per pixel — it depends only on
// `frame`, identical for every pixel in the edge band, so hoisting it out
// to be computed ONCE per render() call (both paths do this now) instead
// of once per pixel (up to ~86,000 redundant Math.sin() calls/frame on
// this site's actual camera position) was a free, zero-risk fix
// independent of the bigger dirty-rects work.
function paintEdgeCell(vx, vy, wx, wy, pulse){
  let exX=0; if(wx<0) exX=-wx; else if(wx>=W) exX=wx-W+1;
  let exY=0; if(wy<0) exY=-wy; else if(wy>=H) exY=wy-H+1;
  const dist=Math.max(exX,exY);
  const t=Math.min(1, dist/EDGE_GLOW_FALLOFF + pulse);
  fillBlock(bd, vx, vy,
    Math.round(EDGE_RED[0]+(13-EDGE_RED[0])*t),
    Math.round(EDGE_RED[1]+(10-EDGE_RED[1])*t),
    Math.round(EDGE_RED[2]+(20-EDGE_RED[2])*t), 255);
  fillBlock(gd, vx, vy, EDGE_RED[0], EDGE_RED[1], EDGE_RED[2], Math.round(180*(1-t)));
}

// Zero a screen-space rect [vx0,vx1)x[vy0,vy1) in CELL coordinates (same
// addressing fillBlock uses, expanded by renderScale) across one buffer —
// native TypedArray.fill per row, not a per-pixel loop. Used only by the
// dirty-rects path: whenever a subchunk repaints, its own gd/gasD
// region needs zeroing first (matching what the legacy path's bulk
// .fill(0) guaranteed every frame for ALL of them) — otherwise a cell that
// used to glow and no longer does would leave its old glow value sitting
// in the buffer forever, since nothing else would ever overwrite it. bd is
// deliberately never zeroed this way (same rationale as the original bulk-
// clear comment) — paintCell always writes a real bd value for every cell.
function zeroBlockRect(arr, vx0, vy0, vx1, vy1){
  const px0=vx0*renderScale, px1=vx1*renderScale;
  const py0=vy0*renderScale, py1=vy1*renderScale;
  for(let y=py0; y<py1; y++){
    const rowStart=(y*BW+px0)*4, rowEnd=(y*BW+px1)*4;
    arr.fill(0, rowStart, rowEnd);
  }
}

export function render(){
  const sc=camera.scale;
  const wantScale = (tilesEnabled && sc<=tileZoomThreshold) ? TILE_PX : 1;
  if(wantScale!==renderScale) resizeBuffers(wantScale);
  bd=bimg.data; gd=gimg.data; gasD=gasImg.data;
  // pulse depends only on `frame` — identical for every out-of-world pixel
  // in a given render() call. Computed once here and threaded through
  // paintEdgeCell instead of recomputed per pixel (both paths below).
  const pulse=(Math.sin(frame*0.04)+1)*0.05;
  const useDirtyRects = flatDirtyRectsEnabled && sc===1
    && Number.isInteger(camera.x) && Number.isInteger(camera.y);

  if(useDirtyRects){
    // ---- DIRTY-RECTS PATH. No bulk gd/gasD.fill(0) here — see
    // zeroBlockRect's own comment for why that's safe: every repainted
    // subchunk zeros its own region before rewriting, and paintEdgeCell
    // always fully overwrites its own pixels every frame regardless.
    // Untouched regions keep last frame's still-correct buffer contents.
    const wx0=Math.max(0, camera.x), wx1=Math.min(W, camera.x+VIEW_W);
    const wy0=Math.max(0, camera.y), wy1=Math.min(H, camera.y+VIEW_H);
    // In-world screen rect this maps to — camera.x/y are integers and
    // sc===1 (guaranteed by useDirtyRects above), so this is exact
    // integer arithmetic, no rounding needed anywhere below.
    const svx0=wx0-camera.x, svx1=wx1-camera.x;
    const svy0=wy0-camera.y, svy1=wy1-camera.y;

    if(wx1>wx0 && wy1>wy0){
      const scx0=Math.floor(wx0/SUBCHUNK_SIZE), scx1=Math.min(SUBCHUNKS_X-1, Math.floor((wx1-1)/SUBCHUNK_SIZE));
      const scy0=Math.floor(wy0/SUBCHUNK_SIZE), scy1=Math.min(SUBCHUNKS_Y-1, Math.floor((wy1-1)/SUBCHUNK_SIZE));
      for(let scy=scy0; scy<=scy1; scy++){
        for(let scx=scx0; scx<=scx1; scx++){
          const sci=scy*SUBCHUNKS_X+scx;
          if(!(subchunkDirty[sci] || flatSubchunkAnimated[sci])) continue;
          const bx0=scx*SUBCHUNK_SIZE, by0=scy*SUBCHUNK_SIZE;
          const cx0=Math.max(bx0,wx0), cx1=Math.min(bx0+SUBCHUNK_SIZE,wx1,W);
          const cy0=Math.max(by0,wy0), cy1=Math.min(by0+SUBCHUNK_SIZE,wy1,H);
          if(cx1<=cx0 || cy1<=cy0){ subchunkDirty[sci]=0; continue; }   // subchunk exists but nothing of it is actually visible this frame
          zeroBlockRect(gd,   cx0-camera.x, cy0-camera.y, cx1-camera.x, cy1-camera.y);
          zeroBlockRect(gasD, cx0-camera.x, cy0-camera.y, cx1-camera.x, cy1-camera.y);
          let animated=false;
          for(let wy=cy0; wy<cy1; wy++){
            const vy=wy-camera.y;
            for(let wx=cx0; wx<cx1; wx++){
              if(paintCell(wx-camera.x, vy, wx, wy)) animated=true;
            }
          }
          flatSubchunkAnimated[sci]=animated?1:0;
          subchunkDirty[sci]=0;
        }
      }
    }

    // Out-of-world screen area — up to 4 non-overlapping rectangular
    // bands surrounding the in-world rect (top/bottom full-width, then
    // left/right for just the middle row range, so corners aren't
    // double-painted). Always repainted every frame — screen-space, no
    // subchunk backs it, and the pulse term above makes it animated
    // regardless. On THIS site's fixed camera only the top band is ever
    // non-empty (VIEW_H=576 > H=384), but this stays general rather than
    // hardcoding that assumption.
    for(let vy=0; vy<svy0; vy++) for(let vx=0; vx<VIEW_W; vx++) paintEdgeCell(vx,vy,camera.x+vx,camera.y+vy,pulse);
    for(let vy=Math.max(svy0,svy1); vy<VIEW_H; vy++) for(let vx=0; vx<VIEW_W; vx++) paintEdgeCell(vx,vy,camera.x+vx,camera.y+vy,pulse);
    for(let vy=Math.max(0,svy0); vy<Math.min(VIEW_H,svy1); vy++) for(let vx=0; vx<svx0; vx++) paintEdgeCell(vx,vy,camera.x+vx,camera.y+vy,pulse);
    for(let vy=Math.max(0,svy0); vy<Math.min(VIEW_H,svy1); vy++) for(let vx=Math.max(svx0,svx1); vx<VIEW_W; vx++) paintEdgeCell(vx,vy,camera.x+vx,camera.y+vy,pulse);
  } else {
    // ---- LEGACY FULL-REPAINT PATH. Always correct regardless of camera
    // scale/position — the on-device A/B baseline for the path above.
    // gd/gasD are "mostly zero" every frame — only emissive/hot cells (gd)
    // and gas cells (gasD) ever write something real into them.
    // TypedArray.fill(0) clears each whole buffer in one native call. bd
    // is NOT included here: unlike the other two, most cells DO need a
    // real (non-zero) bd value written (void color, material color, or
    // transparent-for-skeleton), so there's no dominant "mostly zero" case
    // to bulk-clear it against.
    gd.fill(0); gasD.fill(0);
    for(let vy=0; vy<VIEW_H; vy++){
      const wy=Math.round(camera.y+vy*sc);
      for(let vx=0; vx<VIEW_W; vx++){
        const wx=Math.round(camera.x+vx*sc);
        if(wx<0||wx>=W||wy<0||wy>=H){
          paintEdgeCell(vx,vy,wx,wy,pulse);
          continue;
        }
        paintCell(vx,vy,wx,wy);
      }
    }
  }
  // in-flight jet particles — drawn as a small centered marker within the
  // cell's block rather than the full tile, so they still read as discrete
  // points rather than swallowing a whole tile. At renderScale===1 this is
  // just the original single pixel — a marker bigger than 1px would spill
  // into neighboring cells' pixels at that scale, so it's special-cased.
  const PMARK = renderScale===1 ? 1 : Math.max(2, Math.round(renderScale*0.4));
  const poff = renderScale===1 ? 0 : Math.floor((renderScale-PMARK)/2);
  for(const pt of particles){
    const vx=Math.round((pt.x-camera.x)/sc), vy=Math.round((pt.y-camera.y)/sc);
    if(vx<0||vx>=VIEW_W||vy<0||vy>=VIEW_H) continue;
    const M=MATBY[pt.mat];
    const ox=vx*renderScale+poff, oy=vy*renderScale+poff;
    for(let ty=0; ty<PMARK; ty++){
      let o=((oy+ty)*BW+ox)*4;
      for(let tx=0; tx<PMARK; tx++, o+=4){
        bd[o]=M.rgb[0]; bd[o+1]=M.rgb[1]; bd[o+2]=M.rgb[2]; bd[o+3]=255;
        if(M.em){ gd[o]=M.rgb[0]; gd[o+1]=M.rgb[1]; gd[o+2]=M.rgb[2]; gd[o+3]=200; }
      }
    }
  }
  // starfield in the void — same small-marker treatment as particles, twinkle
  // computed once per star per frame rather than per subpixel.
  const SMARK = renderScale===1 ? 1 : Math.max(1, Math.round(renderScale*0.25));
  const soff = renderScale===1 ? 0 : Math.floor((renderScale-SMARK)/2);
  for(const [sx,sy,br] of stars){
    const vx=Math.round((sx-camera.x)/sc), vy=Math.round((sy-camera.y)/sc);
    if(vx<0||vx>=VIEW_W||vy<0||vy>=VIEW_H) continue;
    if(grid[idx(sx,sy)]===EMPTY){
      const tw=br+Math.random()*25;
      const ox=vx*renderScale+soff, oy=vy*renderScale+soff;
      for(let ty=0; ty<SMARK; ty++){
        let o=((oy+ty)*BW+ox)*4;
        for(let tx=0; tx<SMARK; tx++, o+=4){ bd[o]=tw; bd[o+1]=tw; bd[o+2]=Math.min(255,tw+20); }
      }
    }
  }
  // sky layer: sun/nebula/planet/cloud/star, placed by the player (see
  // main.js's Sky sheet). Void-masked the same way the starfield above
  // already is — check grid emptiness before writing each pixel a shape
  // covers, not a plain filled circle, or something placed near the
  // coast would paint over real terrain instead of sitting behind it.
  // The default ambient thermostat (visible:false) never reaches here.
  for(const sObj of skySources){
    if(!sObj.visible) continue;
    const scx=(sObj.x-camera.x)/sc, scy=(sObj.y-camera.y)/sc, sr=sObj.radius/sc;
    if(scx<-sr-2||scx>VIEW_W+sr+2||scy<-sr-2||scy>VIEW_H+sr+2) continue;
    const x0=Math.max(0,Math.floor(scx-sr)), x1=Math.min(VIEW_W-1,Math.ceil(scx+sr));
    const y0=Math.max(0,Math.floor(scy-sr)), y1=Math.min(VIEW_H-1,Math.ceil(scy+sr));
    const isSun=sObj.kind==="sun";
    const softKind = sObj.kind==="nebula"||sObj.kind==="cloud";
    // Still walked at cell granularity (not per-subpixel) — sky shapes are
    // large soft gradients, so cell-resolution blending reads identically
    // to full-res and keeps this loop as cheap as it was before tiles.
    for(let vy=y0; vy<=y1; vy++){
      for(let vx=x0; vx<=x1; vx++){
        const dx=vx-scx, dy=vy-scy, d=Math.hypot(dx,dy);
        if(d>sr) continue;
        const wx=Math.round(camera.x+vx*sc), wy=Math.round(camera.y+vy*sc);
        if(!inB(wx,wy) || grid[idx(wx,wy)]!==EMPTY) continue;
        const raw = sObj.kind==="star" ? 1 : 1-(d/sr);   // stars: solid tiny dot; everything else: falls off with distance
        const a = Math.pow(raw, softKind?1.6:0.8);        // nebula/cloud fade out gently; sun/planet/star keep a firmer edge
        blendBlock(bimg.data, vx, vy, sObj.color, a);
        if(isSun){
          const ox=vx*renderScale, oy=vy*renderScale;
          for(let ty=0; ty<renderScale; ty++){
            let o=((oy+ty)*BW+ox)*4;
            for(let tx=0; tx<renderScale; tx++, o+=4){
              gimg.data[o]=sObj.color[0]; gimg.data[o+1]=sObj.color[1]; gimg.data[o+2]=sObj.color[2];
              gimg.data[o+3]=Math.max(gimg.data[o+3], Math.round(a*220));
            }
          }
        }
      }
    }
  }
  bctx.putImageData(bimg,0,0);
  gctx.putImageData(gimg,0,0);
  // World-cell tile compositing — the actual fix for the tessellation bug.
  // Iterates DISTINCT WORLD CELLS visible (not view-cells), and drawImage's
  // each one's tile bitmap stretched to fill exactly that cell's current
  // on-screen size. Uses the bctx.scale(renderScale,renderScale) transform
  // already active (see resizeBuffers) with plain cell-space coordinates —
  // no transform reset needed, unlike the gas composite below, since this
  // pass wants exactly what that transform already provides.
  // Only runs in tiled mode: flat mode already draws materials correctly
  // via the fallback fill above (1 pixel/cell, no texture to tessellate).
  if(renderScale===TILE_PX){
    const wx0=Math.max(0, Math.floor(camera.x)-1), wx1=Math.min(W, Math.ceil(camera.x+VIEW_W*sc)+1);
    const wy0=Math.max(0, Math.floor(camera.y)-1), wy1=Math.min(H, Math.ceil(camera.y+VIEW_H*sc)+1);
    if(subchunksEnabled){
      drawSubchunks(wx0,wx1,wy0,wy1,sc);
    } else {
      // Legacy exact per-cell path, kept intact rather than deleted —
      // this is the direct on-device A/B baseline for the cache above,
      // toggled via the Sandbox's own Subchunks tuning group.
      const cellSpan=1/sc;   // one world cell's width/height in cell-space units — the active transform turns this into its real on-screen size
      for(let wy=wy0; wy<wy1; wy++){
        for(let wx=wx0; wx<wx1; wx++){
          const m=grid[idx(wx,wy)];
          if(m===EMPTY) continue;
          const M=MATBY[m];
          if(M.behavior==="generator"||M.rainbow) continue;   // no tile art — already fully drawn by the view-cell pass above
          if(M.behavior==="gas" && gasHazeOnly) continue;      // haze-only mode: the blurred layer below IS the gas, no crisp tile under it
          const tile=tileCache.get(m);
          const tf=(tileAnimationsEnabled && tile.frameCount>1) ? tile.frames[Math.floor(frame/tile.ticksPerFrame)%tile.frameCount] : tile.frames[0];
          const sx=(wx-camera.x)/sc, sy=(wy-camera.y)/sc;
          bctx.drawImage(tf, 0,0,TILE_PX,TILE_PX, sx, sy, cellSpan, cellSpan);
        }
      }
    }
  }
  // Gas blur composite. bctx carries a permanent scale(renderScale,renderScale)
  // transform for the vector overlays below — gasCanvas is already sized to
  // BW×BH (same raw pixel space as bimg), so drawImage under that transform
  // would double-scale it. save()/setTransform(identity) neutralizes it for
  // just this one call, restore() puts the vector-overlay scale back after.
  gasCtx.putImageData(gasImg,0,0);
  bctx.save();
  bctx.setTransform(1,0,0,1,0,0);
  bctx.filter = `blur(${(renderScale*GAS_BLUR_FACTOR).toFixed(2)}px)`;
  bctx.drawImage(gasCanvas,0,0);
  bctx.filter = "none";
  bctx.restore();
  // vecOverlay is drawn into by ALL EIGHT functions below, once per frame —
  // unlike bctx (which gets a fresh putImageData every frame, functioning
  // as its own clear) vecOverlay only ever gets sparse shape draws, so last
  // frame's ship/stamps/etc would stay stuck forever without this.
  vecCtx.clearRect(0,0,VIEW_W,VIEW_H);
  drawDevices();
  drawFields();
  // ELECTRIC RAINBOW MAGIC FORK — was unconditional. Both functions
  // internally clearRect their canvas BEFORE checking whether there's
  // anything to draw (see each function's own comment on why: erasing
  // stale glow on a populated->empty transition). This site never
  // populates shipBlobs or sets beamActive at all — there's no ship,
  // no beam, nothing ever transitions from populated to empty because
  // it's never populated in the first place — so gating the CALL itself
  // (not just the draw work inside it) is safe here specifically, and
  // skips the wasted clearRect + function-call overhead every frame
  // render() runs, not just the drawing.
  if(beamActive) drawHarvestBeam();
  if(shipBlobs.length) drawShipBlobs();
  drawEntities();
  drawStamps();
  drawStampGhost();
  drawBuildGhost();
}

/* Devices drawn as vector shapes on top of the pixel canvas: springs are
   triangles pointing their spray direction, vents are squares. */
function drawDevices(){
  const sc=camera.scale;
  const R=(GEN_R+0.5)/sc;
  const margin=GEN_R+2;
  for(const ctx of [vecCtx, gctx]){
    for(const g of generators){
      const cx=(g.x+0.5-camera.x)/sc, cy=(g.y+0.5-camera.y)/sc;
      if(cx<-margin||cx>VIEW_W+margin||cy<-margin||cy>VIEW_H+margin) continue;
      const M=MATBY[g.matId];
      ctx.save();
      ctx.translate(cx, cy);
      ctx.fillStyle=`rgb(${M.rgb[0]},${M.rgb[1]},${M.rgb[2]})`;
      ctx.strokeStyle="#FFFFFF";
      ctx.lineWidth=0.6/sc;
      ctx.lineJoin="round";
      ctx.beginPath();
      if(g.emit==="push"){
        ctx.rotate(g.dir*Math.PI/2);
        ctx.moveTo(0,-R);
        ctx.lineTo(R*0.9, R);
        ctx.lineTo(-R*0.9, R);
        ctx.closePath();
      } else {
        ctx.rect(-R,-R, R*2, R*2);
      }
      ctx.fill(); ctx.stroke();
      ctx.restore();
    }
  }
}

/* Harvest beam — thin blue core flanked by two thin white lines, drawn
   into BOTH base (crisp) and glow (CSS-blurred 5px + saturated, see
   index.html's #glow filter) the same way every other emissive game
   object here does (drawFields, drawGenerators). That reuse is why this
   needs no blur math of its own: "blurred and glowed all to hell" is
   just what already happens to anything drawn into gctx, for free.
   Three parallel offset lines rather than one thick stroke — a single
   wide blue line would just read as a fat blue line; three thin ones
   flanking each other reads as a beam with a hot white edge, which is
   what was actually asked for.
   A faint pulsing ring at the impact point shows the actual harvest
   radius (BEAM_RADIUS_LEVELS/beamRadiusLevel — the real footprint
   beamTick() uses, imported from the same state.js source main.js reads,
   so the visual can't silently drift out of sync with what's actually
   being mined). Not explicitly requested, added because a laser with an
   invisible AoE is hard to aim on a phone screen; easy to cut if it reads
   as clutter once it's actually on-device. */
/* Harvest beam ("laser"). Crisp core+edges on bctx (#base), PLUS an
   oversized version drawn into #laserglow — a real DOM canvas (see
   index.html) whose CSS filter (blur/brightness/saturation, written
   live from BEAM_BLUR_PX/BEAM_GLOW_BRIGHTNESS/BEAM_GLOW_SATURATION)
   does the actual glow. Same mechanism drawShipBlobs uses: a real
   canvas element + CSS filter + mix-blend-mode:screen, not ctx.filter,
   and the glow-source line is drawn noticeably thicker than the crisp
   one so blur has an actual margin to show instead of being immediately
   covered by the crisp line sitting exactly on top of it. */
function drawHarvestBeam(){
  // Cleared unconditionally, before the early return below — otherwise
  // turning the beam off would leave its last frame's glow stuck on
  // #laserglow forever, since nothing else ever clears it.
  lgCtx.save();
  lgCtx.clearRect(0,0,VIEW_W,VIEW_H);
  lgCtx.restore();
  if(!beamActive || shipFlightState!=="hover") return;
  const ship=activeShip();
  if(!ship) return;
  const sc=camera.scale;
  const sx=(ship.x-camera.x)/sc, sy=(ship.y-camera.y)/sc;
  const tx=(px+0.5-camera.x)/sc, ty=(py+0.5-camera.y)/sc;
  const dx=tx-sx, dy=ty-sy;
  const len=Math.hypot(dx,dy) || 1;
  // Perpendicular unit vector — offsets the two white lines to either
  // side of the blue core, across the beam's own direction rather than
  // a fixed screen axis, so it still reads right at any beam angle.
  const px_=-dy/len, py_=dx/len;
  const offset=1.1/sc;   // world-space, so it stays a consistent APPARENT width across zoom
  const core=0.55/sc, edge=0.35/sc;
  const GLOW_MULT=3;   // same oversizing factor drawShipBlobs uses, same reason
  vecCtx.save();
  vecCtx.lineCap="round";
  vecCtx.strokeStyle="#5FC9FF"; vecCtx.lineWidth=core;
  vecCtx.beginPath(); vecCtx.moveTo(sx,sy); vecCtx.lineTo(tx,ty); vecCtx.stroke();
  vecCtx.strokeStyle="#F2FBFF"; vecCtx.lineWidth=edge;
  vecCtx.beginPath();
  vecCtx.moveTo(sx+px_*offset, sy+py_*offset); vecCtx.lineTo(tx+px_*offset, ty+py_*offset);
  vecCtx.moveTo(sx-px_*offset, sy-py_*offset); vecCtx.lineTo(tx-px_*offset, ty-py_*offset);
  vecCtx.stroke();
  vecCtx.restore();
  const rWorld=(BEAM_RADIUS_LEVELS[beamRadiusLevel]/2)-0.3;   // same formula circleMask uses internally
  const rPx=rWorld/sc;
  lgCtx.save();
  lgCtx.lineCap="round";
  lgCtx.strokeStyle="#5FC9FF"; lgCtx.lineWidth=core*GLOW_MULT;
  lgCtx.beginPath(); lgCtx.moveTo(sx,sy); lgCtx.lineTo(tx,ty); lgCtx.stroke();
  lgCtx.strokeStyle="#F2FBFF"; lgCtx.lineWidth=edge*GLOW_MULT;
  lgCtx.beginPath();
  lgCtx.moveTo(sx+px_*offset, sy+py_*offset); lgCtx.lineTo(tx+px_*offset, ty+py_*offset);
  lgCtx.moveTo(sx-px_*offset, sy-py_*offset); lgCtx.lineTo(tx-px_*offset, ty-py_*offset);
  lgCtx.stroke();
  lgCtx.globalAlpha=0.25 + 0.1*Math.sin(frame*0.3);
  lgCtx.strokeStyle="#5FC9FF"; lgCtx.lineWidth=(0.4/sc)*GLOW_MULT;
  lgCtx.beginPath(); lgCtx.arc(tx,ty,rPx,0,Math.PI*2); lgCtx.stroke();
  lgCtx.restore();
  laserglow.style.filter = `blur(${BEAM_BLUR_PX}px) brightness(${BEAM_GLOW_BRIGHTNESS}%) saturate(${BEAM_GLOW_SATURATION})`;
}

/* Field emitters drawn as rings — Neutron (attract) gold, Positron
   (repel) violet, Dock a hollow teal diamond (not a ring — it isn't a
   field, drawing it like one would visually lie about what it does). */
function drawFields(){
  const sc=camera.scale;
  for(const f of fields){
    const cx=(f.x+0.5-camera.x)/sc, cy=(f.y+0.5-camera.y)/sc;
    if(cx<-20||cx>VIEW_W+20||cy<-20||cy>VIEW_H+20) continue;
    if(f.kind==="dock"){
      const R=(FIELD_R+0.5)/sc;
      for(const ctx of [vecCtx, gctx]){
        ctx.save();
        ctx.translate(cx,cy); ctx.rotate(Math.PI/4);
        ctx.strokeStyle="#5FC9C9"; ctx.fillStyle="#5FC9C9"; ctx.lineWidth=0.6/sc;
        ctx.beginPath(); ctx.rect(-R*0.7,-R*0.7,R*1.4,R*1.4); ctx.stroke();
        ctx.restore();
      }
      for(const ctx of [vecCtx, gctx]){
        ctx.save(); ctx.translate(cx,cy);
        ctx.fillStyle="#5FC9C9";
        ctx.beginPath(); ctx.arc(0,0,R*0.3,0,Math.PI*2); ctx.fill();
        ctx.restore();
      }
      continue;
    }
    if(f.kind==="tesla"){
      const R=(FIELD_R+0.5)/sc;
      const col = f.active ? "#7FE6FF" : "#3A4A56";   // matches Wire (Live)/Wire (Off) colors — visually ties coil state to what it does
      for(const ctx of [vecCtx, gctx]){
        ctx.save(); ctx.translate(cx,cy);
        ctx.strokeStyle=col; ctx.fillStyle=col; ctx.lineWidth=0.6/sc;
        // three bolt-ish spikes instead of a plain circle, so it doesn't read as another field type at a glance
        ctx.beginPath();
        for(let k=0;k<3;k++){
          const a=k*(Math.PI*2/3) - Math.PI/2;
          ctx.moveTo(0,0); ctx.lineTo(Math.cos(a)*R*1.3, Math.sin(a)*R*1.3);
        }
        ctx.stroke();
        ctx.beginPath(); ctx.arc(0,0,R*0.4,0,Math.PI*2); ctx.fill();
        if(f.active){
          const trueR=TESLA_RADIUS/sc;
          ctx.globalAlpha=0.35 + 0.15*Math.sin(frame*0.15);   // gentle pulse so "active" reads at a glance, not just a color swap
          ctx.beginPath(); ctx.arc(0,0,trueR,0,Math.PI*2); ctx.stroke();
          ctx.globalAlpha=1;
        }
        ctx.restore();
      }
      continue;
    }
    const R=(FIELD_R+0.5)/sc;
    const col = f.kind==="neutron" ? "#E8B84B" : "#B08FE8";
    for(const ctx of [vecCtx, gctx]){
      ctx.save();
      ctx.translate(cx,cy);
      ctx.strokeStyle=col; ctx.fillStyle=col; ctx.lineWidth=0.6/sc;
      if(f.kind==="neutron"){
        ctx.beginPath(); ctx.arc(0,0,FIELD_SOLID_R/sc,0,Math.PI*2); ctx.fill();
      }
      ctx.beginPath(); ctx.arc(0,0,R*0.5,0,Math.PI*2); ctx.fill();
      ctx.beginPath(); ctx.arc(0,0,R,0,Math.PI*2); ctx.stroke();
      ctx.globalAlpha=0.5;
      ctx.beginPath(); ctx.arc(0,0, f.kind==="neutron"?R*0.75:R*1.4, 0, Math.PI*2); ctx.stroke();
      ctx.globalAlpha=1;
      ctx.restore();
    }
  }
}

/* Ship guide blobs — pure decoration. Crisp squares on bctx (#base, no
   filter) for the solid core, PLUS oversized squares drawn into
   #blobglow — a real DOM canvas (see index.html), not a detached
   scratchpad — whose CSS filter (blur+brightness, written live from
   BLOB_BLUR_PX/BLOB_GLOW_BRIGHTNESS) does the actual glow. This used to
   go through ctx.filter on a detached canvas instead — that's a
   different, newer browser API than #glow's plain CSS
   filter, with real support gaps on some WebKit versions, and no amount
   of tuning ever made it visibly do anything. #blobglow uses the exact
   mechanism #glow already uses successfully: a real canvas
   element, CSS filter, mix-blend-mode:screen. Rainbow specks reuse the
   exact per-cell hue formula render() uses for M.rainbow tiles (the
   Aether material) so the "flare" actually matches something else in
   the game rather than being an invented palette. */
function drawShipBlobs(){
  // Cleared unconditionally, before the early return — otherwise the
  // last frame's glow would stay stuck on #blobglow forever if shipBlobs
  // ever fully empties (no ship present, or every speck decaying with
  // none respawning). Same bug just fixed in drawHarvestBeam.
  bgCtx.save();
  bgCtx.clearRect(0,0,VIEW_W,VIEW_H);
  bgCtx.restore();
  if(!shipBlobs.length) return;
  const sc=camera.scale;
  const S=BLOB_SPECK_SIZE/sc;
  // Glow-source squares are drawn LARGER than the crisp ones on purpose —
  // at equal size, the crisp pass's opaque squares would sit exactly on
  // top of the blob-glow layer's and cover it almost entirely once
  // enough specks pack into a solid mass (which they do fast at these
  // spawn rates) — blur would then only ever show at the outer
  // silhouette of the whole cluster, never around an individual speck.
  const glowS = S*3;
  const inView=(b)=>{
    const cx=(b.x-camera.x)/sc, cy=(b.y-camera.y)/sc;
    return cx>=-10&&cx<=VIEW_W+10&&cy>=-10&&cy<=VIEW_H+10;
  };
  const specColor=(b)=>{
    if(b.rainbow){
      const t=b.x*0.05+b.y*0.05+frame*0.02;
      const r=Math.sin(t)*110+140, g=Math.sin(t+2.094)*110+140, bl=Math.sin(t+4.189)*110+140;
      return `rgb(${r|0},${g|0},${bl|0})`;
    }
    return `rgb(${b.rgb[0]|0},${b.rgb[1]|0},${b.rgb[2]|0})`;
  };
  // Oversized squares into #blobglow, a real DOM canvas — CSS filter on
  // this element (set below) does the actual blur/brightness, same
  // mechanism #glow already uses (see index.html), not
  // ctx.filter. ctx.filter is a different, newer canvas API with real
  // support gaps on some WebKit versions, and was very likely why the
  // sliders did nothing no matter what they were set to.
  bgCtx.save();
  for(const b of shipBlobs){
    if(!inView(b)) continue;
    const cx=(b.x-camera.x)/sc, cy=(b.y-camera.y)/sc;
    bgCtx.fillStyle=specColor(b);
    bgCtx.fillRect(cx-glowS/2, cy-glowS/2, glowS, glowS);
  }
  bgCtx.restore();
  // CSS filter in real displayed-pixel space, not raster/renderScale
  // space — no multiplying by renderScale here, same as glow's
  // own fixed 5px/24px values, which don't scale with renderScale either.
  blobglow.style.filter = `blur(${BLOB_BLUR_PX}px) brightness(${BLOB_GLOW_BRIGHTNESS}%) saturate(${BLOB_GLOW_SATURATION})`;
  // Crisp squares on `base`, at native resolution — same two-pass bg/fg
  // order as before so Honeymire stays behind Phlogiston/smoke here too.
  vecCtx.save();
  const drawCrisp=(b)=>{
    if(!inView(b)) return;
    const cx=(b.x-camera.x)/sc, cy=(b.y-camera.y)/sc;
    vecCtx.fillStyle=specColor(b);
    vecCtx.fillRect(cx-S/2, cy-S/2, S, S);
  };
  for(const b of shipBlobs) if(b.bg) drawCrisp(b);
  for(const b of shipBlobs) if(!b.bg) drawCrisp(b);
  vecCtx.restore();
}

/* Ship = three triangles, center 1.5x the flankers. Always drawn upright
   now (no more angle-based rotation — see the drag-to-guide control
   scheme in entities.js), with a small render-only idle bob. */
function drawEntities(){
  const sc=camera.scale;
  for(const e of entities){
    const cx=(e.x-camera.x)/sc, cy=(e.y-camera.y)/sc;
    if(cx<-20||cx>VIEW_W+20||cy<-20||cy>VIEW_H+20) continue;
    if(e.kind==="ship"){
      const R=e.r/sc;
      // Idle bob is render-only — see entities.js's note on why this isn't
      // a physics velocity (can't drift position or fight hover/collision).
      // _bobSeed staggers multiple ships so they don't move in lockstep.
      const bobSeed = e._bobSeed ?? (e._bobSeed=Math.random()*Math.PI*2);
      const bob = Math.sin(frame*SHIP_BOB_SPEED+bobSeed)*SHIP_BOB_AMPLITUDE/sc;
      for(const ctx of [vecCtx, gctx]){
        ctx.save();
        ctx.translate(cx,cy+bob);
        // No more angle-based rotation — the ship stays upright always
        // under the drag-to-guide control scheme (no facing direction to
        // point it in).
        ctx.fillStyle="#F2EDE4"; ctx.strokeStyle="#E8B84B"; ctx.lineWidth=0.5/sc; ctx.lineJoin="round";
        const fw=R*0.5;
        const CENTER_SCALE=1.6;
        ctx.beginPath();
        ctx.moveTo(0,-R*1.5*CENTER_SCALE); ctx.lineTo(fw*CENTER_SCALE,R*0.6*CENTER_SCALE); ctx.lineTo(-fw*CENTER_SCALE,R*0.6*CENTER_SCALE);
        ctx.closePath(); ctx.fill(); ctx.stroke();
        for(const s of [-1,1]){
          ctx.beginPath();
          ctx.moveTo(s*fw*1.4, -R); ctx.lineTo(s*fw*2.4, R*0.6); ctx.lineTo(s*fw*0.4, R*0.6); ctx.closePath();
          ctx.fill(); ctx.stroke();
        }
        ctx.restore();
      }
    } else if(e.kind==="fallenstar"){
      const R=e.r/sc;
      for(const ctx of [vecCtx, gctx]){
        ctx.save(); ctx.translate(cx,cy);
        ctx.fillStyle="#F2EDE4"; ctx.strokeStyle="#E8B84B"; ctx.lineWidth=0.5/sc;
        ctx.beginPath(); ctx.arc(0,0,R,0,Math.PI*2); ctx.fill(); ctx.stroke();
        ctx.restore();
      }
    } else if(e.kind==="satellite"){
      const R=e.r/sc;
      for(const ctx of [vecCtx, gctx]){
        ctx.save(); ctx.translate(cx,cy);
        ctx.strokeStyle="#B08FE8"; ctx.lineWidth=0.7/sc; ctx.fillStyle="#B08FE8";
        ctx.beginPath(); ctx.arc(0,0,R,0,Math.PI*2); ctx.stroke();
        ctx.beginPath(); ctx.arc(0,0,R*0.35,0,Math.PI*2); ctx.fill();
        ctx.restore();
      }
    } else if(e.kind==="anchor"){
      const R=e.r/sc;
      for(const ctx of [vecCtx, gctx]){
        ctx.save(); ctx.translate(cx,cy); ctx.rotate(Math.PI/4);
        ctx.fillStyle="#6FA8E8"; ctx.strokeStyle="#3A3152"; ctx.lineWidth=0.5/sc;
        ctx.beginPath(); ctx.rect(-R*0.75,-R*0.75,R*1.5,R*1.5); ctx.fill(); ctx.stroke();
        ctx.restore();
      }
    } else if(e.kind==="avatar"){
      const ship=activeShip();
      if(ship){
        const scx=(ship.x-camera.x)/sc, scy=(ship.y-camera.y)/sc;
        for(const ctx of [vecCtx, gctx]){
          ctx.save();
          ctx.strokeStyle="#E8B84B"; ctx.globalAlpha=0.35; ctx.lineWidth=0.4/sc;
          ctx.beginPath(); ctx.moveTo(cx,cy); ctx.lineTo(scx,scy); ctx.stroke();
          ctx.restore();
        }
      }
      const R=e.r/sc;
      for(const ctx of [vecCtx, gctx]){
        ctx.save(); ctx.translate(cx,cy);
        ctx.fillStyle="#F2EDE4"; ctx.strokeStyle="#E8B84B"; ctx.lineWidth=0.5/sc;
        ctx.beginPath(); ctx.arc(0,0,R,0,Math.PI*2); ctx.fill(); ctx.stroke();
        ctx.restore();
      }
    }
  }
}

/* live ghost preview while a new stamp is being drag-placed — translucent,
   shows the snapped landing position, tints rose if currently blocked. */
function drawStampGhost(){
  if(!stampPlacing || !stampMode) return;
  let cells=stampMode.design.cells, w=stampMode.design.w, h=stampMode.design.h;
  for(let i=0;i<(stampMode.rot%4);i++){ cells=rotateCells(cells,w,h); [w,h]=[h,w]; }
  const [sx,sy]=snappedStampPos(stampMode.design, stampMode.rot, px, py);
  const [gx,gy]=stampAnchor(sx,sy,w,h);
  const sc=camera.scale, ox=(gx-camera.x)/sc, oy=(gy-camera.y)/sc, cell=1/sc;
  const blocked=stampBlockInfo(cells,w,h,sx,sy).blocked;
  vecCtx.save();
  vecCtx.globalAlpha=0.55;
  for(let cy=0;cy<h;cy++)for(let cx=0;cx<w;cx++){
    const cm=cells[cy*w+cx];
    if(cm===EMPTY) continue;
    const M=MATBY[cm];
    vecCtx.fillStyle = blocked ? "#E86F9E" : `rgb(${M.rgb[0]},${M.rgb[1]},${M.rgb[2]})`;
    vecCtx.fillRect(ox+cx*cell, oy+cy*cell, cell, cell);
  }
  vecCtx.restore();
}
// Build-mode ghost preview — same look/logic as drawStampGhost, reading
// buildMode/buildPlacing instead of stampMode/stampPlacing and
// skeletonBlockInfo instead of stampBlockInfo (skeleton has no "solid"
// side to its block result — it never lands-and-sticks, only
// blocked-or-not). Reuses snappedStampPos unchanged: isBuiltAt already
// recognizes skeleton cells (materials.js), so a skeleton design's own
// ghost snaps against OTHER skeleton buildings and ordinary dissolved
// stamps alike, same as a loose stamp's ghost does.
function drawBuildGhost(){
  if(!buildPlacing || !buildMode) return;
  let cells=buildMode.design.cells, w=buildMode.design.w, h=buildMode.design.h;
  for(let i=0;i<(buildMode.rot%4);i++){ cells=rotateCells(cells,w,h); [w,h]=[h,w]; }
  const [sx,sy]=snappedStampPos(buildMode.design, buildMode.rot, px, py);
  const [gx,gy]=stampAnchor(sx,sy,w,h);
  const sc=camera.scale, ox=(gx-camera.x)/sc, oy=(gy-camera.y)/sc, cell=1/sc;
  const blocked=skeletonBlockInfo(cells,w,h,sx,sy).blocked;
  vecCtx.save();
  vecCtx.globalAlpha=0.55;
  for(let cy=0;cy<h;cy++)for(let cx=0;cx<w;cx++){
    const cm=cells[cy*w+cx];
    if(cm===EMPTY) continue;
    const M=MATBY[cm];
    vecCtx.fillStyle = blocked ? "#E86F9E" : `rgb(${M.rgb[0]},${M.rgb[1]},${M.rgb[2]})`;
    vecCtx.fillRect(ox+cx*cell, oy+cy*cell, cell, cell);
  }
  vecCtx.restore();
}
// Exposes the current ghost's snapped position + blocked state to the UI
// layer (index.html/main.js's Confirm button) without duplicating this
// math a third time — same snap/block logic the ghost itself just drew.
export function buildGhostState(){
  if(!buildMode) return null;
  let cells=buildMode.design.cells, w=buildMode.design.w, h=buildMode.design.h;
  for(let i=0;i<(buildMode.rot%4);i++){ cells=rotateCells(cells,w,h); [w,h]=[h,w]; }
  const [sx,sy]=snappedStampPos(buildMode.design, buildMode.rot, px, py);
  const blocked=skeletonBlockInfo(cells,w,h,sx,sy).blocked;
  return { x:sx, y:sy, blocked };
}
function drawStamps(){
  const sc=camera.scale;
  for(const e of entities){
    if(e.kind!=="stamp") continue;
    const [gx,gy]=stampAnchor(e.x,e.y,e.w,e.h);
    const sx=(gx-camera.x)/sc, sy=(gy-camera.y)/sc, spanX=e.w/sc, spanY=e.h/sc;
    if(sx+spanX<-4||sx>VIEW_W+4||sy+spanY<-4||sy>VIEW_H+4) continue;
    const cell=1/sc;
    for(let cy=0;cy<e.h;cy++)for(let cx=0;cx<e.w;cx++){
      const cm=e.cells[cy*e.w+cx];
      if(cm===EMPTY) continue;
      const M=MATBY[cm];
      const col=`rgb(${M.rgb[0]},${M.rgb[1]},${M.rgb[2]})`;
      const x=sx+cx*cell, y=sy+cy*cell;
      vecCtx.fillStyle=col; vecCtx.fillRect(x,y,cell,cell);
      if(M.em){ gctx.fillStyle=col; gctx.fillRect(x,y,cell,cell); }
    }
  }
}
/* shared mini-renderer: the drawer swatches, the Forge preview, and the
   placement pill all draw a design the same way. */
export function drawStampPreview(canvas, cells, w, h){
  const c=canvas.getContext("2d");
  c.clearRect(0,0,w,h);
  for(let cy=0;cy<h;cy++)for(let cx=0;cx<w;cx++){
    const cm=cells[cy*w+cx];
    if(cm===EMPTY) continue;
    const M=MATBY[cm];
    c.fillStyle=`rgb(${M.rgb[0]},${M.rgb[1]},${M.rgb[2]})`;
    c.fillRect(cx,cy,1,1);
  }
}
