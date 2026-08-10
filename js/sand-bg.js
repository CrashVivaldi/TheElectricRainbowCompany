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
//
//   SPLIT (2026-08-09): this file used to also contain the full Studio
// Editor — rect fill/erase tool, material lab, JSON/HTML export/import,
// window.SandEditor — all authoring-only tooling that had no business
// executing on a visitor's page. It's been pulled out into
// js/sand-editor.js. That extraction is NOT yet wired to run standalone —
// it references this file's former module-private state (selectedMat,
// CELL_PX, floorCells, domColliderCells, glowState, etc.) that no longer
// exists in its scope now that it's a separate module. Needs a real
// integration pass before it runs again. This file is now pure visitor
// runtime: no editMode, no authoring surface, nothing reachable from the
// console that shouldn't be.

import { W, H, VIEW_W, VIEW_H, camera, clampCamera, grid, idx, temp,
         setTemperatureEnabled, SPAWN_TEMP_DEFAULT, chunkAwake,
         setOnWorldExit, setOnDecayToEmpty } from "./state.js";
import { MATS, MATBY, EMPTY } from "./materials.js";
import { step, wake, clearSettling } from "./physics.js";
import { render, setVoidHoleInsetCells } from "./render.js";

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
// no natural floor at y=H. This Voidstone floor is the only thing
// stopping painted sand from vanishing.
//   CORRECTION, this pass: the floor used to have deliberate gaps (a
// hole is just an EMPTY cell in the floor row — sand that lands there
// sinks one more row, hits y>=H, and physics.js deletes it next tick),
// which doubled as a drain for the live-sand cap below. The floor is now
// fully solid (see buildFloor) — there is no drain anymore. A visitor
// who paints past MAX_LIVE_SAND simply can't paint more until reload;
// see buildFloor's comment for why that's an accepted tradeoff and not
// something this change tries to compensate for.
const FLOOR_Y = H - 1;
const floorCells = new Set();   // real indices actually placed as floor — NOT just "W of them", since holes mean it's fewer. Used below to keep the live-sand cap counting painted material only, not structural floor.

// NOTE: this site currently has no way to load an authored/baked scene
// (no __INITIAL_GRID__, no RLE decode, no editorCells structural
// tracking) — that whole consumer path moved to js/sand-editor.js along
// with the tooling that produces it. If "author in the studio, ship a
// scene to this site" becomes a real workflow, that loader needs to be
// rebuilt here deliberately, not silently restored by copy-paste.

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

// Rows at/just above the floor row — no invisible Voidstone shelves here.
// Word play shelves live under the title (mid-screen); bottom drain holes
// are EMPTY floor cells only. This band catches any stale bottom ledges
// from earlier builds or missed tracking on resize.
const FLOOR_LEDGE_ZONE_TOP = FLOOR_Y - 10;

function purgeVoidstoneInFloorZone() {
  for (let y = FLOOR_LEDGE_ZONE_TOP; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = idx(x, y);
      if (grid[i] !== VOIDSTONE) continue;
      // The floor itself is now VOIDSTONE (see buildFloor) and lives in
      // exactly this y-range, including FLOOR_Y. This function predates
      // that change — it exists to clean up STALE WORD-LEDGES from an
      // earlier resize, back when the only VOIDSTONE that could ever
      // appear down here was leftover collider debris. Without this
      // exemption it would delete the floor itself one call after
      // buildFloor() paints it, every single applySiteLayout() pass.
      //   floorCells is authoritative for "is this real floor" — it's
      // rebuilt by buildFloor() immediately before this function runs
      // (see applySiteLayout's call order), so it's always current by
      // the time this check executes.
      if (floorCells.has(i)) continue;
      grid[i] = EMPTY;
      domColliderCells.delete(i);
      wake(x, y);
    }
  }
}

// How thick (world cells) the invisible footing under each text collider
// is. Independent of CELL_PX (that's screen pixels per cell, this is
// world-space) — stays a small, thin strip regardless of grain size.
const COLLIDER_LEDGE_THICKNESS = 1;

// Each letter's ledge is narrower than the letter's own bounding box,
// centered within it. Per-letter bounding boxes (from getBoundingClientRect
// on individual letter spans) include the font's side-bearing, which at
// full width leaves gaps between adjacent letters too narrow for sand to
// visibly fall through at typical grain sizes. Shrinking each ledge toward
// the letter's center opens those gaps up without changing the markup or
// the letter spacing itself. 1.0 = full bounding-box width (old behavior).
const LEDGE_WIDTH_SCALE = 0.7;

