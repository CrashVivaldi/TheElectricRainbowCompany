// ============================================================================
// frame.js — builds the rainbow border as a multi-pass infinity mirror.
//
// The border used to be nine hand-written <div>s in index.html, one per ring.
// That was fine at nine. It is not fine at eighteen, and it would be actively
// hostile at whatever number PASSES gets set to next — so the rings are
// generated here instead, and index.html ships an empty .rainbow-frame
// wrapper for this file to populate.
//
// WHAT AN "INFINITY MIRROR" MEANS HERE: the five-color rainbow sequence is
// painted PASSES times, each repetition thinner and darker than the last,
// nesting inward with a deliberate gap between repetitions (PASS_GAP_VMIN)
// so they read as two distinct receding reflections rather than one fatter
// border. Combined with the per-ring parallax from tilt.js, they read as
// reflections at different depths rather than concentric stripes.
//
// NO STRUCTURAL WIDTH CONSTRAINT, as of this pass — worth stating plainly
// since an earlier version of this file had a hard one. sand-bg.js used to
// derive its physics boundary (floor drain, DOM colliders) from
// `5*band + 4*sep`, via a function called rainbowFrameInsetPx(). That
// function no longer exists — the floor rewrite (sand-bg.js) made floor
// placement a fixed px-based constant divided through CELL_PX, with no
// dependency on this file's dimensions at all. --band and --sep are free to
// change for pure visual reasons now, with nothing downstream to keep in
// sync by hand.
//
// STACKING ORDER: the rings currently paint ABOVE the sim (see index.html's
// own STACKING ORDER comment for why that reverted from the opposite order
// this file's design once assumed) — so what covers what is a z-index
// question decided in index.html, not something this file needs to reason
// about.
// ============================================================================

