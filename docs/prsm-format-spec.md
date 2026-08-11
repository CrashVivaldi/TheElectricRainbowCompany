# Prismatic Image Format Specification

**Format name:** Prismatic  
**Extension:** `.prsm`  
**Proposed MIME type:** `application/vnd.prismatic`  
**Current version:** 1  
**Maintainer:** Electric Rainbow Company  
**Schema URL:** `https://crashvivaldi.github.io/Hologram/schema/prsm/v1.json` *(target — not yet live)*

---

## 1. Overview

A `.prsm` file is a holographic image container. It encodes a photograph or
layered composition together with a depth map and rendering parameters
sufficient to reproduce a tilt-reactive, iridescent holographic card effect
in any conforming viewer.

The file is a valid HTML document with a non-standard extension. This means
any web browser can open it without a plugin or OS-level file association.
The renderer may be inlined in the file (self-contained mode) or loaded from
a CDN via a `<script>` tag (linked mode). The image data and all rendering
parameters are encoded in a manifest JSON block embedded in the document
`<head>`.

The format has two content types: `photo` (a single image with an associated
depth map) and `diorama` (up to four transparent-PNG layers composited at
independent depth values). Both types are rendered by the same engine using
the same manifest schema.

---

## 2. File structure

A conforming `.prsm` file must be a valid HTML5 document containing exactly:

1. A `<script type="application/json" id="prsm-manifest">` element in the
   `<head>` whose text content is the manifest JSON (see §3).
2. A `<prismatic-card>` custom element in the `<body>`.
3. A `<script>` element that defines the `prismatic-card` custom element —
   either inline (self-contained mode) or as a `src` reference (linked mode).

No other elements are required. A viewer may add minimal layout CSS; the
reference implementation wraps the card in a dark centered layout.

### 2.1 Self-contained mode

The engine script is inlined verbatim. The file opens and renders with no
network access. This is the default output of the Prismatic authoring tool.

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
  <title>Prismatic — Card Title</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      min-height: 100dvh;
      background: #1a1c1f;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    prismatic-card { width: min(480px, 92vw); aspect-ratio: 1; }
  </style>
  <script type="application/json" id="prsm-manifest">
    { ...manifest JSON... }
  </script>
</head>
<body>
  <prismatic-card></prismatic-card>
  <script>/* prismatic.js inlined */</script>
</body>
</html>
```

### 2.2 Linked mode

The engine is loaded from a URL. Suitable for embedding or hosting
environments where the file size of the inlined engine (~30 KB) is a concern.

```html
<body>
  <prismatic-card></prismatic-card>
  <script src="https://crashvivaldi.github.io/Hologram/prismatic.js"></script>