// How far above each letter's bottom edge the ledge sits, expressed as a
// multiple of the letter's own measured line-box height. The line-box is
// taller than the visible ink (~52px box for ~35px glyph on phone), so
// the effective raise in screen pixels is MULT × line-box-height. At 0.5
// that's roughly one visible letter-height above the bottom edge.
const LEDGE_RAISE_MULT = 0.7;

function applyDomColliders() {
  clearDomColliders();
  purgeVoidstoneInFloorZone();
  const rect0 = canvases[0].getBoundingClientRect();
  const els = document.querySelectorAll(".solid-collider");

  function screenYToWorldRow(screenY) {
    return Math.ceil(camera.y + (screenY - rect0.top) / rect0.height * VIEW_H * camera.scale);
  }

  function placeLedge(wx0, wx1, wyBottom) {
    // Footing sits flush against the letter's own bottom edge — wyBottom
    // is the world row at the letter's bottom (exclusive); the ledge
    // occupies [wyBottom - thickness, wyBottom), growing upward from
    // there so it reads as support directly under the glyph rather than
    // floating above it.
    const wy0 = wyBottom - COLLIDER_LEDGE_THICKNESS;
    if (wy0 >= FLOOR_LEDGE_ZONE_TOP) return;
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
    let wx0 = Math.floor(camera.x + (r.left - rect0.left) / rect0.width * VIEW_W * camera.scale);
    let wx1 = Math.ceil(camera.x + (r.right - rect0.left) / rect0.width * VIEW_W * camera.scale);

    // Shrink toward center — see LEDGE_WIDTH_SCALE above for why.
    const fullWidth = wx1 - wx0;
    const narrowWidth = Math.max(1, Math.round(fullWidth * LEDGE_WIDTH_SCALE));
    const center = (wx0 + wx1) / 2;
    wx0 = Math.floor(center - narrowWidth / 2);
    wx1 = wx0 + narrowWidth;

    const worldHeight = r.height / rect0.height * VIEW_H * camera.scale;
    const raise = Math.round(worldHeight * LEDGE_RAISE_MULT);
    placeLedge(wx0, wx1, screenYToWorldRow(r.bottom) - raise);
  }
}

function clearFloorRow() {
  // Floor material is VOIDSTONE now, not STONE (see buildFloor) — matched
  // against void-colored surroundings so it reads as a clean edge instead
  // of a visible gray bar now that the sim renders in front of the
  // rainbow frame. This check has to track that or a resize would fail
  // to recognize the existing floor as floor, leaving it stuck forever
  // instead of being torn down and rebuilt.
  //   wake() takes the cell's OWN row (not FLOOR_Y) — the floor no longer
  // lives at a fixed row (see FLOOR_RAISE_PX below), so assuming FLOOR_Y
  // here would wake the wrong subchunk once the floor's actually raised.
  for (const i of floorCells) {
    if (grid[i] === VOIDSTONE) {
      grid[i] = EMPTY;
      wake(i % W, Math.floor(i / W));
    }
  }
  floorCells.clear();
}

// CORRECTION, this pass: sand rendering in front of the rainbow frame
// (index.html's z-index reorder, two passes back) turned out unreliable
// in practice — the border only ever showed up along whatever edge sand
// happened to have recently touched, which traces to the dirty-rects
// render path only repainting a subchunk when something wakes it; a
// static, never-touched void band has no reason to ever get re-examined
// after its first paint. Rather than keep chasing that, the frame went
// back to painting ON TOP of the sim (index.html z-index swap, same
// turn as this comment), which makes the border unconditionally visible
// regardless of canvas/paint-order edge cases.
//   That brings back the ORIGINAL problem this whole detour was solving:
// anything sitting in the border band is hidden under the now-opaque
// rings again. FLOOR_RAISE_PX is the fix for the bottom edge specifically
// — lifting the floor's actual row clear of the ring band's screen depth
// means a sand pile's visible top surface pokes up into the open
// interior (never covered by rings, which only occupy the inset border
// strip) instead of building up invisibly behind the bottom band.
//   REAL LIMITATION, not fixed by this: this only helps the BOTTOM edge.
// Sand piled directly against the LEFT or RIGHT screen edge still tucks
// under the rings there, same as before the whole detour started — this
// site's brush-based, centered painting makes that an unlikely case in
// practice, but it's a real gap, not something this change papers over.
//   In world-cell rows, not a fixed number — CELL_PX (screen px per
// world cell) changes with the grain slider and with responsiveCellPx's
// device-based default, so a fixed row count would put the floor at a
// different SCREEN height on every device/setting. Deriving it from a
// real px target divides out that variability the same way every other
// screen-space-to-world-cell conversion in this file already does.
//   Still true, unrelated to any of the above: the floor is fully solid
// with no holes of any kind — there is no drain. The 18 rainbow
// materials have no decay, so a visitor who paints past MAX_LIVE_SAND
// simply can't paint any more until reload. See js/sand-bg.js's
// triggerSandReset (the drain button) for the actual way this site
// recovers from that, since it isn't this function's job to.
const FLOOR_RAISE_PX = 32;

