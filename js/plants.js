// PLANTS — space-colonization branch growth. Vector-native, decoupled
// entirely from the CA engine: state.js/materials.js/physics.js are
// never imported here. Growth isn't grid physics, and running it
// through the sand engine would be forcing a square peg through a
// round hole — see the architecture note in the handoff this page came
// out of. Only shell.js's engine-agnostic scaffolding (tuning panel,
// fixed-timestep loop) is reused from the sand-bg page.
import { createTuningPanel, startFixedStepLoop } from "./shell.js";

// ---- canvas setup: full viewport, DPR-aware. No fixed low-res world
// buffer like the CA engine's VIEW_W*CELL_PX — branches are drawn as
// real vector strokes at native resolution, so there's no grain-size
// concept here at all.
const canvas = document.getElementById("plantCanvas");
const ctx = canvas.getContext("2d");
let cssW = 0, cssH = 0;

function resize() {
  cssW = window.innerWidth;
  cssH = window.innerHeight;
  const dpr = Math.max(1, window.devicePixelRatio || 1);
  canvas.width = Math.round(cssW * dpr);
  canvas.height = Math.round(cssH * dpr);
  canvas.style.width = cssW + "px";
  canvas.style.height = cssH + "px";
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);   // draw in CSS-pixel coords
  buildTrees();   // viewport shape changed — cheapest correct thing is
                   // to restart growth at the new size rather than try
                   // to rescale in-flight attractor clouds/nodes
}
window.addEventListener("resize", resize);

// ---- tunables. Named consts up top, tuning panel below just re-points
// these same bindings — same convention sand-bg.js uses for CELL_PX etc.
let ATTRACTOR_COUNT   = 220;
let PERCEPTION_RADIUS = 90;   // px — how far a node "sees" attractors
let KILL_RADIUS       = 14;   // px — attractor consumed once a node gets this close
let SEGMENT_LEN       = 6;    // px per growth step
let STEPS_PER_TICK    = 2;    // growth-algorithm iterations per sim tick — the speed knob
let TREE_SPACING      = 260;  // px between tree origins, also sets canopy width
let REGROW_DELAY_MS   = 4000; // pause after a tree finishes before it resets and regrows
let BASE_THICKNESS    = 5;
let TAPER             = 0.988; // per-depth thickness falloff (approximation, not a real leaf-weighted pass — see render())

// Root color (trunk) -> tip color. Matching the site's existing brand
// hex constants as JS literals — same duplicated-source-of-truth
// pattern index.html's own comment already flags for --c-red..--c-purple
// vs materials.js, not a new inconsistency.
const ROOT_COLOR = [232, 223, 255];  // --lilac  #E8DFFF
const TIP_COLOR  = [0, 229, 255];    // --cyan   #00E5FF

function lerpColor(a, b, t) {
  return `rgb(${Math.round(a[0] + (b[0] - a[0]) * t)},${Math.round(a[1] + (b[1] - a[1]) * t)},${Math.round(a[2] + (b[2] - a[2]) * t)})`;
}

// ---- one tree: root node + attractor cloud + growth state ----
function makeAttractorCloud(originX, originY) {
  const attractors = [];
  // Canopy: a wide ellipse centered well above the origin. Rejection
  // sampling inside a unit circle, then scaled — simplest way to get
  // uniform-ish density without a polar-radius bias toward the center.
  const canopyCX = originX, canopyCY = originY - cssH * 0.35;
  const rx = TREE_SPACING * 0.55, ry = cssH * 0.3;
  for (let i = 0; i < ATTRACTOR_COUNT; i++) {
    let ux, uy;
    do { ux = Math.random() * 2 - 1; uy = Math.random() * 2 - 1; } while (ux * ux + uy * uy > 1);
    attractors.push({ x: canopyCX + ux * rx, y: canopyCY + uy * ry, dead: false });
  }
  return attractors;
}

function makeTree(originX, originY) {
  return {
    originX, originY,
    nodes: [{ x: originX, y: originY, parent: -1, depth: 0 }],
    attractors: makeAttractorCloud(originX, originY),
    state: "growing",   // "growing" | "resting"
    restUntil: 0,
    maxDepthSeen: 1,
  };
}

let trees = [];
function buildTrees() {
  trees = [];
  const groundY = cssH - 24;
  const count = Math.max(1, Math.round(cssW / TREE_SPACING));
  const startX = (cssW - (count - 1) * TREE_SPACING) / 2;
  for (let i = 0; i < count; i++) {
    trees.push(makeTree(startX + i * TREE_SPACING, groundY));
  }
}

