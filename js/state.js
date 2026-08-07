"use strict";
/* ZODIAC DRIFT 0.16 — modular split, Phase 1.
   Owns the shared mutable world: everything that used to just be a
   top-level `let`/`const` in the monolith's one shared scope, now
   `export`ed so other modules can read it via live bindings.

   IMPORTANT: an ES module import binding is READ-ONLY in the importing
   file. Anything reassigned (not just mutated) elsewhere in the app
   — `grid = new Uint8Array(...)` on load, `entities = entities.filter(...)`,
   a slider setting `flow = ...` — needs the paired setter function below;
   direct property mutation (`camera.x = ...`, `generators.push(...)`)
   does NOT need one, the live binding already sees it. */

/* ================= world dimensions =================
   Chunk size + chunk COUNT are the source of truth — world size is
   DERIVED from them, not the other way around, so they can't drift out
   of agreement (see original monolith's comment on this, preserved in
   spirit here). */
export const CHUNK_SIZE = 64;
export const CHUNKS_X = 11, CHUNKS_Y = 6;
export const W = CHUNK_SIZE*CHUNKS_X, H = CHUNK_SIZE*CHUNKS_Y;   // world size: 704x384 (was 320x192, was 192x192 briefly, was 384x384/36 chunks, was 768x768/9 chunks before that) — non-square on purpose: islands read better wide than tall, so CHUNKS_X/Y are asymmetric (11x6) instead of shrinking/growing both axes evenly. H is now DOUBLE VIEW_H (384 vs 192) — deliberately, unlike every prior size: vertical scrolling is back on purpose (clampCamera's vh>=H check now fails at default zoom, same as horizontal already worked), giving two screens of vertical room to grow into, not just horizontal panning. No code elsewhere assumes a specific W/H (terrain.js's island placement is entirely W/H/VIEW_W/VIEW_H-relative), so this stayed a two-constant change, not a rewrite — confirmed again by grep before this change landed.
// ELECTRIC VIVID RAINBOW FORK — companion to materials.js's new `emAmt`
// field (partial/non-full-strength emissive glow, vs. the pre-existing
// binary `em`). This is the live dial: materials.js sets each material's
// BASE emAmt (relative strength — Sand brighter than Gravel, etc.), this
// multiplies all of them uniformly so the site's glow slider can scale
// "how much do non-emissive materials glow" as one control instead of
// re-tuning every material's number by hand. 1 = base values as authored,
// 0 = the old behavior (no glow at all) for anything using emAmt instead
// of em. `let` + setter, not a bare mutable export, because ES module
// imports are read-only live bindings — sand-bg.js/render.js can freely
// READ this by importing it directly (render.js does, every frame), but
// cannot ASSIGN to it from outside this module. The setter is the only
// legal write path; the slider calls it.
export let NONEMISSIVE_GLOW_MULT = 1;
export function setNonEmissiveGlowMult(v) { NONEMISSIVE_GLOW_MULT = v; }

// ELECTRIC RAINBOW MAGIC FORK — optional hook, physics.js core doesn't know
// or care who's listening. physics.js's trySwap calls this (if set) at the
// exact single point where a cell is deleted for falling past the world's
// top/bottom edge — the ONLY deletion path a material with no decay/
// onContact/meltTo/freezeTo/emits can ever go through. Site-specific
// consumers (sand-bg.js's live-sand cap) register interest via
// setOnWorldExit so they can maintain an exact incremental count instead of
// re-scanning the whole grid every frame to find out what vanished. Real
// game code never sets this — null is the correct default there.
export let onWorldExit = null;
export function setOnWorldExit(fn) { onWorldExit = fn; }

// ELECTRIC RAINBOW MAGIC FORK — same pattern as onWorldExit immediately
// above, second deletion path. Added when the rainbow materials picked
// up real decay rates (materials.js) as the replacement for the removed
// overwrite-on-paint mechanic: painted cells now clear themselves out
// over time via decay instead of being punched through by a new paint
// stroke. Without this hook, decay-to-EMPTY would delete grid cells
// physics.js already knows about while leaving sand-bg.js's
// paintedCellCount none the wiser — the live-sand cap would only ever
// count UP via decay-driven removal it can't see, eventually pinning
// paintedCellCount at MAX_LIVE_SAND permanently and silently disabling
// painting even on an empty-looking screen. physics.js's decay branch
// (step(), pass 1) calls this only when a cell decays specifically TO
// EMPTY (decayTo omitted or explicitly EMPTY) — a decay that converts
// to another real material isn't a freed cell, so it correctly doesn't
// fire here. Real game code never sets this — null is the correct
// default there, exactly like onWorldExit.
export let onDecayToEmpty = null;
export function setOnDecayToEmpty(fn) { onDecayToEmpty = fn; }

