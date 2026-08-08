/* ZODIAC DRIFT — js/ui-matlab.js — the material property editor.

   Extracted verbatim from the Fluid Bench's inline script (it lived
   there since it was written) so BOTH hosts can mount it: the bench
   still shows it as a left-edge slide-in panel, the game shows it as a
   sheet behind the Brush button. Same code, same schemas, same edits —
   this is a straight lift, not a reimplementation, so nothing about
   which properties are editable or how they behave changed in the move.

   WHAT MOVED WITH IT (all of it lived in the same contiguous run):
   PROP_SCHEMA, BOOL_SCHEMA, MAT_GROUP_DEFS, BEHAVIOR_DESC,
   MOVING_BEHAVIORS, IGNITION_DEFAULT, HEAT_OUTPUT_DEFAULT, the
   matGroupCollapsed set, and the dirtyMats/ORIGINAL_MATS pair. The
   schemas and the panel are one thing — splitting them would mean a
   future property needed edits in two files.

   THREE THINGS CHANGED IN THE LIFT, and only three:

   1. It no longer reads a host global for "which material is selected".
      The bench kept a local `let mat`; the game keeps `mat`/`setMat` in
      state.js. Neither is reachable from here, and guessing which one to
      import would couple this module to one host. The host passes the id
      in instead — setMaterial(id) / open(id).

   2. Host-owned UI it used to poke directly is now four hooks. It reached
      into the bench's `matBtns` array to repaint a swatch, flag a button
      as edited, and refresh a title attribute — but the game's material
      list is a completely different shape (a drawer of .mat buttons, not
      a row of .sw buttons). Same setOnXChanged inversion already used by
      stamps.js, entities.js and tuning.js.

   3. syncMatPanel() used to close the bench's "Export changes" text box
      as tidy-up. That box lives in the bench's popover menus, not in this
      panel, and does not exist in the game at all — it would have thrown
      on first open. Now an onSync hook the bench uses for its own tidying.

   TWO THINGS THE LIFT FIXED, because a color editor that half-applies is
   worse than none:

   - Twin resync. Every non-solid material has a "(set)" twin (settled
     material) and every material has a "(built)" twin (placed stamps).
     Both copy their source's look ONCE at module load. So recoloring
     Water left every already-settled and every built Water cell showing
     the OLD color, permanently. resyncTwinAppearance() now pushes the new
     appearance to both, reapplying the stamp twin's darkening so built
     structures keep reading as distinct from loose material.
   - Tile art rebuild. render.js bakes each material's tile once at load;
     at any zoom where tiles are drawn, a color edit was invisible.
     rebuildTileFor() (added to render.js alongside this) refreshes just
     the edited material and its twins.

   NOT MOVED, deliberately: the plain-text export box, the .json table
   import/export, and the confirm-then-reload flow. Those are authoring-
   tool concerns, and the table path ends in location.reload(), which in
   the game means discarding the world. They stay in the bench until
   there's a decision about what table loading means mid-game. The bench
   still drives them off dirtyMats/ORIGINAL_MATS/nameOf, so those three
   are exported. */

import { MATS, MATBY, EMPTY, reactTo, reactChanceOf, SOLID_TWIN, STAMP_TWIN } from "./materials.js";
import { rgbToHsl, setMaterialColor as updateMatColor } from "./color.js";
import { rebuildTileFor } from "./render.js";

/* ---- mount state. One panel per page in practice; `root` scopes every
   lookup so the ids below can stay exactly as they were in the bench's
   markup without becoming document-global assumptions. ---- */
let root = null;
let currentId = null;
const q = sel => root ? root.querySelector(sel) : null;

/* ---- host hooks. All no-ops until the host supplies one, so a host that
   doesn't have (say) a swatch row simply doesn't wire that one. ---- */
let onSwatchChanged = ()=>{};   // (id, mat) — repaint the host's swatch for this material
let onDirtyChanged  = ()=>{};   // (id, isDirty) — mark/unmark the host's button as edited
let onRenamed       = ()=>{};   // (id, newName) — refresh anywhere the host cached the name
let onSync          = ()=>{};   // (mat) — host tidy-up whenever the panel re-renders

export function setMatLabHooks(hooks={}){
  if(hooks.onSwatchChanged) onSwatchChanged = hooks.onSwatchChanged;
  if(hooks.onDirtyChanged)  onDirtyChanged  = hooks.onDirtyChanged;
  if(hooks.onRenamed)       onRenamed       = hooks.onRenamed;
  if(hooks.onSync)          onSync          = hooks.onSync;
}

/* Edited-material bookkeeping. Exported because the bench's export/table
   code (which stayed behind) reads both. ORIGINAL_MATS is snapshotted at
   module load — i.e. against whichever table won, default or custom —
   which is what makes Reset mean "back to this table's definition"
   rather than "back to the default roster". */
export const ORIGINAL_MATS={};
MATS.forEach(m=>{ ORIGINAL_MATS[m.id]=JSON.parse(JSON.stringify(m)); });
export const dirtyMats=new Set();

/* Push a material's appearance onto its twins. See the header note: twins
   snapshot sw/rgb/em/sh once at load and would otherwise keep showing the
   pre-edit color forever. STAMP_DARKEN mirrors materials.js's own constant
   — a built structure is deliberately drawn darker than the same material
   loose, and that has to survive a recolor or the visual distinction dies. */
const STAMP_DARKEN=0.78;
const dk = c => Math.round(c*STAMP_DARKEN);
function resyncTwinAppearance(id){
  const src=MATBY[id];
  if(!src || !src.rgb) return;
  const setId=SOLID_TWIN[id];
  // A solid material is its own "(set)" twin — don't recolor it twice,
  // and don't darken it.
  if(setId!==undefined && setId!==id){
    const t=MATBY[setId];
    if(t){ t.sw=src.sw; t.rgb=src.rgb.slice(); t.em=src.em; t.sh=src.sh; rebuildTileFor(setId); }
  }
  const stampId=STAMP_TWIN[id];
  if(stampId!==undefined){
    const t=MATBY[stampId];
    if(t){
      t.sw=src.sw;
      t.rgb=[dk(src.rgb[0]),dk(src.rgb[1]),dk(src.rgb[2])];
      t.em=src.em; t.sh=src.sh;
      rebuildTileFor(stampId);
    }
  }
}