</body>
```

Linked-mode files are not self-contained and may fail to render offline.

### 2.3 Prohibited patterns

A `.prsm` file MUST NOT contain a `</script>` literal inside any
`<script>` element's text content. The characters `</script>` must be
escaped as `\u003c/script>` when appearing inside the manifest JSON or the
inlined engine source.

---

## 3. Manifest schema

The manifest is a UTF-8 JSON object. Unknown keys MUST be ignored by
conforming readers (forward compatibility). All fields are optional except
`version` and `type`; defaults are specified below.

```jsonc
{
  "$schema": "https://crashvivaldi.github.io/Hologram/schema/prsm/v1.json",
  "version": 1,               // integer, required — must equal 1 for this spec
  "type": "photo",            // string, required — "photo" | "diorama"
  "title": "Untitled",        // string — display name for the card

  "photo": {
    "src": null,              // string | null — base64 JPEG data URL of the image
    "depth": null,            // string | null — base64 JPEG data URL of the depth map
    "depthMode": "custom"     // string — "custom" | "heuristic" | "auto"
                              //   custom:    depth is pre-baked in photo.depth
                              //   heuristic: viewer generates depth from a
                              //              lightweight CPU-based model
                              //   auto:      viewer runs ML depth estimation
  },

  "diorama": {
    "layers": [               // array of 0–4 layer objects, back-to-front
      {
        "src": null,          // string | null — base64 PNG data URL (must support alpha)
        "depth": 0.0,         // number — [-1.0, 1.0], displacement depth
                              //   negative = closer to viewer, positive = further
        "opacity": 1.0        // number — [0.0, 1.0]
      }
    ],
    "strength": 70            // number — [0, 100], composite depth scale
  },

  "foil": {
    "style": "spectrum",      // string — "spectrum" | "mono"
                              //   spectrum: rainbow hue-cycling foil (diffraction grating look)
                              //   mono: single-hue foil (vintage laser-etched sticker look)
    "hue": 140,               // number — [0, 360], base hue in degrees (mono mode only)
    "grain": 0.45,            // number — [0.0, 1.0], per-facet grain amount (mono mode only)
    "opacity": 0.45,          // number — [0.0, 1.0], foil layer opacity over photo
    "sparkle": 0.7,           // number — [0.0, 2.0], specular intensity
    "size": 16,               // number — [10, 28], facet size in logical pixels
    "facetType": "diamond"    // string — "diamond" | "hex" | "prism" | "flecks"
  },

  "effects": {
    "strength": 0.18,         // number — [0.0, 1.0], parallax displacement amount
    "focus": 0.5,             // number — [0.0, 1.0], depth focal plane
    "edge": 0.18,             // number — [0.0, 1.0], edge-fill softness
    "blur": 0.0,              // number — [0.0, 1.0], depth-of-field blur amount
    "brightness": 1.0,        // number — [0.4, 1.8]
    "saturation": 1.0,        // number — [0.0, 2.0]
    "tintHue": 190,           // number — [0, 360]
    "tintAmount": 0.0,        // number — [0.0, 1.0]
    "chromAb": 0.0,           // number — [0.0, 1.0], chromatic aberration
    "vignette": 0.3,          // number — [0.0, 1.0]
    "grain": 0.04,            // number — [0.0, 1.0], animated film grain
    "photoOpacity": 1.0,      // number — [0.0, 1.0]
    "invertDepth": false,     // boolean — invert the depth map
    "wrapTilt": false,        // boolean — sine-wrap tilt input (continuous loop)
    "stretchToFit": true,     // boolean — true = stretch; false = crop-to-fill
    "photoFoil": true,        // boolean — render foil over photo
    "borderFoil": true,       // boolean — render foil border frame
    "borderSparkle": 0.6,     // number — [0.0, 2.0], border foil sparkle
    "borderSize": 16          // number — [10, 28], border foil facet size
  },

  "tilt": {
    "rotAmt": 10,             // number — [0, 30], CSS 3D rotation in degrees
    "gyroSens": 1.0,          // number — [0.5, 2.0], gyroscope sensitivity multiplier
    "invertX": false,         // boolean
    "invertY": false          // boolean
  }
}
```

### 3.1 Type semantics

When `type` is `"photo"`, a conforming reader MUST use `photo.src` as the
primary image and `photo.depth` as the depth map (or generate a depth map
according to `photo.depthMode` if `photo.depth` is null).

When `type` is `"diorama"`, a conforming reader MUST composite
`diorama.layers` into a single image and depth map before rendering.
Layers are ordered back-to-front. Each layer's alpha channel determines
occlusion. If no diorama layers have image data, the reader MAY fall back
to `photo.src` if present.

Both sections MUST be present in the manifest regardless of `type`. This
allows a viewer to switch modes on a received file without re-authoring it.

### 3.2 Image data encoding

All image data MUST be encoded as RFC 2397 data URLs.

- Photo and depth images MUST be JPEG (`data:image/jpeg;base64,...`).
- Diorama layer images MUST be PNG (`data:image/png;base64,...`), as they
  require an alpha channel for occlusion.

Conforming readers SHOULD accept either format in any field for
forward compatibility, but conforming writers MUST follow the above.

### 3.3 Depth map conventions

The depth map is a grayscale image (R channel used). Value 1.0 (white)
represents near (closest to viewer); value 0.0 (black) represents far.
This convention may be inverted at render time by setting
`effects.invertDepth: true`.

The depth map SHOULD be the same dimensions as the photo. If it differs,
readers MUST scale it to match using cover-fit geometry.

### 3.4 Version negotiation

A reader encountering `version > 1` SHOULD display a warning that the file
may have been created with a newer version of the format, then attempt to
render using known fields and ignore unknown ones.

A reader encountering `version < 1` or a missing `version` field MUST treat
the file as version 1 and attempt to render.

---

## 4. Renderer requirements

A conforming `.prsm` renderer MUST:

- Read the manifest from `#prsm-manifest` in the host document.
- Ignore unknown manifest keys without erroring.
- Apply `effects.stretchToFit` to control photo-to-canvas scaling.
- Support both `"photo"` and `"diorama"` content types.
- Support gyroscope input on devices that expose `DeviceOrientationEvent`,
  behind an explicit user permission prompt on platforms that require it
  (currently iOS).
- Request gyroscope permission only after explicit user interaction (tap/click).
- Support `prefers-reduced-motion`: when set, tilt animation must be
  disabled (snap to neutral position, no lerp loop).

A conforming renderer SHOULD:

- Support mouse/pointer tilt input on non-touch devices.
- Lerp tilt input toward target for smooth movement (reference: 0.14
  lerp factor per frame at 60 fps).
- Render the border foil frame when `effects.borderFoil` is true.
- Support all four `foil.facetType` values.

A conforming renderer MAY:

- Omit depth-of-field blur (`effects.blur`) if the rendering environment
  does not support it.
- Fall back to a flat (non-holographic) render if WebGL is unavailable.

---

## 5. Security considerations

`.prsm` files are HTML documents. They are subject to standard browser
security policies (same-origin, CSP, etc.) when served from a web server.

Image data embedded as base64 data URLs is subject to browser memory
limits. Authoring tools SHOULD constrain source images to a maximum of
1280px on the long side for photos and 1024px for diorama layers before
encoding, to keep file sizes manageable.

The manifest JSON is embedded inside a `<script type="application/json">`
element. It is not executed by the browser. However, authoring tools MUST
escape the character sequence `</script>` within the JSON payload (as
`\u003c/script>`) to prevent inadvertent HTML parser confusion.

A linked-mode `.prsm` file that loads its engine from an external URL
inherits the security posture of that URL. Self-contained files have no
external dependencies and are safe to open offline or share via email
attachment.

---

## 6. File identification

| Property | Value |
|---|---|
| Extension | `.prsm` |
| Proposed MIME type | `application/vnd.prismatic` |
| Magic bytes | None (valid HTML — begins with `<!DOCTYPE html>` or `<html`) |
| Encoding | UTF-8 |
| Compression | None at container level; image payloads are JPEG/PNG |

The absence of magic bytes is a deliberate consequence of the HTML container
strategy. A file identification tool (e.g. `file(1)`) will correctly report
a `.prsm` file as an HTML document. Identification by extension is the
primary mechanism.

A future binary container format (`.prsmb` or similar) could introduce magic
bytes; this specification does not define one.

---

## 7. Changelog

| Version | Date | Notes |
|---|---|---|
| 1 | 2026 | Initial specification |