function buildFloor() {
  clearFloorRow();
  // Screen-edge bounds, not the world's true edges — the camera only
  // ever shows a cropped middle slice of the wider world (camera.x ..
  // camera.x+VIEW_W*camera.scale). Floor rows outside that slice are
  // unreachable anyway (painting/screen math only ever produces world
  // coords inside it), so it's safe to only build floor within it.
  const viewLeft = Math.floor(camera.x);
  const viewRight = Math.ceil(camera.x + VIEW_W * camera.scale);
  const floorRow = FLOOR_Y - Math.round(FLOOR_RAISE_PX / CELL_PX);

  for (let x = viewLeft; x < viewRight; x++) {
    const i = idx(x, floorRow);
    grid[i] = VOIDSTONE;
    floorCells.add(i);
    wake(x, floorRow);
  }
}

function applySiteLayout() {
  buildFloor();
  applyDomColliders();
  positionDrainButton();
  updateVoidHoleInset();
}

// ---- transparent hole for the CSS rainbow-frame rings (js/render.js) ----
// CURRENTLY INERT — see render.js's matching comment on setVoidHoleInsetCells.
// Still computed and passed through every layout pass; just has nothing
// left to visibly affect now that the rings paint above the sim again.
// js/frame.js builds the ring stack and exposes its real total depth as
// window.RainbowFrame.totalWidthVmin — read that directly rather than
// re-deriving it from --band/--sep/PASSES/PASS_SCALE here, since this
// file has no reason to know frame.js's own tuning constants and
// shouldn't have to stay in sync with them by hand.
//   +1 cell of pad beyond the exact computed depth: cheap insurance
// against a 1px opaque seam from truncation/rounding at the canvas-to-
// CSS boundary — a hole one cell too deep is invisible (still inside
// the ring band's own color), a hole one cell too shallow is a visible
// hairline of void along the innermost ring.
function updateVoidHoleInset() {
  const RF = window.RainbowFrame;
  if (!RF || !rect0Width()) { setVoidHoleInsetCells(0); return; }
  const vmin = Math.min(window.innerWidth, window.innerHeight) / 100;
  const depthPx = RF.totalWidthVmin * vmin;
  setVoidHoleInsetCells(Math.ceil(depthPx / CELL_PX) + 1);
}
function rect0Width() {
  return canvases[0] && canvases[0].getBoundingClientRect().width;
}

// ---- DRAIN-AND-RESPAWN BUTTON ----
// Ported from the Studio tool's own triggerSandReset, which never
// shipped to the site — ONE real change on the way in, calibrated
// timing, everything else works unmodified because the mechanism it
// leans on (decay via MATS[VOIDSTONE].decay, unset decayTo already
// falling back to EMPTY in physics.js's own decay pass, anyChunkAwake
// for idle-polling) already exists in this file exactly as the studio
// version expects it.
//
// TIMING, actually calibrated rather than reused: physics.js's decay
// check is `Math.random() < M.decay`, evaluated PER CELL, PER TICK, at
// 60 ticks/sec (TICK_MS above) — not per second. The studio's own
// decay=0.08 computes out to 99% of the floor gone in under a second;
// its own comment already flagged it as an untested placeholder ("fast
// but visible — revisit once actually live"), and on the actual math
// it reads as a flash cut, not a drain. 0.03 dissolves over roughly
// 2.5 seconds — long enough to watch happen, still snappy.
//
// TWO ADDITIONS beyond the ported original, both flagged as such:
//   - RESET_POST_DRAIN_PAUSE_MS: a deliberate held beat on a fully
//     empty screen before respawning. The ported original respawns on
//     the exact same frame the last cell finishes dissolving, which
//     plays as a blink rather than a felt "then it respawns" moment.
//   - RESET_COOLDOWN_MS: the button stays disabled for a few seconds
//     after respawn completes. Not in the original (which had no UI
//     wired up yet), but a public-facing button needs SOME guard
//     against being mashed mid-animation or immediately re-triggered.
const VOID_RESET_DECAY = 0.03;
const RESET_POST_DRAIN_PAUSE_MS = 450;
const RESET_COOLDOWN_MS = 4000;