export const VIEW_W = 450, VIEW_H = 576;   // ELECTRIC VIVID RAINBOW FORK: 3x the real game's original 150x192 (was 2x/300x384). Render cost scales with VIEW_W*VIEW_H — confirmed cheap headroom at 2x (~6.7ms/frame unaccelerated in plain Node), so bumping further. camera.scale alone can't fix on-screen grain size — the render buffer is fixed-resolution and CSS-stretched/cropped regardless of zoom. VIEW_H no longer exactly equals H (384) at this size; sand-bg.js's bottom-anchored crop means that's a minor cosmetic nuance (a little more void margin above the floor, now that the wordmark itself is the primary collision surface anyway), not a functional problem.

/* ================= grid ================= */
export let grid = new Uint8Array(W*H);
export function setGrid(g){ grid = g; }

// Per-cell consecutive-stuck-tick counter — powder-settle materials only.
export const settleCounter = new Uint16Array(W*H);

// ---- temperature: DATA ONLY at this stage — no diffusion tick reads or
// writes this yet, no render code tints anything by it. Parallel array to
// grid, same idx(x,y) indexing, fixed size for the app's lifetime same as
// settleCounter/isSettling below (no setter needed — nothing ever
// reassigns the whole array, terrain.js's paintOriginIsland just
// .fill()s it back to SPAWN_TEMP_DEFAULT on reseed, same as it already
// does for chunkAwake/isSettling). Float32 rather than a fixed-point int
// type since we're not performance-squeezed on this and it keeps the
// diffusion math (whenever it's built) simple.
// Unitless scale, not literal Celsius/Fahrenheit: 0 is the intended
// floor (void/space's eventual pinned value, once a diffusion pass
// exists to enforce it — not enforced yet, this array just starts
// uniform), SPAWN_TEMP_DEFAULT is ordinary ambient material, materials
// like Magma are expected to sit far above it. The actual meaning of
// any given number is entirely up to whatever per-material
// meltPoint/freezePoint/ignitionTemp thresholds get set in materials.js.
export const temp = new Float32Array(W*H);
export const SPAWN_TEMP_DEFAULT = 20;
// Master switch for the whole temperature system. temp[i] and every
// material's temp-driven properties (ignitionTemp, meltPoint, freezePoint,
// heatOutput, chillOutput, etc.) are inert data until something actually
// writes temp[i] — that's exactly the four full-grid passes this flag
// gates in physics.js (applySkyHeat, applyCombustionHeat, applyRadiantHeat,
// diffuseTemp — the last of which also contains the melt/freeze/ignition
// threshold checks, so gating it dormants those mechanics too, no
// materials.js changes needed) plus render.js's tempTint/heatGlow.
// trySwap's temp[i]/temp[j] advection swap is deliberately NOT gated —
// O(1) per swap, cheap enough that skipping it isn't worth a branch, and
// harmless since nothing reads the values meaningfully while this is off.
// On by default. Flip it off (drawer's 🌡 button or the Tuning sheet's
// "Temperature enabled" checkbox) to skip the four full-grid passes below
// and the render-side tint/glow when a session doesn't need the mechanic
// — e.g. avoiding an eternal heatOutput source (Magma) keeping chunks
// permanently awake via the radiant-heat wake path.
export let TEMPERATURE_ENABLED = true;
export function setTemperatureEnabled(v){ TEMPERATURE_ENABLED = !!v; }

export const idx = (x,y) => y*W+x;

// Cheap deterministic 2D hash -> unsigned 32-bit int. Same (x,y) always
// gives the same value — used everywhere as stable per-cell "randomness".
export function hash2i(x,y){
  let h=(x*374761393 + y*668265263)|0;
  h=(h ^ (h>>>13))*1274126177|0;
  return (h ^ (h>>>16))>>>0;
}

export const inB = (x,y) => x>=0&&x<W&&y>=0&&y<H;

export let camera = { x:0, y:0, scale:1 };

// ZOOM_MIN/MAX + the two clamp functions live here, not in render.js, even
// though they read like "camera/rendering" code — deliberately: reseed()
// (terrain.js) needs clampCamera() at world-generation time, well before
// render.js exists in the load order, and neither function touches a
// canvas/ctx at all, just camera.x/y/scale math against W/H/VIEW_W/VIEW_H.
// Same reasoning as wake() living in physics.js as a cross-cutting
// primitive — this is camera's equivalent, called from terrain, render,
// persistence, and ui alike.
export const ZOOM_MIN=0.15, ZOOM_MAX=3.2;   // 3.2 ~ enough to see the whole world at once. ZOOM_MIN dropped from 0.4 once tiles proved out at close zoom — this is the new floor to feel out.
export function clampCameraScale(){
  camera.scale = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, camera.scale));
}
export function clampCamera(){
  clampCameraScale();
  const vw=VIEW_W*camera.scale, vh=VIEW_H*camera.scale;
  camera.x = (vw>=W) ? (W-vw)/2 : Math.max(0, Math.min(W-vw, camera.x));
  camera.y = (vh>=H) ? (H-vh)/2 : Math.max(0, Math.min(H-vh, camera.y));
}