(function () {
  "use strict";

  // ---- tuning ----------------------------------------------------------

  // Total repetitions of the 5-color sequence, including the first. 1 gives
  // a plain single-pass border. Each additional pass costs 9 more
  // composited fixed-position elements, so this is not free at large
  // values, but at 2 it is 18 transform-only layers and unmeasurable in
  // practice.
  const PASSES = 1;

  // Gap between passes uses `sep` directly (read from --sep in CSS below)
  // rather than a separate constant — that makes the purple-to-red
  // transition between pass 0 and pass 1 exactly the same width as every
  // other separator in pass 0, so there's no visible seam at the join.
  // Assigned after sep is parsed; see the PASS_GAP line inside build().

  // Each pass's COLORED ring thicknesses, as a fraction of the previous
  // pass. Wants to be aggressive: real reflections compress hard toward
  // the vanishing point. Values near 1 produce evenly-spaced stripes that
  // look flat no matter how much parallax is applied on top.
  const PASS_SCALE = 0.45;

  // Separator (black spacer between colored rings) scale per pass —
  // deliberately GREATER THAN 1 so the gaps between rings within pass 2
  // are wider than in pass 1, making the inner reflection read as more
  // open and spacious rather than a compressed version of the outer one.
  // (PASS_SCALE < 1 compresses colored rings inward; SEP_PASS_SCALE > 1
  // pushes separator spacing outward — the two act in opposite directions
  // on their respective ring types.)
  const SEP_PASS_SCALE = 1.3;

  // Each pass's brightness, as a fraction of the previous. Compounds, so
  // at 0.72 two passes land at 100% / 72%.
  //   Applied by mixing the ring color toward --void rather than by setting
  // opacity. Opacity would let whatever is behind the border show through
  // the rings in a way that shifts as the sim moves. Mixing toward the
  // void color is stable, and it is also what a dimmer reflection
  // physically is: less light, not partial transparency.
  const PASS_DIM = 0.72;

  // Minimum thickness any ring is allowed to have, in vmin. This exists
  // because PASS_SCALE compounds and vmin is small: a compressed second-pass
  // colored ring can compute to a fraction of a device pixel, which does not
  // render as a thin line — it renders as an inconsistent smear or nothing
  // at all, depending on how the device rounds it, and that pass effectively
  // disappears on real hardware.
  //   0.25vmin is about 1 device pixel on a typical phone, which is the
  // narrowest a line can be and still be reliably drawn.
  //   For transparent separators (pass 2+) this floor still applies to the
  // offset accumulation — the spacing the sep contributes to the layout —
  // even though nothing visible is drawn there. That's correct: you still
  // want minimum spacing between rings even when the gap itself is clear.
  const MIN_THICKNESS_VMIN = 0.25;

  // Exponent on the normalized ring index when computing parallax depth.
  // 1 would be linear (rings sliding past each other at even rates, reads as
  // flat layers); above 1 back-loads the displacement onto the deepest rings,
  // which is what makes the stack read as a receding corridor.
  const DEPTH_CURVE = 1.6;

  // ---- read the design tokens from CSS ---------------------------------
  // index.html stays the source of truth for every color and dimension. This
  // file computes geometry; it does not invent values.

  const root = document.documentElement;
  const cs = getComputedStyle(root);

  // Same parsing convention as sand-bg.js's rainbowFrameInsetPx(), kept
  // deliberately identical so the two can't disagree about what "0.35vmin"
  // means. Everything is normalized to vmin units and stays there — the ring
  // insets are emitted as vmin strings so the browser handles resize for
  // free, exactly as the old hand-written CSS did.
  function parseVmin(raw, fallback) {
    const val = (raw || fallback).trim();
    return parseFloat(val); // all frame dimensions are authored in vmin
  }

  const band = parseVmin(cs.getPropertyValue("--band"), "0.35vmin");
  const sep = parseVmin(cs.getPropertyValue("--sep"), "1.2425vmin");
  const radius = parseVmin(cs.getPropertyValue("--radius"), "8vmin");

  const hex = (name, fallback) =>
    (cs.getPropertyValue(name) || fallback).trim();

  const COLORS = {
    red: hex("--c-red", "#FF0000"),
    yellow: hex("--c-yellow", "#F5C518"),
    green: hex("--c-green", "#3DBF5F"),
    blue: hex("--c-blue", "#2E86F5"),
    purple: hex("--c-purple", "#9B4FE0"),
    void: hex("--void", "#0A0714"),
  };

  // One pass, outer to inner: color, separator, color, separator, ...
  // Nine entries, five colored and four black, matching the original
  // hand-written stack exactly.
  const SEQUENCE = [
    { color: COLORS.red, kind: "color" },
    { color: null, kind: "sep" },
    { color: COLORS.yellow, kind: "color" },
    { color: null, kind: "sep" },
    { color: COLORS.green, kind: "color" },
    { color: null, kind: "sep" },
    { color: COLORS.blue, kind: "color" },
    { color: null, kind: "sep" },
    { color: COLORS.purple, kind: "color" },
  ];

  // ---- color math ------------------------------------------------------

  function parseHex(h) {
    const s = h.replace("#", "").trim();
    const full = s.length === 3 ? s.split("").map(c => c + c).join("") : s;
    return {
      r: parseInt(full.slice(0, 2), 16),
      g: parseInt(full.slice(2, 4), 16),
      b: parseInt(full.slice(4, 6), 16),
    };
  }

  function toHex(c) {
    const h = (v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, "0");
    return `#${h(c.r)}${h(c.g)}${h(c.b)}`;
  }

  // Linear mix toward the void color. t=1 returns the original, t=0 returns
  // pure void. Done in plain sRGB rather than a perceptual space on purpose:
  // the rings are thin, saturated, and sitting on a near-black page, and sRGB
  // mixing keeps hue stable through the darkening in a way that reads as
  // "further away" rather than "different color".
  function dim(hexColor, t) {
    const c = parseHex(hexColor);
    const v = parseHex(COLORS.void);
    return toHex({
      r: v.r + (c.r - v.r) * t,
      g: v.g + (c.g - v.g) * t,
      b: v.b + (c.b - v.b) * t,
    });
  }

  // ---- build -----------------------------------------------------------

  function build() {
    const host = document.querySelector(".rainbow-frame");
    if (!host) return;

    host.innerHTML = "";

    // The first pass's own width — informational only now (exposed on
    // window.RainbowFrame below), not load-bearing anywhere. No downstream
    // code depends on this specific number; see the file header for why.
    const passOneWidth = 5 * band + 4 * sep;

    // Precompute every ring's geometry before touching the DOM, so the total
    // ring count is known and depth fractions can be normalized across the
    // whole stack rather than per-pass (a per-pass normalization would reset
    // the parallax at every repetition and destroy the sense of one
    // continuous corridor).
    const rings = [];
    let offset = 0;

    for (let p = 0; p < PASSES; p++) {
      // Gap goes BEFORE a pass's rings, not after — so it sits in the empty
      // space between one pass ending and the next beginning, and the last
      // pass doesn't leave a trailing gap with nothing on the other side of
      // it.
      if (p > 0) offset += 1.0;  // 1.0vmin between passes — slightly wider than --sep (0.8vmin)

      for (let i = 0; i < SEQUENCE.length; i++) {
        const entry = SEQUENCE[i];
        // Colored rings compress by PASS_SCALE; separators compress by the
        // less-aggressive SEP_PASS_SCALE so the rings within deeper passes
        // read as further apart rather than as a tighter version of pass 1.
        const rawScale = entry.kind === "color" ? Math.pow(PASS_SCALE, p) : Math.pow(SEP_PASS_SCALE, p);
        const thickness = Math.max(
          (entry.kind === "color" ? band : sep) * rawScale,
          MIN_THICKNESS_VMIN
        );
        rings.push({
          pass: p,
          kind: entry.kind,
          // Pass 0 separators: opaque black — they define the structure of
          // the outermost, physical-feeling frame, and black is what reads
          // as a hard edge between colored bands.
          // Pass 1+ separators: transparent — the gap between rings in the
          // inner reflection doesn't need to be ink-black, just space. The
          // void background shows through at nearly the same near-black
          // color anyway, and leaving it clear makes the inner rings feel
          // lighter and more receding rather than a second solid-edged frame.
          color: entry.kind === "color"
            ? dim(entry.color, Math.pow(PASS_DIM, p))
            : p === 0 ? "#000000" : "transparent",
          offset: offset,
          thickness: thickness,
        });
        offset += thickness;
      }
    }

    const total = rings.length;

    rings.forEach((r, i) => {
      const el = document.createElement("div");
      el.className = `ring ring-p${r.pass} ring-${r.kind}`;

      // Normalized depth across the ENTIRE stack, curved. Ring 0 is pinned at
      // exactly 0: it is the bezel, flush with the screen edge, and any
      // displacement at all would swing it off the viewport and open a sliver
      // of bare background along one side on every tilt.
      const t = total > 1 ? i / (total - 1) : 0;
      const d = Math.pow(t, DEPTH_CURVE);

      el.style.setProperty("--d", d.toFixed(4));
      el.style.inset = `${r.offset.toFixed(4)}vmin`;

      // Concentric corners: each ring's radius is the outer radius minus its
      // own inset. The old single-element version got this for free, because
      // box-shadow spread on a rounded rect shrinks the inner radius as it
      // moves inward; separate elements get no such favor.
      //   Once the stack runs deeper than --radius, this goes negative and is
      // clamped to 0, squaring off the corners of the innermost passes while
      // the outer ones stay round. It is far less visible than it sounds —
      // those passes are heavily dimmed — but the fix, if it ever reads
      // wrong, is to raise --radius in index.html, accepting rounder
      // corners on pass 1 as the tradeoff.
      const rad = Math.max(0, radius - r.offset);
      el.style.borderRadius = `${rad.toFixed(4)}vmin`;

      el.style.boxShadow = `inset 0 0 0 ${r.thickness.toFixed(4)}vmin ${r.color}`;

      host.appendChild(el);
    });

    // Expose what was actually built. Nothing consumes this yet; it exists so
    // that the geometry can be checked from the console against what
    // sand-bg.js believes, without re-deriving it by hand.
    window.RainbowFrame = {
      passes: PASSES,
      ringCount: total,
      passOneWidthVmin: passOneWidth,
      totalWidthVmin: offset,
      rebuild: build,
    };
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", build);
  } else {
    build();
  }
})();
