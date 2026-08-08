// THE ELECTRIC VIVID RAINBOW COMPANY — full-screen interactive sand,
// zoomed way out. Forked off Zodiac Drift as of 2026-08-02; no
// persistence, no game chrome.
//   CORRECTION (site-tuning session, later same day): the line below used
// to claim state/materials/physics/entities/stamps/render were "verbatim
// from the game" — that was the ORIGINAL one-time-fork decision, and it's
// been gone since the tuning/perf session. As of that session: the site's
// js/ files are their own codebase, no verbatim obligation, no
// diff-flagging against the game (see that session's handoff §0 for the
// full framing change). materials.js, render.js, state.js, and physics.js
// have all had real site-specific edits landed directly in them since —
// most recently: state.js's onWorldExit hook and physics.js's one-line
// call site (trySwap's world-edge deletion), added to kill a full-grid
// scan that used to run every render frame. entities.js and stamps.js
// remain untouched so far, not because of a verbatim rule, just because
// nothing's needed editing there yet.
//   One courtesy still kept, not an obligation: flagging when a site fix
// is general enough to be worth porting BACK to the game.

import { W, H, VIEW_W, VIEW_H, camera, clampCamera, grid, idx, temp,
         setTemperatureEnabled, SPAWN_TEMP_DEFAULT, chunkAwake, setGrid,
         setNonEmissiveGlowMult, setOnWorldExit, setOnDecayToEmpty } from "./state.js";
import { MATS, MATBY, EMPTY, SOLID_TWIN, STAMP_TWIN,
         CORE_MATERIAL_NAMES, MAX_CUSTOM_MATERIALS, CUSTOM_TABLE_STORAGE_KEY } from "./materials.js";
import { mountMatLab, setMaterial as setMatLabMaterial } from "./ui-matlab.js";
import { step, wake, clearSettling } from "./physics.js";
import { render, setFlatDirtyRectsEnabled, flatDirtyRectsEnabled } from "./render.js";

setTemperatureEnabled(false);

// ---- material palette. Real materials, found by name — never
// hardcoded ids. Picked deliberately from the roster's powder/liquid/
// pressured materials with NO onContact and NO decay (verified against
// the actual materials.js definitions, not assumed) — density-based
// sinking/layering still works fully (that's real physics.js behavior,
// nothing special needed to keep it), reactions are just off the table
// for this pass by not including any reactive materials, not by
// disabling anything.
const SPECTRUM_COLORS = ["Red", "Yellow", "Green", "Blue", "Purple"];
const PALETTE_NAMES = [
  ...SPECTRUM_COLORS.map(c => `${c} Sand`),
  ...SPECTRUM_COLORS.map(c => `${c} Water`),
  ...SPECTRUM_COLORS.map(c => `${c} Gas`),
];
const PALETTE = PALETTE_NAMES.map(name => {
  const id = MATS.findIndex(m => m.name === name);
  if (id === -1) throw new Error(`Palette material "${name}" not found in materials.js — has it been renamed?`);
  return { id, name, color: MATS[id].sw };
});
let selectedMat = PALETTE[0].id;   // Sand, by default

const STONE = MATS.findIndex(m => m.name === "Stone");
if (STONE === -1) throw new Error("Stone not found in materials.js — has it been renamed?");
const VOIDSTONE = MATS.findIndex(m => m.name === "Voidstone");
if (VOIDSTONE === -1) throw new Error("Voidstone not found in materials.js — has it been renamed?");

// Zoomed all the way out was the wrong tool for "grains look too big" —
// camera.scale doesn't change on-screen block size at all (the render
// buffer is fixed-resolution, CSS-stretched regardless of zoom). scale=1
// now shows the FULL world height with zero void margin, since VIEW_H
// was doubled (state.js) to equal H exactly.
camera.scale = 1;
camera.x = Math.round((W - VIEW_W * camera.scale) / 2);
camera.y = Math.round((H - VIEW_H * camera.scale) / 2);   // provisional — clampCamera below will set this itself
clampCamera();
// ELECTRIC VIVID RAINBOW FORK: bottom-align AFTER clampCamera, not
// before — clampCamera (real, unmodified game code) unconditionally
// CENTERS the world whenever the view is taller than it (our case,
// VIEW_H=576 > H=384 since the resolution bump), which would silently
// undo anything set beforehand. Centering split the extra buffer space
// evenly above AND below, putting real out-of-bounds space — rendered
// as the game's own bold red edge-warning gradient, not neutral void —
// at the visible bottom regardless of crop height. Bottom-aligning
// instead means the world's last row lands exactly on the buffer's
// last row: all the extra space stacks at the TOP, which the
// bottom-anchored crop (below) already cuts first in a short/landscape
// window, before it ever reaches real content.
if (VIEW_H * camera.scale >= H) {
  camera.y = Math.round(H - VIEW_H * camera.scale);
}
// Static camera (never pans), so there's no sub-pixel-scroll reason to
// keep fractional coords — flooring here means every downstream array
// index built from camera.x/y is safe by construction, not just at the
// one call site that happened to get caught by testing.
camera.x = Math.floor(camera.x);
camera.y = Math.floor(camera.y);

// trySwap (physics.js) deletes material outright once it falls past the
// world's bottom edge ("left the world top or bottom — gone") — there's
// no natural floor at y=H. So this Stone floor isn't decorative, it's
// the only thing stopping painted sand from vanishing... EXCEPT at
// deliberate gaps: a hole is just an EMPTY cell left in the floor row.
// Sand that lands there tries to sink one more row, hits y>=H, and
// physics.js deletes it on the very next tick — no engine change
// needed, confirmed by reading trySwap directly rather than assuming.
// This is the drain mechanism for the live-sand cap below: holes bleed
// off standing piles continuously instead of needing an active prune.
// Edge holes are sized from the rainbow frame inset (see buildFloor);
// center hole tracks the title width; both are rebuilt on resize.
const FLOOR_EDGE_HOLE_SCALE = 0.88;   // slightly narrower than the border bands
const FLOOR_Y = H - 1;
const floorCells = new Set();   // real indices actually placed as floor — NOT just "W of them", since holes mean it's fewer. Used below to keep the live-sand cap counting painted material only, not structural floor.

// ---- STUDIO EDITOR — structural, editor-placed cells (rectangle
// fill/erase tool). Tracked the same way floorCells/domColliderCells
// are: a Set of grid indices so carry-pickup can exempt them (this is
// authored site structure, not visitor-painted sand a guest should be
// able to scoop up) and so they're never counted against
// MAX_LIVE_SAND/paintedCellCount, which exists to bound ephemeral
// visitor painting, not permanent authored content.
//   CAVEAT, flagged not solved: the 18 rainbow materials have real decay
// rates (materials.js, added for visitor-painted cells fading over
// time). Anything the editor fills with one of THOSE materials will
// still decay away on its own — there's no separate "permanent"
// material set yet. Fine for quick mockups, not fine for a client's
// actual structural art. Worth a real conversation before this ships on
// a client site; flagging here rather than silently working around it.
const editorCells = new Set();

// ---- STUDIO EDITOR — RLE grid encode/decode. The exported JSON format's
// core payload. Plain run-length-encoding, not a general compressor —
// this grid is overwhelmingly EMPTY/Stone in long horizontal runs, so
// RLE alone gets a huge size win with a trivial, dependency-free
// implementation and a genuinely git-diffable flat array of numbers
// (unlike a base64 blob, which diffs as one opaque line no matter how
// small the actual change was).
function encodeGridRLE(g) {
  const runs = [];
  let i = 0;
  while (i < g.length) {
    const v = g[i];
    let j = i + 1;
    while (j < g.length && g[j] === v) j++;
    runs.push(v, j - i);
    i = j;
  }
  return runs;
}
function decodeGridRLE(runs, length) {
  const g = new Uint8Array(length);
  let p = 0, i = 0;
  while (p < runs.length) {
    const v = runs[p++], c = runs[p++];
    g.fill(v, i, i + c);
    i += c;
  }
  return g;
}

// ---- STUDIO EDITOR — initial-state loading. An HTML export
// (SandEditor.exportHTML, near the bottom of this file) bakes the grid
// at export time into `window.__INITIAL_GRID__` as a plain inline
// <script> before this module tag. If present, it's authoritative: skip
// the default floor-build below entirely and reconstruct floorCells/
// domColliderCells/editorCells + paintedCellCount from what's actually
// in the loaded grid, one-time cost (a single W*H scan at startup, not
// a per-frame one) rather than assume anything about how it got there.
const _initial = window.__INITIAL_GRID__;
let usingInitialGrid = false;
if (_initial && Array.isArray(_initial.runs) && _initial.length === W * H) {
  setGrid(decodeGridRLE(_initial.runs, _initial.length));
  usingInitialGrid = true;
}

// Floor row is built later by buildFloor() — needs live canvas layout for
// edge/center hole placement (see applySiteLayout after resizeBox).

