// ============================================================================
// tilt.js — shared "which way is the viewer looking from" signal.
//
// Publishes exactly two numbers, both in [-1, 1], as CSS custom properties on
// :root, updated once per animation frame:
//
//   --tilt-x   left/right   (-1 = tipped left,  +1 = tipped right)
//   --tilt-y   up/down      (-1 = tipped away,  +1 = tipped toward you)
//
// Anything that wants to react to viewer angle reads those vars in plain CSS
// calc() — no JS coupling, no imports, no subscription. The rainbow border's
// per-ring parallax is the first consumer; the wordmark, the glow layers, or
// anything else can join later by reading the same two vars and never touching
// this file.
//
// WHY CSS VARS AND NOT A CALLBACK API: this signal has exactly one shape (two
// scalars) and many potential consumers, and the browser already has a
// perfectly good global broadcast channel for scalars that CSS needs. An
// event-emitter here would mean every consumer needs a JS file, an import, and
// a teardown path to read two numbers. Custom properties give the same reach
// for free. The escape hatch exists anyway — window.SiteTilt.get() below — for
// the case where something genuinely needs the values in JS (canvas drawing,
// say, where CSS can't reach).
//
// INPUT SOURCES, in priority order:
//   1. Device orientation (phones/tablets) — takes over permanently the first
//      time a real reading arrives.
//   2. Pointer position (desktop) — active until/unless gyro takes over.
// There is deliberately no manual toggle and no "enable tilt" button: the
// permission request piggybacks silently on the first touch the visitor makes
// anywhere on the page (see requestGyroOnFirstTouch), and if it's denied or
// unavailable, pointer input just keeps working. A visitor should never be
// asked to opt into a background visual effect.
//
// CALIBRATION: the first orientation reading becomes the neutral baseline
// rather than assuming the phone is held flat. Someone reading in bed at 40
// degrees gets the same usable range as someone holding the phone upright,
// which a fixed "flat is zero" model gets badly wrong. Baseline resets on
// orientationchange, since portrait/landscape is a genuinely different
// holding posture and the old baseline is meaningless across that boundary.
// ============================================================================

