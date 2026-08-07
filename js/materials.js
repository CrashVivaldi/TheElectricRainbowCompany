"use strict";
/* ZODIAC DRIFT 0.16 — modular split, Phase 1.
   MATERIAL REGISTRY — the single source of truth. Every material is one
   entry here. The sim, the renderer, and the palette UI all read from
   this — nothing about a material lives anywhere else. To add a new
   material: add an entry, as long as its `behavior` already exists in
   physics.js's BEHAVIORS table.

   id       — stable numeric id, assigned automatically from array order
   name     — display name
   sw       — swatch color for UI (also used as base render color)
   rgb      — [r,g,b] render color (defaults to swatch if omitted)
   em       — emissive? (contributes to the glow pass)
   sh       — per-pixel shimmer amount (render-only dither, 0 = flat)
   dens     — density. Higher sinks through lower. Solids use Infinity.
   behavior — 'void' | 'solid' | 'powder' | 'powder-settle' | 'liquid' |
              'pressured' | 'gas' | 'diffuse' | 'grow' | 'creep'
              liquid    = lazy: falls, seeps sideways one cell at a time
              pressured = spring-fed feel: disperses fast, levels quickly
              grow      = DUPLICATES upward into empty space, deflecting
                          sideways when blocked — see growChance. Never
                          removes its own source cell (a vine doesn't
                          un-grow its base).
              creep     = hugs solid surfaces instead of falling freely —
                          see climbBias. Falls via plain gravity if not
                          touching any surface at all.
   decay    — optional. Per-tick chance the cell fades away.
   decayTo  — optional. Material id to fade INTO instead of EMPTY. Only
              meaningful alongside `decay`.
   onContact— optional. { otherMatId: rule, ... } — touching that
              neighbor converts THIS cell only. The neighbor is never
              touched — self-converts only, by design.
              A `rule` is EITHER a bare result id (uses this material's
              own reactChance) OR { to:resultId, chance:0..1 } to give
              that ONE pairing its own rate. Mixing forms in the same
              table is fine. Use reactTo()/reactChanceOf() to read them —
              never index a rule directly, it may be either shape.
   reactChance — optional, 0..1. Default rate for any onContact entry
              written in the bare form. Defaults to 1 (instant) if
              onContact is set but this isn't — set this on any reactive
              material or it'll pop across a whole boundary in one tick.
   emits    — optional. { matId, chance } — per tick, that chance to place
              matId in a random empty orthogonal neighbor. Independent of
              decay/react/movement; doesn't consume the source cell.
   growChance — optional, 0..1 per tick. Only meaningful for behavior:'grow'.
              Defaults to 0.02 if unset.
   climbBias — optional, -1..+1. Only meaningful for behavior:'creep'.
              Negative favors downward steps, positive favors upward
              (climbing), 0 (default) is neutral.
   visc     — optional, 0..1. Per-tick chance a movement-capable material
              (anything with a step() behavior fn) actually attempts to
              move at all this tick. Defaults to 1 (always) if unset.
              For behavior:'liquid' this is the BULK/interior rate only —
              see cohesion below for how surface cells differ.
   cohesion — optional, 0..1. Only meaningful for behavior:'liquid'.
              Defaults to 0.6 if unset. Boosts a liquid cell's effective
              move chance toward 1 when it has fewer than 3 same-material
              orthogonal neighbors (i.e. it's on the liquid's own
              surface/edge rather than deep interior) — keeps a slow/
              thick liquid's surface reading as smooth rather than
              crumbling into desynced grains at low visc. 0 disables this
              and falls back to plain visc everywhere.
   -- temperature (DATA ONLY as of this pass — no diffusion tick or
      render code interprets any of these yet; see state.js's `temp`
      array. All optional, all unitless (not literal °C/°F), all on the
      same scale where 0 is intended as the eventual floor and
      SPAWN_TEMP_DEFAULT (state.js, currently 20) is ordinary ambient. --
   conductivity — optional, 0..1. How readily heat will move through this
              material once a diffusion pass exists. Not yet consumed by
              any code — pure schema right now.
   spawnTemp — optional. Starting temperature for a freshly-painted or
              generator-spawned cell of this material. Not yet consumed
              by paint/spawn code — pure schema right now; the world's
              `temp` array is uniformly SPAWN_TEMP_DEFAULT until this is
              wired in.
   meltPoint / meltTo, freezePoint / freezeTo — optional. LIVE now (see
              physics.js's diffuseTemp copy-back pass), no longer
              reserved schema. Despite the names these are just an upper
              and a lower threshold: at temp >= meltPoint the cell
              becomes meltTo; at temp <= freezePoint it becomes freezeTo.
              Water's upper threshold is a boil, Sand's is glass,
              Clay's is a kiln — "melt" is only the shortest word for the
              general case. Omitting the *To half converts to EMPTY.
              This replaces the hand-wired Snow/Magma and Magma/Water
              onContact pairs, which are GONE — quenching lava with water
              is emergent conduction now, not a special case.
              KEEP EVERY THRESHOLD OUTSIDE THE AMBIENT BAND (~14..26).
              AMBIENT_PULL_RATE drags every cell toward 20 forever, so a
              threshold inside that band fires spontaneously everywhere
              with no heat source involved. Respecting that is what makes
              the Ambient Temperature slider work as a climate dial.
   ignitionTemp — optional. A material carrying this converts to Fire
              (physics.js, MATS name "Fire") once its temp crosses this
              value — checked in diffuseTemp's per-cell loop. This is the
              RADIANT ignition path (no literal Fire cell needs to be
              touching); direct-contact ignition is just an ordinary
              onContact rule pointed at Fire, same as any other reaction.
   heatOutput — optional. Read by physics.js's applyCombustionHeat() each
              tick as a FLOOR (Math.max) on that cell's own temp — what
              lets a burning cell keep radiating real heat outward via
              diffuseTemp instead of just holding whatever temp it
              inherited from its fuel and cooling immediately. Currently
              only Fire sets this, but nothing ties it to a specific
              material — any future material can use it the same way.
   chillOutput — optional. The cold mirror of heatOutput, read by the same
              applyCombustionHeat() pass. A material carrying this pulls
              its own cell back down toward that temp each tick, which is
              what lets Snow/Rimestone/Aetherfrost stay cold against the
              ambient thermostat and therefore actually chill their
              neighbours. Note it is a PULL, not the hard floor heatOutput
              uses — a hard ceiling would make a cold material unmeltable
              (its own clamp would undo any incoming heat before its
              meltPoint could ever be crossed). See the long comment in
              physics.js's applyCombustionHeat for the full reasoning. */
import { inB, idx, grid, skeletonMask } from "./state.js";

/* ---- reaction-rule normalizers. An onContact entry is either a bare
   result id or a {to, chance} object (see the schema note at the top).
   These two functions are the ONLY place that difference is resolved —
   physics.js's reactAt and the Sandbox's rule editor both read through
   them, so neither has to know or care which form a given rule uses, and
   a third consumer later gets it right for free. Never index an
   onContact entry directly. */
export const reactTo = rule => (rule && typeof rule==="object") ? rule.to : rule;
export const reactChanceOf = (M, rule) =>
  (rule && typeof rule==="object" && rule.chance!==undefined)
    ? rule.chance
    : (M.reactChance!==undefined ? M.reactChance : 1);

/* ====== ALCHEMY TABLE SYSTEM ======
   Ten materials + void are pinned identically across EVERY table,
   default or custom — see index.html's buildTableExport/loadCustomTable
   flow. They are never serialized into a table file and never
   overridable by one: a table's own `materials` array only ever holds
   up to MAX_CUSTOM_MATERIALS genuinely new/custom entries, resolved
   and appended after these 10 are injected verbatim from the default
   definitions below. Positions 0-10 are always void + these 10, in
   this exact order, in every table that has ever existed or ever will.
   Order here is deliberate — it's the actual id assignment order. */
export const CORE_MATERIAL_NAMES = ["Erase","Stone","Water","Sand","Dirt","Snow","Oil","Magma","Smoke","Steam","Fire"];
export const MAX_CUSTOM_MATERIALS = 40;
export const CUSTOM_TABLE_STORAGE_KEY = "zodiacdrift_customTable";

// ---- shallow clone that preserves Infinity (Stone/Sand's `dens`, etc.)
// — the common JSON.parse(JSON.stringify(x)) deep-clone trick silently
// turns Infinity into null, which would corrupt exactly the fields that
// matter most here. Only handles the shapes a material actually has:
// flat scalars, one nested rgb array, one nested onContact object whose
// values may themselves be {to,chance,settled} objects, one nested
// emits object. Good enough for this file; not a generic deep-clone.
function cloneMaterial(m){
  const out={ ...m };
  if(m.rgb) out.rgb=[...m.rgb];
  if(m.emits) out.emits={ ...m.emits };
  if(m.onContact){
    out.onContact={};
    for(const k of Object.keys(m.onContact)){
      const r=m.onContact[k];
      out.onContact[k] = (r && typeof r==="object") ? { ...r } : r;
    }
  }
  return out;
}