/* ================= material property editor =================
   Slide-in panel from the left, mirrors whichever material is currently
   selected in the Mat row. Schema-driven — adding a future property
   (e.g. `visc` off the material-behavior roadmap) is one entry in
   PROP_SCHEMA, not a rewrite of this panel.

   Edits mutate the live MATS/MATBY objects directly — physics.js and
   this bench's own draw() both read M.dens/M.sh/M.decay fresh every
   tick/frame, so changes take effect immediately, no extra plumbing.
   They do NOT retroactively touch SOLID_TWIN/STAMP_TWIN entries (e.g.
   "Sand (set)") — those copied their sh/rgb/em ONCE at module load, so
   already-settled piles keep their old shimmer; only newly-falling loose
   material picks up an edit. That's a real seam in how twins are built,
   not something this panel works around.

   Nothing here writes to disk — browser JS can't touch materials.js on
   your filesystem, and the one API that could (File System Access) is
   Chrome-desktop-only, useless on the phone this thing is built for.
   Export instead produces a plain-text diff you copy into the real file
   by hand. */
const MOVING_BEHAVIORS = new Set(["grow","creep","powder","powder-settle","liquid","pressured","gas","diffuse","fire"]);
const PROP_SCHEMA=[
  { key:"dens", label:"Density", min:0, max:50, step:1,
    appliesTo:m=>m.behavior!=="solid" && m.behavior!=="void" && m.behavior!=="generator" },
  { key:"sh", label:"Shimmer", min:0, max:40, step:1,
    appliesTo:m=>m.behavior!=="void" && m.behavior!=="generator" },
  // Promoted from raw-data-only. Default 0 matches physics.js's own
  // fallback for an unset conductivity (diffuseTemp's condA/condB) — an
  // untouched slider shows the value actually in effect, same convention
  // every other row here follows. 0 is also a true insulator (§5's
  // deferred-design note in the materials handoff: unset/0 already
  // blocks both conduction AND radiant, no separate insulator flag
  // needed), so leaving this at 0 is a meaningful, valid choice, not
  // just an empty default.
  { key:"conductivity", label:"Conductivity", min:0, max:1, step:0.01, default:0,
    appliesTo:m=>m.behavior!=="void" && m.behavior!=="generator" },
  { key:"decay", label:"Decay", min:0, max:0.03, step:0.0005,
    appliesTo:m=>m.behavior!=="void" && m.behavior!=="generator" },
  // ---- added: physics.js already reads all four of these per-material
  // (growChance/climbBias/reactChance as explicit fields, visc as the
  // step()'s movement-pass gate) but none had a row here before — only
  // hand-editable in materials.js. Defaults match physics.js's own
  // fallback when the field is unset, so an untouched slider shows the
  // value actually in effect right now, not a misleading 0.
  { key:"growChance", label:"Grow chance", min:0, max:0.3, step:0.002, default:0.02,
    appliesTo:m=>m.behavior==="grow" },
  { key:"climbBias", label:"Climb bias", min:-1, max:1, step:0.05, default:0,
    appliesTo:m=>m.behavior==="creep" },
  { key:"reactChance", label:"React chance", min:0, max:1, step:0.01, default:1,
    appliesTo:m=>!!m.onContact },
  { key:"visc", label:"Viscosity (move chance)", min:0, max:1, step:0.01, default:1,
    appliesTo:m=>MOVING_BEHAVIORS.has(m.behavior) },
  { key:"cohesion", label:"Cohesion (surface tension)", min:0, max:1, step:0.01, default:0.6,
    appliesTo:m=>m.behavior==="liquid" },
  // emits.chance is nested (M.emits.chance) — get/set override the flat
  // m[key] default every other row uses. Only shows for materials that
  // already have an `emits` block (Calcite); doesn't offer to CREATE an
  // emits relationship from scratch — that's "which material" (a
  // dropdown, not a slider), out of scope here same as onContact/decayTo.
  { key:"emitsChance", label:"Emit chance", min:0, max:0.05, step:0.0005, default:0,
    appliesTo:m=>!!m.emits,
    get:m=>m.emits?.chance, set:(m,v)=>{ m.emits.chance=v; } },
  // ---- thermal rows. All four are read by physics.js per-material:
  // heatCapacity divides every temperature change a cell undergoes
  // (conduction AND the ambient thermostat), chillOutput is the cold
  // mirror of heatOutput, and melt/freeze points are the phase-change
  // thresholds. Defaults match physics.js's own fallbacks so an untouched
  // slider shows the value actually in effect, same convention as the
  // movement rows above.
  //   The 0..99 range on the two thresholds is the world temp scale, not
  // an arbitrary pick — 0 is the void floor and SKY_HEAT_CEILING is 99.
  { key:"heatCapacity", label:"Heat capacity (thermal mass)", min:0.05, max:20, step:0.05, default:1,
    appliesTo:m=>m.behavior!=="void" && m.behavior!=="generator" },
  { key:"chillOutput", label:"Chill output (holds itself cold)", min:0, max:40, step:1, default:0,
    appliesTo:m=>m.chillOutput!==undefined },
  { key:"meltPoint", label:"Melt / upper threshold", min:0, max:99, step:1, default:0,
    appliesTo:m=>m.meltPoint!==undefined },
  { key:"freezePoint", label:"Freeze / lower threshold", min:0, max:99, step:1, default:0,
    appliesTo:m=>m.freezePoint!==undefined },
];
function propGet(p,m){ return p.get ? p.get(m) : m[p.key]; }
function propSet(p,m,v){ if(p.set) p.set(m,v); else m[p.key]=v; }
const BOOL_SCHEMA=[
  { key:"em", label:"Emissive" },
  { key:"rainbow", label:"Rainbow shift" },
  { key:"needsLateralSupport", label:"Needs lateral support",
    appliesTo:m=>m.behavior==="powder-settle" },
];
function markDirtyIfChanged(id){
  const cur=MATBY[id], orig=ORIGINAL_MATS[id];
  const changed = PROP_SCHEMA.some(p=>propGet(p,cur)!==propGet(p,orig))
    || BOOL_SCHEMA.some(p=>!!cur[p.key]!==!!orig[p.key])
    || cur.name !== orig.name
    || cur.sw!==orig.sw
    || JSON.stringify(cur.rgb)!==JSON.stringify(orig.rgb)
    || (cur.decayTo!==undefined?cur.decayTo:EMPTY) !== (orig.decayTo!==undefined?orig.decayTo:EMPTY)
    || JSON.stringify(cur.onContact||{}) !== JSON.stringify(orig.onContact||{})
    || cur.ignitionTemp !== orig.ignitionTemp
    || cur.heatOutput !== orig.heatOutput
    // phase targets, same undefined-means-EMPTY normalisation decayTo uses
    || (cur.meltTo!==undefined?cur.meltTo:EMPTY) !== (orig.meltTo!==undefined?orig.meltTo:EMPTY)
    || (cur.freezeTo!==undefined?cur.freezeTo:EMPTY) !== (orig.freezeTo!==undefined?orig.freezeTo:EMPTY);
  if(changed) dirtyMats.add(id); else dirtyMats.delete(id);
  onDirtyChanged(id, dirtyMats.has(id));
}
// ---- material description block: plain-language summary shown above
// Density in the material panel. Entirely derived from the material's
// own data (behavior/decay/emits/onContact) — nothing hand-written per
// material, so it can't drift out of sync with what physics.js actually
// does. The reaction line is the part Crash specifically asked for:
// every material this one reacts with, and what it becomes.
const BEHAVIOR_DESC = {
  void: "Erases — clears a cell to empty.",
  solid: "Static — never moves.",
  powder: "Falls freely like sand; may compact into a solid form over time.",
  "powder-settle": "Falls and slides downhill; settles into a solid form after enough idle time.",
  liquid: "Falls and seeps sideways one cell at a time — a lazy liquid.",
  pressured: "Falls and disperses sideways fast — levels out quickly, spring-fed feel.",
  gas: "Rises and drifts upward.",
  diffuse: "Spreads randomly in all directions.",
  grow: "Duplicates upward into empty space, deflecting sideways when blocked — never removes its own source cell.",
  creep: "Hugs solid surfaces instead of falling freely.",
  fire: "Mostly stationary; flickers upward but won't drift into open air. Ignites nearby fuel — see Reacts with / Flammable below.",
};
function describeMaterial(m){
  const lines=[];
  lines.push(BEHAVIOR_DESC[m.behavior] || m.behavior);
  if(m.behavior==="liquid"){
    const coh = m.cohesion!==undefined ? m.cohesion : 0.6;
    lines.push(`Surface cohesion ${coh} — higher keeps a slow/thick pour looking like a smooth liquid instead of loose grains; 0 falls back to plain viscosity everywhere.`);
  }
  if(m.decay){
    const to = m.decayTo!==undefined ? MATBY[m.decayTo].name : "nothing (erased)";
    lines.push(`Decays into ${to} — chance ${m.decay} per tick.`);
  }
  if(m.emits){
    lines.push(`Emits ${MATBY[m.emits.matId].name} into an empty neighbor — chance ${m.emits.chance} per tick.`);
  }
  if(m.onContact && Object.keys(m.onContact).length){
    const parts = Object.entries(m.onContact).map(([otherId,rule])=>
      `touching ${MATBY[otherId].name} → becomes ${MATBY[reactTo(rule)].name} (chance ${reactChanceOf(m,rule)})`);
    lines.push(`Reacts on contact while adjacent: ${parts.join("; ")}.`);
  } else {
    lines.push("Reacts with: nothing — no other material converts it on contact.");
  }
  if(m.ignitionTemp!==undefined){
    lines.push(`Flammable — ignites (becomes Fire) at temp ${m.ignitionTemp}, whether from radiant heat or direct contact with Fire.`);
  }
  if(m.heatOutput!==undefined){
    lines.push(`Radiates heat — holds its own temp at a floor of ${m.heatOutput} while present, feeding real heat into nearby cells via diffusion.`);
  }
  return lines;
}
function renderMatDesc(m){
  const descEl=q("#matPanelDesc"); descEl.innerHTML="";
  for(const line of describeMaterial(m)){
    const d=document.createElement("div"); d.textContent=line;
    descEl.appendChild(d);
  }
}
// ---- color editor: two sliders (Color = hue, Brightness = lightness),
// saturation left exactly as-is rather than adding a third slider that
// wasn't asked for. Edits write straight to m.rgb (what render.js
// actually draws) and keep m.sw (the hex used everywhere else — deck
// swatches, this panel's own header swatch, matHistory's old swatch
// styling before it went text-only) equal to it, same as every material
// in the registry already keeps them in sync by hand.