let resetInProgress = false;
const drainBtn = document.getElementById("drainBtn");

function setDrainBtnEnabled(enabled) {
  if (!drainBtn) return;
  drainBtn.disabled = !enabled;
  drainBtn.classList.toggle("is-busy", !enabled);
}

function triggerSandReset() {
  if (resetInProgress) return;
  resetInProgress = true;
  setDrainBtnEnabled(false);

  // Decay is only evaluated in AWAKE chunks — floor/collider cells are
  // static and never wake on their own, so cranking the decay rate alone
  // would silently do nothing until something else happened to wake
  // those chunks. Waking every one explicitly is what actually starts
  // the dissolve.
  for (const i of floorCells) wake(i % W, Math.floor(i / W));
  for (const i of domColliderCells) wake(i % W, Math.floor(i / W));
  MATS[VOIDSTONE].decay = VOID_RESET_DECAY;

  function pollIdle() {
    if (anyChunkAwake()) {
      requestAnimationFrame(pollIdle);
      return;
    }
    // Hard delete whatever's left (any orphaned mid-fall material, any
    // decay debris) rather than trusting every last cell resolved
    // itself naturally, then hold on the empty screen for a beat before
    // respawning — see RESET_POST_DRAIN_PAUSE_MS above for why.
    grid.fill(EMPTY);
    floorCells.clear();
    domColliderCells.clear();
    paintedCellCount = 0;
    MATS[VOIDSTONE].decay = 0; // restore BEFORE rebuilding, or the fresh floor starts dissolving itself immediately

    setTimeout(() => {
      buildFloor();
      applyDomColliders();
      resetInProgress = false;
      // Cooldown starts at RESPAWN, not at button-press — the whole
      // drain-pause-respawn sequence already takes ~3 seconds; adding
      // the cooldown on top of that (rather than overlapping it) is
      // what actually guards against an immediate re-trigger.
      setTimeout(() => setDrainBtnEnabled(true), RESET_COOLDOWN_MS);
    }, RESET_POST_DRAIN_PAUSE_MS);
  }
  requestAnimationFrame(pollIdle);
}

if (drainBtn) {
  drainBtn.addEventListener("click", triggerSandReset);
}

// Vertical midpoint between the contact link's bottom edge and the top
// of "The" (the h1's first word, on its own line above the wider
// subtitle) — both real, measured rects, not guessed constants, so this
// stays correct across every screen size and through the async Monoton
// font swap (see the document.fonts.ready hook below applySiteLayout is
// already wired into). ".stage h1 > .solid-collider" is exactly one
// element: "The" is the h1's first direct child span; the other three
// words live one level deeper, inside .title-subline.
function positionDrainButton() {
  if (!drainBtn) return;
  const contact = document.querySelector(".contact-link");
  const theWord = document.querySelector(".stage h1 > .solid-collider");
  if (!contact || !theWord) return;
  const cRect = contact.getBoundingClientRect();
  const tRect = theWord.getBoundingClientRect();
  const midY = (cRect.bottom + tRect.top) / 2;
  drainBtn.style.top = `${Math.round(midY - drainBtn.offsetHeight / 2)}px`;
}