function buildDefaultMats(){
  const MATS=[
 {name:"Erase",     sw:"#0D0A14", rgb:[13,10,20],    em:false, sh:0,  dens:0,        behavior:"void"},
 // ---- ROCK. The whole bedrock family shares one upper threshold (95 ->
 // Magma) so ANY stone can be melted, not just the one called Stone. 95
 // is deliberately near the ceiling: unreachable by conduction alone (see
 // the calibration note at the bottom of this file), so it takes a real
 // sustained blaze or a magma bath. Stone should not melt casually.
 {name:"Stone",     sw:"#4A4258", rgb:[74,66,88],    em:false, emAmt:0.08, sh:4,  dens:Infinity, behavior:"solid", noOverwrite:true,
   conductivity:0.15, spawnTemp:20, heatCapacity:4, meltPoint:88 /* meltTo patched below -> Magma */},
// ---- ELECTRIC RAINBOW MAGIC FORK — dedicated material for the text-
// collider ledges (sand-bg.js's applyDomColliders), kept separate from
// Stone specifically so the floor keeps its own visible color while
// these blend invisibly into the void. rgb matches render.js's actual
// void fill (13,10,20) exactly — not the CSS --void hex (#0A0714,
// which is (10,7,20), close but NOT identical) — so there's no visible
// seam against everything else the renderer already paints as void.
// sh:0 (no shimmer/dither) for the same reason: a static, perfectly
// flat void-colored block that's supposed to read as "nothing here."
 {name:"Voidstone", sw:"#0D0A14", rgb:[13,10,20],    em:false, sh:0,  dens:Infinity, behavior:"solid", noOverwrite:true,
   conductivity:0.15, spawnTemp:20, heatCapacity:4},
 // ---- WATER. Both thresholds live: freezes to Snow at 10, boils to
 // Steam at 82. Together with Steam's own condensation threshold this is
 // a closed water cycle, no hand-wired pairs anywhere in it.
 {name:"Water", sw:"#3E9EDF", rgb:[62,158,223],  em:true,  sh:26, dens:20,       behavior:"pressured",
   conductivity:0.8, spawnTemp:18, heatCapacity:2 /* water's real signature property: it takes a lot to move it. 2 rather than 3 so it can still reach its boil threshold before a lava pool exhausts itself */,
   freezePoint:12, /* freezeTo patched below -> Snow. 12 not 10: a cell needs ~3 chilled neighbours to get here, so a snowbank freezes a pool and a stray flake does not */
   meltPoint:46    /* meltTo patched below -> Steam. MEASURED, not guessed: a headless run puts the peak temperature of water at a lava interface at ~53, because the water is mixing and the lava is cooling the whole time. Every earlier value here (82, then 62, then 50) produced no steam or a single cell. Swept: 50->1 concurrent steam cell, 48->3, 46->6, 44->8, 42->6. 46 gives a visible hiss along a lava contact line without flashing the whole pool off. "melt" is the schema's word for the UPPER threshold generally; this one is a boil */},
 {name:"Sand",      sw:"#EAEAB5", rgb:[234,234,181], em:false, emAmt:0.20, sh:4,  dens:30,       behavior:"powder-settle", needsLateralSupport:true,
   conductivity:0.35 /* raised from 0.20: at 0.20 sand adjacent to magma equilibrates around 41 and could never vitrify at any threshold worth having */,
   spawnTemp:20, meltPoint:46 /* meltTo patched below -> Crystal. GLASS. 46 because magma is DENSER than sand (40 vs 30), so sand floats on a flow and never gets more than about one contact face — measured hottest sand cell on a lava bath was 48.7. Every higher value produced no glass at all */},
 // ---- DIRT. The hinge of the regrowth cycle, and the reason Ash needed
 // a second act: forest burns -> Fire -> Ember -> Ash -> rain falls on ash
 // -> Dirt -> a spore drifting from an existing Skyvine lands and
 // germinates on it -> forest. Dirt is fertile SOIL, not a spore source —
 // it used to spontaneously emit Bloomspore on its own (bare dirt growing
 // plants with no plant life anywhere nearby), which was the bug. Now the
 // loop needs a live Skyvine somewhere to seed it; Dirt just makes
 // whatever lands on it germinate reliably (see Bloomspore's onContact).
 {name:"Dirt",      sw:"#5A4330", rgb:[90,67,48],    em:false, emAmt:0.15, sh:7,  dens:28, behavior:"powder-settle", needsLateralSupport:true,
   conductivity:0.22, spawnTemp:20},
 // ---- SNOW. Its old onContact{Magma:Water} pair is GONE — that rule
 // was temperature wearing a costume, and temperature does it properly
 // now (and against ANY heat source, not just literal magma).
 //   Retuned this session (Crash, live in the sandbox, promoted to
 // default): conductivity 0.3->0.81 and meltPoint 28->20. The old pair
 // made contact-melting mathematically impossible even fully engulfed by
 // 90-degree Magma on all 4 sides (worked out the steady-state math —
 // topped out ~21.5, short of 28) once CHILL_PULL got rebalanced this
 // same session. Higher conductivity lets Snow actually accept the heat
 // it's touching instead of mostly resisting it; meltPoint 20 (== ambient)
 // means real contact heat still clears it (single-face contact with
 // 90-degree Magma now settles ~35, comfortably above) while an isolated
 // or merely-ambient-adjacent cell still sits stable in the 5-6 range,
 // well under threshold — chillOutput/CHILL_PULL still hold it there at
 // rest, this only changed how it behaves once something hot is touching.
 {name:"Snow",      sw:"#CFEFFF", rgb:[207,239,255], em:true,  sh:28, dens:10, behavior:"powder", decay:0.000012,
   conductivity:0.81, spawnTemp:2, heatCapacity:5, chillOutput:4, meltPoint:20 /* meltTo patched below -> Water */},
 // ---- OIL. First beneficiary of per-reaction rates: its old single
 // reactChance of 0.2 had to cover both its rules at once, which the last
 // handoff flagged as unfixable. Now it catches lazily off an ember,
 // readily off open flame, and instantly off magma. Its old Magma->Smoke
 // rule is gone — oil hitting lava should IGNITE, not politely evaporate.
 {name:"Oil",       sw:"#690C8A", rgb:[105,12,138],  em:true,  sh:30, dens:7,  behavior:"liquid",
   cohesion:0.7, conductivity:0.12, spawnTemp:20, ignitionTemp:50},
 // ---- MAGMA. SWAPPED again this session: Magma is now the INERT one,
 //   Lava (at the end of this file) is the self-heater. Reasoning: the
 //   "safer"/more common material should sit at Magma's position (id 7,
 //   part of the finalized 0-45 core order); the dangerous, permanently-
 //   molten one is the deliberately-late addition, same logic as why
 //   Lava got tacked on at the end in the first place.
 //   No heatOutput here at all — ordinary conduction/ambient cooling,
 //   freezes to Stone via freezePoint like every other rock always has.
 //   The "heatOutput:1 melted Stone" mystery from earlier THIS SESSION
 //   is resolved, not just flagged — see Lava's own comment at the
 //   bottom of this file for the full root cause (a since-removed
 //   radiant-heat mechanism) and the fix (a hard pin plus removing that
 //   mechanism entirely). Not an open question anymore.
 {name:"Magma",     sw:"#E03614", rgb:[224,54,20],   em:true,  sh:24, dens:40, behavior:"pressured",
   conductivity:0.55, spawnTemp:90, heatCapacity:14 /* the number that makes lava behave like lava — see capOf() in physics.js */,
   freezePoint:30 /* freezeTo patched below -> Stone */},
 {name:"Smoke",     sw:"#8D8FA1", rgb:[141,143,161], em:false, sh:16, dens:4, behavior:"gas",
   decay:0.01, /* decayTo patched below -> Ash */
   conductivity:0.10, spawnTemp:55},
 // ================= NEW MATERIALS =================
 // Appended at the END of the base array on purpose: every pre-existing
 // base id keeps its value, so only the auto-generated twins downstream
 // shift. Never insert into the middle of this array (see the id-space
 // note further down).
 //
 // ---- STEAM. The missing half of the water cycle. Boiled off Water
 // at 82, condenses back below 40. Note it does NOT get its spawnTemp on
 // conversion — a phase change is a conversion, not an introduction, so
 // steam carries the 82+ it boiled at and cools from there, which is what
 // gives it a natural lifetime instead of needing a decay rate.
 {name:"Steam",     sw:"#C9DCE8", rgb:[201,220,232], em:true,  sh:22, dens:2,  behavior:"gas",
   conductivity:0.30, heatCapacity:0.10 /* LOW on purpose, and load-bearing: trySwap deletes anything that leaves the top of the world, and gas climbs several cells per tick, so steam that cools at the default rate simply escapes before it can ever condense. The sweep noted here previously (0.35->0%, 0.25->18%, 0.15->64%, 0.08->92% water recovered) was measured against freezePoint:34 — since retuned to freezePoint:21 (see below), which sits only 1 above ambient and is deep in the tail of the cooling curve, so those percentages no longer apply as-measured; Crash tested 21 live in the sandbox and confirmed by feel it's the balance he wants, not re-swept numerically */,
   spawnTemp:90, freezePoint:21 /* freezeTo patched below -> Water */},
 // Fire now decays into Ember rather than straight to Ash, giving
 // combustion a three-stage tail: flame -> coals -> ash.
 {name:"Fire",      sw:"#FF7A1A", rgb:[255,122,26],  em:true,  sh:22, dens:3,  behavior:"fire",
   visc:0.15, decay:0.02,
   conductivity:0.35, spawnTemp:85, heatOutput:85},
 // Clay fires into Stone in a kiln. Cheap, legible, and it gives Clay
 // something to be besides a color — plus Ash+Water now MAKES clay-
 // adjacent material (Dirt), so there's a full mud-to-ceramic path.
 {name:"Clay",      sw:"#B06A48", rgb:[176,106,72],  em:false, sh:6,  dens:Infinity, behavior:"solid",
   conductivity:0.20, spawnTemp:20, meltPoint:56 /* meltTo patched below -> Stone (fired). Needs ~3 contact faces: you have to build a kiln around it, which is the correct amount of effort */},
 // ---- bedrock family — visual/terrain variety for the generator (see
 // terrain.js's GEN_BEDROCK_*). Still mechanically near-identical to
 // Stone, but no longer *identical*: Mossrock seeds the flora cycle.
 {name:"Slate",     sw:"#332E3D", rgb:[51,46,61],    em:false, sh:2,  dens:Infinity, behavior:"solid",
   conductivity:0.18, spawnTemp:20, meltPoint:88},
 // ---- GEMSTONES (Ruby/Sapphire) + Glass. All three use the new
 // `translucent` flag, which render.js bakes as a frosted blend toward a
 // light neutral — NOT real see-through alpha (see makeTranslucentTile).
 // Terminal like Crystal: no melt/freeze thresholds, nothing converts
 // them. Stats here are first-pass guesses for tuning, not tuned values.
 {name:"Ruby",      sw:"#C41E3A", rgb:[196,30,58],   em:false, sh:26, dens:Infinity, behavior:"solid", translucent:true,
   conductivity:0.10, spawnTemp:20, heatCapacity:4},
 {name:"Sapphire",  sw:"#1F5FBF", rgb:[31,95,191],   em:false, sh:26, dens:Infinity, behavior:"solid", translucent:true,
   conductivity:0.10, spawnTemp:20, heatCapacity:4},
 {name:"Glass",     sw:"#C8D0D4", rgb:[200,208,212], em:false, sh:22, dens:Infinity, behavior:"solid", translucent:true,
   conductivity:0.08, spawnTemp:20, heatCapacity:3},
 {name:"Rimestone", sw:"#5C6E96", rgb:[92,110,150],  em:false, sh:5,  dens:Infinity, behavior:"solid",
   conductivity:0.20, spawnTemp:4, chillOutput:8, meltPoint:34 /* meltTo patched below -> Water. Frozen bedrock: survives ambient 20, thaws if the world warms */},
 // Mossrock no longer sheds Bloomspore on its own — bare ground spawning
 // plants with zero existing plant life nearby was the original bug
 // report. Skyvine is the only spore source now; Mossrock is otherwise
 // mechanically identical to Slate/Stone.
 {name:"Mossrock",  sw:"#6FA893", rgb:[111,168,147], em:false, sh:9,  dens:Infinity, behavior:"solid",
   conductivity:0.15, spawnTemp:20, meltPoint:88},
 {name:"Calcite",   sw:"#9E7D3E", rgb:[158,125,62],  em:false, sh:4,  dens:Infinity, behavior:"solid",
   /* emits patched below -> Water, very slowly */
   conductivity:0.30, spawnTemp:20},
 {name:"Aetherfrost",sw:"#D6CAED", rgb:[214,202,237], em:true, sh:12, dens:Infinity, behavior:"solid",
   decay:0.002, /* decayTo patched below -> Aether */
   conductivity:0.25, spawnTemp:1, chillOutput:2, meltPoint:30 /* meltTo patched below -> Aether. Now it thaws as well as sublimates */},
 // Crystal: deliberately TERMINAL — no thresholds, nothing converts it.
 // Some things in a roster should be an end state or every chain becomes
 // a loop and nothing you build ever stays built. Its one gift is a very
 // high conductivity: crystal is the material you run heat THROUGH.
 {name:"Crystal",   sw:"#D8D2E0", rgb:[216,210,224], em:false, sh:14, dens:Infinity, behavior:"solid",
   conductivity:0.85 /* raised from 0.50 — this is now the roster's thermal wire */, spawnTemp:20},
 // ---- WOOD. Three ignition rates instead of one, plus it ROTS: touching
 // Ooze slowly turns wood into more Ooze. That's the first genuinely
 // adversarial material relationship in the roster — everything else
 // either burns, freezes, or grows, and none of it eats your buildings.
 // Rate is deliberately tiny (0.008); it should be a slow horror, not a
 // demolition tool.
 {name:"Wood",      sw:"#7A5230", rgb:[122,82,48],   em:false, sh:5,  dens:Infinity, behavior:"solid",
   conductivity:0.22, spawnTemp:20, ignitionTemp:65},
 // ---- EMERALD DUST. Green sand — same needsLateralSupport shape as Sand,
 // just a different look and a slightly higher density. dens:38 is a
 // placeholder chosen to sit clearly above Sand (30) while leaving real
 // headroom under Gravel ("very dense" per spec, not yet built) — revisit
 // once Gravel's actual number exists.
 {name:"Emerald Dust", sw:"#2ECC71", rgb:[46,204,113], em:true,  sh:18, dens:38, behavior:"powder-settle", needsLateralSupport:true,
   conductivity:0,   spawnTemp:20},
 // ---- AURORA SILT. Was decorative. Now it's the charged mineral: it
 // discharges into Aether under a Tesla field (teslaReact, the same hook
 // Wire uses — nothing about that mechanism was ever wire-specific), and
 // souring in Water is what MAKES Ghost Tide, which previously had no
 // source in the world at all and could only be painted.
 {name:"Aurora Silt",sw:"#F5429B", rgb:[245,66,155], em:false, emAmt:0.15, sh:20, dens:25, behavior:"powder-settle", needsLateralSupport:true,
   conductivity:0.20, spawnTemp:12},
 // ---- ULTRARED. The name was doing all the work; now the material does.
 // A thermal brick: permanent, doesn't decay, doesn't burn, just radiates.
 // 55 is chosen against the ignition table on purpose — one line of it
 // will light Oil (50) and not Wood (65), but a solid MASS of it stacks
 // radiant contributions and will light anything. Quantity is the dial,
 // which is a better toy than a single scary number.
 {name:"Ultrared",  sw:"#ff0000", rgb:[255,0,0],     em:false, emAmt:0.20, sh:8,  dens:22, behavior:"powder-settle", needsLateralSupport:true,
   conductivity:0.50, spawnTemp:70, heatCapacity:10, heatOutput:55},
 // ---- STARFALL. Was the most inert thing in the roster: a powder that
 // did nothing at all. Now it's the hot half of the star cycle — burning
 // meteor dust that radiates gently and cools into Stardust, which is
 // the reagent that turns Water to Crystal. Three-step chain from one
 // material that previously had zero connections.
 {name:"Starfall",  sw:"#FFD98A", rgb:[255,217,138], em:true,  sh:34, dens:5,        behavior:"powder",
   conductivity:0.25, spawnTemp:45, heatOutput:40,
   decay:0.004 /* decayTo patched below -> Stardust */},
 // ---- RED SAND. Sand variant, slightly denser (34 vs Sand's 30).
 // RENAMED from "Red Sand" — collided with the new rainbow-palette
 // "Red Sand" (pure #FF0000) added below. This material's actual color
 // (#D4703A) reads as rust/terracotta, not true red, so the new name
 // fits better too. Flag to Crash: pick a different name if this one
 // doesn't land — no other code references this material by name (verified
 // via grep), so renaming it again later is a one-line, zero-risk change.
 {name:"Rust Sand", sw:"#D4703A", rgb:[212,112,58],  em:false, emAmt:0.20, sh:5,  dens:34, behavior:"powder-settle", needsLateralSupport:true,
   conductivity:0,   spawnTemp:20},
 // Ash + water = mud. Gives Ash a second act and feeds Dirt, which is the
 // hinge of the burn-and-regrow cycle (see Dirt's own entry).
 {name:"Ash",       sw:"#3D342E", rgb:[61,52,46],    em:false, sh:8,  dens:3,  behavior:"powder", decay:0.0012,
   conductivity:0.15, spawnTemp:45 /* onContact patched below -> Water:Dirt */},
 {name:"Stardust",  sw:"#F2F2FA", rgb:[242,242,250], em:true,  sh:30, dens:2, behavior:"powder",
   conductivity:0.20, spawnTemp:10},
 // ---- EMBER. Fire's smoldering tail. Deliberately uses decay rather
 // than a freezePoint to die: applyCombustionHeat floors a radiating
 // cell's temp at its own heatOutput every tick, so ANY material with
 // heatOutput set can never cool below it and a freezePoint above it
 // would never fire. This is the general rule for combustibles, not a
 // quirk of Ember. 45 radiates enough to relight Oil (50)? No — just
 // under, on purpose. Embers should look dangerous and mostly not be.
 {name:"Ember",     sw:"#B4381A", rgb:[180,56,26],   em:true,  sh:18, dens:3,  behavior:"powder",
   conductivity:0.30, spawnTemp:62, heatOutput:45,
   decay:0.01 /* decayTo patched below -> Ash */},
 // ---- GRAVEL. The heavy end of the powder family (55) — everything
 // granular should sink through it, nothing should float it.
 {name:"Gravel",    sw:"#7A7A80", rgb:[122,122,128], em:false, emAmt:0.10, sh:3,  dens:55, behavior:"powder-settle", needsLateralSupport:true,
   conductivity:0.12, spawnTemp:20},
 // ---- PHLOGISTON. The classical fire-principle, and now mechanically
 // that: a combustible gas. ignitionTemp 68 (radiant) plus a fast
 // per-reaction contact rate off Fire, so a vented cloud goes up as a
 // sheet rather than creeping cell by cell. Ghost Tide decays into this,
 // which makes an old ghost pool a delayed-action bomb.
 {name:"Phlogiston", sw:"#B08FE8", rgb:[176,143,232], em:true,  sh:30, dens:1,        behavior:"gas",
   conductivity:0.10, spawnTemp:60, ignitionTemp:68},
 // ---- AETHER. Was inert — diffused prettily, reacted with nothing, and
 // was the target of exactly one decay. Now it has both ends: it freezes
 // into Aetherfrost in the cold and burns off into Phlogiston, so the
 // Aether/Aetherfrost pair breathes instead of running one way.
 {name:"Aether",    sw:"#C77DFF", rgb:[199,125,255], em:true,  sh:14, dens:3,        behavior:"diffuse", rainbow:true,
   conductivity:0.40, spawnTemp:15, freezePoint:8 /* freezeTo patched below -> Aetherfrost */},
 {name:"Ghost Tide",sw:"#9FE8DC", rgb:[159,232,220], em:true,  sh:32, dens:15,       behavior:"liquid", decay:0.012, /* decayTo patched below -> Phlogiston */
   cohesion:0.8, conductivity:0.50, spawnTemp:8},
 // ---- CLOUDS. Aether's physics (behavior:"diffuse") without the
 // rainbow flag — same drift, plain white. No freezePoint, so unlike
 // Aether it has no Aetherfrost end; it just diffuses.
 {name:"Clouds",    sw:"#E8ECF2", rgb:[232,236,242], em:true,  sh:12, dens:3,        behavior:"diffuse",
   conductivity:0.40, spawnTemp:15},
 // Honeymire dissolves in water (slowly — it's the whole point of a
 // viscous trap that it doesn't just vanish) and burns. cohesion raised
 // to 0.85: at visc 0.04 its surface was the exact case the cohesion
 // system was built for.
 {name:"Honeymire", sw:"#EDB611", rgb:[237,182,17],  em:false, sh:10, dens:24, behavior:"liquid",
   visc:0.04, cohesion:0.85,
   conductivity:0.20, spawnTemp:24, ignitionTemp:70},
 // ---- ACID. Plain liquid, no bespoke mechanics — cohesion, movement,
 // everything else comes from the shared liquid behavior and
 // LIQUID_COHESION_DEFAULT like Oil/Ghost Tide/Honeymire. Its only
 // identity is its two onContact reactions, patched below by name.
 {name:"Acid",      sw:"#9AE62C", rgb:[154,230,44],  em:true,  sh:22, dens:18, behavior:"liquid",
   conductivity:0,   spawnTemp:20, decay:0.0065, reactChance:0.5, heatCapacity:1},
 {name:"Bloomspore",sw:"#2CB043", rgb:[44,176,67],   em:false, sh:6,  dens:4, behavior:"powder",
   conductivity:0.15, spawnTemp:20, ignitionTemp:50},
 {name:"Skyvine",   sw:"#2CB086", rgb:[44,176,134],  em:false, sh:8,  dens:Infinity, behavior:"grow",
   growChance:0.01,   // was 0.045 — still uncapped/immortal, just slower. See physics.js's
                       // growInto() comment: no cap besides world bounds and this pace.
   conductivity:0.20, spawnTemp:20, ignitionTemp:60
   /* emits patched below -> Bloomspore. Seed step of the flora loop: vine
      grows, drops a spore, spore drifts/falls and germinates into a new
      vine once it's actually landed on fertile ground (Dirt/Honeymire) —
      see Bloomspore's onContact for the settled-gate. */},
 // ---- FLORA. Tendril and Skyvine were both grow:0.02 and both reacted
 // with nothing — literally interchangeable. Split them: Tendril is the
 // slow creeping one, Skyvine the fast climber that SEEDS. Both burn
 // easily, which they should, and which finally makes a forest fire a
 // thing that can happen.
 {name:"Tendril",   sw:"#8B5FBF", rgb:[139,95,191],  em:false, sh:8,  dens:Infinity, behavior:"grow",
   growChance:0.015,
   conductivity:0.20, spawnTemp:20, ignitionTemp:55},
 {name:"Ooze",      sw:"#1B2A52", rgb:[27,42,82],    em:true,  sh:10, dens:20, behavior:"creep",
   climbBias:0.9,
   conductivity:0.25, spawnTemp:18},
 // ---- wire pair — unchanged mechanically. Off self-converts to Live via
 // onContact, Live decays back to Off on a timer, a junction lights every
 // adjacent Off cell in the SAME tick (reactAt loops all 4 neighbors).
 {name:"Wire (Off)", sw:"#4A5A6E", rgb:[74,90,110],   em:false, sh:6,  dens:Infinity, behavior:"solid",
   conductivity:0.9, spawnTemp:20},
 {name:"Wire (Live)",sw:"#7FE6FF", rgb:[127,230,255], em:true,  sh:24, dens:Infinity, behavior:"solid",
   conductivity:0.9, spawnTemp:30},
  ];
  MATS.forEach((m,i)=>m.id=i);

const EMPTY = MATS.findIndex(m=>m.behavior==="void");
const STONE = MATS.findIndex(m=>m.behavior==="solid");
const SAND  = MATS.findIndex(m=>m.name==="Sand");
const WATER = MATS.findIndex(m=>m.name==="Water");
const AETHER= MATS.findIndex(m=>m.name==="Aether");
const PHLOGISTON = MATS.findIndex(m=>m.name==="Phlogiston");
const STARFALL = MATS.findIndex(m=>m.name==="Starfall");
const GHOSTTIDE = MATS.findIndex(m=>m.name==="Ghost Tide");
const SLATE = MATS.findIndex(m=>m.name==="Slate");
const MOSSROCK = MATS.findIndex(m=>m.name==="Mossrock");
const CLAY = MATS.findIndex(m=>m.name==="Clay");
const CRYSTAL = MATS.findIndex(m=>m.name==="Crystal");
const RIMESTONE = MATS.findIndex(m=>m.name==="Rimestone");
const SNOW = MATS.findIndex(m=>m.name==="Snow");
const OIL = MATS.findIndex(m=>m.name==="Oil");
const SMOKE = MATS.findIndex(m=>m.name==="Smoke");
const OOZE = MATS.findIndex(m=>m.name==="Ooze");
const TENDRIL = MATS.findIndex(m=>m.name==="Tendril");
const SKYVINE = MATS.findIndex(m=>m.name==="Skyvine");
const BLOOMSPORE = MATS.findIndex(m=>m.name==="Bloomspore");
const CALCITE = MATS.findIndex(m=>m.name==="Calcite");
const HONEYMIRE = MATS.findIndex(m=>m.name==="Honeymire");
const STARDUST = MATS.findIndex(m=>m.name==="Stardust");
const AETHERFROST = MATS.findIndex(m=>m.name==="Aetherfrost");
const AURORASILT = MATS.findIndex(m=>m.name==="Aurora Silt");
const ULTRARED = MATS.findIndex(m=>m.name==="Ultrared");
const ASH = MATS.findIndex(m=>m.name==="Ash");
const MAGMA = MATS.findIndex(m=>m.name==="Magma");
const WIRE_OFF = MATS.findIndex(m=>m.name==="Wire (Off)");
const WIRE_LIVE = MATS.findIndex(m=>m.name==="Wire (Live)");
const WOOD = MATS.findIndex(m=>m.name==="Wood");
const FIRE = MATS.findIndex(m=>m.name==="Fire");
const STEAM = MATS.findIndex(m=>m.name==="Steam");
const EMBER = MATS.findIndex(m=>m.name==="Ember");
const DIRT = MATS.findIndex(m=>m.name==="Dirt");
const ACID = MATS.findIndex(m=>m.name==="Acid");
const GRAVEL = MATS.findIndex(m=>m.name==="Gravel");

/* ================= CROSS-REFERENCE PATCH BLOCK =================
   Every reference to another material is resolved BY NAME here, after
   ids exist. A hardcoded numeric id anywhere in this file is a bug.
   Self-converts-only: for "X turns Y into Z", the rule lives on Y (the
   material that actually changes), keyed by X (the neighbor that
   triggers it). The engine never touches the neighbor. */

/* ---- PHASE CHANGES. These replace the old Snow/Magma and
   Magma/Water onContact pairs entirely — both are gone. Quenching
   lava with water is no longer a special case that only works against
   literal Magma; it's conduction, and it works against anything cold. */
MATS.find(m=>m.name==="Stone").meltTo       = MAGMA;
MATS.find(m=>m.name==="Slate").meltTo       = MAGMA;
MATS.find(m=>m.name==="Mossrock").meltTo    = MAGMA;
MATS.find(m=>m.name==="Clay").meltTo        = STONE;      // fired ceramic
MATS.find(m=>m.name==="Sand").meltTo        = CRYSTAL;    // glass
MATS.find(m=>m.name==="Water").freezeTo = SNOW;
MATS.find(m=>m.name==="Water").meltTo   = STEAM;      // boil
MATS.find(m=>m.name==="Steam").freezeTo     = WATER;      // condense — closes the water cycle
MATS.find(m=>m.name==="Snow").meltTo        = WATER;
MATS.find(m=>m.name==="Rimestone").meltTo   = WATER;
MATS.find(m=>m.name==="Magma").freezeTo     = STONE;      // lava crusts on its own now
MATS.find(m=>m.name==="Aether").freezeTo    = AETHERFROST;
MATS.find(m=>m.name==="Aetherfrost").meltTo = AETHER;

/* ---- DECAY CHAINS */
MATS.find(m=>m.name==="Ghost Tide").decayTo  = PHLOGISTON; // an old ghost pool is a slow gas bomb
MATS.find(m=>m.name==="Smoke").decayTo       = ASH;
MATS.find(m=>m.name==="Aetherfrost").decayTo = AETHER;
MATS.find(m=>m.name==="Starfall").decayTo    = STARDUST;   // burning meteor dust cools into the inert kind
MATS.find(m=>m.name==="Fire").decayTo        = EMBER;      // was ASH — Ember is the new middle stage
MATS.find(m=>m.name==="Ember").decayTo       = ASH;
MATS.find(m=>m.name==="Wire (Live)").decay   = 0.15;       // pulse lifespan
MATS.find(m=>m.name==="Wire (Live)").decayTo = WIRE_OFF;

/* ---- EMISSION. One emits block per material (engine limit), so each of
   these is a considered choice about what a material's single passive
   output should be. */
MATS.find(m=>m.name==="Calcite").emits  = { matId: WATER, chance: 0.0015 };
MATS.find(m=>m.name==="Fire").emits     = { matId: SMOKE, chance: 0.05 };
MATS.find(m=>m.name==="Ember").emits    = { matId: SMOKE, chance: 0.015 };  // coals smoke less than flame
MATS.find(m=>m.name==="Skyvine").emits  = { matId: BLOOMSPORE, chance: 0.0006 };
// Dirt and Mossrock used to also emit Bloomspore spontaneously (ground
// generating plants with zero existing plant life nearby) — removed.
// Skyvine is now the sole spore source; spread requires an actual plant.

/* ---- CONTACT REACTIONS. Rates that differ per pairing use the
   {to, chance} form; the rest fall back to the material's reactChance. */

// Water + Stardust -> Crystal. Kept as given.
// Water + Fire -> Smoke added this session from Crash's sandbox table.
// NOTE this is Smoke, not Steam — flagged to Crash as a possible editor
// slip (the two are adjacent pale gases in the dropdown) since Water
// already has meltPoint 46 -> Steam covering ordinary boiling. Left as
// exported pending his call.
MATS.find(m=>m.name==="Water").onContact = { [FIRE]: SMOKE, [STARDUST]: CRYSTAL };
MATS.find(m=>m.name==="Water").reactChance = 0.25;

// Stone + Stardust -> Magma. Instant, no chance override — reactChance
// defaults to 1, same as every other bare-id onContact rule. With
// temperature on, the resulting Magma has nothing sustaining its heat,
// so Stone's own freezeTo pulls it right back to Stone almost
// immediately — a one-tick flicker rather than a lasting transmutation.
// Still visibly happens with temperature off (the conversion itself
// isn't temperature-gated, only the flicker-back is).
MATS.find(m=>m.name==="Stone").onContact = { [STARDUST]: MAGMA, [ACID]: GHOSTTIDE };

// ACID — the placeholder single Stone pairing is gone, replaced by
// Crash's own sandbox-authored dissolution set. Rates read as hardness:
// the plain entries fall back to Acid's reactChance (0.5), the harder
// stone gets an explicit slower chance.
//   SELF-CONVERTS-ONLY, AND THE CATCH: every rule here is a rule about
// what the ACID becomes, not what the rock becomes. Only Stone has a
// reciprocal rule (Stone's own [ACID]: GHOSTTIDE, patched above), so
// Stone is the only material acid actually eats. Against Clay/Slate/
// Rimestone/Mossrock/Calcite/Gravel the acid vanishes and the rock is
// untouched — flagged to Crash; if the intent was "acid dissolves these
// too," each of those materials needs its own [ACID] rule at the same
// chance, and these entries become the acid-consumption half of a pair.
// Left exactly as exported pending that call.
//   Acid + Fire is patched further down, next to Fumes — Fumes doesn't
// exist yet at this point in the build.
MATS.find(m=>m.name==="Acid").onContact = {
  [STONE]:     EMPTY,
  [CLAY]:      EMPTY,
  [RIMESTONE]: EMPTY,
  [CALCITE]:   EMPTY,
  [SLATE]:     { to: EMPTY, chance: 0.10 },
  [GRAVEL]:    { to: EMPTY, chance: 0.20 },
  [MOSSROCK]:  { to: EMPTY, chance: 0.25 },
};

// Oil: the reason per-reaction rates were built. Lazy off coals, ready
// off flame, instant off lava.
MATS.find(m=>m.name==="Oil").onContact = {
  [FIRE]:  { to: FIRE, chance: 0.55 },
  [EMBER]: { to: FIRE, chance: 0.25 },
  [MAGMA]: { to: FIRE, chance: 0.90 },
};

// Phlogiston: fast contact spread so a vented cloud goes up as a sheet.
MATS.find(m=>m.name==="Phlogiston").onContact = {
  [FIRE]:  { to: FIRE, chance: 0.85 },
  [MAGMA]: { to: FIRE, chance: 0.60 },
};

// Wood: three catch speeds, plus rot. Rot is the roster's only genuinely
// adversarial relationship — everything else burns, freezes or grows;
// nothing else eats what you built.
MATS.find(m=>m.name==="Wood").onContact = {
  [FIRE]:  { to: FIRE, chance: 0.15 },
  [EMBER]: { to: FIRE, chance: 0.04 },
  [MAGMA]: { to: FIRE, chance: 0.60 },
  [OOZE]:  { to: OOZE, chance: 0.008 },
};

// Flora: all cheap fuel, and all fed by the two soil materials.
MATS.find(m=>m.name==="Tendril").onContact = {
  [FIRE]: { to: FIRE, chance: 0.30 },
  [MAGMA]:{ to: FIRE, chance: 0.80 },
};
MATS.find(m=>m.name==="Skyvine").onContact = {
  [FIRE]: { to: FIRE, chance: 0.30 },
  [MAGMA]:{ to: FIRE, chance: 0.80 },
};
MATS.find(m=>m.name==="Bloomspore").onContact = {
  [FIRE]:      { to: FIRE,    chance: 0.60 },   // ignites instantly, falling or not — fire doesn't care
  [HONEYMIRE]: { to: SKYVINE, chance: 0.08, settled: true },   // honey is fertilizer
  [DIRT]:      { to: SKYVINE, chance: 0.05, settled: true },   // so is soil
  // settled: true — germination only rolls once settleCounter shows the
  // spore has actually come to rest (see physics.js's reactAt), not
  // merely adjacent while still falling past. This is the whole fix for
  // "spores grow mid-air": a falling cell's settleCounter is reset to 0
  // every tick by its own movement, so the check can never pass in transit.
};

// Ooze: turns to Tendril in water (kept), and burns off as Smoke.
MATS.find(m=>m.name==="Ooze").onContact = {
  [WATER]: { to: TENDRIL, chance: 0.20 },
  [FIRE]:  { to: SMOKE,   chance: 0.50 },
};

// Ash + water = mud. Feeds the regrowth cycle.
MATS.find(m=>m.name==="Ash").onContact = { [WATER]: { to: DIRT, chance: 0.06 } };

// Honeymire dissolves in water — slowly, or it stops being a trap.
MATS.find(m=>m.name==="Honeymire").onContact = { [WATER]: { to: WATER, chance: 0.03 } };

// Aurora Silt sours in water into Ghost Tide, which previously had no
// source in the world at all and could only be painted by hand.
MATS.find(m=>m.name==="Aurora Silt").onContact = { [WATER]: { to: GHOSTTIDE, chance: 0.05 } };

// Wire: unchanged. Instant on purpose — a network should light at once.
MATS.find(m=>m.name==="Wire (Off)").onContact = { [WIRE_LIVE]: WIRE_LIVE };
MATS.find(m=>m.name==="Wire (Off)").reactChance = 1;

/* ---- TESLA. teslaReact was never wire-specific — it's just "what this
   material becomes in a Tesla field." Aurora Silt discharges into Aether,
   which is the second user of a hook that has had exactly one since it
   was written. */
MATS.find(m=>m.name==="Wire (Off)").teslaReact    = WIRE_LIVE;
MATS.find(m=>m.name==="Aurora Silt").teslaReact   = AETHER;

/* ================= CALIBRATION NOTE — READ BEFORE RETUNING =============
   Every threshold above was picked against what the engine can actually
   REACH, not against physical realism. Three facts drive all of it:

   1. AMBIENT IS A STRONG THERMOSTAT. AMBIENT_PULL_RATE (0.02) drags every
      cell toward DEFAULT_AMBIENT_HEAT (20) every tick, which at 60fps is
      a ~2 second time constant. Consequences: (a) any threshold inside
      roughly 14..26 fires spontaneously everywhere, with no heat source —
      nothing here is in that band; (b) all COOLING-driven changes are
      fast, so lava solidifying in a couple of seconds is ambient's doing,
      not the phase-change code's. Want geological lava? Turn the Ambient
      Pull slider down. That dial is now a real design control.

   2. CONDUCTION IS WEAK AGAINST IT. A cell adjacent to one 99-degree
      neighbor equilibrates near
          T = (0.0375*cond*99 + 0.02*20) / (0.0375*cond + 0.02)
      which for a typical conductivity of 0.2-0.5 lands around 40-60 —
      NOT 99. That's why Sand vitrifies at 72 rather than a "realistic"
      90, and why bedrock's 95 is effectively "needs a real blaze."
      Raising a material's conductivity is often the right fix for
      "this never reaches its threshold," not lowering the threshold.

   3. RADIANT-AT-A-DISTANCE HEAT NO LONGER EXISTS. It used to: a hot
      material summed contributions from every same-effect source within
      a fixed radius with no occlusion, so heatOutput on a material that
      appears in BULK (a dense Lava pool, specifically) could inject far
      more per tick than any single-source estimate suggested, with
      nothing bounding the climb but an emergency safety clamp that was
      never meant to be a resting temperature. Removed entirely — heat
      now only moves by conduction (touching neighbors, see point 2
      above) or a self-heating cell's own hard-pinned temp (below). This
      is also why Magma has no heatOutput and Ultrared sits at a modest
      55 despite looking tempting to push further — conduction is the
      only channel left, and it's the well-behaved one.
      Radiant COLD (chillOutput, physics.js's applyRadiantChill) is a
      different, still-live mechanism — it never had this problem, since
      it's floored at 0, a real bound already used everywhere else, not
      an emergency value.

   THE ONE RULE THAT ISN'T OBVIOUS: heatOutput vs freezePoint.
   applyCombustionHeat PINS a self-heating cell's temp at exactly its own
   heatOutput every tick (not a floor anymore — see Lava's own comment
   below for why that changed), so heatOutput ABOVE freezePoint means the
   cell can never reach its own freeze threshold and burns forever. Ember
   uses decay to die for exactly this reason, not a freezePoint. Magma
   can use freezePoint precisely because it has no heatOutput. */


/* GENERATOR BLOCKS — placeable wellsprings. Each emits its own material
   for as long as it sits on the map. See physics.js's tickGenerators/
   emitSpring/emitSeep for the emission physics. */
[["Water Spring","Water","push"], ["Sand Spring","Sand","push"], ["Phlogiston Vent","Phlogiston","seep"]]
  .forEach(([name,spawnName,emit])=>{
    const src=MATS.find(m=>m.name===spawnName);
    MATS.push({ name, sw:src.sw, rgb:src.rgb, em:true, sh:src.sh,
      dens:Infinity, behavior:"generator", spawnId:src.id, emit, id:MATS.length });
  });

  // ---- LAVA. SWAPPED: this is now the self-heater, Magma (above) is the
  // inert twin. heatOutput:80 sits above freezePoint (30), so per the
  // heatOutput-vs-freezePoint rule, Lava can never cool back below its
  // own freeze threshold on its own — permanently molten, can't be
  // quenched by conduction/ambient alone. Pours at spawnTemp:80, same
  // number as its own heatOutput on purpose — nothing to visibly settle
  // into after placement, it's already sitting at the number it holds.
  //   The escape hatch is contact, not cooling: touching Magma converts
  // Lava to Magma outright (self-converts-only — the rule lives on Lava,
  // the material that actually changes, keyed by Magma as the trigger).
  // A newly-converted cell is ordinary inert Magma, which then touches
  // ITS other Lava neighbors next tick, cascading through a whole
  // connected pool one contact-front at a time rather than flipping
  // everything in one tick. Once a cell's Magma, it freezes to Stone
  // normally — "one drop neutralizes the pool" is this chain, not a
  // single global effect.
  //   reactChance:0.25 is a first-pass guess for a visible cascading
  // front rather than an instant flip — Crash tunes this kind of rate
  // himself, not treating 0.25 as final.
  //   RADIANT RUNAWAY — ROOT-CAUSED, THEN THE WHOLE MECHANISM REMOVED.
  // heatOutput used to be a floor (physics.js's applyCombustionHeat) —
  // that alone wasn't the bug, but combined with radiant-at-a-distance
  // heat (a since-removed mechanism that summed every same-effect source
  // within radius with no occlusion), a dense pool of self-heating cells
  // could mutually irradiate itself and bank heat upward every tick with
  // nothing bounding it but an emergency 4000-degree safety clamp that
  // was never meant to be a resting temperature. Measured: a 17x17 pool
  // hit that clamp in under 150 ticks, and Stone touching the pool's
  // edge hit it too, just as fast. Two changes closed this for good:
  //   1. Radiant-at-a-distance heat is gone entirely (see the
  // calibration note above) — heat only moves by touching now.
  //   2. heatOutput is a hard PIN, not a floor: temp[i] is forced to
  // exactly heatOutput every tick, so a self-heating cell can neither
  // bank conductive heat from neighbors nor be pushed hotter by an
  // external source. It can still freely heat or cool everything ELSE
  // around it via ordinary conduction — this only removes ITS OWN
  // ability to drift off its labeled number.
  // Confirmed this also explains the earlier "heatOutput:1 melted Stone"
  // observation: under the old floor-plus-radiant combination, a self-
  // heating cell's actual temp could silently run far above its labeled
  // heatOutput; now its temp IS its heatOutput, always, so conduction
  // into neighbors matches the calibration note's predicted ranges.
  MATS.push({ name:"Lava", sw:"#E03614", rgb:[224,54,20], em:true, sh:24, dens:40,
    behavior:"pressured", conductivity:0.55, spawnTemp:90, heatCapacity:14,
    freezePoint:30, freezeTo:STONE, heatOutput:90,
    onContact:{ [MAGMA]: MAGMA }, reactChance:0.25, id:MATS.length });

  // ---- FUMES. A Phlogiston clone in sickly yellow-green: same gas
  // behavior, same dens:1, same conductivity, same ignitionTemp:68, and
  // the same fast contact-catch off Fire/Magma that makes a vented cloud
  // go up as a sheet. One difference, and it's the defining one — it
  // decays fast (0.05 per tick, five times Smoke's 0.01, ~20 ticks of
  // expected life) and decays to NOTHING: decayTo is deliberately left
  // undefined, which physics.js reads as EMPTY. Phlogiston is a body of
  // gas that sits until something lights it; Fumes is a brief event.
  // 0.05 is a first-pass number in the same spirit as Lava's reactChance
  // — Crash tunes rates like this himself, don't treat it as final.
  //   PUSHED LAST IN THE BASE ROSTER, ON PURPOSE — but read this before
  // adding another one. Appending here leaves every hand-authored
  // material id untouched (Erase 0 through Lava 46 are exactly where they
  // were). It does NOT leave the auto-generated twins untouched: twins
  // are built after buildDefaultMats() returns, starting at MATS.length,
  // so one more base material pushes the whole twin run up by one.
  // VERIFIED, not assumed — Fumes took id 47, which used to be
  // "Stone (built)", and all 72 twins shifted by exactly 1.
  //   That matters because persistence.js run-length-encodes the raw
  // grid[] ids (encodeGridRLE), so a world saved before this change has
  // cells holding the OLD twin numbers: a placed "Stone (built)" cell
  // stored as 47 now reads back as Fumes. Any pre-Fumes save will show
  // scrambled stamp/set materials. Flagged to Crash rather than worked
  // around — the real fix is the name->id save manifest with a version
  // bump that's already on the roadmap, and the alternative (pushing
  // Fumes after the twin loop and hand-generating its two twins) keeps
  // ids stable but puts it outside the default-table build that
  // resolveCustomMats walks, which is a structural call, not a comment.
  MATS.push({ name:"Fumes", sw:"#C6DA5E", rgb:[198,218,94], em:true, sh:30, dens:1,
    behavior:"gas", conductivity:0.10, spawnTemp:60, ignitionTemp:68, decay:0.05,
    onContact:{ [FIRE]: { to: FIRE, chance: 0.85 }, [MAGMA]: { to: FIRE, chance: 0.60 } },
    id:MATS.length });

  // Acid + Fire -> Fumes. Patched here rather than with Acid's other
  // rules above because Fumes doesn't exist yet at that point in the
  // build. This replaces the old Acid+Fire -> Steam entry: it was the
  // only steam-producing reaction Acid had, which is what "make the acid
  // reactions that result in steam produce Fumes instead" resolved to.
  //   chance 1.0 is from Crash's table (@1), i.e. acid touching flame
  // converts on the very first tick. Worth knowing what that composes
  // into: Fumes is flammable and catches off Fire at 0.85, so acid
  // meeting fire becomes gas that immediately re-ignites — acid reads as
  // fuel now, not as something fire merely destroys.
  MATS.find(m=>m.name==="Acid").onContact[FIRE] =
    { to: MATS.findIndex(m=>m.name==="Fumes"), chance: 1.0 };

  /* ====== RAINBOW MATERIALS — Electric Rainbow Company site palette ======
     18 materials: 6 color families (5 spectrum colors + Orange, a
     placeholder slotted between Red and Yellow) x 3 states each
     (sand/liquid/gas). No onContact/emits on any of the 18 — reactions
     are explicitly out of scope for this pass (Crash's call). All 18 DO
     carry a slow decay:0.00004 -> EMPTY (added when overwrite-on-paint
     was pulled from sand-bg.js — see that file's placeMaterial comment).
     ~7min average cell lifetime at the site's 60-tick/sec rate: 1/0.00004
     = 25000 ticks / 60 = ~417s. Decay is now the ONLY way a painted cell
     clears itself short of the floor drain holes or falling off-world —
     tune this one number, uniformly across all 18, to make the world
     clear faster or slower.

     DENSITY: climbs red -> orange -> yellow -> green -> blue -> purple
     within each state-row, per spec — purple is always the densest
     member of its row, red always the lightest.

     BEHAVIOR: sand and liquid alternate within their rows so both
     relevant behavior variants get used, not just one:
       sand   -> powder-settle / powder,   alternating
       liquid -> pressured / liquid,       alternating
     Gas is deliberately NOT alternated with "diffuse" — the engine's
     gasHazeOnly rendering (blurred haze, no crisp cell shown) is keyed
     specifically to behavior:"gas", not "diffuse", which renders as a
     solid visible shimmering cell instead (Aether/Clouds-style). Since
     these are explicitly named "Gas", all six use behavior:"gas" so
     they actually render as gas. Per Crash's explicit call — don't
     reintroduce diffuse here.

     GLOW: em:true (full bloom-pass contribution, not the partial emAmt
     path) on all 18, sh tuned toward Oil's degree of shimmer per
     Crash's "akin to how Oil currently renders" call — sh:30 on the
     liquids to match Oil's own sh:30 exactly, sands/gases close behind.

     COLORS: the five spectrum hues are the EXACT same hex as index.html's
     border-frame CSS variables (--c-red etc.) — one source of truth in
     spirit, kept in sync by hand since CSS custom properties and this
     JS registry don't share storage. If the border colors ever change,
     these six colors need updating too.

     ID SAFETY: one MATS.push() call PER material, each with its own
     id:MATS.length — deliberately NOT batched into a single
     MATS.push(a,b,c,...) call. Every argument in a batched push() gets
     evaluated before any of them are actually pushed, so id:MATS.length
     would read the SAME stale length for all 18 entries and hand out 18
     colliding ids — exactly the silent-alias failure allocTwinId()'s own
     comment warns about below. Sequential single-argument pushes are
     what make each id:MATS.length correct. Same pattern Fumes uses
     immediately above. */

  // ---- RED (least dense in every row) ----
  MATS.push({ name:"Red Sand",  sw:"#FF0000", rgb:[255,0,0],     em:true, sh:0, dens:26,
    behavior:"powder",
    conductivity:0.20, spawnTemp:20, id:MATS.length });
  MATS.push({ name:"Red Water", sw:"#FF0000", rgb:[255,0,0],     em:true, sh:0, dens:8,
    behavior:"pressured",
    conductivity:0.20, spawnTemp:20, id:MATS.length });
  MATS.push({ name:"Red Gas",   sw:"#FF0000", rgb:[255,0,0],     em:true, sh:0, dens:1,
    behavior:"gas",
    conductivity:0.20, spawnTemp:20, id:MATS.length });

  // ---- ORANGE (placeholder color family — slotted between Red and
  // Yellow on the spectrum; not part of the 5-color border) ----
  MATS.push({ name:"Orange Sand",  sw:"#F58A2E", rgb:[245,138,46], em:true, sh:0, dens:29,
    behavior:"powder",
    conductivity:0.20, spawnTemp:20, id:MATS.length });
  MATS.push({ name:"Orange Water", sw:"#F58A2E", rgb:[245,138,46], em:true, sh:0, dens:11,
    behavior:"liquid",
    conductivity:0.20, spawnTemp:20, id:MATS.length });
  MATS.push({ name:"Orange Gas",   sw:"#F58A2E", rgb:[245,138,46], em:true, sh:0, dens:1.4,
    behavior:"gas",
    conductivity:0.20, spawnTemp:20, id:MATS.length });

  // ---- YELLOW ----
  MATS.push({ name:"Yellow Sand",  sw:"#F5C518", rgb:[245,197,24], em:true, sh:0, dens:32,
    behavior:"powder",
    conductivity:0.20, spawnTemp:20, id:MATS.length });
  MATS.push({ name:"Yellow Water", sw:"#F5C518", rgb:[245,197,24], em:true, sh:0, dens:14,
    behavior:"pressured",
    conductivity:0.20, spawnTemp:20, id:MATS.length });
  MATS.push({ name:"Yellow Gas",   sw:"#F5C518", rgb:[245,197,24], em:true, sh:0, dens:1.8,
    behavior:"gas",
    conductivity:0.20, spawnTemp:20, id:MATS.length });

  // ---- GREEN ----
  MATS.push({ name:"Green Sand",  sw:"#3DBF5F", rgb:[61,191,95],  em:true, sh:0, dens:36,
    behavior:"powder",
    conductivity:0.20, spawnTemp:20, id:MATS.length });
  MATS.push({ name:"Green Water", sw:"#3DBF5F", rgb:[61,191,95],  em:true, sh:0, dens:18,
    behavior:"liquid",
    conductivity:0.20, spawnTemp:20, id:MATS.length });
  MATS.push({ name:"Green Gas",   sw:"#3DBF5F", rgb:[61,191,95],  em:true, sh:0, dens:2.2,
    behavior:"gas",
    conductivity:0.20, spawnTemp:20, id:MATS.length });

  // ---- BLUE ----
  MATS.push({ name:"Blue Sand",  sw:"#2E86F5", rgb:[46,134,245],  em:true, sh:0, dens:40,
    behavior:"powder",
    conductivity:0.20, spawnTemp:20, id:MATS.length });
  MATS.push({ name:"Blue Water", sw:"#2E86F5", rgb:[46,134,245],  em:true, sh:0, dens:22,
    behavior:"pressured",
    conductivity:0.20, spawnTemp:20, id:MATS.length });
  MATS.push({ name:"Blue Gas",   sw:"#2E86F5", rgb:[46,134,245],  em:true, sh:0, dens:2.6,
    behavior:"gas",
    conductivity:0.20, spawnTemp:20, id:MATS.length });

  // ---- PURPLE (densest in every row) ----
  MATS.push({ name:"Purple Sand",  sw:"#9B4FE0", rgb:[155,79,224], em:true, sh:0, dens:44,
    behavior:"powder",
    conductivity:0.20, spawnTemp:20, id:MATS.length });
  MATS.push({ name:"Purple Water", sw:"#9B4FE0", rgb:[155,79,224], em:true, sh:0, dens:26,
    behavior:"liquid",
    conductivity:0.20, spawnTemp:20, id:MATS.length });
  MATS.push({ name:"Purple Gas",   sw:"#9B4FE0", rgb:[155,79,224], em:true, sh:0, dens:3.0,
    behavior:"gas",
    conductivity:0.20, spawnTemp:20, id:MATS.length });

  return MATS;
}