// ---- LIVE-SAND CAP. Holes in the floor (above) drain standing piles
// continuously, but a visitor holding the pointer down and dragging
// across open space can still add material faster than a handful of
// narrow gaps can drain it — this is the hard backstop for that case,
// not a replacement for the holes.
//   4000 chosen as: world is W*H = 270,336 cells total, but this is a
// homepage decoration meant to draw a glance, not become the page —
// 4000 painted cells is enough for genuinely dense, satisfying pile-ups
// (a full BRUSH_R=4 dab is ~49 cells, so this is ~80 uninterrupted dabs
// worth of standing material) while staying nowhere near "buried."
// It's also a trivial fraction of total awake-chunk capacity, so it's
// not doing any perf work here — it's a visual-density ceiling, not a
// performance safety valve (the chunk-sleep system already handles that).
// One constant, easy to move if it reads wrong once it's live in front
// of you — say the word and I'll wire it into the tuning panel instead.
const MAX_LIVE_SAND = 4000;
// ELECTRIC RAINBOW MAGIC FORK — was recomputed via a full W*H grid scan
// (~270k cells) every render-eligible frame. Now maintained incrementally:
// +1 in placeMaterial below when a NEW cell is painted (overwriting an
// already-painted cell is still exempt, unchanged), -1 via onWorldExit
// (state.js) whenever physics.js's trySwap deletes a cell for falling past
// the world edge, OR whenever physics.js's decay pass converts a cell to
// EMPTY (onDecayToEmpty, added alongside real decay rates on the 18
// rainbow materials — see materials.js). Between the two, this now
// covers every deletion path a palette material can hit: world-exit and
// decay-to-EMPTY are the only ways any of the current 18 ever vanish
// (none have onContact/meltTo/freezeTo/emits, verified directly against
// materials.js, not assumed — and none decayTo another material, only
// to EMPTY). Floor/DOM-collider cells are static solids that never reach
// either deletion path, so this can only ever fire for painted material.
// O(1) per event instead of O(W*H) per frame, exact — not a throttled
// estimate.
let paintedCellCount = 0;
setOnWorldExit(() => {
  paintedCellCount = Math.max(0, paintedCellCount - 1);
});
setOnDecayToEmpty(() => {
  paintedCellCount = Math.max(0, paintedCellCount - 1);
});

// ELECTRIC RAINBOW MAGIC FORK — a decay-based expiry queue lived here
// briefly (30s FIFO, cleared cells to help bound long-run particle count)
// and got pulled: decayQueue.shift() is O(n) per call, and continuous
// pour (added same session) makes it easy to build a large pile fast
// whose cells then cluster together in expiry time too, since expiresAt
// is a fixed offset from placement tick — meaning a burst of thousands of
// entries could expire in a tight run of ticks, each paying an O(n) shift
// against a still-large queue. Real O(n²) territory in a hot loop, and
// exactly what caused the freezing. Testing at the time only ever pushed
// a couple of cells at once — never the realistic "hold continuously,
// build a real pile" case that continuous pour makes common. If decay
// comes back, it needs an actual ring buffer or a head-index into a
// periodically-compacted array, not Array.shift() in a loop over
// anything that can grow into the thousands.

function placeMaterial(wx, wy) {
  if (wx < 0 || wx >= W || wy < 0 || wy >= FLOOR_Y) return;
  const i = idx(wx, wy);
  const existing = grid[i];
  const empty = existing === EMPTY;
  // ELECTRIC RAINBOW MAGIC FORK — overwrite-on-paint REMOVED (was a 60%
  // per-touch punch-through chance, added to match main.js's real
  // paint() rule). Reverted to a hard refuse on any non-empty cell:
  // the overwrite mechanic isn't part of the actual game to begin with,
  // it's a site-only addition, and it was the leading suspect for an
  // on-device freeze when painting a liquid over an existing powder
  // cell. Slow decay (materials.js, all 18 rainbow materials) is the
  // replacement mechanism for clearing old material — painted cells now
  // fade out on their own over time instead of being punched through.
  if (!empty) return;
  const M = MATS[selectedMat];
  if (paintedCellCount >= MAX_LIVE_SAND) return;
  grid[i] = selectedMat;
  temp[i] = SPAWN_TEMP_DEFAULT;
  clearSettling(i);
  wake(wx, wy);
  paintedCellCount++;
}

// ---- DOM element collision: any element with class="solid-collider"
// becomes solid within the sim, positioned via its real getBoundingClientRect
// — the wordmark/tagline are the first test case. Reuses Stone (same
// material as the floor) rather than adding a new one, easy to swap
// later. Provenance-tracked (domColliderCells) so a resize can cleanly
// undo exactly what THIS system placed, without touching the floor or
// anything the user painted.
//   ELECTRIC RAINBOW MAGIC FORK: now uses Voidstone (not Stone) and only
// a THIN LEDGE at the bottom edge of each element's bounding box, not
// the full height — see applyDomColliders below for the actual reasoning.
const domColliderCells = new Set();

// ---- STUDIO EDITOR — (re)classifies every non-empty grid cell by
// material/position: STONE on the floor row -> floorCells, VOIDSTONE
// anywhere -> domColliderCells (applyDomColliders() below only fills
// EMPTY cells, so without this a reloaded page's old ledges would never
// get cleaned up on resize), everything else -> assumed editor-placed
// structure (editorCells), immune to visitor carry and exempt from
// MAX_LIVE_SAND. Used both for the one-time startup load of an exported
// initial grid, and again on a live JSON import from the editor toolbar.
//   Real visitor-painted sand from BEFORE an export would also fall
// into the editorCells bucket and get treated as structural — an
// accepted imprecision: the export format doesn't currently distinguish
// "a visitor painted this" from "the editor placed this," and
// re-classifying it as structural on reload is the safer failure mode
// (permanent) over the alternative (visitor sand quietly decaying/
// capped when it wasn't before).
function reconstructTrackingSetsFromGrid() {
  floorCells.clear(); domColliderCells.clear(); editorCells.clear();
  paintedCellCount = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = idx(x, y);
      const v = grid[i];
      if (v === EMPTY) continue;
      if (y === FLOOR_Y && v === STONE) { floorCells.add(i); continue; }
      if (v === VOIDSTONE) { domColliderCells.add(i); continue; }
      editorCells.add(i);
    }
  }
}
if (usingInitialGrid) reconstructTrackingSetsFromGrid();

function clearDomColliders() {
  for (const i of domColliderCells) {
    // Only clear if it's still literally what we placed — if user-painted
    // sand has since settled/compacted into this exact cell, leave it
    // alone rather than deleting real content.
    if (grid[i] === VOIDSTONE) {
      grid[i] = EMPTY;
      wake(i % W, Math.floor(i / W));
    }
  }
  domColliderCells.clear();
}

// How thick (world cells) the invisible footing under each text collider
// is. Independent of CELL_PX (that's screen pixels per cell, this is
// world-space) — stays a small, thin strip regardless of grain size.
const COLLIDER_LEDGE_THICKNESS = 1;

// Inner edge of the rainbow border frame (matches index.html --frame-inset).
function rainbowFrameInsetPx() {
  const root = getComputedStyle(document.documentElement);
  const vmin = Math.min(window.innerWidth, window.innerHeight) / 100;
  const parseLen = (raw, fallback) => {
    const val = (raw || fallback).trim();
    if (val.endsWith("vmin")) return parseFloat(val) * vmin;
    if (val.endsWith("px")) return parseFloat(val);
    return parseFloat(val) * vmin;
  };
  const band = parseLen(root.getPropertyValue("--band"), "1vmin");
  const sep = parseLen(root.getPropertyValue("--sep"), "0.43vmin");
  return 5 * band + 4 * sep;
}

function applyDomColliders() {
  clearDomColliders();
  const rect0 = canvases[0].getBoundingClientRect();
  const els = document.querySelectorAll(".solid-collider");

  function screenYToWorldRow(screenY) {
    return Math.ceil(camera.y + (screenY - rect0.top) / rect0.height * VIEW_H * camera.scale);
  }

  function placeLedge(wx0, wx1, wyBottom) {
    const wy0 = wyBottom - COLLIDER_LEDGE_THICKNESS;
    for (let y = wy0; y < wyBottom; y++) {
      for (let x = wx0; x < wx1; x++) {
        if (x < 0 || x >= W || y < 0 || y >= H) continue;
        const i = idx(x, y);
        if (grid[i] !== EMPTY) continue;
        grid[i] = VOIDSTONE;
        domColliderCells.add(i);
        wake(x, y);
      }
    }
  }

  for (const el of els) {
    const r = el.getBoundingClientRect();
    const wx0 = Math.floor(camera.x + (r.left - rect0.left) / rect0.width * VIEW_W * camera.scale);
    const wx1 = Math.ceil(camera.x + (r.right - rect0.left) / rect0.width * VIEW_W * camera.scale);
    placeLedge(wx0, wx1, screenYToWorldRow(r.bottom));
  }
}

function screenXToWorldX(screenX) {
  const rect0 = canvases[0].getBoundingClientRect();
  return camera.x + (screenX - rect0.left) / rect0.width * VIEW_W * camera.scale;
}

function edgeHoleWorldWidth() {
  const insetPx = rainbowFrameInsetPx();
  const rect0 = canvases[0].getBoundingClientRect();
  if (!rect0.width) return 4;
  const insetWorld = (insetPx / rect0.width) * VIEW_W * camera.scale;
  return Math.max(2, Math.floor(insetWorld * FLOOR_EDGE_HOLE_SCALE));
}

function clearFloorRow() {
  for (const i of floorCells) {
    if (grid[i] === STONE) {
      grid[i] = EMPTY;
      wake(i % W, FLOOR_Y);
    }
  }
  floorCells.clear();
}

function mergeHoleRanges(ranges) {
  const sorted = ranges.slice().sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const [a, b] of sorted) {
    if (merged.length && a <= merged[merged.length - 1][1]) {
      merged[merged.length - 1][1] = Math.max(merged[merged.length - 1][1], b);
    } else merged.push([a, b]);
  }
  return merged;
}

function buildFloor() {
  if (usingInitialGrid) return;
  clearFloorRow();
  const edgeW = edgeHoleWorldWidth();
  // Edge holes must line up with the SCREEN edges, not the world's true
  // edges — the camera only ever shows a cropped middle slice of the
  // wider world (camera.x .. camera.x+VIEW_W*camera.scale), so a hole
  // placed at world x=0/W sits far outside anything visible. Floor rows
  // outside the visible slice are unreachable anyway (painting/screen
  // math only ever produces world coords inside it), so it's safe to
  // only build floor within that range.
  const viewLeft = Math.floor(camera.x);
  const viewRight = Math.ceil(camera.x + VIEW_W * camera.scale);
  const holes = [[viewLeft, viewLeft + edgeW], [viewRight - edgeW, viewRight]];

  const merged = mergeHoleRanges(holes);
  const inHole = (x) => merged.some(([a, b]) => x >= a && x < b);

  for (let x = viewLeft; x < viewRight; x++) {
    if (inHole(x)) continue;
    const i = idx(x, FLOOR_Y);
    grid[i] = STONE;
    floorCells.add(i);
    wake(x, FLOOR_Y);
  }
}

