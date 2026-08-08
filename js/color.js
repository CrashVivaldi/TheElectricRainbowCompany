/* ================= color.js — shared color conversion helpers =============
   Pure functions, no DOM, no simulation state. Lifted out of index.html so
   the material editor UI (js/ui-matlab.js) can be hosted anywhere — these
   three were the only non-UI dependency in that whole 500-line cluster.

   Conventions, since they aren't the most common ones:
     - hue in DEGREES 0..360, saturation and lightness in PERCENT 0..100
       (not the 0..1 fractions many libraries use)
     - rgb as a plain [r,g,b] array of 0..255 integers
     - hex as "#rrggbb", clamped, always 6 digits
   Materials store both `rgb` (the array the renderer reads) and `sw` (the
   hex string the swatch CSS uses), which is why setMaterialColor writes
   both together — they must never drift apart.
*/

export function hslToRgb(h,s,l){
  h=((h%360)+360)%360; h/=360; s/=100; l/=100;
  let r,g,b;
  if(s===0){ r=g=b=l; }
  else{
    const hue2rgb=(p,q,t)=>{
      if(t<0)t+=1; if(t>1)t-=1;
      if(t<1/6) return p+(q-p)*6*t;
      if(t<1/2) return q;
      if(t<2/3) return p+(q-p)*(2/3-t)*6;
      return p;
    };
    const q = l<0.5 ? l*(1+s) : l+s-l*s;
    const p = 2*l-q;
    r=hue2rgb(p,q,h+1/3); g=hue2rgb(p,q,h); b=hue2rgb(p,q,h-1/3);
  }
  return [Math.round(r*255), Math.round(g*255), Math.round(b*255)];
}

export function rgbToHsl(r,g,b){
  r/=255; g/=255; b/=255;
  const max=Math.max(r,g,b), min=Math.min(r,g,b);
  let h=0, s=0; const l=(max+min)/2;
  if(max!==min){
    const d=max-min;
    s = l>0.5 ? d/(2-max-min) : d/(max+min);
    switch(max){
      case r: h=(g-b)/d+(g<b?6:0); break;
      case g: h=(b-r)/d+2; break;
      default: h=(r-g)/d+4; break;
    }
    h/=6;
  }
  return [h*360, s*100, l*100];
}

export function rgbToHex(rgb){ return "#"+rgb.map(v=>Math.max(0,Math.min(255,v)).toString(16).padStart(2,"0")).join(""); }

/* Write a material's colour from HSL, keeping its two representations in
   sync. Materials carry BOTH `rgb` (renderer) and `sw` (swatch CSS); this
   is the one place that guarantees they agree. */
export function setMaterialColor(m, h, s, l){
  const rgb = hslToRgb(h, s, l);
  m.rgb = rgb;
  m.sw = rgbToHex(rgb);
  return rgb;
}