// ---- resolve one material's cross-reference fields from NUMERIC ids
// (as found in a fully-built default-style array) back to NAMES, so it
// can flow through the exact same name-based resolver a custom table's
// own entries use below. Needed only for the core 10 — they're built
// once by buildDefaultMats() (numeric, like everything there), but have
// to be re-expressed as names before being spliced into a *different*
// array where those old numeric positions no longer mean anything.
function nameifyRefs(m, sourceMats){
  const nm=cloneMaterial(m);
  const nameOf=id=>sourceMats[id] ? sourceMats[id].name : undefined;
  for(const k of ["decayTo","meltTo","freezeTo","teslaReact","spawnId"]){
    if(nm[k]!==undefined) nm[k]=nameOf(nm[k]);
  }
  if(nm.emits) nm.emits={ mat:nameOf(nm.emits.matId), chance:nm.emits.chance };
  if(nm.onContact){
    const out={};
    for(const [otherId,rule] of Object.entries(nm.onContact)){
      const otherName=nameOf(+otherId);
      if(otherName===undefined) continue;   // shouldn't happen against a just-built default array, but don't propagate a bad key if it somehow does
      out[otherName] = (rule && typeof rule==="object")
        ? { to:nameOf(rule.to), chance:rule.chance, settled:rule.settled }
        : nameOf(rule);
    }
    nm.onContact=out;
  }
  return nm;
}

