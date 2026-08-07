// SHARED PAGE SHELL — engine-agnostic scaffolding factored out of
// sand-bg.js so each new design-element experiment (plants, later an
// animal, whatever comes next) doesn't have to hand-roll its own
// tuning-panel DOM or its own requestAnimationFrame accumulator loop.
//   Deliberately does NOT know anything about grids, materials, or the
// cellular-automaton engine — sand-bg.js's canvas-stack/resize/pointer
// code is NOT in here, because it's genuinely CA-specific (world-cell
// coordinates, camera, CELL_PX) and forcing it through a shared
// abstraction would just be indirection for indirection's sake. What IS
// shared here is identical regardless of what's being simulated: a
// collapsible corner panel with sliders/checkboxes/buttons, and a
// fixed-timestep RAF loop with an accumulator.

// ---- Collapsible tuning panel ----
// Same visual language/positioning as sand-bg.js's panel (bottom-right,
// dark translucent, JetBrains Mono). Returns an API instead of module-
// level globals so multiple pages — or in principle multiple panels on
// one page — don't collide.
export function createTuningPanel({ title = "TUNING" } = {}) {
  const panel = document.createElement("div");
  panel.style.cssText =
    "position:fixed;bottom:8px;right:8px;z-index:11;width:230px;max-height:70vh;overflow-y:auto;" +
    "background:rgba(10,7,20,0.88);border:1px solid rgba(255,255,255,0.15);border-radius:8px;" +
    "padding:8px 10px;font:11px/1.4 'JetBrains Mono',monospace;color:#E8DFFF;pointer-events:auto;";

  const header = document.createElement("div");
  header.textContent = `${title} \u25be`;
  header.style.cssText = "cursor:pointer;font-weight:600;letter-spacing:0.05em;margin-bottom:4px;user-select:none;";
  const body = document.createElement("div");
  let open = true;
  header.addEventListener("pointerdown", (e) => {
    e.stopPropagation();
    open = !open;
    body.style.display = open ? "" : "none";
    header.textContent = `${title} ${open ? "\u25be" : "\u25b8"}`;
  });
  panel.appendChild(header);
  panel.appendChild(body);
  // Same reasoning as sand-bg.js: a slider/button drag shouldn't leak
  // through to whatever pointerdown handler the page's own sim has.
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
    body.appendChild(row);
    return input;
  }

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
    body.appendChild(row);
    return input;
  }

  function addHeading(text) {
    const h = document.createElement("div");
    h.textContent = text;
    h.style.cssText = "margin-top:8px;opacity:0.7;";
    body.appendChild(h);
    return h;
  }

  function addButton(label, onClick) {
    const btn = document.createElement("button");
    btn.textContent = label;
    btn.style.cssText =
      "width:100%;margin:6px 0;padding:5px;background:rgba(255,255,255,0.08);" +
      "border:1px solid rgba(255,255,255,0.2);border-radius:5px;color:#E8DFFF;" +
      "font:inherit;cursor:pointer;";
    btn.addEventListener("pointerdown", (e) => e.stopPropagation());
    btn.addEventListener("click", onClick);
    body.appendChild(btn);
    return btn;
  }

  document.body.appendChild(panel);
  return { panel, body, addSlider, addCheckbox, addHeading, addButton };
}

// ---- Fixed-timestep RAF loop ----
// Same accumulator pattern as sand-bg.js's loop(): real elapsed time
// drives a whole number of fixed-size ticks per frame (capped, so a
// stalled/backgrounded tab doesn't try to catch up with thousands of
// ticks on return), independent of render — render can skip frames,
// ticks can't be dropped without changing sim speed.
//   tick(tickMs): called once per fixed step.
//   render(): called once per RAF frame, after this frame's ticks.
//   shouldRender(tickedThisFrame): optional — return false to skip
//   render() on frames where nothing changed. Defaults to always-true.
//   Respects prefers-reduced-motion the same way sand-bg.js does: draws
//   exactly one static frame and never starts the RAF loop.
export function startFixedStepLoop({ tickMs = 1000 / 60, maxTicksPerFrame = 5, tick, render, shouldRender }) {
  let acc = 0, last = 0;
  const reducedMotion = window.matchMedia
    && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  function frame(now) {
    const dt = last ? now - last : tickMs;
    last = now;
    acc = Math.min(acc + dt, tickMs * maxTicksPerFrame);
    let ticked = false;
    while (acc >= tickMs) {
      tick(tickMs);
      acc -= tickMs;
      ticked = true;
    }
    if (!shouldRender || shouldRender(ticked)) render();
    if (!reducedMotion) requestAnimationFrame(frame);
  }
  if (!reducedMotion) requestAnimationFrame(frame);
  else render();
  return { get reducedMotion() { return reducedMotion; } };
}