/* ================= chunk activity =================
   Bookkeeping layer over the flat `grid` — which CHUNK_SIZE x CHUNK_SIZE
   regions currently have anything worth stepping. See physics.js's
   wake()/step() for how these get read and written; this module only
   owns the storage. */
// SLEEP_AFTER_IDLE (ticks of no activity before a chunk stops simulating)
// now lives in the tunables block below, alongside the rest of the
// physics.js constants promoted to live-tunable — same reasoning as the
// SAND_SETTLE_TICKS etc. already there.
export let chunkAwake   = new Uint8Array(CHUNKS_X*CHUNKS_Y).fill(1);
export let chunkIdle    = new Uint16Array(CHUNKS_X*CHUNKS_Y);
export let chunkTouched = new Uint8Array(CHUNKS_X*CHUNKS_Y);
export function chunkIndexAt(x,y){
  const cx = Math.min(CHUNKS_X-1, (x/CHUNK_SIZE)|0);
  const cy = Math.min(CHUNKS_Y-1, (y/CHUNK_SIZE)|0);
  return cy*CHUNKS_X+cx;
}

// POWDER DECOMPRESSION queue — cells to recheck for lost support next tick.
export const decompressQueue = new Set();
// PENDING SETTLE — per-chunk count of cells still counting toward
// SAND_SETTLE_TICKS, so a chunk holding one doesn't sleep mid-count.
export const settlingByChunk = new Uint16Array(CHUNKS_X*CHUNKS_Y);
export const isSettling = new Uint8Array(W*H);   // idempotency guard for markSettling/clearSettling

/* ================= subchunk render cache =================
   RENDER-ONLY bookkeeping — see HANDOFF #8. A small NxN world-cell block
   gets its own persistent canvas (owned by render.js, not here) redrawn
   only when something inside it changed; this module just owns the
   dirty-bit storage, same division of labor as chunk-activity above
   (physics.js's wake() writes both, render.js only reads/clears this one).
   Deliberately its OWN grid, NOT reusing CHUNK_SIZE/CHUNKS_X/Y — those
   govern physics sim sleep and must stay untouched by anything
   render-visibility-related (the exact trap a prior ChatGPT rewrite fell
   into: conflating render visibility with sim visibility silently paused
   off-screen devices). SUBCHUNK_SIZE is live-tunable for on-device A/B
   (8 vs 12 vs 16) — W and H both being 384 keeps all three candidates
   exact divisors, but subchunkIndexAt's clamp + render.js's own
   bw/bh-clamped canvas sizing handle a non-divisor size too, so the
   slider isn't restricted to just those three.
   Starts fully dirty (every subchunk needs its first real paint). A size
   change reallocates fresh, also fully dirty — old bits don't map to new
   block boundaries. render.js's own resetSubchunkCache() (called by
   the Sandbox slider right after this) clears its now-orphaned canvases;
   this module has no canvases to clean up, just the bit array. */
export let SUBCHUNK_SIZE = 8;
export let SUBCHUNKS_X = Math.ceil(W/SUBCHUNK_SIZE), SUBCHUNKS_Y = Math.ceil(H/SUBCHUNK_SIZE);
export let subchunkDirty = new Uint8Array(SUBCHUNKS_X*SUBCHUNKS_Y).fill(1);
export function subchunkIndexAt(x,y){
  const cx = Math.min(SUBCHUNKS_X-1, (x/SUBCHUNK_SIZE)|0);
  const cy = Math.min(SUBCHUNKS_Y-1, (y/SUBCHUNK_SIZE)|0);
  return cy*SUBCHUNKS_X+cx;
}
export function setSubchunkSize(v){
  SUBCHUNK_SIZE = v;
  SUBCHUNKS_X = Math.ceil(W/SUBCHUNK_SIZE); SUBCHUNKS_Y = Math.ceil(H/SUBCHUNK_SIZE);
  subchunkDirty = new Uint8Array(SUBCHUNKS_X*SUBCHUNKS_Y).fill(1);
}

/* ================= placed objects / live world content ================= */
export let generators = [];   // {x, y, spawnId, matId, emit, dir, placedBy}
export function setGenerators(g){ generators = g; }

export let fields = [];   // {x, y, kind:"neutron"|"positron"|"dock", sign}
export function setFields(f){ fields = f; }

export let entities = [];   // ships, stamps-in-flight, avatar, test rig entities
export function setEntities(e){ entities = e; }

export let particles = [];   // in-flight generator-emitted momentum particles
export function setParticles(p){ particles = p; }