// ---- the mirror image of index.html's serializeMaterial: takes
// materials whose cross-reference fields are NAME STRINGS and returns
// them resolved to array-position ids. Any reference that doesn't
// resolve to a name within THIS combined list (core + custom) is
// dropped, not fatal — a single bad reference in a hand-edited or
// foreign-app-version file shouldn't take the whole table down with it.
// `defaultMats` supplies the core 10's verbatim definitions; the core's
// own cross-references (e.g. Water -> Stardust -> Crystal) re-resolve
// against whatever THIS table actually contains, which means a custom
// table that omits Stardust/Crystal/Ember/Ash/etc. simply drops that
// one reaction/decay-target on the core material rather than crashing —
// e.g. Fire just never decays to Ember in a table with no Ember. That's
// an intentional consequence of only the 10 named materials being
// pinned, not their whole default dependency web — flagged, not hidden.
function resolveCustomMats(customMaterials, defaultMats){
  const core = CORE_MATERIAL_NAMES.map(n=>nameifyRefs(defaultMats.find(m=>m.name===n), defaultMats));
  const combined = [...core, ...customMaterials.map(cloneMaterial)];
  const nameToIndex = new Map(combined.map((m,i)=>[m.name,i]));
  combined.forEach((m,i)=>{ m.id=i; });
  const resolveName = n => nameToIndex.has(n) ? nameToIndex.get(n) : undefined;
  for(const m of combined){
    if(m.dens==="Infinity") m.dens=Infinity;   // JSON has no Infinity literal — see index.html's serializeMaterial for the write side of this sentinel
    for(const k of ["decayTo","meltTo","freezeTo","teslaReact","spawnId"]){
      if(m[k]===undefined) continue;
      const r=resolveName(m[k]);
      if(r===undefined){ console.warn(`Zodiac Drift: table material "${m.name}" has a dangling ${k} reference to "${m[k]}" \u2014 dropped.`); delete m[k]; }
      else m[k]=r;
    }
    if(m.emits){
      const r=resolveName(m.emits.mat);
      if(r===undefined){ console.warn(`Zodiac Drift: table material "${m.name}" has a dangling emits reference to "${m.emits.mat}" \u2014 dropped.`); delete m.emits; }
      else m.emits={ matId:r, chance:m.emits.chance };
    }
    if(m.onContact){
      const out={};
      for(const [otherName,rule] of Object.entries(m.onContact)){
        const otherId=resolveName(otherName);
        if(otherId===undefined){ console.warn(`Zodiac Drift: table material "${m.name}" has a dangling onContact trigger "${otherName}" \u2014 dropped.`); continue; }
        if(rule && typeof rule==="object"){
          const toId=resolveName(rule.to);
          if(toId===undefined){ console.warn(`Zodiac Drift: table material "${m.name}"'s onContact[${otherName}] targets missing material "${rule.to}" \u2014 dropped.`); continue; }
          const newRule={ to:toId };
          if(rule.chance!==undefined) newRule.chance=rule.chance;
          if(rule.settled) newRule.settled=true;
          out[otherId]=newRule;
        } else {
          const toId=resolveName(rule);
          if(toId===undefined){ console.warn(`Zodiac Drift: table material "${m.name}"'s onContact[${otherName}] targets missing material "${rule}" \u2014 dropped.`); continue; }
          out[otherId]=toId;
        }
      }
      m.onContact=out;
    }
  }
  return combined;
}