function applySiteLayout() {
  buildFloor();
  applyDomColliders();
}

// Brush radius scales with zoom — at 1 world-cell fixed radius, a dab
// would look tiny once each cell only covers a fraction of a screen
// pixel at this zoom level. Scaling it keeps the touch feel consistent.
const BRUSH_R = 4;
function paintAt(wx, wy) {
  for (let dy = -BRUSH_R; dy <= BRUSH_R; dy++) {
    for (let dx = -BRUSH_R; dx <= BRUSH_R; dx++) {
      if (dx * dx + dy * dy <= BRUSH_R * BRUSH_R) placeMaterial(wx + dx, wy + dy);
    }
  }
}

// ---- full-screen sizing: fixed, ADJUSTABLE pixel size per world-cell
// (CELL_PX) — NOT stretched to fill whatever shape the window happens
// to be. render() always produces the same VIEW_W x VIEW_H buffer;
// stretching all of it into any window shape (the previous approach)
// squished the floor/pile into a barely-visible sliver in short
// landscape windows — technically still rendered, just diluted across
// a much taller virtual space than the window could usefully show.
//   Each canvas is now sized to its natural VIEW_W*CELL_PX x
// VIEW_H*CELL_PX and anchored bottom-center: only as many rows as
// actually fit the window height are shown, and they're always the
// BOTTOM rows — right where the floor and any pile are — with the
// empty sky above cropped off instead of squeezed in. A tap in the
// cropped-off void area harmlessly no-ops (placeSand's own bounds
// check rejects it), no special-casing needed.
//   CELL_PX is the actual adjustable knob: raise it for bigger grains
// (shows less of the world), lower it for smaller grains (shows more).
// Ceiling: if the window exceeds VIEW_W*CELL_PX or VIEW_H*CELL_PX in
// either dimension, that edge will letterbox (visible void-colored
// gap) — the fixed 300x384 buffer is the hard limit. Fix at that point
// is bumping VIEW_W/VIEW_H in state.js, or lowering CELL_PX.
// ---- responsive grain default. Mobile: CELL_PX=2 (smaller grains —
// more of the world fits the fixed VIEW_W*CELL_PX buffer into a
// narrower window before letterboxing). Desktop: CELL_PX=3. Width-based
// rather than pointer-type-based (matchMedia "(pointer: coarse)") —
// Crash's framing was screen-size/viewport ("mobile needs...desktop
// needs"), and width is what actually drives the letterbox tradeoff
// this constant controls. 768px is a common phone/tablet breakpoint,
// not measured against this site specifically — trivial to change if
// it reads wrong on a real device.
const MOBILE_BREAKPOINT_PX = 768;
function responsiveCellPx() {
  return window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT_PX}px)`).matches ? 2 : 3;
}
// Once the tuning-panel slider has been touched, the responsive default
// stops reasserting itself on resize/orientation-change — a manual
// choice shouldn't get silently overwritten by rotating the phone.
// Until then, resize/orientationchange keep re-deriving it live (see
// both handlers below), so e.g. widening a desktop browser window past
// the breakpoint, or the reverse, actually changes grain size without
// a reload.
let grainUserOverridden = false;
// ELECTRIC VIVID RAINBOW FORK — was `const`, now `let`: the tuning
// panel's grain-size slider reassigns this directly (same module, legal)
// and calls resizeBox() itself to apply it. Nothing else in this file
// reads CELL_PX before resizeBox runs, so a stale read isn't possible.
let CELL_PX = responsiveCellPx();
let grainSlider = null;   // assigned once the tuning panel builds it, near the bottom of this file
// Re-checks the responsive default and, if it's changed and the user
// hasn't manually overridden it, applies it by driving the actual
// slider element — dispatching a real "input" event reuses the
// slider's own onInput callback (below) instead of duplicating the
// CELL_PX/resizeBox/applyDomColliders sequence a second time here.
function maybeApplyResponsiveGrain() {
  if (grainUserOverridden || !grainSlider) return;
  const target = responsiveCellPx();
  if (target === CELL_PX) return;
  grainSlider.value = target;
  grainSlider.dispatchEvent(new Event("input"));
}
const box = document.getElementById("box");
const canvasIds = ["base", "glow", "blobglow", "laserglow", "vecOverlay"];
const canvases = canvasIds.map(id => document.getElementById(id));
function resizeBox() {
  box.style.width = window.innerWidth + "px";
  box.style.height = window.innerHeight + "px";
  const cw = VIEW_W * CELL_PX, ch = VIEW_H * CELL_PX;
  for (const c of canvases) {
    c.style.width = cw + "px";
    c.style.height = ch + "px";
    c.style.left = "50%";
    c.style.bottom = "0px";
    c.style.top = "auto";
    c.style.transform = "translateX(-50%)";
  }
}
resizeBox();
applySiteLayout();
// ELECTRIC RAINBOW MAGIC FORK — applyDomColliders() reads LIVE rendered
// getBoundingClientRect() off each .solid-collider span, no font-specific
// math anywhere in it — genuinely font-agnostic by construction. But
// that also means it's exactly as accurate as whatever's actually
// painted on screen the moment it runs, and Google Fonts load
// asynchronously: the call directly above almost certainly measures the
// h1 in its FALLBACK font (monospace), not the real one, since the
// custom font typically hasn't finished downloading yet at this point
// in the page lifecycle. Nothing else was re-triggering a re-measurement
// after the swap — the only other caller is the debounced resize
// handler, which has no reason to fire just because a font finished
// loading. On a phone, where an orientation-triggered resize might never
// happen in a session, that meant the ledges could sit silently
// misaligned with the visible letterforms for the entire visit.
// document.fonts.ready resolves once every @font-face the page
// requested has either loaded or failed — re-running the measurement
// there catches the real, final layout. Keeping the immediate call
// above too: cheap, harmless, and gives SOME colliders right away
// rather than a naked gap before fonts.ready resolves.
document.fonts.ready.then(applySiteLayout);

// ---- carry-preview overlay sizing. Plain screen-space canvas — full
// viewport resolution, 1:1 with CSS pixels (no devicePixelRatio
// multiplier, matching #box's own canvases, which are sized the same
// unscaled way — see the CELL_PX comment above). Resized alongside
// resizeBox() below, not on its own separate schedule, so the two never
// drift out of sync relative to each other.
const carryCanvas = document.getElementById("carryOverlay");
const carryCtx = carryCanvas.getContext("2d");
function resizeCarryOverlay() {
  carryCanvas.width = window.innerWidth;
  carryCanvas.height = window.innerHeight;
}
resizeCarryOverlay();

// ---- carry-GLOW overlay. Same screen-space sizing as carryOverlay
// above, own canvas (index.html's #carryGlow) — a picked-up blob was
// rendering flat on carryOverlay with no glow at all, since carrying
// lifts material off the grid entirely (see beginCarry below) and the
// grid is the only thing render.js's real #glow layer ever draws from.
// This mirrors the exact base+glow duplicate-canvas trick render.js
// already uses three times over (#glow, #blobglow, #laserglow): draw
// the identical solid rects into a second canvas, let a CSS blur/
// saturate/brightness filter + screen blend do the actual glow. Kept
// as its own canvas rather than folded into carryOverlay because that
// filter has to apply to ONLY the glow duplicate, not the crisp layer
// underneath — one canvas can't have two different filters.
const carryGlowCanvas = document.getElementById("carryGlow");
const carryGlowCtx = carryGlowCanvas.getContext("2d");
function resizeCarryGlow() {
  carryGlowCanvas.width = window.innerWidth;
  carryGlowCanvas.height = window.innerHeight;
}
resizeCarryGlow();

// ---- WORLD-SPACE LINK OVERLAY. Canvas pixels have no native hit-testing
// or href of their own — a <canvas> is one DOM element, full stop, so
// "make this region clickable" always means putting a REAL element on
// top of it, regardless of what drew the pixels underneath (Stone, a
// future skeleton-baked building, a stamped/painted shape — all just
// bytes in the same buffer once rendered, no distinction the DOM can
// see). This is the general mechanism: give it a WORLD-CELL rectangle,
// it mints a real <a>, sized/positioned to match on screen, using the
// same screen<->world math screenToCell (below) already uses, just
// inverted. Doesn't care what's solid underneath or why.
//   No real destinations to link yet (skeleton content isn't landed on
// the site), so nothing calls addLinkRegion() below — this is the
// mechanism, ready to wire up once there's actual art/structures to
// attach hrefs to.
const linkRegions = [];   // {el, wx0, wy0, wx1, wy1}

function worldRectToScreen(wx0, wy0, wx1, wy1) {
  const rect = canvases[0].getBoundingClientRect();
  const pxPerWX = rect.width / (VIEW_W * camera.scale);
  const pxPerWY = rect.height / (VIEW_H * camera.scale);
  return {
    left: rect.left + (wx0 - camera.x) * pxPerWX,
    top: rect.top + (wy0 - camera.y) * pxPerWY,
    width: (wx1 - wx0) * pxPerWX,
    height: (wy1 - wy0) * pxPerWY,
  };
}

// wx0,wy0,wx1,wy1: world-cell rectangle (same coordinate space
// screenToCell produces). href: link target. label: for aria-label,
// since this element has no visible text of its own — the rendered
// sand/art underneath IS the visual, the <a> is purely a hit-target.
function addLinkRegion(wx0, wy0, wx1, wy1, href, label) {
  const el = document.createElement("a");
  el.href = href;
  el.setAttribute("aria-label", label || href);
  // display:block + fixed positioning, explicitly no visible chrome
  // (no border/background/underline) — this sits ON TOP of already-
  // rendered content, it should be invisible as an element and only
  // present as a hit target + whatever native affordance the browser
  // gives a real link (cursor, focus ring on tab, right-click menu).
  el.style.cssText = "position:fixed;z-index:12;display:block;";
  document.body.appendChild(el);
  const region = { el, wx0, wy0, wx1, wy1 };
  linkRegions.push(region);
  positionLinkRegion(region);
  return region;   // caller can el.remove() + splice this out of linkRegions if a region needs to go away later
}

function positionLinkRegion(region) {
  const r = worldRectToScreen(region.wx0, region.wy0, region.wx1, region.wy1);
  region.el.style.left = r.left + "px";
  region.el.style.top = r.top + "px";
  region.el.style.width = r.width + "px";
  region.el.style.height = r.height + "px";
}

function repositionAllLinkRegions() {
  for (const r of linkRegions) positionLinkRegion(r);
}

let resizeDebounce = null;
window.addEventListener("resize", () => {
  maybeApplyResponsiveGrain();   // no-op unless the breakpoint was actually crossed and the user hasn't overridden it
  resizeBox();
  resizeCarryOverlay();
  resizeCarryGlow();
  repositionAllLinkRegions();   // cheap (just style writes, no layout re-scan), unlike applyDomColliders below — fine to run on every resize event, not just the debounced settle
  clearTimeout(resizeDebounce);
  // Debounced — a resize drag fires many events in a row, and re-scanning
  // every tagged element's real layout position on every single one of
  // them is wasted work mid-drag. Re-applies once things settle.
  resizeDebounce = setTimeout(applySiteLayout, 150);
});

// Orientation changes on mobile fire a resize event, but the browser
// often hasn't finished reflowing the new layout when that resize lands —
// getBoundingClientRect() still reads the old orientation's geometry,
// so the 150ms debounced applyDomColliders above measures the wrong thing
// and the collider boxes end up misaligned. orientationchange itself fires
// reliably AFTER the resize, but layout still isn't complete — a short
// additional delay gives the browser time to finish the reflow before
// we re-scan. 350ms is generous; most devices finish within 200ms, but
// cheap insurance for slower hardware.
window.addEventListener("orientationchange", () => {
  clearTimeout(resizeDebounce);
  resizeDebounce = setTimeout(() => {
    maybeApplyResponsiveGrain();   // rotating can cross the width breakpoint on larger phones/small tablets
    resizeBox();
    resizeCarryOverlay();
    resizeCarryGlow();
    repositionAllLinkRegions();
    applySiteLayout();
  }, 350);
});

// ---- pointer painting: screen coords -> world cells, via the CANVAS's
// own live rect (not the box's) — the canvas may now be smaller than
// the box and offset within it (bottom-anchored, horizontally centered
// cropping), so the box's own rect would be wrong once it stopped being
// a 1:1 stand-in for the rendered content.
let pointerDown = false;
// ELECTRIC RAINBOW MAGIC FORK — updated on down/move, read every frame in
// loop() below while pointerDown is true. Matches the real game's model
// (main.js: a `painting` flag + `if(painting) paint()` once per animation
// frame, NOT gated on movement) instead of the site's old move-only
// painting, which only fired on pointermove and did nothing while held
// still — holding still is exactly the "continuous pour" case.
let lastPointerX = 0, lastPointerY = 0;
function screenToCell(clientX, clientY) {
  const rect = canvases[0].getBoundingClientRect();
  // Floor the FULL combined coordinate, not just the offset — camera.x/y
  // can be fractional, and a fractional index silently no-ops on a
  // Uint8Array write instead of throwing. Caught this earlier by
  // testing, not by reading the code.
  const cellX = Math.floor(camera.x + (clientX - rect.left) / rect.width * VIEW_W * camera.scale);
  const cellY = Math.floor(camera.y + (clientY - rect.top) / rect.height * VIEW_H * camera.scale);
  return [cellX, cellY];
}

// ---- pick up & carry: touch non-empty material -> lift a radius-6 disc
// of it clear off the grid (physics stops seeing it entirely, so it
// genuinely floats, ignoring gravity, not just "moves slowly") -> it
// follows the pointer in screen space only, no grid writes while held ->
// on release, write every held cell back at its same relative offset
// from wherever the pointer ended up. Gesture disambiguation is just
// "what's under the touch": empty cell -> paintAt (existing behavior,
// untouched), non-empty -> carry. No mode toggle, no long-press timer.
//   Deliberately bypasses paintAt/placeMaterial for both pickup and
// drop — this is EXISTING material changing location, not new material
// being created, so it must NOT touch paintedCellCount in either
// direction (pick up already-counted material, set it back down,
// still exactly one count the whole time) or MAX_LIVE_SAND's cap. Both
// hooks (onWorldExit, onDecayToEmpty) stay irrelevant here too — this
// is a same-tick relocation, not a deletion.
const CARRY_R = 6;
let carrying = false;
let carriedCells = [];        // {dx, dy, mat} — dx/dy relative to the pickup anchor cell
let carryPointerX = 0, carryPointerY = 0;   // last known client coords while carrying, screen space

function beginCarry(anchorWX, anchorWY, clientX, clientY) {
  carriedCells = [];
  for (let dy = -CARRY_R; dy <= CARRY_R; dy++) {
    for (let dx = -CARRY_R; dx <= CARRY_R; dx++) {
      if (dx * dx + dy * dy > CARRY_R * CARRY_R) continue;
      const wx = anchorWX + dx, wy = anchorWY + dy;
      if (wx < 0 || wx >= W || wy < 0 || wy >= FLOOR_Y) continue;
      const i = idx(wx, wy);
      if (grid[i] === EMPTY) continue;
      // structural cells are not pickupable — domColliderCells (invisible
      // word ledges) and floorCells (floor) both need to stay put.
      // Checking both sets rather than the material id alone: VOIDSTONE is
      // the material used for ledges, but the floor uses its own material
      // too, and guarding by set membership is safer than guarding by id
      // (a future material added to one of these structural sets would be
      // automatically immune without needing a separate id check here).
      if (domColliderCells.has(i) || floorCells.has(i) || editorCells.has(i)) continue;
      carriedCells.push({ dx, dy, mat: grid[i] });
      grid[i] = EMPTY;
      clearSettling(i);
      wake(wx, wy);   // neighbors need to know this cell is gone (e.g. a compacted pile losing lateral support)
    }
  }
  carrying = carriedCells.length > 0;
  carryPointerX = clientX; carryPointerY = clientY;
}

function dropCarry() {
  if (!carrying) return;
  const [dropWX, dropWY] = screenToCell(carryPointerX, carryPointerY);
  for (const cell of carriedCells) {
    const tx = dropWX + cell.dx, ty = dropWY + cell.dy;
    if (tx < 0 || tx >= W || ty < 0 || ty >= FLOOR_Y) continue;   // off-world — that cell's material is lost, matches how painting off-world already no-ops
    const i = idx(tx, ty);
    if (grid[i] !== EMPTY) continue;   // occupied — no overwrite, same hard rule paintAt follows; that cell's material is lost rather than forced in
    grid[i] = cell.mat;
    clearSettling(i);
    wake(tx, ty);
  }
  carrying = false;
  carriedCells = [];
  carryCtx.clearRect(0, 0, carryCanvas.width, carryCanvas.height);
}

// Screen-space draw of the held clump, called once per animation frame
// from loop() while carrying — reuses the exact same world<->screen
// conversion worldRectToScreen (below) is built on, so the preview lines
// up pixel-for-pixel with where the cells will actually land on drop.
function drawCarryPreview() {
  carryCtx.clearRect(0, 0, carryCanvas.width, carryCanvas.height);
  carryGlowCtx.clearRect(0, 0, carryGlowCanvas.width, carryGlowCanvas.height);
  if (!carrying) return;
  const rect = canvases[0].getBoundingClientRect();
  const pxPerWX = rect.width / (VIEW_W * camera.scale);
  const pxPerWY = rect.height / (VIEW_H * camera.scale);
  const [anchorWX, anchorWY] = screenToCell(carryPointerX, carryPointerY);
  for (const cell of carriedCells) {
    const wx = anchorWX + cell.dx, wy = anchorWY + cell.dy;
    const sx = rect.left + (wx - camera.x) * pxPerWX;
    const sy = rect.top + (wy - camera.y) * pxPerWY;
    const w = Math.ceil(pxPerWX), h = Math.ceil(pxPerWY);
    const M = MATBY[cell.mat];
    carryCtx.fillStyle = M.sw;
    carryCtx.fillRect(Math.round(sx), Math.round(sy), w, h);
    // Same rect, second canvas — carryGlowCanvas's CSS filter (kept in
    // sync with #glow's own tuning-panel sliders, see applyGlowFilter
    // below) does the actual blur/bloom. All 18 rainbow materials are
    // em:true (checked directly, not assumed — see materials.js), but
    // guarding on M.em rather than drawing unconditionally means a
    // future non-emissive material that somehow ends up carryable
    // won't get a glow it isn't supposed to have.
    if (M.em) {
      carryGlowCtx.fillStyle = M.sw;
      carryGlowCtx.fillRect(Math.round(sx), Math.round(sy), w, h);
    }
  }
}

// ---- STUDIO EDITOR — rectangle fill/erase tool. Only active when
// editMode is on AND the toolbar's tool is set to "fill" or "erase";
// otherwise every pointer event below falls straight through to the
// existing paint/carry gesture, byte-for-byte the same as before the
// editor existed. Drag defines a rectangle in world-cell space (any
// direction — normalizedRect below sorts it out), release commits it.
let editMode = false;
let editorTool = "paint";   // "paint" | "fill" | "erase"
let showGrid = false;
let overlaysVisible = true;   // tuning panel + palette bar
let uiHidden = false;         // hard kill-switch for every bit of this file's own on-screen chrome

let rectDragging = false;
let rectStartWX = 0, rectStartWY = 0, rectCurWX = 0, rectCurWY = 0;

function normalizedRect(x0, y0, x1, y1) {
  return {
    x0: Math.max(0, Math.min(x0, x1)),
    y0: Math.max(0, Math.min(y0, y1)),
    x1: Math.min(W, Math.max(x0, x1) + 1),
    y1: Math.min(FLOOR_Y + 1, Math.max(y0, y1) + 1),
  };
}

// Fill writes selectedMat directly (bulk tool, not gated on "must be
// empty" like paintAt/placeMaterial — it's meant to overwrite) and
// tracks every written cell as editorCells structure. Erase writes
// EMPTY and drops the cell from all three structural tracking sets, so
// erasing a chunk of floor or an old ledge actually un-registers it
// rather than leaving a stale entry behind.
function commitRect(x0, y0, x1, y1, erase) {
  const r = normalizedRect(x0, y0, x1, y1);
  for (let y = r.y0; y < r.y1; y++) {
    for (let x = r.x0; x < r.x1; x++) {
      const i = idx(x, y);
      floorCells.delete(i);
      domColliderCells.delete(i);
      editorCells.delete(i);
      if (erase) {
        grid[i] = EMPTY;
      } else {
        grid[i] = selectedMat;
        editorCells.add(i);
      }
      clearSettling(i);
      wake(x, y);
    }
  }
}

// ---- STUDIO EDITOR — grid + rect-drag overlay canvas. Same
// screen-space, unscaled sizing convention as carryOverlay/carryGlow
// above, own dedicated canvas rather than sharing one of those (they're
// cleared and redrawn every frame by their own owners already, and this
// needs to draw regardless of whether a carry is in progress).
const editorOverlayCanvas = document.createElement("canvas");
editorOverlayCanvas.style.cssText = "position:fixed;inset:0;z-index:13;pointer-events:none;";
document.body.appendChild(editorOverlayCanvas);
const editorOverlayCtx = editorOverlayCanvas.getContext("2d");
function resizeEditorOverlay() {
  editorOverlayCanvas.width = window.innerWidth;
  editorOverlayCanvas.height = window.innerHeight;
}
resizeEditorOverlay();
window.addEventListener("resize", resizeEditorOverlay);
window.addEventListener("orientationchange", resizeEditorOverlay);

function drawEditorOverlay() {
  editorOverlayCtx.clearRect(0, 0, editorOverlayCanvas.width, editorOverlayCanvas.height);
  if (uiHidden || (!showGrid && !rectDragging)) return;
  const rect = canvases[0].getBoundingClientRect();
  const pxPerWX = rect.width / (VIEW_W * camera.scale);
  const pxPerWY = rect.height / (VIEW_H * camera.scale);

  if (showGrid) {
    editorOverlayCtx.strokeStyle = "rgba(232,223,255,0.18)";
    editorOverlayCtx.lineWidth = 1;
    editorOverlayCtx.beginPath();
    const xStart = Math.floor(camera.x), xEnd = Math.ceil(camera.x + VIEW_W * camera.scale);
    const yStart = Math.floor(camera.y), yEnd = Math.ceil(camera.y + VIEW_H * camera.scale);
    for (let x = xStart; x <= xEnd; x++) {
      const sx = Math.round(rect.left + (x - camera.x) * pxPerWX) + 0.5;
      editorOverlayCtx.moveTo(sx, rect.top);
      editorOverlayCtx.lineTo(sx, rect.top + rect.height);
    }
    for (let y = yStart; y <= yEnd; y++) {
      const sy = Math.round(rect.top + (y - camera.y) * pxPerWY) + 0.5;
      editorOverlayCtx.moveTo(rect.left, sy);
      editorOverlayCtx.lineTo(rect.left + rect.width, sy);
    }
    editorOverlayCtx.stroke();
  }

  if (rectDragging) {
    const r = normalizedRect(rectStartWX, rectStartWY, rectCurWX, rectCurWY);
    const sx = rect.left + (r.x0 - camera.x) * pxPerWX;
    const sy = rect.top + (r.y0 - camera.y) * pxPerWY;
    const sw = (r.x1 - r.x0) * pxPerWX;
    const sh = (r.y1 - r.y0) * pxPerWY;
    const erasing = editorTool === "erase";
    editorOverlayCtx.fillStyle = erasing ? "rgba(255,44,217,0.18)" : "rgba(0,229,255,0.18)";
    editorOverlayCtx.fillRect(sx, sy, sw, sh);
    editorOverlayCtx.strokeStyle = erasing ? "#FF2CD9" : "#00E5FF";
    editorOverlayCtx.lineWidth = 2;
    editorOverlayCtx.strokeRect(sx, sy, sw, sh);
  }
}

box.addEventListener("pointerdown", (e) => {
  pointerDown = true;
  box.setPointerCapture(e.pointerId);
  lastPointerX = e.clientX; lastPointerY = e.clientY;
  const [x, y] = screenToCell(e.clientX, e.clientY);
  if (editMode && (editorTool === "fill" || editorTool === "erase")) {
    rectDragging = true;
    rectStartWX = rectCurWX = x;
    rectStartWY = rectCurWY = y;
    return;
  }
  if (x >= 0 && x < W && y >= 0 && y < FLOOR_Y && grid[idx(x, y)] !== EMPTY) {
    beginCarry(x, y, e.clientX, e.clientY);
  } else {
    paintAt(x, y);
  }
});
box.addEventListener("pointermove", (e) => {
  lastPointerX = e.clientX; lastPointerY = e.clientY;
  if (!pointerDown) return;
  if (rectDragging) {
    const [x, y] = screenToCell(e.clientX, e.clientY);
    rectCurWX = x; rectCurWY = y;
    return;
  }
  if (carrying) {
    carryPointerX = e.clientX; carryPointerY = e.clientY;   // no grid write while carrying — loop() redraws the preview from this every frame
    return;
  }
  const [x, y] = screenToCell(e.clientX, e.clientY);
  paintAt(x, y);
});
function endRectDrag(commit) {
  if (!rectDragging) return;
  if (commit) commitRect(rectStartWX, rectStartWY, rectCurWX, rectCurWY, editorTool === "erase");
  rectDragging = false;
}
box.addEventListener("pointerup", () => { pointerDown = false; endRectDrag(true); dropCarry(); });
box.addEventListener("pointercancel", () => { pointerDown = false; endRectDrag(false); dropCarry(); });

// ---- main loop, real elapsed time drives tick count. No ambient rain —
// sand only appears where it's actually painted now.
const TICK_MS = 1000 / 60;
const MAX_TICKS_PER_FRAME = 5;
let tickAccumulator = 0;
let lastTime = 0;

const reducedMotion = window.matchMedia
  && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

let forceRenderNextFrame = false;   // set true by anything that changes render() output WITHOUT touching the grid (currently: the non-emissive glow slider)
let wasAwakeLastCheck = true;       // conservative default — guarantees the very first loop() call renders regardless

function anyChunkAwake() {
  for (let i = 0; i < chunkAwake.length; i++) if (chunkAwake[i]) return true;
  return false;
}

function loop(now) {
  const dt = lastTime ? now - lastTime : TICK_MS;
  lastTime = now;
  // ELECTRIC RAINBOW MAGIC FORK — continuous pour, matching main.js's
  // `if(painting) paint()`: once per animation frame, using the LAST
  // known pointer position, independent of whether it moved this frame.
  // Placed before the tick loop (and thus before awakeNow below) so a
  // freshly-painted chunk is visible to THIS frame's render dirty-check,
  // not one frame late.
  //   Gated on !carrying — pointerDown stays true for the whole duration
  // of a carry drag (it's the same gesture, just branched at pointerdown
  // by what was under the touch), and without this check the currently-
  // selected palette material would keep pouring at the drag position
  // every frame WHILE a clump is also being carried. Carry and paint are
  // mutually exclusive for the lifetime of one pointer gesture.
  if (pointerDown && !carrying) {
    const [x, y] = screenToCell(lastPointerX, lastPointerY);
    paintAt(x, y);
  }
  drawCarryPreview();   // no-ops (just clears) when not carrying — cheap, always safe to call
  drawEditorOverlay();  // no-ops (just clears) unless the editor's grid or a rect-drag is actually visible
  tickAccumulator = Math.min(tickAccumulator + dt, TICK_MS * MAX_TICKS_PER_FRAME);
  while (tickAccumulator >= TICK_MS) {
    step();
    tickAccumulator -= TICK_MS;
  }
  const awakeNow = anyChunkAwake();
  // ELECTRIC RAINBOW MAGIC FORK — dirty-check render. render() alone still
  // walks the full VIEW_W*VIEW_H buffer (~259k cells) every time it runs —
  // that's the real remaining brute-force cost, and fixing it for real is
  // dirty-rect territory (extending state.js's subchunkDirty tracking,
  // currently wired only to the tile-render path which this site doesn't
  // use, to the base per-cell color/shimmer/glow pass too), not a quick
  // patch — deliberately not attempted here. What THIS pass fixes: render()
  // no longer runs at all while nothing's awake, and the two full-grid
  // scans that used to ride along on every render call (drawChunkDebug's
  // 66-chunk walk, now deleted entirely — stuck-block bug confirmed
  // resolved; recomputeCounts' W*H cell scan, now replaced by an exact
  // incremental counter — see paintedCellCount above and onWorldExit,
  // state.js) are gone. chunkAwake is real bookkeeping physics.js already
  // maintains — reading it costs nothing extra, it's not a new scan.
  //   Render three cases: something's awake right now, something WAS
  // awake last frame (so the truly final settled frame still gets
  // painted — skipping one tick too early would freeze the pile
  // mid-fall, not at rest), or something explicitly asked for a fresh
  // frame despite the grid being static (forceRenderNextFrame).
  //   REAL TRADEOFF, not a free lunch: per-cell shimmer and the
  // world-edge pulse are driven by `frame`/Math.random() INSIDE
  // render() itself, not by grid state — they currently animate even on
  // fully settled, unmoving material. Skipping render() while idle means
  // that twinkle freezes once a pile truly stops moving, resuming the
  // instant anything wakes a chunk again (new paint, still-settling
  // sand). Reads as "goes calm when it's calm" for a background
  // decoration, not a bug — but it IS a visible behavior change from
  // before, flagging it plainly rather than letting it pass silently.
  const shouldRender = awakeNow || wasAwakeLastCheck || forceRenderNextFrame;
  if (shouldRender) {
    render();
    forceRenderNextFrame = false;
  }
  wasAwakeLastCheck = awakeNow;
  requestAnimationFrame(loop);
}

render();
if (!reducedMotion) requestAnimationFrame(loop);

// ---- palette UI: three groups (sands top-left, liquids top-right,
// gases bottom-center), inset inside the rainbow frame via index.html CSS.
function createPaletteGroup(className) {
  const group = document.createElement("div");
  group.className = `palette-group ${className}`;
  document.body.appendChild(group);
  return group;
}
function addSwatch(group, mat, swatchEls) {
  const sw = document.createElement("div");
  sw.className = "palette-swatch";
  sw.title = mat.name;
  sw.style.background = mat.color;
  sw.addEventListener("pointerdown", (e) => {
    e.stopPropagation();
    selectedMat = mat.id;
    for (const s of swatchEls) s.style.boxShadow = "0 0 0 2px rgba(255,255,255,0.18)";
    sw.style.boxShadow = "0 0 0 3px #fff, 0 0 12px 2px #fff";
  });
  swatchEls.push(sw);
  group.appendChild(sw);
  return sw;
}
const paletteGroups = {
  sands: createPaletteGroup("palette-sands"),
  liquids: createPaletteGroup("palette-liquids"),
  gases: createPaletteGroup("palette-gases"),
};
const swatchEls = [];
const paletteByName = Object.fromEntries(PALETTE.map(m => [m.name, m]));
for (const color of SPECTRUM_COLORS) addSwatch(paletteGroups.sands, paletteByName[`${color} Sand`], swatchEls);
for (const color of SPECTRUM_COLORS) addSwatch(paletteGroups.liquids, paletteByName[`${color} Water`], swatchEls);
for (const color of SPECTRUM_COLORS) addSwatch(paletteGroups.gases, paletteByName[`${color} Gas`], swatchEls);
swatchEls[0].style.boxShadow = "0 0 0 3px #fff, 0 0 12px 2px #fff";   // Red Sand starts selected

// ---- TUNING PANEL — hand-tuning UI for grain size + the glow layer's
// CSS filter + the non-emissive glow strength (materials.js's `emAmt`,
// see render.js). Real DOM, own scroll region, collapsible so it doesn't
// eat screen on phones. Every slider writes straight to the live value it
// controls and re-derives anything downstream (resizeBox for grain size,
// style.filter strings for glow) — no page reload needed for any of it.
// This whole panel is site-only scaffolding, not meant to ship to the
// real game; the VALUES it lands on are what's meant to port back (see
// HANDOFF §5-style note at end of session).
const glowEl = document.getElementById("glow");

// Current live values for the glow layer's three filter components —
// tracked here (not read back from style.filter, which is a pain to
// parse) since the panel is the only thing that ever changes them now.
const glowState = { blur: 5, sat: 1.6, bright: 130 };
function applyGlowFilter() {
  const filterStr = `blur(${glowState.blur}px) saturate(${glowState.sat}) brightness(${glowState.bright}%)`;
  glowEl.style.filter = filterStr;
  // Carried blobs should read as the same material mid-air, not a
  // differently-tuned glow — same filter string, second element.
  carryGlowCanvas.style.filter = filterStr;
}
applyGlowFilter();   // carryGlowCanvas has no filter until this runs once — without
                      // an initial call it'd render un-blurred (a hard-edged bright
                      // square) for any carry that starts before a slider is touched

const panel = document.createElement("div");
panel.style.cssText =
  "position:fixed;bottom:8px;right:8px;z-index:11;width:230px;max-height:70vh;overflow-y:auto;" +
  "background:rgba(10,7,20,0.88);border:1px solid rgba(255,255,255,0.15);border-radius:8px;" +
  "padding:8px 10px;font:11px/1.4 'JetBrains Mono',monospace;color:#E8DFFF;pointer-events:auto;";

const panelHeader = document.createElement("div");
panelHeader.textContent = "TUNING ▾";
panelHeader.style.cssText = "cursor:pointer;font-weight:600;letter-spacing:0.05em;margin-bottom:4px;user-select:none;";
const panelBody = document.createElement("div");
let panelOpen = true;
panelHeader.addEventListener("pointerdown", (e) => {
  e.stopPropagation();
  panelOpen = !panelOpen;
  panelBody.style.display = panelOpen ? "" : "none";
  panelHeader.textContent = panelOpen ? "TUNING ▾" : "TUNING ▸";
});
panel.appendChild(panelHeader);
panel.appendChild(panelBody);

// Prevent the sim's own pointerdown painting from firing when the user
// is just trying to drag a slider — same pattern the palette swatches
// already use (stopPropagation on pointerdown).
panel.addEventListener("pointerdown", (e) => e.stopPropagation());

function addSlider(label, min, max, step, value, onInput) {
  const row = document.createElement("div");
  row.style.cssText = "margin:6px 0;";
  const labelEl = document.createElement("div");
  const valEl = document.createElement("span");
  valEl.textContent = value;
  labelEl.textContent = label + ": ";
  labelEl.appendChild(valEl);
  labelEl.style.cssText = "margin-bottom:2px;";
  const input = document.createElement("input");
  input.type = "range";
  input.min = min; input.max = max; input.step = step; input.value = value;
  input.style.cssText = "width:100%;";
  input.addEventListener("input", () => {
    const v = parseFloat(input.value);
    valEl.textContent = v;
    onInput(v);
  });
  row.appendChild(labelEl);
  row.appendChild(input);
  panelBody.appendChild(row);
  return input;
}

// ELECTRIC RAINBOW MAGIC FORK — checkbox variant, same row/label shape as
// addSlider above, for boolean toggles (currently just dirty-rects).
function addCheckbox(label, checked, onChange) {
  const row = document.createElement("div");
  row.style.cssText = "margin:6px 0;display:flex;align-items:center;gap:6px;";
  const input = document.createElement("input");
  input.type = "checkbox";
  input.checked = checked;
  const labelEl = document.createElement("label");
  labelEl.textContent = label;
  input.addEventListener("change", () => onChange(input.checked));
  row.appendChild(input);
  row.appendChild(labelEl);
  panelBody.appendChild(row);
  return input;
}

// grainSlider assigned here to the module-level binding declared up by
// CELL_PX (maybeApplyResponsiveGrain drives this same element on
// resize/rotation). The onInput callback below is the ONE place that
// actually changes CELL_PX now — both a manual drag and a responsive
// re-check funnel through it, so there's only one place that has to
// remember to call applyDomColliders() after resizeBox().
//   BUG FIXED here: this previously called resizeBox() only. resizeBox()
// changes the canvas element's CSS size but nothing about window size,
// so the resize listener's own applyDomColliders() debounce never fired
// for a manual grain change — domColliderCells stayed put at the OLD
// screen<->world ratio while the canvas (and therefore the real text-to-
// world mapping) had already moved. Grain changes are deliberate,
// infrequent user actions (not a resize drag), so calling
// applyDomColliders() directly rather than debouncing is fine here.
grainSlider = addSlider("Grain size (CELL_PX)", 2, 12, 1, CELL_PX, (v) => {
  CELL_PX = v;
  resizeBox();
  applySiteLayout();
});
// Only a genuine user drag should count as an override — dispatching a
// synthetic "input" event (maybeApplyResponsiveGrain) doesn't fire
// pointerdown, so the responsive default keeps re-asserting itself
// until the person actually touches this slider once.
grainSlider.addEventListener("pointerdown", () => { grainUserOverridden = true; });

const glowHeading = document.createElement("div");
glowHeading.textContent = "— #glow (base bloom) —";
glowHeading.style.cssText = "margin-top:8px;opacity:0.7;";
panelBody.appendChild(glowHeading);
addSlider("Blur px", 0, 20, 1, glowState.blur, (v) => { glowState.blur = v; applyGlowFilter(); });
addSlider("Saturate", 0, 3, 0.1, glowState.sat, (v) => { glowState.sat = v; applyGlowFilter(); });
addSlider("Brightness %", 50, 250, 5, glowState.bright, (v) => { glowState.bright = v; applyGlowFilter(); });

const matHeading = document.createElement("div");
matHeading.textContent = "— non-emissive glow —";
matHeading.style.cssText = "margin-top:8px;opacity:0.7;";
panelBody.appendChild(matHeading);
addSlider("Sand/Stone/etc strength", 0, 2, 0.05, 1, (v) => {
  setNonEmissiveGlowMult(v);
  forceRenderNextFrame = true;   // this changes render() output without touching the grid — the dirty-check (loop(), above) needs an explicit nudge or it'd stay stale while idle
});

const perfHeading = document.createElement("div");
perfHeading.textContent = "— perf (site tuning session) —";
perfHeading.style.cssText = "margin-top:8px;opacity:0.7;";
panelBody.appendChild(perfHeading);
// ELECTRIC RAINBOW MAGIC FORK — dirty-rects for render()'s flat pixel pass
// (render.js). ON-DEVICE VERIFIED this session (Crash): the heat/near-
// freeze symptom from heavy multi-material coverage got dramatically
// harder to reproduce with this on. Default flipped ON (render.js) to
// match — checkbox now starts checked, still here as a real off-switch
// if a seam/ghosting/stuck-pixel artifact ever turns up around a
// subchunk boundary, not as a permanent opt-in.
addCheckbox("Dirty rects (perf, verified on-device)", true, (checked) => {
  setFlatDirtyRectsEnabled(checked);
  forceRenderNextFrame = true;   // toggling itself doesn't touch the grid, needs an explicit nudge like the glow slider above
});

document.body.appendChild(panel);
panel.style.display = "none";   // site tuning scaffolding — hidden on the public page

// ==================== STUDIO EDITOR ====================
// Everything from here down is authoring tooling for Crash, not
// visitor-facing site behavior. editMode/uiHidden/overlaysVisible all
// default to their "visitor" state — a plain load of this file never
// shows any of it. The parent frame (index.html's module picker) is the
// only thing that turns it on, via window.SandEditor below, so this
// stays entirely dormant when sands.html is loaded on its own.

const editorToolbar = document.createElement("div");
editorToolbar.style.cssText =
  "position:fixed;top:8px;right:8px;z-index:14;display:none;flex-direction:column;gap:6px;" +
  "background:rgba(10,7,20,0.92);border:1px solid rgba(255,255,255,0.15);border-radius:8px;" +
  "padding:8px 10px;font:11px/1.4 'JetBrains Mono',monospace;color:#E8DFFF;pointer-events:auto;width:190px;";
// Same reasoning as the tuning panel above: a click/drag inside this
// toolbar shouldn't leak through to the sim's own pointerdown painting.
editorToolbar.addEventListener("pointerdown", (e) => e.stopPropagation());

const toolbarHeading = document.createElement("div");
toolbarHeading.textContent = "EDITOR";
toolbarHeading.style.cssText = "font-weight:600;letter-spacing:0.05em;margin-bottom:2px;";
editorToolbar.appendChild(toolbarHeading);

function addToolbarButton(label) {
  const b = document.createElement("button");
  b.textContent = label;
  b.style.cssText =
    "font:11px 'JetBrains Mono',monospace;color:#E8DFFF;background:rgba(255,255,255,0.06);" +
    "border:1px solid rgba(255,255,255,0.18);border-radius:5px;padding:5px 6px;cursor:pointer;text-align:left;";
  editorToolbar.appendChild(b);
  return b;
}

const toolHint = document.createElement("div");
toolHint.textContent = "Paint uses the palette below.";
toolHint.style.cssText = "opacity:0.6;font-size:10px;margin:-2px 0 2px;";
editorToolbar.appendChild(toolHint);

const toolBtns = {};
function setActiveTool(tool) {
  editorTool = tool;
  for (const t in toolBtns) {
    toolBtns[t].style.borderColor = t === tool ? "#00E5FF" : "rgba(255,255,255,0.18)";
  }
  // Leaving a tool mid-drag shouldn't leave a stuck preview rectangle.
  rectDragging = false;
}
toolBtns.paint = addToolbarButton("\u270f\ufe0f Paint / carry");
toolBtns.fill  = addToolbarButton("\u25a4 Fill rectangle");
toolBtns.erase = addToolbarButton("\u2715 Erase rectangle");
toolBtns.paint.addEventListener("click", () => setActiveTool("paint"));
toolBtns.fill.addEventListener("click", () => setActiveTool("fill"));
toolBtns.erase.addEventListener("click", () => setActiveTool("erase"));
setActiveTool("paint");

const gridRow = document.createElement("label");
gridRow.style.cssText = "display:flex;align-items:center;gap:6px;margin-top:4px;cursor:pointer;";
const gridCheckbox = document.createElement("input");
gridCheckbox.type = "checkbox";
gridCheckbox.addEventListener("change", () => { showGrid = gridCheckbox.checked; });
gridRow.appendChild(gridCheckbox);
gridRow.appendChild(document.createTextNode("Grid overlay"));
editorToolbar.appendChild(gridRow);

const exportHeading = document.createElement("div");
exportHeading.textContent = "\u2014 save \u2014";
exportHeading.style.cssText = "margin-top:6px;opacity:0.7;";
editorToolbar.appendChild(exportHeading);

function downloadBlob(filename, content, type) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function exportJSONFile() {
  const payload = {
    version: 1,
    exportedAt: new Date().toISOString(),
    W, H, CELL_PX,
    length: grid.length,
    runs: encodeGridRLE(grid),
  };
  downloadBlob(`sands-state-${Date.now()}.json`, JSON.stringify(payload), "application/json");
}

// ---- HTML export. Fetches THIS document's own live markup (works
// against the local dev server or any real HTTP host; a file:// load
// may block this fetch under some browsers' CORS rules for local files
// — export JSON and hand-splice at that point if that ever comes up)
// and string-injects the grid snapshot as a plain inline <script>
// immediately before the sand-bg.js module tag, so a fresh load of the
// exported file finds window.__INITIAL_GRID__ already set before this
// module's own top-level code runs (see usingInitialGrid near the top
// of this file). No build step, no server round-trip beyond the one
// fetch of the page's own markup.
async function exportHTML() {
  let html;
  try {
    const res = await fetch(location.href);
    html = await res.text();
  } catch (e) {
    alert("HTML export failed (couldn't fetch this page's own source — are you running it off a local server, not file://?). Exporting JSON instead.");
    exportJSONFile();
    return;
  }
  const payload = { runs: encodeGridRLE(grid), length: grid.length };
  const anchor = '<script type="module" src="./js/sand-bg.js"></script>';
  if (!html.includes(anchor)) {
    alert("HTML export failed (couldn't find the sand-bg.js script tag to inject state before). Exporting JSON instead.");
    exportJSONFile();
    return;
  }
  const inject = `<script>window.__INITIAL_GRID__ = ${JSON.stringify(payload)};</script>\n  `;
  downloadBlob("index.html", html.replace(anchor, inject + anchor), "text/html");
}

function importJSONFile(file) {
  const reader = new FileReader();
  reader.onload = () => {
    let payload;
    try { payload = JSON.parse(reader.result); }
    catch (e) { alert("Import failed: not valid JSON."); return; }
    if (!payload || !Array.isArray(payload.runs) || payload.length !== W * H) {
      alert("Import failed: this file's grid size doesn't match the current build (W*H). It may be from a different session/build.");
      return;
    }
    setGrid(decodeGridRLE(payload.runs, payload.length));
    reconstructTrackingSetsFromGrid();
    chunkAwake.fill(1);   // cheap (66 chunks, not 270k cells) — forces physics/render to actually look at everything just-loaded
    forceRenderNextFrame = true;
    applyDomColliders();
  };
  reader.readAsText(file);
}

addToolbarButton("Export HTML (site file)").addEventListener("click", exportHTML);
addToolbarButton("Export JSON (resume editing)").addEventListener("click", exportJSONFile);

const importRow = document.createElement("div");
importRow.style.cssText = "margin-top:2px;";
const importLabel = document.createElement("div");
importLabel.textContent = "Import JSON:";
importLabel.style.cssText = "margin-bottom:2px;";
const importInput = document.createElement("input");
importInput.type = "file";
importInput.accept = "application/json";
importInput.style.cssText = "width:100%;font-size:10px;color:#E8DFFF;";
importInput.addEventListener("change", () => {
  const file = importInput.files[0];
  if (file) importJSONFile(file);
  importInput.value = "";
});
importRow.appendChild(importLabel);
importRow.appendChild(importInput);
editorToolbar.appendChild(importRow);

document.body.appendChild(editorToolbar);

// ==================== STUDIO EDITOR — MATERIAL LAB ====================
// Ported from the game's sandbox — js/ui-matlab.js is the real editor
// (property sliders, reaction rows, color picker, all of it), lifted
// verbatim. It only needed materials.js (already identical to the
// game's), render.js's rebuildTileFor (already present, unmodified),
// and color.js (new file, also verbatim) — nothing about it was written
// for this site, nothing about it had to change to work here.
//   NOT ported: tuning.js/ui-tuning.js's full physics-tuning sheet
// (particles, ships, lasers, tesla — none of which this site has, and
// two of its own imports don't even exist in this site's state.js
// anymore, since physics.js's pressured() was rewritten with local
// constants during the water-streak fix). ui-matlab.js's panel DOES
// assume ui-tuning.js's shared row CSS already exists on the page
// (.propRow/.propLabel/.propControls/.tuneGroupLabel/.tuneGroup) — that
// tiny CSS-only piece is reproduced directly below rather than pulled in
// through the broken import chain.
const SHARED_ROW_CSS = `
.tuneGroupLabel{ font-size:14px; color:#FFCF56; text-transform:uppercase;
  letter-spacing:0.08em; margin:10px 2px 6px; display:flex; justify-content:space-between;
  align-items:center; cursor:pointer; user-select:none; }
