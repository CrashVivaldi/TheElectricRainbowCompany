// ============================================================================
// svg-border.js — EXPERIMENTAL swap-in for the CSS box-shadow rainbow frame.
//
// Renders the border authored in border-editor.html (bezier spine + per-ring
// color/thickness) as a real SVG instead of the stacked inset box-shadow in
// index.html's .rainbow-frame rule. This is a from-scratch runtime port of
// border-editor.html's flatten/offset/ring-build math (NOT a copy-paste of
// the whole tool — just the parts needed to turn static point data into
// painted ring paths), operating on the exact JSON export from that tool.
//
// STATUS: preview / not yet committed to. The old .rainbow-frame CSS block
// in index.html is commented out, not deleted — revert is a one-line swap.
//
// KNOWN GAP, DELIBERATE: the CSS version cuts a clip-path notch out of the
// border over the floor drain, driven live by --floor-gap (see sand-bg.js's
// measurement of the title element). This SVG version does NOT replicate
// that notch yet — border-editor.html has no concept of it, and Crash asked
// to skip it for this pass. The border currently paints as a closed loop
// straight through where the drain notch used to be.
//
// WHY THIS RESIZES CORRECTLY WITHOUT A JS RECOMPUTE LOOP: the ring paths are
// built ONCE, in the same normalized 0-1000 unit square border-editor.html
// itself edits in. They're placed in an <svg viewBox="0 0 1000 1000"
// preserveAspectRatio="none"> sized to 100vw x 100vh — the SAME model
// border-editor.html already uses to preview against an arbitrary aspect
// ratio. The browser's own SVG scaling handles every resize/orientation
// change for free; there is nothing to recompute on window resize for the
// border geometry itself.
//
// TRADEOFF, STATED PLAINLY: because the spine is stretched non-uniformly to
// fill whatever aspect ratio the window happens to be, band/separator
// thickness is only truly uniform at the aspect ratio the shape "reads"
// correctly at (roughly square-ish, since these points are the default
// rounded-rect). On a very wide or very tall window, ring thickness will
// visibly vary between the horizontal and vertical edges, and corners will
// go slightly elliptical instead of staying circular. The old vmin-based
// box-shadow approach didn't have this problem. Fine for a design check;
// worth knowing before shipping it as-is.
//
// PHYSICS/LAYOUT CONTRACT PRESERVED: sand-bg.js's rainbowFrameInsetPx()
// (colliders, floor-drain padding) and index.html's --frame-inset (palette
// positioning) both read the --band/--sep CSS custom properties directly —
// NOT a hardcoded number. This file does not touch sand-bg.js at all; it
// relies on index.html having updated --band/--sep to match this exported
// shape's actual thickness, so the invisible physics boundary and the new
// visible border agree on where the inner edge sits. If --band/--sep in
// index.html's :root block ever drift out of sync with BORDER_DATA below,
// that contract breaks silently. Keep them paired by hand.
// ============================================================================