// ---- reads a table already validated and written by index.html's Load
// Table flow (full user-facing validation lives there: reject on
// duplicate/reserved names, cap enforcement, clear error messages).
// This reader is defensive ON TOP of that, not instead of it — if
// what's stored is malformed anyway (manual edit, future format change,
// corrupted storage), it logs a warning and falls back to the default
// table rather than breaking the app. There's no UI to show an error in
// at this point in the load; by the time index.html's own script runs,
// this decision is already made.
function loadCustomTable(){
  let raw;
  try{ raw=localStorage.getItem(CUSTOM_TABLE_STORAGE_KEY); }catch(e){ return null; }
  if(!raw) return null;
  let parsed;
  try{ parsed=JSON.parse(raw); }catch(e){ console.warn("Zodiac Drift: stored custom table isn't valid JSON \u2014 falling back to default.", e); return null; }
  if(!parsed || !Array.isArray(parsed.materials)){ console.warn("Zodiac Drift: stored custom table missing a materials array \u2014 falling back to default."); return null; }
  if(parsed.materials.length > MAX_CUSTOM_MATERIALS){ console.warn(`Zodiac Drift: stored custom table has ${parsed.materials.length} materials, over the ${MAX_CUSTOM_MATERIALS} cap \u2014 falling back to default.`); return null; }
  const names = parsed.materials.map(m=>m && m.name).filter(Boolean);
  if(new Set(names.map(n=>n.toLowerCase())).size !== names.length){ console.warn("Zodiac Drift: stored custom table has duplicate material names \u2014 falling back to default."); return null; }
  if(names.some(n=>CORE_MATERIAL_NAMES.includes(n))){ console.warn("Zodiac Drift: stored custom table redefines a reserved core material name \u2014 falling back to default."); return null; }
  return { materials:parsed.materials, tuning:parsed.tuning||null };
}