.tuneGroupLabel:first-child{ margin-top:2px; }
.tuneGroupLabel .arrow{ font-size:9px; transition:transform .15s; }
.propRow{ margin-bottom:12px; }
.propRow .propLabel{ display:flex; justify-content:space-between; font-size:11px;
  color:#8b7fa8; text-transform:uppercase; letter-spacing:0.06em; margin-bottom:4px; }
.propRow .propLabel b{ color:#E8DFFF; font-weight:normal; }
.propRow .propControls{ display:flex; gap:6px; align-items:center; }
.propRow input[type=range]{ flex:1 1 auto; accent-color:#FFCF56; }
.propRow input[type=number]{ width:64px; background:#0A0714;
  border:1px solid #2a2140; color:#E8DFFF; font:inherit;
  font-size:11px; padding:5px; border-radius:5px; }
`;
const sharedRowStyleEl = document.createElement("style");
sharedRowStyleEl.textContent = SHARED_ROW_CSS;
document.head.appendChild(sharedRowStyleEl);

// ---- slide-in panel, same left-edge convention the sandbox used.
// Built entirely in JS like every other panel in this file — no HTML
// changes needed to add this.
const matLabPanel = document.createElement("div");
matLabPanel.style.cssText =
  "position:fixed;left:0;top:0;bottom:0;z-index:16;width:min(300px,86vw);" +
  "background:rgba(10,7,20,0.97);border-right:1px solid rgba(255,255,255,0.15);" +
  "padding:12px;font:11px/1.4 'JetBrains Mono',monospace;color:#E8DFFF;" +
  "overflow-y:auto;pointer-events:auto;transform:translateX(-100%);transition:transform .18s ease;";
matLabPanel.addEventListener("pointerdown", (e) => e.stopPropagation());

const matSelectRow = document.createElement("div");
matSelectRow.style.cssText = "margin-bottom:10px;";
const matSelectLabel = document.createElement("div");
matSelectLabel.textContent = "Editing material:";
matSelectLabel.style.cssText = "opacity:0.7;margin-bottom:4px;";
const matSelect = document.createElement("select");
matSelect.style.cssText =
  "width:100%;padding:6px;background:#171227;color:#E8DFFF;" +
  "border:1px solid #2a2140;border-radius:6px;font-size:12px;";
matSelectRow.appendChild(matSelectLabel);
matSelectRow.appendChild(matSelect);
matLabPanel.appendChild(matSelectRow);

const matLabBody = document.createElement("div");
matLabPanel.appendChild(matLabBody);

const matLabSaveHeading = document.createElement("div");
matLabSaveHeading.textContent = "\u2014 material table \u2014";
matLabSaveHeading.style.cssText = "margin-top:10px;opacity:0.7;";
matLabPanel.appendChild(matLabSaveHeading);

const matLabCaveat = document.createElement("div");
matLabCaveat.textContent =
  "Edits here are live in this browser tab only until saved. Nothing writes back to materials.js on disk.";
matLabCaveat.style.cssText = "font-size:10px;opacity:0.6;margin-bottom:6px;";
matLabPanel.appendChild(matLabCaveat);

document.body.appendChild(matLabPanel);

// ---- twins (SOLID_TWIN's self-mapped solids aside) are derived, not
// independently authored — excluded from the picker so there's nothing
// to accidentally edit that resyncTwinAppearance() would just overwrite
// on the next color change to its source anyway.
function editableMaterialIds() {
  const twinIds = new Set();
  for (const [srcId, twinId] of Object.entries(SOLID_TWIN)) if (+srcId !== twinId) twinIds.add(twinId);
  for (const twinId of Object.values(STAMP_TWIN)) twinIds.add(twinId);
  return MATS.filter(m => m.behavior !== "void" && !twinIds.has(m.id)).map(m => m.id);
}

function rebuildMatSelect() {
  const current = matSelect.value ? +matSelect.value : selectedMat;
  matSelect.innerHTML = "";
  for (const id of editableMaterialIds()) {
    const opt = document.createElement("option");
    opt.value = id;
    opt.textContent = MATBY[id].name;
    matSelect.appendChild(opt);
  }
  matSelect.value = current;
}
rebuildMatSelect();

let matLabMounted = false;
function ensureMatLabMounted() {
  if (matLabMounted) return;
  matLabMounted = true;
  mountMatLab(matLabBody, { showClose: false, initialMat: selectedMat });
}

matSelect.addEventListener("change", () => {
  const id = +matSelect.value;
  selectedMat = id;   // editing a material and painting with it are the same "selected material"
  ensureMatLabMounted();
  setMatLabMaterial(id);
});

// ---- material table save/export. Mirrors the site's OWN existing
// custom-table contract in materials.js (resolveCustomMats/
// loadCustomTable/CUSTOM_TABLE_STORAGE_KEY) — that whole mechanism was
// already there, forked from the game, and simply had nothing writing
// to it yet. Serialization here deliberately mirrors materials.js's own
// nameifyRefs so the two agree on shape: cross-references (decayTo,
// meltTo, freezeTo, teslaReact, spawnId, onContact, emits) are written
// as NAME strings, everything else copied as-is. `id` and any
// `_staged_*` scratch key (ui-matlab.js's own preview-value convention)
// are stripped — neither is a real material field.
function nameOfMat(id) { const m = MATBY[id]; return m ? m.name : undefined; }
const REF_KEYS = ["decayTo", "meltTo", "freezeTo", "teslaReact", "spawnId"];
function serializeCustomMaterial(m) {
  const out = {};
  for (const k of Object.keys(m)) {
    if (k === "id" || k.startsWith("_staged_")) continue;
    out[k] = m[k];
  }
  if (out.rgb) out.rgb = [...out.rgb];
  for (const k of REF_KEYS) if (out[k] !== undefined) out[k] = nameOfMat(out[k]);
  if (out.emits) out.emits = { mat: nameOfMat(out.emits.matId), chance: out.emits.chance };
  if (out.onContact) {
    const oc = {};
    for (const [triggerId, rule] of Object.entries(out.onContact)) {
      const triggerName = nameOfMat(+triggerId);
      if (triggerName === undefined) continue;
      oc[triggerName] = (rule && typeof rule === "object")
        ? { to: nameOfMat(rule.to), chance: rule.chance, settled: rule.settled }
        : nameOfMat(rule);
    }
    out.onContact = oc;
  }
  return out;
}
function buildCustomTableExport() {
  const twinIds = new Set();
  for (const [srcId, twinId] of Object.entries(SOLID_TWIN)) if (+srcId !== twinId) twinIds.add(twinId);
  for (const twinId of Object.values(STAMP_TWIN)) twinIds.add(twinId);
  const customMats = MATS.filter(m =>
    m.behavior !== "void" && !CORE_MATERIAL_NAMES.includes(m.name) && !twinIds.has(m.id));
  if (customMats.length > MAX_CUSTOM_MATERIALS) {
    alert(`Warning: ${customMats.length} custom materials exceeds the ${MAX_CUSTOM_MATERIALS} cap \u2014 materials.js will reject this table on load. Trim before saving.`);
  }
  return { materials: customMats.map(serializeCustomMaterial), tuning: null };
}
function exportMaterialTableFile() {
  downloadBlob(`material-table-${Date.now()}.json`, JSON.stringify(buildCustomTableExport(), null, 2), "application/json");
}
// "Save & reload" is a convenience for testing in THIS browser, not the
// canonical save — same file-first philosophy as the grid export above.
// materials.js's loadCustomTable() only runs once at module top-level
// load, so there's no way to apply a table without a real reload.
function saveMaterialTableAndReload() {
  const payload = buildCustomTableExport();
  try { localStorage.setItem(CUSTOM_TABLE_STORAGE_KEY, JSON.stringify(payload)); }
  catch (e) { alert("Couldn't save to this browser's storage: " + e.message); return; }
  location.reload();
}
function importMaterialTableFile(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try { JSON.parse(reader.result); }   // sanity check only — materials.js's own loadCustomTable() does the real validation on next load
    catch (e) { alert("Import failed: not valid JSON."); return; }
    localStorage.setItem(CUSTOM_TABLE_STORAGE_KEY, reader.result);
    location.reload();
  };
  reader.readAsText(file);
}

function addMatLabButton(label) {
  const b = document.createElement("button");
  b.textContent = label;
  b.style.cssText =
    "display:block;width:100%;font:11px 'JetBrains Mono',monospace;color:#E8DFFF;" +
    "background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.18);" +
    "border-radius:5px;padding:6px;cursor:pointer;text-align:left;margin-bottom:4px;";
  matLabPanel.appendChild(b);
  return b;
}
addMatLabButton("Download table (JSON)").addEventListener("click", exportMaterialTableFile);
addMatLabButton("Save to this browser + reload").addEventListener("click", saveMaterialTableAndReload);
const matImportRow = document.createElement("div");
matImportRow.style.cssText = "margin-top:2px;";
const matImportLabel = document.createElement("div");
matImportLabel.textContent = "Load table from file:";
matImportLabel.style.cssText = "margin-bottom:2px;opacity:0.7;";
const matImportInput = document.createElement("input");
matImportInput.type = "file";
matImportInput.accept = "application/json";
matImportInput.style.cssText = "width:100%;font-size:10px;color:#E8DFFF;";
matImportInput.addEventListener("change", () => {
  const file = matImportInput.files[0];
  if (file) importMaterialTableFile(file);
});
matImportRow.appendChild(matImportLabel);
matImportRow.appendChild(matImportInput);
matLabPanel.appendChild(matImportRow);

let matLabOpen = false;
function setMatLabOpen(open) {
  matLabOpen = open;
  matLabPanel.style.transform = open ? "translateX(0)" : "translateX(-100%)";
  if (open) { ensureMatLabMounted(); rebuildMatSelect(); setMatLabMaterial(selectedMat); }
}
const matLabToggleBtn = addToolbarButton("\ud83e\uddea Materials");
matLabToggleBtn.addEventListener("click", () => setMatLabOpen(!matLabOpen));


// ---- cross-frame control surface. The parent frame (index.html's
// module picker) owns the actual toggle buttons — edit mode, overlays,
// hide-all-UI — since those live in chrome that has to persist across
// which module is loaded. This is the one thing on this side of the
// iframe boundary: read the toggles, show/hide this file's own DOM,
// nothing more. Exposed as a plain global rather than a message-based
// API because same-origin + same-tab makes a direct call simpler and
// synchronous, with no listener/ack plumbing to keep in sync.
function applyUIVisibility() {
  const hide = uiHidden;
  const showPalette = overlaysVisible && !hide;
  editorToolbar.style.display = (editMode && !hide) ? "flex" : "none";
  for (const group of Object.values(paletteGroups)) {
    group.style.display = showPalette ? "flex" : "none";
  }
  panel.style.display = (editMode && overlaysVisible && !hide) ? "block" : "none";
  // The material lab is edit-mode-only chrome, same as the rest of
  // editorToolbar — but it's a separate slide-in element (left edge, not
  // inside editorToolbar itself), so it needs its own visibility pass.
  // Leaving editMode also force-closes it rather than just hiding the
  // toggle button, so re-entering edit mode always starts from a known
  // closed state instead of resuming whatever was open before.
  if ((!editMode || hide) && matLabOpen) setMatLabOpen(false);
  matLabPanel.style.visibility = hide ? "hidden" : "visible";
}
applyUIVisibility();

window.SandEditor = {
  setEditMode(on) {
    editMode = !!on;
    if (!editMode) { showGrid = false; gridCheckbox.checked = false; rectDragging = false; setActiveTool("paint"); }
    applyUIVisibility();
  },
  setOverlaysVisible(on) {
    overlaysVisible = !!on;
    applyUIVisibility();
  },
  setUIHidden(on) {
    uiHidden = !!on;
    applyUIVisibility();
  },
  isEditMode: () => editMode,
  isOverlaysVisible: () => overlaysVisible,
  isUIHidden: () => uiHidden,
};