/* ================= sky layer =================
   Placeable background objects — sun/nebula/planet/cloud/star — sparse
   and positioned like generators/fields above, NOT per-cell grid
   material. Only `kind:"sun"` entries do anything physically; the rest
   are purely decorative (render.js draws all of them, physics.js only
   reads the suns).
     { x, y, kind, radius, color, heatRadius, heatStrength, visible, placedBy, isDefaultAmbient }
   heatRadius/heatStrength only matter for suns. A REAL placed sun has a
   finite heatRadius and injects heat with distance falloff — reaches
   "pretty far" by design, self-balances against diffusion losses to its
   surroundings, same as a real light source radiating into a cooler
   area. heatRadius:Infinity is reserved for exactly one special
   entry per world — isDefaultAmbient:true, invisible, auto-created —
   which instead PULLS the whole island toward heatStrength as a target
   (a thermostat, not an injection, since "the whole island, always" has
   nowhere finite to lose excess heat to). This is deliberately the ONLY
   way ambient warmth exists — see physics.js's applySkyHeat — there's
   still no hardcoded law pulling temperature toward anything; a player
   who deletes this one entry gets a genuinely cold, sunless island. */
export let skySources = [];
export function setSkySources(s){ skySources = s; }
// matches SPAWN_TEMP_DEFAULT on purpose — a fresh island's default
// thermostat aims for "feels the same as before this system existed,"
// not a change in default feel. Owners adjust the entry's own
// heatStrength after creation; this is only the starting value.
export const DEFAULT_AMBIENT_HEAT = 20;
export function ensureDefaultAmbientSun(){
  if(skySources.some(s=>s.isDefaultAmbient)) return;
  skySources.push({ x:0, y:0, kind:"sun", radius:0, color:[255,214,120],
    heatRadius:Infinity, heatStrength:DEFAULT_AMBIENT_HEAT, visible:false,
    placedBy:"", isDefaultAmbient:true });
}
export let SKY_HEAT_RATE = 0.03;   // real, finite-radius suns: flat per-tick injection scale
export function setSkyHeatRate(v){ SKY_HEAT_RATE = v; }
export let AMBIENT_PULL_RATE = 0.02;   // the default thermostat: proportional pull-toward-target scale
export function setAmbientPullRate(v){ AMBIENT_PULL_RATE = v; }
// How hard a chillOutput material (Snow, Frostbedrock, etc.) pulls its own
// cell back toward its target temp each tick — the cold mirror of a
// self-heating material's heatOutput pin, but a pull, not a pin, so a real
// heat source can still win (see materials.js's note on why heatOutput-vs-
// freezePoint traps happen and why chillOutput deliberately doesn't do the
// same). Was a hardcoded local const in physics.js at 0.25 — moved here and
// dropped to 0.05 this session: at 0.25 it was categorically stronger than
// conduction could ever be (worked out the steady-state math: Snow fully
// engulfed on all 4 sides by 90-degree Magma only settled ~21.5, still
// under its own 28 meltPoint — contact melting was mathematically
// impossible, not just slow). 0.05 is a first-pass number, same as Lava's
// reactChance — Crash tunes this one himself from here via the Tuning
// panel, not a value to treat as final.
export let CHILL_PULL = 0.03;
export function setChillPull(v){ CHILL_PULL = v; }

/* ================= identity & sharing =================
   Trust-based (not server-enforced) — see persistence.js for how these
   get resolved from a loaded .isl / server row. */
export let islandName = "";
export function setIslandName(v){ islandName = v; }
export let ownerName = "";
export function setOwnerName(v){ ownerName = v; }
export let identity = "";
export function setIdentity(v){ identity = v; }
export let role = "owner";   // "owner" | "minion" | "guest"
export function setRole(v){ role = v; }
export let minions = [];
export function setMinions(v){ minions = v; }
export let brigadoon = [];
export function setBrigadoon(v){ brigadoon = v; }
export let homeSpawn = null;   // {x,y} — claimed Dock position, or null
export function setHomeSpawn(v){ homeSpawn = v; }

/* ================= server / lattice travel state ================= */
export let myIslandCoord = null;   // your permanent home coordinate
export function setMyIslandCoord(v){ myIslandCoord = v; }
export let viewingCoord = null;    // whichever coordinate's data is currently loaded
export function setViewingCoord(v){ viewingCoord = v; }
export let previewUncommitted = false;   // true while viewing a generated-but-unfounded preview
export function setPreviewUncommitted(v){ previewUncommitted = v; }

// True only when the currently-loaded world is actually your own home
// island. Pure derived booleans, no I/O — live here (not persistence.js,
// their original home) specifically so entities.js's checkDockArrival can
// use isHome() without forward-referencing persistence.js, which doesn't
// exist until Phase 5.
export function isHome(){
  return !!(myIslandCoord && viewingCoord && myIslandCoord.x===viewingCoord.x && myIslandCoord.y===viewingCoord.y);
}
// True on your home coordinate OR any other coordinate you actually own.
export function isMine(){
  return !previewUncommitted && !!viewingCoord && (isHome() || role==="owner");
}