// Brush radius scales with zoom — at 1 world-cell fixed radius, a dab
// would look tiny once each cell only covers a fraction of a screen
// pixel at this zoom level. Scaling it keeps the touch feel consistent.
const BRUSH_R = 4;
function paintAt(wx, wy) {
  // No new sand while a reset is draining/paused/respawning — resetInProgress
  // stays true through exactly that window (set at button-press, cleared
  // right after applyDomColliders() rebuilds the ledges in triggerSandReset
  // above), so this reopens the instant the ledges are actually back rather
  // than waiting out the separate button cooldown on top of that.
  if (resetInProgress) return;
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
// grainUserOverridden never becomes true on this file anymore — the
// manual grain-size slider that used to set it lived in the tuning
// panel, which moved to js/sand-editor.js along with the rest of the
// authoring UI. Left in place (rather than deleted outright) as the
// documented hook for that: if the editor grows a way to reach back into
// this module and drive CELL_PX directly, this is the flag it should
// set. Until then this always stays false, meaning the site always
// re-derives grain size from the breakpoint on resize/rotation — which
// is exactly what every real visitor already experienced, since the
// slider was hidden behind editMode and no visitor ever had a way to
// touch it in the first place.
let grainUserOverridden = false;
let CELL_PX = responsiveCellPx();
function maybeApplyResponsiveGrain() {
  if (grainUserOverridden) return;
  const target = responsiveCellPx();
  if (target === CELL_PX) return;
  CELL_PX = target;
  resizeBox();
  applySiteLayout();
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
      if (domColliderCells.has(i) || floorCells.has(i)) continue;
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
  // Same reset-window guard as paintAt — a mid-reset drop would either get
  // wiped a moment later by the drain's own grid.fill(EMPTY), or, worse,
  // land in the brief window between that wipe and buildFloor()/
  // applyDomColliders() finishing, which is exactly the state this feature
  // exists to prevent visitors from painting into. Simplest correct fix is
  // just not letting the drop happen at all — the carried clump is
  // discarded rather than silently lost mid-air, matching how paintAt
  // already treats a rejected placement.
  if (resetInProgress) {
    carrying = false;
    carriedCells = [];
    carryCtx.clearRect(0, 0, carryCanvas.width, carryCanvas.height);
    return;
  }
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

// Plain paint/carry gesture — no editMode, no rect tool. That whole
// surface (fill/erase drag, grid overlay, editMode/editorTool/showGrid/
// overlaysVisible/uiHidden state) moved to js/sand-editor.js.
box.addEventListener("pointerdown", (e) => {
  pointerDown = true;
  box.setPointerCapture(e.pointerId);
  lastPointerX = e.clientX; lastPointerY = e.clientY;
  const [x, y] = screenToCell(e.clientX, e.clientY);
  if (x >= 0 && x < W && y >= 0 && y < FLOOR_Y && grid[idx(x, y)] !== EMPTY) {
    beginCarry(x, y, e.clientX, e.clientY);
  } else {
    paintAt(x, y);
  }
});
box.addEventListener("pointermove", (e) => {
  lastPointerX = e.clientX; lastPointerY = e.clientY;
  if (!pointerDown) return;
  if (carrying) {
    carryPointerX = e.clientX; carryPointerY = e.clientY;   // no grid write while carrying — loop() redraws the preview from this every frame
    return;
  }
  const [x, y] = screenToCell(e.clientX, e.clientY);
  paintAt(x, y);
});
box.addEventListener("pointerup", () => { pointerDown = false; dropCarry(); });
box.addEventListener("pointercancel", () => { pointerDown = false; dropCarry(); });

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
  rafHandle = requestAnimationFrame(loop);
}

render();
let rafHandle = null;
if (!reducedMotion) rafHandle = requestAnimationFrame(loop);

// Pause the sim entirely when the tab is hidden — no physics, no render,
// zero JS overhead. Resume the moment it becomes visible again.
// Mirrors the same null-guard pattern tilt.js uses for its idle-stop.
document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    if (rafHandle !== null) { cancelAnimationFrame(rafHandle); rafHandle = null; }
  } else {
    if (!reducedMotion && rafHandle === null) rafHandle = requestAnimationFrame(loop);
  }
});

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

// ---- glow layer filter — fixed values, hand-tuned. The live sliders
// that used to adjust these (grain size, blur/saturate/brightness,
// non-emissive glow strength, dirty-rects toggle) lived in a tuning
// panel that was gated behind editMode and never reachable by a real
// visitor anyway (panel.style.display stayed "none" on the public
// page). That whole UI moved to js/sand-editor.js. These are the values
// it was already sitting at.
const glowEl = document.getElementById("glow");
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
                      // square) for any carry