function syncSwatchesFor(id){
  const m=MATBY[id];
  if(m.behavior!=="void") onSwatchChanged(id, m);
  if(id===currentId) q("#matPanelSw").style.background = m.behavior==="void" ? "none" : m.sw;
}
function renderMatColor(m){
  const wrap=q("#matPanelColor"); wrap.innerHTML="";
  const label=document.createElement("div"); label.className="tuneGroupLabel"; label.textContent="Color";
  wrap.appendChild(label);
  if(m.behavior==="void"){
    const note=document.createElement("div"); note.className="propNote"; note.textContent="Erase has no color to edit.";
    wrap.appendChild(note); return;
  }
  const [h0,,l0]=rgbToHsl(m.rgb[0],m.rgb[1],m.rgb[2]);
  const rows=[
    { label:"Color (hue)", min:0, max:360, step:1, value:Math.round(h0),
      apply:v=>{ const [,s,l]=rgbToHsl(m.rgb[0],m.rgb[1],m.rgb[2]); updateMatColor(m,v,s,l); } },
    { label:"Brightness", min:0, max:100, step:1, value:Math.round(l0),
      apply:v=>{ const [h,s]=rgbToHsl(m.rgb[0],m.rgb[1],m.rgb[2]); updateMatColor(m,h,s,v); } },
  ];
  for(const r of rows){
    const row=document.createElement("div"); row.className="propRow";
    row.innerHTML = `<div class="propLabel"><span>${r.label}</span><b>${r.value}</b></div>
      <div class="propControls">
        <input type="range" min="${r.min}" max="${r.max}" step="${r.step}" value="${r.value}">
        <input type="number" min="${r.min}" max="${r.max}" step="${r.step}" value="${r.value}">
      </div>`;
    const range=row.querySelector('input[type=range]'), num=row.querySelector('input[type=number]'), b=row.querySelector('b');
    const apply=v=>{
      const n=Math.max(r.min, Math.min(r.max, parseFloat(v)||0));
      r.apply(n); range.value=n; num.value=n; b.textContent=n;
      markDirtyIfChanged(m.id);
      syncSwatchesFor(m.id);
      resyncTwinAppearance(m.id);
      rebuildTileFor(m.id);
    };
    range.oninput=e=>apply(e.target.value);
    num.oninput=e=>apply(e.target.value);
    wrap.appendChild(row);
  }
}
// ---- raw data block: every property literally on the material object,
// including the ones PROP_SCHEMA/BOOL_SCHEMA don't have a slider for
// (conductivity, spawnTemp, teslaReact/teslaChance, decayTo as a raw id,
// onContact's full table, etc). Nothing here is editable — it's a plain
// dump, specifically so "does this material even have that property" is
// never a guess. Object/array values get JSON-stringified inline; nested
// material-id references (onContact, decayTo, emits.matId, teslaReact)
// resolve to the target's name in parentheses since a bare numeric id
// means nothing to a tester.
function nameOf(id){ return MATBY[id] ? MATBY[id].name : String(id); }
// Shared onContact -> human-readable string, used by every place that
// displays or exports a material's reactions (raw-data panel, Export
// changes, Export ALL materials). ONE place, on purpose — this is the fix
// for the actual bug: `settled` (Bloomspore's germination gate) already
// serialized correctly in serializeOnContactRule (the JSON table export)
// but three OTHER call sites each hand-rolled their own copy of this same
// {to,chance} -> string logic before `settled` existed, so it silently
// never got taught to any of them. Same data, four formatters, three
// wrong — exactly the failure mode of writing a thing more than once.
function formatOnContact(oc, emptyText){
  return Object.entries(oc||{}).map(([k,r])=>{
    const chance = r && typeof r==="object" && r.chance!==undefined ? ` @${r.chance}` : "";
    const settled = r && typeof r==="object" && r.settled ? " [settled]" : "";
    return `${nameOf(k)}→${nameOf(reactTo(r))}${chance}${settled}`;
  }).join(", ") || emptyText;
}
function renderMatRaw(m){
  const wrap=q("#matPanelRaw"); wrap.innerHTML="";
  const label=document.createElement("div"); label.className="tuneGroupLabel"; label.textContent="All raw data (read-only)";
  wrap.appendChild(label);
  const list=document.createElement("div");
  for(const key of Object.keys(m).sort()){
    if(key.startsWith("_staged_")) continue;   // UI scratch state, not a real material field — see buildScalarToggleEditor
    let v=m[key];
    let shown;
    if(v===Infinity) shown="Infinity";
    else if(key==="onContact" && v && typeof v==="object"){
      shown = formatOnContact(v, "{}");
    } else if(key==="decayTo" || key==="meltTo" || key==="freezeTo") shown = `${v} (${nameOf(v)})`;
    else if(key==="teslaReact") shown = `${v} (${nameOf(v)})`;
    else if(key==="emits" && v && typeof v==="object"){
      shown = `matId:${v.matId} (${nameOf(v.matId)}), chance:${v.chance}`;
    } else if(Array.isArray(v)) shown = `[${v.join(",")}]`;
    else if(typeof v==="object" && v!==null) shown = JSON.stringify(v);
    else shown = String(v);
    const row=document.createElement("div");
    row.innerHTML = `<span class="rawKey">${key}</span>: ${shown}`;
    list.appendChild(row);
  }
  wrap.appendChild(list);
}
// ---- decay-target picker: a plain <select> rather than a slider, since
// this is choosing among named materials, not a number range. "— Erase
// (nothing) —" maps to EMPTY's own id, which is exactly what an unset
// decayTo already falls back to in physics.js (decay(): `M.decayTo!==
// undefined ? M.decayTo : EMPTY`), so picking it and leaving decayTo
// undefined are behaviorally identical — we just always write a real id
// here instead of leaving it undefined, simpler to reason about. Only
// shown where the Decay slider itself applies (same appliesTo as the
// decay row in PROP_SCHEMA) — a decay target means nothing on a material
// that can't decay in the first place.
function renderMatDecayTo(m){
  const wrap=q("#matPanelDecayTo"); wrap.innerHTML="";
  const decayApplies = m.behavior!=="void" && m.behavior!=="generator";
  if(!decayApplies) return;
  const label=document.createElement("div"); label.className="tuneGroupLabel"; label.textContent="Decays into";
  wrap.appendChild(label);
  const sel=document.createElement("select");
  const optNone=document.createElement("option"); optNone.value=EMPTY; optNone.textContent="— Erase (nothing) —";
  sel.appendChild(optNone);
  for(const other of MATS){
    if(other.behavior==="void") continue;   // already represented by the Erase option above
    const opt=document.createElement("option"); opt.value=other.id; opt.textContent=other.name;
    sel.appendChild(opt);
  }
  sel.value = (m.decayTo!==undefined ? m.decayTo : EMPTY);
  sel.onchange=()=>{
    m.decayTo = +sel.value;
    markDirtyIfChanged(m.id);
    renderMatDesc(m);   // the description's "Decays into X" line needs to update live too
  };
  wrap.appendChild(sel);
}
// ---- reaction-rule editor: onContact is a {triggerId: resultId} map,
// not a single value like decayTo, so this is a variable-length list of
// rows rather than one dropdown. Object keys are inherently unique, so
// the data itself can never hold two different results for the same
// trigger material — if a tester points two rows at the same trigger,
// they collapse into one on the next render, which is the data model
// being correct (a material can't have two contradictory rules for
// touching the same neighbor), not a bug to guard against separately.
// Same appliesTo as Decays Into and the Decay slider: void/generator
// materials don't get this section.
/* A rule is EITHER a bare result id or {to, chance} (see materials.js).
   Reading goes through reactTo/reactChanceOf so this editor never has to
   branch on the shape; writing preserves whichever form the rule is
   already in, and only promotes bare -> object when someone actually
   sets a per-rule chance. Without this the row rendered `+rule` on an
   object, got NaN, and silently destroyed the rule on the next edit. */