/* ================= tunables (Tuning-sheet slider driven) ================= */
export let flow = 0.22;
export function setFlow(v){ flow = v; }
export let jet = 0.5;
export function setJet(v){ jet = v; }
export let POWDER_COMPACT_CHANCE = 0.002;
export function setPowderCompactChance(v){ POWDER_COMPACT_CHANCE = v; }
export let SAND_SETTLE_TICKS = 45;
export function setSandSettleTicks(v){ SAND_SETTLE_TICKS = v; }
export let SAND_SLIDE_REACH = 10;
export function setSandSlideReach(v){ SAND_SLIDE_REACH = v; }
export let SAND_SLIDE_CHANCE = 0.01;
export function setSandSlideChance(v){ SAND_SLIDE_CHANCE = v; }
// Whole part = guaranteed swap attempts per tick, fractional part = one
// further probabilistic attempt (0.03 -> 3% chance of one attempt, exactly
// the old behavior when this was a plain [0,1] "chance"; 3.5 -> 3
// guaranteed attempts plus a 50% chance of a 4th). Uncapped above 1 on
// purpose — a bare probability maxes out at "one attempted move per tick,
// same cadence as everything else," which reads as barely-diffusing for
// a material that's supposed to spread fast. See physics.js's diffuse().
export let AETHER_MOVE_INTENSITY = 0.03;
export function setAetherMoveIntensity(v){ AETHER_MOVE_INTENSITY = v; }
// ---- behavior:'gas' (Phlogiston, Smoke, Steam — Aether is 'diffuse',
// above, a separate behavior). Three sequential rolls per tick in
// physics.js's gas(): try straight up, then diagonal up, then sideways
// drift — each only attempted if the previous one failed. Were bare
// hardcoded numbers with no precedent for promotion until now; same
// tuning-sheet treatment as every other behavior constant in this file.
// ELECTRIC RAINBOW MAGIC FORK — lowered from 0.75/0.5/0.35. Gas has no
// settle/sleep mechanism at all (unlike powder/powder-settle/liquid) —
// a gas cell with open space above just keeps trying to rise every
// tick, forever, which keeps its chunk permanently awake and forces a
// full shimmer/glow recompute every frame for as long as it exists.
// The site's old 10-material palette had ZERO gas materials in it; the
// 18-material rainbow palette added six at once, all full-glow (em:true),
// all simultaneously paintable — reported as heat + near-freeze on
// mobile specifically when different materials/colors overlap ("mixing"),
// which lines up: a single settled color goes fully idle fast, gas
// mixed with anything never does. This halves the attempt frequency
// (fewer wake() calls, fewer forced re-renders per second) without
// touching the no-sleep structure itself — a mitigation, not a fix.
// If this isn't enough on-device, the real fix is giving gas an actual
// settle/idle exit condition, which is a physics-behavior change worth
// discussing before touching, not a number to quietly retune.
export let GAS_UP_CHANCE = 0.35;
export function setGasUpChance(v){ GAS_UP_CHANCE = v; }
export let GAS_DIAG_CHANCE = 0.22;
export function setGasDiagChance(v){ GAS_DIAG_CHANCE = v; }
export let GAS_DRIFT_CHANCE = 0.15;
export function setGasDriftChance(v){ GAS_DRIFT_CHANCE = v; }
// ---- behavior:'liquid' (Ghost Tide, Oil, Honeymire — Water/Magma are
// 'pressured', a separate behavior). Fallback cohesion for a liquid
// material that doesn't set its own `cohesion` — see physics.js's
// liquid() for the full surface-tension reasoning. Was a bare hardcoded
// const with no precedent for promotion until now.
export let LIQUID_COHESION_DEFAULT = 0.6;
export function setLiquidCohesionDefault(v){ LIQUID_COHESION_DEFAULT = v; }
export let stampCooldownMs = 350;
export function setStampCooldownMs(v){ stampCooldownMs = v; }
// ---- promoted from physics.js module-scope consts, same tuning-sheet
// pattern as the block above — physics.js now imports these live
// bindings instead of declaring its own frozen consts. Values unchanged
// from their prior hardcoded defaults.
export let SLEEP_AFTER_IDLE = 12;   // was a plain const above chunk-activity; moved into the tunable block since it's exactly as "feel" as the others, just chunk-granularity instead of per-cell
export function setSleepAfterIdle(v){ SLEEP_AFTER_IDLE = v; }
export let P_GRAV = 0.05;
export function setPGrav(v){ P_GRAV = v; }
export let P_DRAG = 0.94;
export function setPDrag(v){ P_DRAG = v; }
export let P_SUBMERGE_DRAG = 0.9;
export function setPSubmergeDrag(v){ P_SUBMERGE_DRAG = v; }
export let P_SUBMERGE_KICK = 2;
export function setPSubmergeKick(v){ P_SUBMERGE_KICK = v; }
export let JET_SPEED_MIN = 0.7;
export function setJetSpeedMin(v){ JET_SPEED_MIN = v; }
export let JET_SPEED_MAX = 3.2;
export function setJetSpeedMax(v){ JET_SPEED_MAX = v; }
export let GEN_BFS_CAP = 1600;
export function setGenBfsCap(v){ GEN_BFS_CAP = v; }
// Tesla coil: distance-gated reaction radius (bounding-box scan, not a
// chunk-wide pass — this stays small on purpose, see applyTeslaFields).
export let TESLA_RADIUS = 12;
export function setTeslaRadius(v){ TESLA_RADIUS = v; }
// Radiant chill: a cold cell (chillOutput set) chills nearby cells at a
// distance, straight through void gaps — void neither stores nor
// forwards it, same "skip void entirely" rule diffuseTemp's sun branch
// already uses. Separate from ordinary conduction (diffuseTemp), which
// still requires unbroken material contact and still treats void as a
// zero-conductivity insulator, unchanged.
//   The heat-direction counterpart to this used to exist (a hot cell
// warming nearby cells the same way) — removed. It summed with no
// occlusion across every source in range, so a dense pool of same-type
// self-heating cells could mutually irradiate itself into the
// thousands of degrees with nothing bounding it but an emergency safety
// clamp that was never meant to be a normal resting temperature. The
// chill direction never had this problem (floored at 0, a real bound
// already used everywhere, not an emergency value), so it's kept,
// unaffected. Heat now only moves by conduction (diffuseTemp, requires
// touching) or a self-heating cell's own hard-pinned temp
// (applyCombustionHeat) — never at a distance through open space.
export let RADIANT_CHILL_RADIUS = 3;
export function setRadiantChillRadius(v){ RADIANT_CHILL_RADIUS = v; }
export let RADIANT_CHILL_RATE = 0.025;
export function setRadiantChillRate(v){ RADIANT_CHILL_RATE = v; }
// How fast a burning cell (heatOutput set) climbs toward that value, as a
// Fire's animated tile flicker (render.js) — baked-once-per-rebuild
// frames, not re-rolled live every actual render frame (see render.js's
// tileCache comment). Changing any of these needs render.js's
// rebuildFireTile() called afterward to regenerate the cached frames —
// the Sandbox's own slider wiring does this, main.js doesn't need to
// since it never changes these off their defaults.
export let FIRE_FLICKER_TICKS_PER_FRAME = 3;
export function setFireFlickerTicksPerFrame(v){ FIRE_FLICKER_TICKS_PER_FRAME = v; }
export let FIRE_FLICKER_MIN = 0.7;
export function setFireFlickerMin(v){ FIRE_FLICKER_MIN = v; }
export let FIRE_FLICKER_RANGE = 0.5;   // brightness varies MIN..MIN+RANGE per frame
export function setFireFlickerRange(v){ FIRE_FLICKER_RANGE = v; }
export let FIRE_FLICKER_YELLOW = 0.15;   // nudge toward yellow on brighter frames
export function setFireFlickerYellow(v){ FIRE_FLICKER_YELLOW = v; }
// genFireChance()/pushBurst() used to be flow-derived one-liners with the
// base/multiplier baked directly into the formula (0.15 + flow*0.85,
// 1 + round(flow*5)) — split out so each half is independently tunable
// instead of only reachable by fighting the flow slider.
export let GEN_FIRE_BASE = 0.15;
export function setGenFireBase(v){ GEN_FIRE_BASE = v; }
export let GEN_FIRE_FLOW_MULT = 0.85;
export function setGenFireFlowMult(v){ GEN_FIRE_FLOW_MULT = v; }
export let PUSH_BURST_BASE = 1;
export function setPushBurstBase(v){ PUSH_BURST_BASE = v; }
export let PUSH_BURST_FLOW_MULT = 5;
export function setPushBurstFlowMult(v){ PUSH_BURST_FLOW_MULT = v; }
// heat exchanged per tick between two adjacent cells, as a fraction of
// their temperature difference, before the weaker-conducting material's
// own conductivity scales it down further. See physics.js's diffuseTemp.
export let DIFFUSION_RATE = 0.5;
export function setDiffusionRate(v){ DIFFUSION_RATE = v; }
// Render-side temperature thresholds — moved here from render.js so they
// can be tuned live in the bench, same as every other number that shapes
// what the player actually experiences. Purely visual: none of these feed
// back into diffuseTemp's math, they only decide how a given temperature
// gets painted.
// Cold/hot tint now each get their own start/full pair, same shape glow
// already had — decoupled from SPAWN_TEMP_DEFAULT/ambient entirely (used
// to implicitly anchor "start" at ambient; now both ends are explicit
// tunables, matching what glow already did). See render.js's tempTint.
export let TEMP_COLD_FULL = 0;
export function setTempColdFull(v){ TEMP_COLD_FULL = v; }
export let TEMP_COLD_START = 2;
export function setTempColdStart(v){ TEMP_COLD_START = v; }
export let TEMP_HOT_START = 75;
export function setTempHotStart(v){ TEMP_HOT_START = v; }
export let TEMP_HOT_FULL = 99;
export function setTempHotFull(v){ TEMP_HOT_FULL = v; }
export let TEMP_GLOW_START = 65;
export function setTempGlowStart(v){ TEMP_GLOW_START = v; }
export let TEMP_GLOW_FULL = 99;
export function setTempGlowFull(v){ TEMP_GLOW_FULL = v; }
// Gas haze blur radius (canvas-px, before renderScale/CSS upscaling — see
// render.js's gas-blur composite pass). Promoted from a hardcoded
// render.js const (was 0.9) to a live tunable. First bump to 2.5 still
// read as too subtle on-device; raised 10x to 25 — Tuning sheet's slider
// range widened to match, see index.html.
export let GAS_BLUR_FACTOR = 25;
export function setGasBlurFactor(v){ GAS_BLUR_FACTOR = v; }
// Ship blob glow — separate from GAS_BLUR_FACTOR and #glow's fixed CSS
// blur on purpose: the blobs were riding the shared #glow layer's fixed
// 5px blur, so there was no way to push them further (or pull back)
// without touching every other thing #glow draws. render.js draws them
// into their own real DOM canvas (#blobglow, index.html) with a live
// CSS filter instead — same mechanism #glow already uses,
// not ctx.filter (a different, newer canvas API that turned out to have
// real support gaps and simply never showed anything, no matter the
// values). These two are plain CSS px / CSS brightness%, same units
// glow's own fixed values use.
export let BLOB_BLUR_PX = 25;
export function setBlobBlurPx(v){ BLOB_BLUR_PX = v; }
export let BLOB_GLOW_BRIGHTNESS = 140;   // percent — CSS brightness(), so >100 is a real amplified bloom, not just less-transparent
export function setBlobGlowBrightness(v){ BLOB_GLOW_BRIGHTNESS = v; }
export let BLOB_GLOW_SATURATION = 1.6;   // CSS saturate() — glow uses 1.6 in its fixed filter (index.html); blobglow's filter was missing it entirely, which is why rainbow blobs read washed out next to them
export function setBlobGlowSaturation(v){ BLOB_GLOW_SATURATION = v; }
// Harvest beam ("laser") glow — same #blobglow pattern, own canvas
// (#laserglow, index.html), own live CSS filter, deliberately NOT
// sharing BLOB_BLUR_PX/BLOB_GLOW_BRIGHTNESS/BLOB_GLOW_SATURATION so beam
// glow can be dialed independently of blob glow. See render.js's
// drawHarvestBeam.
export let BEAM_BLUR_PX = 25;
export function setBeamBlurPx(v){ BEAM_BLUR_PX = v; }
export let BEAM_GLOW_BRIGHTNESS = 140;
export function setBeamGlowBrightness(v){ BEAM_GLOW_BRIGHTNESS = v; }
export let BEAM_GLOW_SATURATION = 1.6;
export function setBeamGlowSaturation(v){ BEAM_GLOW_SATURATION = v; }