(function () {
  "use strict";

  // ---- exact data exported from border-editor.html (rainbow-border-project.json) ----
  // Kept inline rather than fetched: this is static design data, not something
  // meant to change at runtime, and inlining avoids an extra network request /
  // same-origin fetch complication on GitHub Pages.
  const BORDER_DATA = {
    "version": 2,
    "band": 0.005,
    "sep": 0.01,
    "colors": {
      "red": "#FF0000",
      "yellow": "#F5C518",
      "green": "#3DBF5F",
      "blue": "#2E86F5",
      "purple": "#9B4FE0",
      "sep": "#000000"
    },
    "glow": { "enabled": true, "blur": 6, "sat": 1.7, "bright": 150 },
    "points": [
      { "x": 0.08, "y": 0, "hInX": 0.035817220016000004, "hInY": 0, "hOutX": 0.08, "hOutY": 0, "thicknessMul": 1 },
      { "x": 0.92, "y": 0, "hInX": 0.92, "hInY": 0, "hOutX": 0.964182779984, "hOutY": 0, "thicknessMul": 1 },
      { "x": 1, "y": 0.08, "hInX": 1, "hInY": 0.035817220016000004, "hOutX": 1, "hOutY": 0.08, "thicknessMul": 1 },
      { "x": 1, "y": 0.92, "hInX": 1, "hInY": 0.92, "hOutX": 1, "hOutY": 0.964182779984, "thicknessMul": 1 },
      { "x": 0.92, "y": 1, "hInX": 0.964182779984, "hInY": 1, "hOutX": 0.92, "hOutY": 1, "thicknessMul": 1 },
      { "x": 0.08, "y": 1, "hInX": 0.08, "hInY": 1, "hOutX": 0.035817220016000004, "hOutY": 1, "thicknessMul": 1 },
      { "x": 0, "y": 0.92, "hInX": 0, "hInY": 0.964182779984, "hOutX": 0, "hOutY": 0.92, "thicknessMul": 1 },
      { "x": 0, "y": 0.08, "hInX": 0, "hInY": 0.08, "hOutX": 0, "hOutY": 0.035817220016000004, "thicknessMul": 1 }
    ]
  };

  const SPACE = 1000;

  // Reconstruct points in the same 0-1000 unit space border-editor.html itself
  // edits in (import handler there does the identical *SPACE conversion).
  const points = BORDER_DATA.points.map(p => ({
    x: p.x * SPACE, y: p.y * SPACE,
    hInX: p.hInX * SPACE, hInY: p.hInY * SPACE,
    hOutX: p.hOutX * SPACE, hOutY: p.hOutY * SPACE,
    thicknessMul: typeof p.thicknessMul === "number" ? p.thicknessMul : 1,
  }));
  const band = BORDER_DATA.band * SPACE;
  const sep = BORDER_DATA.sep * SPACE;

  // ---- ported verbatim from border-editor.html's ring-build math ----

  function cubicAt(p0, p1, p2, p3, t) {
    const mt = 1 - t;
    const a = mt * mt * mt, b = 3 * mt * mt * t, c = 3 * mt * t * t, d = t * t * t;
    return {
      x: a * p0.x + b * p1.x + c * p2.x + d * p3.x,
      y: a * p0.y + b * p1.y + c * p2.y + d * p3.y,
    };
  }

  const SAMPLES_PER_SEGMENT = 24;

  function flatten(pts) {
    const samples = [], thicknessAt = [];
    const n = pts.length;
    for (let i = 0; i < n; i++) {
      const p0 = pts[i], p1 = pts[(i + 1) % n];
      const c0 = { x: p0.hOutX, y: p0.hOutY };
      const c1 = { x: p1.hInX, y: p1.hInY };
      const t0 = p0.thicknessMul ?? 1, t1 = p1.thicknessMul ?? 1;
      for (let s = 0; s < SAMPLES_PER_SEGMENT; s++) {
        const t = s / SAMPLES_PER_SEGMENT;
        samples.push(cubicAt(p0, c0, c1, p1, t));
        thicknessAt.push(t0 + (t1 - t0) * t);
      }
    }
    return { samples, thicknessAt };
  }

  function centroidOf(samples) {
    let sx = 0, sy = 0;
    for (const p of samples) { sx += p.x; sy += p.y; }
    return { x: sx / samples.length, y: sy / samples.length };
  }

  function inwardNormals(samples, centroid) {
    const n = samples.length;
    const normals = [];
    let agreeCount = 0;
    for (let i = 0; i < n; i++) {
      const prev = samples[(i - 1 + n) % n], next = samples[(i + 1) % n];
      let tx = next.x - prev.x, ty = next.y - prev.y;
      const len = Math.hypot(tx, ty) || 1;
      tx /= len; ty /= len;
      const nx = ty, ny = -tx;
      const toCentroidX = centroid.x - samples[i].x, toCentroidY = centroid.y - samples[i].y;
      const dot = nx * toCentroidX + ny * toCentroidY;
      normals.push({ nx, ny, agrees: dot > 0 });
      if (dot > 0) agreeCount++;
    }
    const flip = agreeCount < n / 2;
    return normals.map(nrm => flip ? { nx: -nrm.nx, ny: -nrm.ny } : { nx: nrm.nx, ny: nrm.ny });
  }

  function offsetSamplesScaled(samples, normals, baseDepth, thicknessAt) {
    return samples.map((p, i) => ({
      x: p.x + normals[i].nx * baseDepth * thicknessAt[i],
      y: p.y + normals[i].ny * baseDepth * thicknessAt[i],
    }));
  }

  function polylineD(pts, reverse) {
    const seq = reverse ? [...pts].reverse() : pts;
    let d = `M ${seq[0].x.toFixed(2)} ${seq[0].y.toFixed(2)} `;
    for (let i = 1; i < seq.length; i++) d += `L ${seq[i].x.toFixed(2)} ${seq[i].y.toFixed(2)} `;
    d += "Z";
    return d;
  }

  function ringD(outerPts, innerPts) {
    return polylineD(outerPts, false) + " " + polylineD(innerPts, true);
  }

  // ---- build the ring paths once ----

  const NS = "http://www.w3.org/2000/svg";

  function buildBorderSvg() {
    const { samples: flat, thicknessAt } = flatten(points);
    const centroid = centroidOf(flat);
    const normals = inwardNormals(flat, centroid);

    const colors = [
      BORDER_DATA.colors.red, BORDER_DATA.colors.sep,
      BORDER_DATA.colors.yellow, BORDER_DATA.colors.sep,
      BORDER_DATA.colors.green, BORDER_DATA.colors.sep,
      BORDER_DATA.colors.blue, BORDER_DATA.colors.sep,
      BORDER_DATA.colors.purple,
    ];

    const cumulative = [0];
    let acc = 0;
    for (let i = 0; i < colors.length; i++) {
      acc += (i % 2 === 0) ? band : sep; // even = color ring, odd = black separator
      cumulative.push(acc);
    }
    const boundaries = cumulative.map(d => offsetSamplesScaled(flat, normals, d, thicknessAt));

    const svg = document.createElementNS(NS, "svg");
    svg.setAttribute("id", "svgRainbowFrame");
    svg.setAttribute("viewBox", `0 0 ${SPACE} ${SPACE}`);
    svg.setAttribute("preserveAspectRatio", "none");

    const ringsGroup = document.createElementNS(NS, "g");
    const glowGroup = document.createElementNS(NS, "g");
    glowGroup.style.mixBlendMode = "screen";

    // Same two-layer trick as the rest of the site's glow (#glow over #base,
    // #carryGlow over #carryOverlay): one crisp layer + one blurred/bloomed
    // layer on top, screen-blended. Blurring the crisp layer directly loses
    // the sharp edge entirely.
    if (BORDER_DATA.glow.enabled) {
      const defs = document.createElementNS(NS, "defs");
      const filter = document.createElementNS(NS, "filter");
      filter.setAttribute("id", "rainbowFrameGlow");
      filter.setAttribute("x", "-20%");
      filter.setAttribute("y", "-20%");
      filter.setAttribute("width", "140%");
      filter.setAttribute("height", "140%");
      filter.setAttribute("color-interpolation-filters", "sRGB");

      const feBlur = document.createElementNS(NS, "feGaussianBlur");
      feBlur.setAttribute("in", "SourceGraphic");
      feBlur.setAttribute("stdDeviation", String(BORDER_DATA.glow.blur));
      feBlur.setAttribute("result", "blurred");

      const feXfer = document.createElementNS(NS, "feComponentTransfer");
      feXfer.setAttribute("in", "blurred");
      feXfer.setAttribute("result", "brightened");
      const slope = String(BORDER_DATA.glow.bright / 100);
      ["R", "G", "B"].forEach(ch => {
        const func = document.createElementNS(NS, `feFunc${ch}`);
        func.setAttribute("type", "linear");
        func.setAttribute("slope", slope);
        feXfer.appendChild(func);
      });

      const feSat = document.createElementNS(NS, "feColorMatrix");
      feSat.setAttribute("in", "brightened");
      feSat.setAttribute("type", "saturate");
      feSat.setAttribute("values", String(BORDER_DATA.glow.sat));

      filter.appendChild(feBlur);
      filter.appendChild(feXfer);
      filter.appendChild(feSat);
      defs.appendChild(filter);
      svg.appendChild(defs);
      glowGroup.setAttribute("filter", "url(#rainbowFrameGlow)");
    }

    for (let i = 0; i < colors.length; i++) {
      const d = ringD(boundaries[i], boundaries[i + 1]);

      const path = document.createElementNS(NS, "path");
      path.setAttribute("d", d);
      path.setAttribute("fill", colors[i]);
      path.setAttribute("fill-rule", "evenodd");
      ringsGroup.appendChild(path);

      if (BORDER_DATA.glow.enabled && i % 2 === 0) { // skip black separators — nothing to bloom
        const glowPath = document.createElementNS(NS, "path");
        glowPath.setAttribute("d", d);
        glowPath.setAttribute("fill", colors[i]);
        glowPath.setAttribute("fill-rule", "evenodd");
        glowGroup.appendChild(glowPath);
      }
    }

    svg.appendChild(ringsGroup);
    if (BORDER_DATA.glow.enabled) svg.appendChild(glowGroup);
    return svg;
  }

  function init() {
    const old = document.querySelector(".rainbow-frame");
    const svg = buildBorderSvg();
    if (old) old.replaceWith(svg);
    else document.body.appendChild(svg);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