function buildReactRow(m, triggerId, rule){
  const resultId = reactTo(rule);
  const row=document.createElement("div"); row.className="reactRow";
  const selTrigger=document.createElement("select");
  const selResult=document.createElement("select");
  for(const other of MATS){
    const o1=document.createElement("option"); o1.value=other.id; o1.textContent=other.name;
    if(other.id===triggerId) o1.selected=true;
    selTrigger.appendChild(o1);
    const o2=document.createElement("option"); o2.value=other.id; o2.textContent=other.name;
    if(other.id===resultId) o2.selected=true;
    selResult.appendChild(o2);
  }
  const arrow=document.createElement("span"); arrow.className="reactArrow"; arrow.textContent="→";
  const removeBtn=document.createElement("button"); removeBtn.className="reactRemove"; removeBtn.textContent="✕";
  row.appendChild(selTrigger); row.appendChild(arrow); row.appendChild(selResult); row.appendChild(removeBtn);

  selTrigger.onchange=()=>{
    const newTrigger=+selTrigger.value;
    const curResult=m.onContact[triggerId];
    delete m.onContact[triggerId];
    m.onContact[newTrigger]=curResult;
    markDirtyIfChanged(m.id);
    renderMatReacts(m);
    renderMatDesc(m);
  };
  selResult.onchange=()=>{
    const cur=m.onContact[triggerId];
    // keep the object form if it already had one — changing the RESULT
    // must not silently discard a per-rule chance
    if(cur && typeof cur==="object") cur.to=+selResult.value;
    else m.onContact[triggerId]=+selResult.value;
    markDirtyIfChanged(m.id);
    renderMatDesc(m);
  };
  removeBtn.onclick=()=>{
    delete m.onContact[triggerId];
    if(Object.keys(m.onContact).length===0) m.onContact=undefined;
    markDirtyIfChanged(m.id);
    renderMatReacts(m);
    renderMatDesc(m);
  };
  // ---- per-rule chance line ----
  const cr=document.createElement("div"); cr.className="reactChance";
  const isOwn = rule && typeof rule==="object" && rule.chance!==undefined;
  const cur = reactChanceOf(m, rule);
  const lab=document.createElement("span");
  lab.textContent = isOwn ? "chance" : "chance (inherited)";
  if(!isOwn) lab.className="inherited";
  const sl=document.createElement("input");
  sl.type="range"; sl.min=0; sl.max=1; sl.step=0.01; sl.value=cur;
  const val=document.createElement("b"); val.textContent=(+cur).toFixed(2);
  sl.oninput=()=>{
    const v=+sl.value;
    val.textContent=v.toFixed(2);
    // promote to the object form on first touch — that IS the gesture for
    // "this pairing gets its own rate rather than the material's default"
    const c=m.onContact[triggerId];
    m.onContact[triggerId] = { to: reactTo(c), chance: v };
    lab.textContent="chance"; lab.className="";
    markDirtyIfChanged(m.id);
  };
  cr.appendChild(lab); cr.appendChild(sl); cr.appendChild(val);
  row.appendChild(cr);
  return row;
}
/* Phase-change targets. Same shape as the decayTo picker — a named
   material is a <select>, not a slider — but generalised over the two
   threshold pairs so meltTo and freezeTo don't need a function each.
   Only shown when the matching THRESHOLD exists, since a target with no
   threshold is dead data that would never be read. Threshold itself is a
   PROP_SCHEMA slider in this same group. */