// ---- space colonization: one growth iteration. Classic Runions et al.
// formulation — each live attractor influences only its single nearest
// node within PERCEPTION_RADIUS; a node's new growth direction is the
// normalized sum of unit vectors toward every attractor influencing it;
// attractors within KILL_RADIUS of their nearest node are consumed.
// Returns true if the tree is still active (grew this step, or still
// has live attractors that could grow it on a future step).
function growStep(tree) {
  const { nodes, attractors } = tree;
  const influence = new Array(nodes.length).fill(null);
  let anyAlive = false;
  for (const a of attractors) {
    if (a.dead) continue;
    anyAlive = true;
    let nearestI = -1, nearestD = Infinity;
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      const d = Math.hypot(a.x - n.x, a.y - n.y);
      if (d < PERCEPTION_RADIUS && d < nearestD) { nearestD = d; nearestI = i; }
    }
    if (nearestI === -1) continue;
    if (nearestD < KILL_RADIUS) { a.dead = true; continue; }
    const n = nodes[nearestI];
    const inf = influence[nearestI] || (influence[nearestI] = { x: 0, y: 0 });
    inf.x += (a.x - n.x) / nearestD;
    inf.y += (a.y - n.y) / nearestD;
  }
  let grew = false;
  const newNodes = [];
  for (let i = 0; i < nodes.length; i++) {
    const inf = influence[i];
    if (!inf) continue;
    const len = Math.hypot(inf.x, inf.y) || 1;
    const n = nodes[i];
    const depth = n.depth + 1;
    newNodes.push({ x: n.x + (inf.x / len) * SEGMENT_LEN, y: n.y + (inf.y / len) * SEGMENT_LEN, parent: i, depth });
    tree.maxDepthSeen = Math.max(tree.maxDepthSeen, depth);
    grew = true;
  }
  for (const nn of newNodes) nodes.push(nn);
  return grew || anyAlive;
}

function tickTree(tree, now) {
  if (tree.state === "resting") {
    if (now >= tree.restUntil) {
      tree.nodes = [{ x: tree.originX, y: tree.originY, parent: -1, depth: 0 }];
      tree.attractors = makeAttractorCloud(tree.originX, tree.originY);
      tree.maxDepthSeen = 1;
      tree.state = "growing";
    }
    return;
  }
  let stillGoing = false;
  for (let s = 0; s < STEPS_PER_TICK; s++) {
    stillGoing = growStep(tree) || stillGoing;
  }
  if (!stillGoing) {
    tree.state = "resting";
    tree.restUntil = now + REGROW_DELAY_MS;
  }
}

function tick() {
  const now = performance.now();
  for (const tree of trees) tickTree(tree, now);
}

function render() {
  ctx.clearRect(0, 0, cssW, cssH);
  ctx.lineCap = "round";
  for (const tree of trees) {
    for (const n of tree.nodes) {
      if (n.parent === -1) continue;
      const p = tree.nodes[n.parent];
      // Thickness/color both keyed off depth-ratio, not a real leaf-
      // count-weighted backward pass (that would need a second traversal
      // per frame). Cheap approximation, reads fine visually — worth
      // revisiting only if a specific look is wanted that this can't hit.
      const t = Math.min(1, n.depth / Math.max(1, tree.maxDepthSeen));
      ctx.strokeStyle = lerpColor(ROOT_COLOR, TIP_COLOR, t);
      ctx.lineWidth = Math.max(0.6, BASE_THICKNESS * Math.pow(TAPER, n.depth));
      ctx.beginPath();
      ctx.moveTo(p.x, p.y);
      ctx.lineTo(n.x, n.y);
      ctx.stroke();
    }
  }
}

resize();   // also calls buildTrees()
startFixedStepLoop({ tickMs: 1000 / 30, tick, render });

// ---- tuning panel ----
// NOTE: ATTRACTOR_COUNT / TREE_SPACING changes only take effect the next
// time a tree resets (or immediately via "Restart all") — they're read
// at cloud/layout build time, not live per-frame. Flagging this since
// it's the one slider set that doesn't feel instant, unlike sand-bg.js's
// panel where every slider is a true live value.
const panel = createTuningPanel({ title: "GROWTH" });
panel.addSlider("Attractors", 40, 500, 10, ATTRACTOR_COUNT, v => { ATTRACTOR_COUNT = v; });
panel.addSlider("Perception radius", 20, 200, 5, PERCEPTION_RADIUS, v => { PERCEPTION_RADIUS = v; });
panel.addSlider("Kill radius", 4, 40, 1, KILL_RADIUS, v => { KILL_RADIUS = v; });
panel.addSlider("Segment length", 2, 16, 1, SEGMENT_LEN, v => { SEGMENT_LEN = v; });
panel.addSlider("Speed (steps/tick)", 1, 8, 1, STEPS_PER_TICK, v => { STEPS_PER_TICK = v; });
panel.addSlider("Tree spacing", 120, 500, 10, TREE_SPACING, v => { TREE_SPACING = v; });
panel.addSlider("Base thickness", 1, 12, 0.5, BASE_THICKNESS, v => { BASE_THICKNESS = v; });
panel.addSlider("Regrow delay (s)", 0, 15, 0.5, REGROW_DELAY_MS / 1000, v => { REGROW_DELAY_MS = v * 1000; });
panel.addButton("Restart all", () => buildTrees());