// ---- decide once, before anything downstream reads MATS ----
const _defaultMats = buildDefaultMats();
const _customTable = loadCustomTable();
export const activeTuningOverrides = _customTable ? _customTable.tuning : null;   // main.js/index.html apply this after their own tuning defaults are set, see their startup sequence
const _authoredMats = _customTable ? resolveCustomMats(_customTable.materials, _defaultMats) : _defaultMats;
export const MATS = _authoredMats;

/* SOLIDIFIED TWINS — auto-generated, hidden, one per paintable material.
   Exist so a landed/compacted cell can hold its shape with Stone physics
   while keeping the same look. Stone is its own twin (already solid).
   MATS order is the id space — never reorder MATS. Runs unconditionally
   against whichever MATS won above (default or custom) — twins are
   never part of a table file, always regenerated fresh, same as they
   always have been for the default table. */
export const SOLID_TWIN={};
// POWDER DECOMPRESSION reverse-lookup: twin material id -> its loose
// powder source id, ONLY for twins born from a powder.
export const TWIN_OF_POWDER={};
export const POWDER_BEHAVIORS = new Set(["powder","powder-settle"]);
// STAMP_TWIN — a SECOND, parallel set of solid twins for landed stamps:
// permanent, immune to Powder Decompression entirely. Drawn darker so a
// built structure reads as distinct from the same material loose.
export const STAMP_TWIN={};
// STAMP_ORIGIN — the reverse of STAMP_TWIN: built-twin id -> the source
// material id it was painted from. STAMP_TWIN only ever mapped forward
// (source -> twin); this is what a future "a stamp's properties come
// from what it's actually made of" system needs — given any cell of a
// placed stamp, look up what it originally was. Deliberately NOT
// collapsing stamps down to one shared material id (discussed and
// rejected: color can't safely double as a physics-identity carrier once
// materials are recolorable, see the color editor above) — keeping
// per-cell material identity via this map is what keeps that door open
// without committing to the aggregation system itself yet.
export const STAMP_ORIGIN={};
const STAMP_DARKEN=0.78;
const dk = c => Math.round(c*STAMP_DARKEN);