function renderMatPhaseTargets(m){
  const wrap=q("#matPanelPhase"); wrap.innerHTML="";
  const pairs=[
    { pt:"meltPoint",   tt:"meltTo",   label:"Above melt point, becomes" },
    { pt:"freezePoint", tt:"freezeTo", label:"Below freeze point, becomes" },
  ];
  for(const {pt,tt,label} of pairs){
    if(m[pt]===undefined) continue;
    const lab=document.createElement("div"); lab.className="tuneGroupLabel"; lab.textContent=label;
    wrap.appendChild(lab);
    const sel=document.createElement("select");
    const optNone=document.createElement("option");
    optNone.value=EMPTY; optNone.textContent="— Erase (nothing) —";
    sel.appendChild(optNone);
    for(const other of MATS){
      if(other.behavior==="void") continue;
      const opt=document.createElement("option");
      opt.value=other.id; opt.textContent=other.name;
      sel.appendChild(opt);
    }
    sel.value = (m[tt]!==undefined ? m[tt] : EMPTY);
    sel.onchange=()=>{ m[tt]=+sel.value; markDirtyIfChanged(m.id); renderMatDesc(m); };
    wrap.appendChild(sel);
  }
}
function renderMatReacts(m){
  const wrap=q("#matPanelReacts"); wrap.innerHTML="";
  const applies = m.behavior!=="void" && m.behavior!=="generator";
  if(!applies) return;
  const label=document.createElement("div"); label.className="tuneGroupLabel"; label.textContent="Reacts with";
  wrap.appendChild(label);
  const entries = m.onContact ? Object.entries(m.onContact) : [];
  for(const [triggerId,rule] of entries) wrap.appendChild(buildReactRow(m, +triggerId, rule));
  const addBtn=document.createElement("button"); addBtn.id="matReactsAdd"; addBtn.textContent="+ Add reaction";
  addBtn.onclick=()=>{
    if(!m.onContact) m.onContact={};
    m.onContact[EMPTY]=EMPTY;   // safe, immediately-visible default: "touching void, becomes void" — pick real values right away
    markDirtyIfChanged(m.id);
    renderMatReacts(m);
    renderMatDesc(m);
  };
  wrap.appendChild(addBtn);
}
// ---- flammable / radiates-heat editors: ignitionTemp and heatOutput
// are simple optional scalars (unlike onContact's map), but they still
// need to be CREATABLE from scratch on any material — unlike reactChance/
// emitsChance in PROP_SCHEMA (which only ever adjust a field that's
// already there), you need to be able to make an arbitrary material
// flammable to actually test it. Same on/off-then-slider shape as each
// other, factored into one helper rather than duplicated twice.
// STAGED-VALUE PATTERN. The slider now shows even while the toggle is
// off, so you can dial in a value BEFORE committing to creating the
// field — you couldn't preview anything before; flipping the toggle
// blind snapped straight to opts.default. The preview value can't live
// on m[field] itself, since m[field]!==undefined is literally what the
// engine reads to decide "this material ignites/radiates" — touching a
// preview slider would silently make an inert material flammable as a
// side effect of just looking at it. So it lives in a separate scratch
// property, `_staged_<field>`, that isn't a real material field at all.
// Two things guard that boundary: raw-data display and Export ALL both
// explicitly skip any key starting with `_staged_` (search this file for
// that prefix), and resetMaterial() already deletes every key on a
// material before reapplying its snapshot, so a stale staged value can't
// survive a Reset either.
// Toggling off doesn't discard the dialed-in number — it moves the
// current value INTO the staged slot, so switching a field off and back
// on returns you to what you had, not back to opts.default every time.
function buildScalarToggleEditor(m, field, opts){
  const wrap=q(opts.wrapId); wrap.innerHTML="";
  const applies = m.behavior!=="void" && m.behavior!=="generator";
  if(!applies) return;
  const stagedKey = "_staged_"+field;
  const label=document.createElement("div"); label.className="tuneGroupLabel"; label.textContent=opts.groupLabel;
  wrap.appendChild(label);
  const row=document.createElement("div"); row.className="toggleRow";
  const lbl=document.createElement("span"); lbl.textContent=opts.toggleLabel; lbl.style.paddingRight="8px";
  const btn=document.createElement("button");
  const on = m[field]!==undefined;
  btn.textContent = on ? "On" : "Off";
  btn.classList.toggle("on", on);
  btn.onclick=()=>{
    if(m[field]!==undefined){
      m[stagedKey] = m[field];   // preserve for next time, don't lose the dialed-in number
      m[field] = undefined;
    } else {
      m[field] = m[stagedKey]!==undefined ? m[stagedKey] : opts.default;
    }
    markDirtyIfChanged(m.id);
    buildScalarToggleEditor(m, field, opts);
    renderMatDesc(m);
  };
  row.appendChild(lbl); row.appendChild(btn);
  wrap.appendChild(row);
  const curVal = m[field]!==undefined ? m[field] : (m[stagedKey]!==undefined ? m[stagedKey] : opts.default);
  const sliderRow=document.createElement("div");
  sliderRow.className = "propRow" + (on ? "" : " staged");
  sliderRow.innerHTML = `<div class="propLabel"><span>${opts.sliderLabel}${on?"":" (preview)"}</span><b>${curVal}</b></div>
    <div class="propControls">
      <input type="range" min="0" max="99" step="1" value="${curVal}">
      <input type="number" min="0" max="99" step="1" value="${curVal}">
    </div>`;
  const range=sliderRow.querySelector('input[type=range]'), num=sliderRow.querySelector('input[type=number]'), b=sliderRow.querySelector('b');
  const apply=v=>{
    const n=Math.max(0, Math.min(99, parseFloat(v)||0));
    if(m[field]!==undefined) m[field]=n; else m[stagedKey]=n;
    range.value=n; num.value=n; b.textContent=n;
    markDirtyIfChanged(m.id);
    renderMatDesc(m);
  };
  range.oninput=e=>apply(e.target.value);
  num.oninput=e=>apply(e.target.value);
  wrap.appendChild(sliderRow);
}
const IGNITION_DEFAULT = 50;   // my pick — matches Oil's own value, a reasonable starting point for any new flammable test material
function renderMatFlammable(m){
  buildScalarToggleEditor(m, "ignitionTemp", {
    wrapId:"#matPanelFlammable", groupLabel:"Flammable",
    toggleLabel:"Catches fire", sliderLabel:"Ignition temp", default:IGNITION_DEFAULT });
}
const HEAT_OUTPUT_DEFAULT = 85;   // my pick — matches Fire's own value
function renderMatHeatOutput(m){
  buildScalarToggleEditor(m, "heatOutput", {
    wrapId:"#matPanelHeatOutput", groupLabel:"Radiates heat",
    toggleLabel:"Self-heats while present", sliderLabel:"Heat output", default:HEAT_OUTPUT_DEFAULT });
}
function buildPropRow(p, m){
  const applies = !p.appliesTo || p.appliesTo(m);
  const dflt = p.default ?? 0;
  const raw = propGet(p,m);
  const row=document.createElement("div");
  row.className="propRow"+(applies?"":" disabled");
  const val = applies ? (raw ?? dflt) : (raw===Infinity ? "∞" : (raw ?? "—"));
  row.innerHTML = `<div class="propLabel"><span>${p.label}</span><b>${typeof val==="number"?val:val}</b></div>
    <div class="propControls">
      <input type="range" min="${p.min}" max="${p.max}" step="${p.step}" value="${applies?(raw??dflt):0}" ${applies?"":"disabled"}>
      <input type="number" min="${p.min}" max="${p.max}" step="${p.step}" value="${applies?(raw??dflt):0}" ${applies?"":"disabled"}>
    </div>`;
  if(!applies){
    const note=document.createElement("div"); note.className="propNote";
    note.textContent = m.dens===Infinity && p.key==="dens" ? "Infinite (solid) — not editable" : "Not applicable to this material's behavior";
    row.appendChild(note);
  } else {
    const range=row.querySelector('input[type=range]'), num=row.querySelector('input[type=number]'), b=row.querySelector('b');
    const apply=v=>{
      const n=Math.max(p.min, Math.min(p.max, parseFloat(v)||0));
      propSet(p,m,n); range.value=n; num.value=n; b.textContent=n;
      markDirtyIfChanged(m.id);
      renderMatDesc(m);   // decay/reactChance/emitsChance numbers shown in the description above need to stay live, not just the slider's own row
    };
    range.oninput=e=>apply(e.target.value);
    num.oninput=e=>apply(e.target.value);
  }
  return row;
}
function buildToggleRow(t, m){
  const row=document.createElement("div"); row.className="toggleRow";
  const label=document.createElement("span"); label.textContent=t.label; label.style.paddingRight="8px";
  const btn=document.createElement("button");
  btn.textContent = m[t.key] ? "On" : "Off";
  btn.classList.toggle("on", !!m[t.key]);
  btn.onclick=()=>{ m[t.key]=!m[t.key]; btn.textContent=m[t.key]?"On":"Off"; btn.classList.toggle("on", !!m[t.key]); markDirtyIfChanged(m.id); };
  row.appendChild(label); row.appendChild(btn);
  return row;
}
// ---- material panel groups: same visual language as the global Tuning
// sheet (tuneGroupLabel header + arrow), but a separate class pair
// (matGroup/matGroupBody, see CSS) since this panel's content is far
// more varied than the Tuning sheet's uniform propRow-only rows — a
// group here can hold selects, buttons, a raw text dump, not just
// sliders. "custom" entries are the standalone renderers that already
// existed (decayTo/reacts/flammable/heatOutput/color/raw) — each gets a
// freshly-created leaf div with its expected id, then its own unchanged
// render function populates it, same as before this refactor.
// Rebuilt from scratch on every syncMatPanel() call (material switch or
// reset) — same granularity the rest of this panel already rebuilds at,
// not on every slider drag. matGroupCollapsed persists across those
// rebuilds so open/closed state survives switching materials, same
// pattern tuneCollapsed uses for the Tuning sheet. Starts with every key
// present — default CLOSED, per Crash's call.
const MAT_GROUP_DEFS = [
  { key:"physical", label:"Physical", props:["dens","sh","conductivity"], bools:["needsLateralSupport"] },
  { key:"movement", label:"Movement", props:["visc","cohesion","growChance","climbBias"] },
  { key:"reactions", label:"Decay & Reactions", props:["decay","reactChance","emitsChance"],
    custom:[ {id:"matPanelDecayTo", render:renderMatDecayTo}, {id:"matPanelReacts", render:renderMatReacts} ] },
  // New group: everything temperature-driven that isn't combustion.
  // heatCapacity applies to every material, so this group always renders;
  // the thresholds and chill rows only appear where those fields exist.
  { key:"thermal", label:"Temperature & Phase",
    props:["heatCapacity","chillOutput","meltPoint","freezePoint"],
    custom:[ {id:"matPanelPhase", render:renderMatPhaseTargets} ] },
  { key:"combustion", label:"Combustion",
    custom:[ {id:"matPanelFlammable", render:renderMatFlammable}, {id:"matPanelHeatOutput", render:renderMatHeatOutput} ] },
  { key:"appearance", label:"Appearance", bools:["em","rainbow"],
    custom:[ {id:"matPanelColor", render:renderMatColor} ] },
  { key:"raw", label:"Raw data (read-only)",
    custom:[ {id:"matPanelRaw", render:renderMatRaw} ] },
];
const matGroupCollapsed = new Set(MAT_GROUP_DEFS.map(g=>g.key));
function buildMatGroups(m){
  const root=q("#matPanelGroups"); root.innerHTML="";
  for(const g of MAT_GROUP_DEFS){
    const props = (g.props||[]).map(k=>PROP_SCHEMA.find(p=>p.key===k)).filter(Boolean);
    const bools = (g.bools||[]).map(k=>BOOL_SCHEMA.find(t=>t.key===k)).filter(Boolean);
    const anyPropApplies = props.some(p=>!p.appliesTo || p.appliesTo(m));
    const anyBoolApplies = bools.some(t=>!t.appliesTo || t.appliesTo(m));
    const hasCustom = !!(g.custom && g.custom.length);
    // Skip the whole group for a material where nothing in it applies at
    // all — e.g. Movement is pointless to show (and toggle open) on a
    // solid. Groups with a custom renderer stay, even if that renderer
    // ends up showing little for this material (e.g. Combustion on
    // "Erase") — same as before this refactor, just now collapsible.
    if(!anyPropApplies && !anyBoolApplies && !hasCustom) continue;

    const wrap=document.createElement("div");
    wrap.className="matGroup"+(matGroupCollapsed.has(g.key)?" collapsed":"");
    const head=document.createElement("div"); head.className="tuneGroupLabel";
    head.innerHTML = `<span>${g.label}</span><span class="arrow">▾</span>`;
    head.onclick=()=>{
      if(matGroupCollapsed.has(g.key)) matGroupCollapsed.delete(g.key); else matGroupCollapsed.add(g.key);
      wrap.classList.toggle("collapsed");
    };
    wrap.appendChild(head);
    const body=document.createElement("div"); body.className="matGroupBody";
    for(const p of props) body.appendChild(buildPropRow(p,m));
    for(const t of bools){
      if(t.appliesTo && !t.appliesTo(m)) continue;
      body.appendChild(buildToggleRow(t,m));
    }
    if(g.custom) for(const c of g.custom){
      const leaf=document.createElement("div"); leaf.id=c.id;
      body.appendChild(leaf);
    }
    wrap.appendChild(body);
    root.appendChild(wrap);
    // custom renderers do their own $(id) lookup — the leaf div only
    // just got attached to the live document via the appendChild above,
    // so this has to run after, not before.
    if(g.custom) for(const c of g.custom) c.render(m);
  }
}
function syncMatPanel(){
  const m=MATBY[currentId];
  if(!m) return;
  q("#matPanelSw").style.background = m.behavior==="void" ? "none" : m.sw;
  q("#matPanelName").value = m.name;
  q("#matPanelNameError").classList.remove("show");
  renderMatDesc(m);
  buildMatGroups(m);
  onSync(m);
}
// Rename — names are the cross-reference key for onContact/decayTo/emits/
// teslaReact/meltTo/freezeTo (both in the live in-memory MATS and in the
// table export format being built alongside this), so they must stay
// unique and non-empty or those references become ambiguous. Nothing at
// runtime caches a material's name elsewhere (renderMatHistory, swatch
// titles, describeMaterial etc. all read MATBY[id].name live), so the
// rename itself just needs three things done: write it, refresh the one
// place a name string DOES get cached (the swatch button's title attr,
// set once at creation), and mark dirty.
function renameMaterial(id, newNameRaw){
  const m=MATBY[id];
  const trimmed=newNameRaw.trim();
  const errEl=q("#matPanelNameError");
  if(!trimmed){
    errEl.textContent="Name can't be empty."; errEl.classList.add("show");
    q("#matPanelName").value=m.name;
    return;
  }
  const dup=MATS.find(x=>x.id!==id && x.name.toLowerCase()===trimmed.toLowerCase());
  if(dup){
    errEl.textContent=`"${trimmed}" is already used by another material.`; errEl.classList.add("show");
    q("#matPanelName").value=m.name;
    return;
  }
  errEl.classList.remove("show");
  if(trimmed===m.name) return;
  m.name=trimmed;
  markDirtyIfChanged(id);
  onRenamed(id, trimmed);
}
function resetMaterial(id){
  const orig=ORIGINAL_MATS[id];
  const live=MATBY[id];
  // Object.assign alone only overwrites keys present in orig — it can't
  // remove a key (e.g. onContact, decayTo) that a tester added via the
  // panel on a material that didn't have one originally. Clear first,
  // then reapply, so Reset is an actual reset, not a merge.
  for(const k of Object.keys(live)) delete live[k];
  Object.assign(live, JSON.parse(JSON.stringify(orig)));
  dirtyMats.delete(id);
  onDirtyChanged(id, false);
  onRenamed(id, live.name);
  onSwatchChanged(id, live);
  resyncTwinAppearance(id);
  syncMatPanel();
}