/* ================= flight / active-tool state ================= */
export let shipFlightState = "pilot";   // "pilot" | "hover" | "disembark"
// "landing" retired — under the drag-to-guide control scheme, release is
// always just "hold position and bob," so there's nothing left for a
// separate landing sequence to do. See entities.js's stepEntities for the
// drift-out-of-solid behavior that replaces its old auto-transition.
export function setShipFlightState(v){ shipFlightState = v; }

/* Harvest beam. Lives here rather than in main.js (where the input
   handling that flips it actually is) because render.js needs to read
   beamActive every frame to know whether to draw the beam at all, and an
   ES module import is a read-only live view from the consumer's side —
   render.js could see main.js's local beamActive but could never be the
   one place a boolean like this actually needs one owner, same reason
   shipFlightState/px/py already live here instead of in main.js. */
export let beamActive = false;
export function setBeamActive(v){ beamActive = v; }
/* circleMask(n)'s parameter is a diameter-ish size, not a radius — see
   main.js's beamTick for the verified numbers. Radius ~2.7/3.7/4.7 cells.
   Single source for both the harvest footprint (main.js) and the visual
   impact-radius ring (render.js), so they can't drift apart. */
export const BEAM_RADIUS_LEVELS = [6, 8, 10];
export let beamRadiusLevel = 0;
export function setBeamRadiusLevel(v){ beamRadiusLevel = v; }
// shipDragging: true for as long as a finger is actively guiding the ship
// toward px,py under the drag-to-guide control scheme (was holdSteering —
// same down/up lifecycle from main.js's pointerdown/endPointer, meaning
// fully repurposed since angle-steering no longer exists). Renamed rather
// than left stale, same reasoning materials.js's Starwater->Water rename
// documents: a name that no longer describes what it holds is a footgun
// for the next session reading this file.
export let shipDragging = false;
export function setShipDragging(v){ shipDragging = v; }
// thrustLevel retired with the old pilot control scheme — no thrust
// vector exists anymore; movement is entirely drag-toward-px,py.
// Purely cosmetic guide-blob specks (rainbow + smoke) for the ship's new
// control scheme. Deliberately separate from `particles` above: that
// array is grid-coupled (writes real material into the world on landing,
// shares generators' 4000-particle safety cap) and these must never do
// either — spawn/step live in entities.js next to the rest of the ship
// state machine, same relationship physics.js's stepParticles has to
// this file's `particles`.
export let shipBlobs = [];
export function setShipBlobs(b){ shipBlobs = b; }
// ---- on-foot avatar controls (shipFlightState==="disembark" only).
// A continuous 0..1 level set by a slider's pointer handler in main.js,
// read once per tick by entities.js's stepEntities — rather than a
// keyboard-style boolean, since touch is the primary input and the L/R
// slider is analog by design. avatarMoveLevel is signed: -1 = full left,
// 0 = centered/idle, +1 = full right. Springs back to 0 on release.
export let avatarMoveLevel = 0;
export function setAvatarMoveLevel(v){ avatarMoveLevel = v; }
// Jetpack: continuous upward accel while the warp slider is held past its
// halfway point during disembark. Boolean rather than analog on purpose —
// the slider's TRAVEL past 50% is the gesture, not a throttle position.
export let avatarJetpack = false;
export function setAvatarJetpack(v){ avatarJetpack = !!v; }
// One-shot jump request. Set true by the warp slider's pointerdown, consumed
// (and cleared) by the next stepEntities. A latch rather than a direct
// velocity write so the impulse always lands inside the physics step, in
// order with gravity/drag, instead of racing the tick from an input handler.
export let avatarJumpRequested = false;
export function setAvatarJumpRequested(v){ avatarJumpRequested = !!v; }
// NOTE: `mat` starts null here, not SAND — materials.js's ids don't exist
// until that module loads, and state.js must not import materials.js
// (that would be circular, since materials.js's isBuiltAt needs grid/idx/
// inB from here). main.js sets this to SAND once materials.js is loaded;
// see its startup sequence.
export let mat = null;
export function setMat(v){ mat = v; }
export let painting = false;
export function setPainting(v){ painting = v; }
export let pourMode = true;
export function setPourMode(v){ pourMode = v; }
export let paused = false;
export function setPaused(v){ paused = v; }
export let stampMode = null;   // null | {design, rot}
export function setStampMode(v){ stampMode = v; }
export let fieldMode = null;   // null | "neutron" | "positron" | "dock"
export function setFieldMode(v){ fieldMode = v; }
export let brushIndex = 1;
export function setBrushIndex(v){ brushIndex = v; }
// Live pointer position in world cells + the drag-placing flag for an
// armed stamp — render.js's drawStampGhost needs these for the live
// preview, ui.js's pointer handlers are what actually set them.
export let px = 0, py = 0;
export function setPx(v){ px = v; }
export function setPy(v){ py = v; }
export let stampPlacing = false;
export function setStampPlacing(v){ stampPlacing = v; }