/* ---- TWIN ID ALLOCATION: DOWNWARD FROM THE TOP OF THE ID SPACE ----
   Twins used to take `id:MATS.length` — the next number after whatever
   the base roster ended on. That made every twin id a function of how
   many base materials existed, so appending ONE material shifted all 72
   twins by one. Since persistence.js run-length-encodes raw grid[] ids,
   that silently scrambled every already-saved world's stamps and settled
   material (verified, not theorised — see the Fumes comment above).

   Now the id space is allocated from both ends: base materials count UP
   from 0 as they always have, twins count DOWN from TWIN_ID_TOP. Adding
   a base material takes the next number up and moves nothing; its own
   two twins take the next two numbers down. Existing ids on both sides
   stay put.

   TWIN_ID_TOP is 255 and not some rounder, roomier number because
   state.js's `grid` is a Uint8Array — a cell physically cannot hold more
   than 255, and an id above that would wrap (999 -> 231) and silently
   ALIAS onto a real material rather than erroring. If the roster ever
   genuinely needs more than 256 total, the fix is widening grid to
   Uint16Array plus a save-format bump, not raising this constant.

   WHERE YOU APPEND STILL MATTERS. Twins are handed out in the order this
   loop walks the roster, so a new material only leaves existing twins
   alone if it goes at the TRUE end of the roster — which is NOT the end
   of the big array literal in buildDefaultMats(). Lava and Fumes are
   MATS.push()'d after that literal closes, so anything added at the
   literal's end lands ahead of them in iteration order and takes the
   twin slots they were using. Verified: inserting after Wire (Live)
   moved 4 twins; appending after the Fumes push moved 0. Append after
   Fumes.

   NOTE FOR ANYTHING THAT INDEXES BY MATERIAL: from here on, a material's
   id is NOT its position in MATS. MATS.forEach((M,i)=>...) gives i =
   array position; grid cells hold M.id. Those were the same number by
   coincidence before this change and are not anymore — key any per-
   material lookup off M.id. (render.js's tileCache was doing exactly
   this and was fixed alongside this change.) MATBY, SOLID_TWIN,
   STAMP_TWIN, TWIN_OF_POWDER and STAMP_ORIGIN are all plain id-keyed
   objects, so sparse numbering is fine for them. */
