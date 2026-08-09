// ============================================================================
// frame.js — builds the rainbow border as a multi-pass infinity mirror.
//
// The border used to be nine hand-written <div>s in index.html, one per ring.
// That was fine at nine. It is not fine at twenty-seven, and it would be
// actively hostile at whatever number PASSES gets set to next — so the rings
// are generated here instead, and index.html now ships an empty
// .rainbow-frame wrapper for this file to populate.
//
// WHAT AN "INFINITY MIRROR" MEANS HERE: the five-color rainbow sequence is
// painted PASSES times, each repetition thinner and darker than the last,
// nesting inward. Combined with the per-ring parallax from tilt.js, the
// repetitions read as reflections receding into the screen rather than as a
// merely thicker border.
//
// ============================================================================
// THE ONE HARD CONSTRAINT, AND WHY IT SHAPES EVERYTHING BELOW
// ============================================================================
// sand-bg.js's rainbowFrameInsetPx() computes the physics boundary as
// literally `5 * band + 4 * sep` — it reads the --band and --sep custom
// properties and reconstructs a SINGLE pass's width from them. It does not
// read --frame-inset, and it has no concept of repetitions.
//
// That function is what positions the floor drain, the DOM colliders, and
// (via --frame-inset) the palette groups and the contact link. If the total
// painted border ever stopped matching `5*band + 4*sep`, the invisible
// physics edge would drift away from the visible inner edge and sand would
// start piling up against nothing, or vanishing into the border.
//
// So: PASS 1 IS EXACTLY 5*band + 4*sep WIDE, always. That is the contract.
// Passes 2..N are drawn INSIDE the play area as decoration, not as part of
// the frame's structural width. Nothing in sand-bg.js needs to know they
// exist, and nothing in sand-bg.js was changed to support them.
//
// This is also why the extra passes look right rather than looking like a
// fatter border: sand falls IN FRONT of them (index.html raises #stageWrap
// above the rings in the stacking order), so they sit behind the simulation
// the way a reflection sits behind glass. Reflections you can pour sand over.
// ============================================================================

(function () {
  "use strict";

  // ---- tuning ----------------------------------------------------------

  // Total repetitions of the 5-color sequence, including the first. 1 gives
  // exactly the old single-pass border. Each additional pass costs 9 more
  // composited fixed-position elements, so this is not free at large values,
  // but at 3 it is 27 transform-only layers and unmeasurable in practice.
  const PASSES = 3;

  // Each pass's ring thicknesses, as a fraction of the previous pass. This is
  // the single most important number for whether the effect reads as DEPTH
  // versus as a striped border, and it wants to be aggressive: real
  // reflections compress hard toward the vanishing point. Values near 1
  // produce evenly-spaced stripes that look flat no matter how much parallax
  // is applied on top.
  const PASS_SCALE = 0.45;

  // Each pass's brightness, as a fraction of the previous. Compounds, so at
  // 0.55 the three passes land at 100% / 55% / 30%.
  //   Applied by mixing the ring color toward --void rather than by setting
  // opacity. Opacity would let whatever is behind the border show through the
  // rings, which — now that the sand sim renders IN FRONT of the frame — would
  // mean the deep passes get tinted by the page background in a way that
  // shifts as the sim moves. Mixing toward the void color is stable, and it
  // is also what a dimmer reflection physically is: less light, not partial
  // transparency.
  const PASS_DIM = 0.55;

  // Minimum thickness any ring is allowed to have, in vmin. This exists
  // because PASS_SCALE compounds and vmin is small: at 0.45, a third-pass
  // colored ring computes to 0.0709vmin, which on a 390px-wide phone is
  // 0.28 device pixels. That does not render as a thin line — it renders as
  // an inconsistent smear or nothing at all, depending on how the device
  // rounds it, and the whole third pass effectively disappears on the exact
  // hardware this effect is built for.
  //   0.25vmin is about 1 device pixel on a typical phone, which is the
  // narrowest a line can be and still be reliably drawn.
  //   The tradeoff, stated plainly: floored rings stop compressing in
  // THICKNESS while continuing to compress in SPACING. That is a real
  // departure from strict perspective, but it is the right one — the eye
  // reads depth from the spacing rhythm far more than from line weight, and
  // a correctly-scaled invisible line communicates nothing at all.
  //   Only affects passes 2 and up: the floor is below both --band (0.35) and
  // --sep (1.2425), so pass 1 is never touched by it and the sand-bg.js width
  // contract is unaffected.
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

    // First pass: exactly the structural width sand-bg.js assumes. Asserted
    // rather than assumed — see the contract note at the top of this file.
    const passOneWidth = 5 * band + 4 * sep;

    // Precompute every ring's geometry before touching the DOM, so the total
    // ring count is known and depth fractions can be normalized across the
    // whole stack rather than per-pass (a per-pass normalization would reset
    // the parallax at every repetition and destroy the sense of one
    // continuous corridor).
    const rings = [];
    let offset = 0;

    for (let p = 0; p < PASSES; p++) {
      const scale = Math.pow(PASS_SCALE, p);
      const brightness = Math.pow(PASS_DIM, p);

      for (let i = 0; i < SEQUENCE.length; i++) {
        const entry = SEQUENCE[i];
        const thickness = Math.max(
          (entry.kind === "color" ? band : sep) * scale,
          MIN_THICKNESS_VMIN
        );
        rings.push({
          pass: p,
          kind: entry.kind,
          // Separators stay pure black at every depth. They are structural —
          // they are what separates one colored band from the next — and a
          // "dimmer black" is just black. Mixing them toward void would
          // actually LIGHTEN them slightly, since --void isn't pure black.
          color: entry.kind === "color" ? dim(entry.color, brightness) : "#000000",
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
      // the outer ones stay round. At the shipped values that happens partway
      // through pass 2. It is far less visible than it sounds — those passes
      // are heavily dimmed and have sand falling in front of them — but the
      // fix, if it ever reads wrong, is to raise --radius in index.html,
      // accepting rounder corners on pass 1 as the tradeoff.
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