/* ================= skeleton layer =================
   Immutable architectural backdrop — pre-authored buildings/structures
   placed in Build mode, baked once into render.js's own canvas and
   never touched again. Deliberately NOT part of grid[]: no chunk-wake,
   no decay, no onContact, none of physics.js's per-tick cost. This
   module owns only the two things that need to be shared across
   modules: the collision mask (physics.js's isSolidAt reads it, same
   chokepoint the ship/avatar/every entity already goes through) and the
   placement log (persistence.js saves/replays it). The actual pixels
   live in render.js's own canvas, rebuilt FROM this data on load —
   same "don't store what you can cheaply regenerate" philosophy as
   terrain.js's coordinate-seeded islands.
     Fixed-size for the app's lifetime, same as settleCounter/isSettling
   above — no setter needed, nothing ever reassigns the whole array,
   only individual cells get flipped to 1 (see stamps.js's
   landSkeletonStamp). Never cleared except a full reseed. */
export const skeletonMask = new Uint8Array(W*H);   // 1 = solid, blocks entities exactly like a "solid" material would
// [{name, x, y, rot}] — one entry per placed skeleton structure, in
// placement order. Replayed by stamps.js's rebuildSkeletonFromPlacements
// on load to reconstruct both skeletonMask and render.js's canvas.
// Reassigned wholesale on load (persistence.js), same pattern as
// setEntities/setGenerators — hence the setter.
export let skeletonPlacements = [];
export function setSkeletonPlacements(v){ skeletonPlacements = v; }
// Armed skeleton design awaiting placement — mirrors stampMode's own
// {design, rot} shape and buildPlacing mirrors stampPlacing, on purpose:
// same drag-to-position feel, just a different landing path and no
// gravity/physics step once placed (Build mode drops-and-locks directly
// where you confirm, it doesn't fall).
export let buildMode = null;   // null | {design, rot}
export function setBuildMode(v){ buildMode = v; }
export let buildPlacing = false;
export function setBuildPlacing(v){ buildPlacing = v; }