const TWIN_ID_TOP = 255;
let nextTwinId = TWIN_ID_TOP;
// Captured BEFORE the loop below starts pushing twins into MATS —
// once it does, MATS[MATS.length-1] is a twin, not a base material, and
// comparing against that would compare the twin range to itself.
const HIGHEST_BASE_ID = MATS.reduce((hi,m)=>Math.max(hi,m.id), 0);
function allocTwinId(){
  // Collide loudly rather than aliasing. A silent overlap here would
  // make two different materials share one grid value — the exact class
  // of bug this whole change exists to kill.
  if(nextTwinId <= HIGHEST_BASE_ID){
    throw new Error(`Zodiac Drift: material id space exhausted — the base roster (highest id ${HIGHEST_BASE_ID}) has grown into the twin range (next twin id ${nextTwinId}). Widen state.js's grid to Uint16Array and raise TWIN_ID_TOP.`);
  }
  return nextTwinId--;
}
MATS.filter(m=>m.behavior!=="void" && m.behavior!=="generator").forEach(src=>{
  if(src.behavior==="solid"){
    SOLID_TWIN[src.id]=src.id;
  } else {
    const twin={ name:src.name+" (set)", sw:src.sw, rgb:src.rgb, em:src.em, sh:src.sh,
      dens:Infinity, behavior:"solid", hidden:true, id:allocTwinId() };
    MATS.push(twin);
    SOLID_TWIN[src.id]=twin.id;
    if(POWDER_BEHAVIORS.has(src.behavior)) TWIN_OF_POWDER[twin.id]=src.id;
  }
  const stamp={ name:src.name+" (built)", sw:src.sw,
    rgb:[dk(src.rgb[0]),dk(src.rgb[1]),dk(src.rgb[2])], em:src.em, sh:src.sh,
    dens:Infinity, behavior:"solid", hidden:true, id:allocTwinId() };
  MATS.push(stamp);
  STAMP_TWIN[src.id]=stamp.id;   // NOT added to TWIN_OF_POWDER — permanent by construction
  STAMP_ORIGIN[stamp.id]=src.id;
});

export const MATBY={}; MATS.forEach(m=>MATBY[m.id]=m);

/* Name/predicate -> material ID. Was MATS.findIndex(...), which returns
   an ARRAY POSITION. That equalled the id for every base material and
   still does — but twins now carry ids from the top of the space
   downward while still living at the end of the array, so position and
   id are no longer the same concept in this array. Reading .id directly
   makes these constants correct by construction instead of correct by
   luck. Same first-match semantics findIndex had (STONE still resolves
   to real Stone, not the first solid twin), and same -1 on no match. */
const idOf = pred => { const m = MATS.find(pred); return m ? m.id : -1; };


// ---- exported named constants: computed ONCE here, against whichever
// MATS ended up active. buildDefaultMats()'s own internal copies of
// these same expressions are function-local (see const_block above,
// stripped of `export`) and only used for ITS OWN patch block while
// constructing the default table \u2014 this is the single source of truth
// everything else in the app actually imports.
export const EMPTY = idOf(m=>m.behavior==="void");
export const STONE = idOf(m=>m.behavior==="solid");
export const SAND  = idOf(m=>m.name==="Sand");
export const WATER = idOf(m=>m.name==="Water");
export const AETHER= idOf(m=>m.name==="Aether");
export const PHLOGISTON = idOf(m=>m.name==="Phlogiston");
export const STARFALL = idOf(m=>m.name==="Starfall");
export const GHOSTTIDE = idOf(m=>m.name==="Ghost Tide");
export const SLATE = idOf(m=>m.name==="Slate");
export const MOSSROCK = idOf(m=>m.name==="Mossrock");
export const CLAY = idOf(m=>m.name==="Clay");
export const CRYSTAL = idOf(m=>m.name==="Crystal");
export const RIMESTONE = idOf(m=>m.name==="Rimestone");
export const SNOW = idOf(m=>m.name==="Snow");
export const OIL = idOf(m=>m.name==="Oil");
export const SMOKE = idOf(m=>m.name==="Smoke");
export const OOZE = idOf(m=>m.name==="Ooze");
export const TENDRIL = idOf(m=>m.name==="Tendril");
export const SKYVINE = idOf(m=>m.name==="Skyvine");
export const BLOOMSPORE = idOf(m=>m.name==="Bloomspore");
export const CALCITE = idOf(m=>m.name==="Calcite");
export const HONEYMIRE = idOf(m=>m.name==="Honeymire");
export const STARDUST = idOf(m=>m.name==="Stardust");
export const AETHERFROST = idOf(m=>m.name==="Aetherfrost");
export const AURORASILT = idOf(m=>m.name==="Aurora Silt");
export const ULTRARED = idOf(m=>m.name==="Ultrared");
export const ASH = idOf(m=>m.name==="Ash");
export const MAGMA = idOf(m=>m.name==="Magma");
export const WIRE_OFF = idOf(m=>m.name==="Wire (Off)");
export const WIRE_LIVE = idOf(m=>m.name==="Wire (Live)");
export const WOOD = idOf(m=>m.name==="Wood");
export const FIRE = idOf(m=>m.name==="Fire");
export const STEAM = idOf(m=>m.name==="Steam");
export const EMBER = idOf(m=>m.name==="Ember");
export const DIRT = idOf(m=>m.name==="Dirt");
export const ACID = idOf(m=>m.name==="Acid");

// to "is this grid cell part of something someone placed" (stamp snapping).
export const STAMP_TWIN_IDS = new Set(Object.values(STAMP_TWIN));
// "built" now covers two independent things a loose stamp should snap
// flush against: an ordinary dissolved stamp sitting in grid[] (the
// STAMP_TWIN check, unchanged) OR a skeleton structure, which lives
// entirely outside grid[] in its own mask (see state.js's skeleton-layer
// block). Extending this ONE function, rather than teaching
// snappedStampPos a second check, is what makes skeleton buildings a
// snap target for free — every caller of isBuiltAt (currently just
// stamps.js's snappedStampPos) gets this for free too.
export const isBuiltAt = (x,y) => inB(x,y) && (STAMP_TWIN_IDS.has(grid[idx(x,y)]) || skeletonMask[idx(x,y)]===1);

/* heavier sinks through lighter; nothing sinks through a solid or a generator core */
export const canSink=(a,b)=> MATBY[a].dens>MATBY[b].dens && MATBY[b].behavior!=="solid" && MATBY[b].behavior!=="generator";