(function () {
  "use strict";

  // ---- tuning ----------------------------------------------------------
  // Degrees of physical tilt that map to the full -1..1 range. 30 is a
  // deliberately small window: this is an ambient effect, and a visitor
  // holding a phone naturally moves it far less than they think. A larger
  // number here makes the effect feel dead on a phone that's barely moving.
  const GYRO_RANGE_DEG = 30;

  // Exponential smoothing factor, applied per frame. Lower = heavier, more
  // liquid; higher = snappier, more responsive. 0.12 reads as "weighted
  // glass" rather than either "stuck" or "twitchy". Raw sensor output
  // without this is visibly jittery — phone gyros are noisy at rest.
  const SMOOTHING = 0.12;

  // ---- state -----------------------------------------------------------
  const root = document.documentElement;
  const target = { x: 0, y: 0 };   // where input says we should be
  const current = { x: 0, y: 0 };  // where the smoothed value actually is
  let gyroActive = false;
  let baseline = null;             // { beta, gamma } captured on first reading
  let rafHandle = null;

  const reducedMotion =
    window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const clamp = (v) => (v < -1 ? -1 : v > 1 ? 1 : v);

  function setTarget(x, y) {
    target.x = clamp(x);
    target.y = clamp(y);
  }

  // ---- the one place the vars actually get written ----------------------
  function publish(x, y) {
    // toFixed(4) rather than raw floats: keeps the serialized string short
    // (these are written every frame and re-parsed by the style system each
    // time) without any visible loss of precision at these magnitudes.
    root.style.setProperty("--tilt-x", x.toFixed(4));
    root.style.setProperty("--tilt-y", y.toFixed(4));
  }

  function frame() {
    current.x += (target.x - current.x) * SMOOTHING;
    current.y += (target.y - current.y) * SMOOTHING;
    publish(current.x, current.y);
    rafHandle = requestAnimationFrame(frame);
  }

  // ---- pointer input (desktop, and any touch drag before gyro engages) --
  // Normalized against the viewport rather than any particular element: the
  // consumers of this signal are full-viewport frames, so viewport-relative
  // is the coordinate space that actually means something here.
  function onPointerMove(e) {
    if (gyroActive) return;
    const x = (e.clientX / window.innerWidth - 0.5) * 2;
    const y = (e.clientY / window.innerHeight - 0.5) * 2;
    setTarget(x, y);
  }

  // Pointer leaving the window means we have no idea where the viewer is
  // looking from — drifting back to neutral is more honest than freezing at
  // whatever the last edge value happened to be.
  function onPointerOut(e) {
    if (gyroActive) return;
    if (e.relatedTarget === null) setTarget(0, 0);
  }

  // ---- device orientation ----------------------------------------------
  function onDeviceOrientation(e) {
    if (e.gamma === null || e.beta === null) return;

    if (!baseline) {
      baseline = { beta: e.beta, gamma: e.gamma };
      if (!gyroActive) {
        gyroActive = true;
        // Gyro wins permanently once it produces a real reading. Leaving the
        // pointer listeners attached would let a stray touchmove fight the
        // sensor for control of the same two numbers.
        window.removeEventListener("pointermove", onPointerMove);
        window.removeEventListener("pointerout", onPointerOut);
      }
    }

    setTarget(
      (e.gamma - baseline.gamma) / GYRO_RANGE_DEG,
      (e.beta - baseline.beta) / GYRO_RANGE_DEG
    );
  }

  function attachGyro() {
    window.addEventListener("deviceorientation", onDeviceOrientation, { passive: true });
  }

  // iOS 13+ gates the sensor behind a permission call that MUST originate
  // from a user gesture. Rather than putting an "enable tilt" button on the
  // page for a purely decorative effect, this rides along with the visitor's
  // first touch — which on this site is essentially guaranteed, since
  // touching the sand is the whole point of the page. Fires once, then
  // unhooks itself whether or not permission was granted.
  function requestGyroOnFirstTouch() {
    const DOE = window.DeviceOrientationEvent;
    if (!DOE) return;

    if (typeof DOE.requestPermission !== "function") {
      // Android/desktop: no gate, just listen.
      attachGyro();
      return;
    }

    const handler = function () {
      window.removeEventListener("touchstart", handler);
      DOE.requestPermission()
        .then(function (result) {
          if (result === "granted") attachGyro();
        })
        .catch(function () {
          // Denied, or blocked by a sandboxed iframe context. Pointer input
          // is already running and stays running — nothing to recover from,
          // and nothing worth telling the visitor about.
        });
    };
    window.addEventListener("touchstart", handler, { passive: true });
  }

  // Portrait <-> landscape is a different holding posture entirely, so the
  // captured baseline no longer describes "neutral" for how the phone is now
  // being held. Dropping it lets the next reading recapture. Deliberately
  // does NOT reset `current` — letting the smoothing carry through the
  // transition avoids a visible snap on rotate.
  window.addEventListener("orientationchange", function () {
    baseline = null;
  });

  // ---- init ------------------------------------------------------------
  publish(0, 0);

  if (reducedMotion) {
    // Vars stay pinned at 0 and the rAF loop never starts. Consumers written
    // as calc() against these vars therefore render in their neutral state
    // with no extra media query on their end — the whole effect switches off
    // from this one place, which is the point of centralizing the signal.
    return;
  }

  window.addEventListener("pointermove", onPointerMove, { passive: true });
  window.addEventListener("pointerout", onPointerOut, { passive: true });
  requestGyroOnFirstTouch();
  rafHandle = requestAnimationFrame(frame);

  // ---- escape hatch ----------------------------------------------------
  // For consumers that can't read CSS vars — canvas drawing, mainly. Nothing
  // uses this yet; it exists so that the first thing that needs it doesn't
  // have to restructure this file to get at the values.
  window.SiteTilt = {
    get: function () { return { x: current.x, y: current.y }; },
    isGyro: function () { return gyroActive; },
    stop: function () {
      if (rafHandle !== null) cancelAnimationFrame(rafHandle);
      rafHandle = null;
      publish(0, 0);
    },
  };
})();