/* ---- panel markup. Owned here rather than assumed to exist in the host's
   HTML: the bench had these 16 lines inline, the game has none of it, and
   a shared module that requires each host to hand-copy matching markup is
   a drift bug waiting to happen. `showClose` is off for the game, whose
   sheet chrome already provides a close affordance. ---- */
const PANEL_HTML = showClose => `
  <div id="matPanelHead">
    <div class="sw" id="matPanelSw"></div>
    <input type="text" id="matPanelName" maxlength="40" spellcheck="false" autocomplete="off">
    ${showClose ? '<button id="matPanelClose">✕</button>' : ''}
  </div>
  <div id="matPanelNameError"></div>
  <div id="matPanelDesc"></div>
  <div id="matPanelGroups"></div>
  <div class="matActions">
    <button id="matReset">Reset this</button>
    <button id="matResetAll" class="danger">Reset all</button>
  </div>`;

/* ---- CSS. ui-tuning.js's injectTuningSheetCSS() already ships the shared
   row chrome (.propRow/.propLabel/.propControls/.tuneGroupLabel/.tuneGroup)
   to both hosts, so this is only the material-editor delta on top of it:
   the panel's own head/name/desc/raw blocks, reaction rows, collapsible
   material groups, and the disabled/staged row states. Idempotent, same as
   its counterpart. var() fallbacks are present because the game's palette
   variables are named the same but this shouldn't hard-depend on that. ---- */
let cssInjected=false;
export function injectMatLabCSS(){
  if(cssInjected) return;
  cssInjected=true;
  const css=`
#matPanelHead{ display:flex; align-items:center; gap:8px; margin-bottom:10px; }
#matPanelHead .sw{ width:28px; height:28px; border-radius:6px; border:1px solid var(--line,#2a2140); }
#matPanelName{ font-size:14px; font-weight:normal; flex:1 1 auto; min-width:0;
  background:none; border:1px solid transparent; color:var(--ink,#efe9f7); font-family:inherit;
  padding:4px 6px; border-radius:6px; }
#matPanelName:focus{ border-color:var(--line,#2a2140); background:var(--void,#0a0714); outline:none; }
#matPanelNameError{ font-size:9px; color:#E86F9E; margin:-6px 2px 8px; display:none; }
#matPanelNameError.show{ display:block; }
#matPanelDesc{ font-size:11px; color:var(--dim,#8b7fa8); line-height:1.5;
  margin-bottom:12px; padding-bottom:10px; border-bottom:1px solid var(--line,#2a2140); }
#matPanelDesc div{ margin-bottom:3px; }
#matPanelDesc div:last-child{ margin-bottom:0; }
#matPanelDesc b{ color:var(--ink,#efe9f7); font-weight:normal; }
#matPanelRaw{ font-size:10px; color:var(--dim,#8b7fa8); line-height:1.6; font-family:monospace;
  margin:6px 0 10px; padding:8px; background:rgba(0,0,0,0.15); border-radius:6px;
  max-height:160px; overflow-y:auto; }
#matPanelRaw .rawKey{ color:var(--gold,#E8C46F); }
#matPanelDecayTo select{ width:100%; padding:6px; background:var(--panel,#171227); color:var(--ink,#efe9f7);
  border:1px solid var(--line,#2a2140); border-radius:6px; font-size:12px; }
#matPanelReacts{ margin-bottom:10px; }
.reactRow{ display:flex; flex-wrap:wrap; align-items:center; gap:6px; margin-bottom:10px; }
.reactRow select{ flex:1 1 auto; min-width:0; padding:6px; background:var(--panel,#171227);
  color:var(--ink,#efe9f7); border:1px solid var(--line,#2a2140); border-radius:6px; font-size:12px; }
.reactChance{ display:flex; align-items:center; gap:6px; width:100%; font-size:11px;
  color:var(--dim,#8b7fa8); }
.reactChance input[type=range]{ flex:1 1 auto; accent-color:var(--gold,#E8C46F); }
.reactChance .inherited{ opacity:.55; font-style:italic; }
.matGroup.collapsed .matGroupBody{ display:none; }
.matGroup.collapsed .tuneGroupLabel .arrow{ transform:rotate(-90deg); }
.propRow.disabled{ opacity:0.35; pointer-events:none; }
.propRow.staged{ opacity:0.6; }
.propRow input[type=checkbox]{ width:20px; height:20px; accent-color:var(--gold,#E8C46F); cursor:pointer; }
.propNote{ font-size:9px; color:var(--dim,#8b7fa8); margin-top:2px; }
.toggleRow{ display:flex; justify-content:space-between; align-items:center;
  gap:8px; font-size:11px; color:var(--dim,#8b7fa8); padding:8px 2px;
  border-top:1px solid var(--line,#2a2140); }
.toggleRow:first-of-type{ border-top:none; }
.matActions{ display:flex; gap:6px; margin-top:12px; flex-wrap:wrap; }
.matActions button{ flex:1 1 auto; font-size:11px; padding:8px; }
/* Edited-material marker. The bench styles this itself on its swatch row
   (.sw.edited, gold inset ring); the game had no rule at all, so the
   onDirtyChanged hook was toggling a class that rendered nothing —
   "which materials have I changed?" was unanswerable there. Scoped to
   .mat so it can't collide with the bench's own .sw rule. */
.mat.edited{ box-shadow:0 0 0 2px var(--gold,#E8C46F) inset; }
.mat.edited .sw{ box-shadow:0 0 0 2px var(--gold,#E8C46F) inset; }
#matReactsAdd{ font-size:11px; padding:8px; }`;
  const style=document.createElement("style");
  style.setAttribute("data-matlab-css","1");
  style.textContent=css;
  document.head.appendChild(style);
}

/* Mount the editor into `container`. Returns the small API a host needs;
   everything else stays private. Call once. */
export function mountMatLab(container, opts={}){
  root = container;
  const showClose = opts.showClose !== false;
  if(opts.injectCSS !== false) injectMatLabCSS();
  root.innerHTML = PANEL_HTML(showClose);

  q("#matPanelName").addEventListener("blur", ()=>renameMaterial(currentId, q("#matPanelName").value));
  q("#matPanelName").addEventListener("keydown", e=>{ if(e.key==="Enter") q("#matPanelName").blur(); });
  q("#matReset").onclick=()=>resetMaterial(currentId);
  q("#matResetAll").onclick=()=>{ [...dirtyMats].forEach(id=>resetMaterial(id)); syncMatPanel(); };
  if(showClose && opts.onClose) q("#matPanelClose").onclick=opts.onClose;

  if(opts.initialMat!==undefined && opts.initialMat!==null) setMaterial(opts.initialMat);
  return { setMaterial, sync: syncMatPanel, getMaterial: ()=>currentId };
}

/* Point the panel at a material and redraw. Safe to call whether or not
   the panel is currently visible — the host decides visibility. */
export function setMaterial(id){
  currentId = id;
  if(root) syncMatPanel();
}

export { syncMatPanel, markDirtyIfChanged, resetMaterial, renameMaterial, nameOf,
         describeMaterial, formatOnContact, resyncTwinAppearance,
         // Read by the bench's plain-text "Export changes" diff, which
         // stayed behind — it walks the same schemas the panel edits so
         // the two can't disagree about what counts as a property.
         PROP_SCHEMA, BOOL_SCHEMA, propGet };
