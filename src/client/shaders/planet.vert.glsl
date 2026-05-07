precision highp float;

#include <common>
#include <logdepthbuf_pars_vertex>

// Per-vertex (quad corner): xy in [-0.5, 0.5].
in vec2 aCorner;
// Per-instance: planet center in the renderer's local frame (host star
// at the origin), physical radius in pc, body colour, solidity 0..1
// (0=gas giant soft edge, 1=rocky hard edge), atmosphere flag 0/1.
in vec3 iPosition;
in float iRadiusPc;
in vec3 iColour;
in float iSolidity;
in float iAtmosphere;

uniform float uViewportH;
uniform float uFovYRad;
// Pixel floor — same role as the star pipeline's appSize: keeps planets
// from disappearing entirely when their physical disc projects to
// sub-pixel size. Smaller than the star floor since planets are
// secondary visual content.
uniform float uMinPxSize;

out vec3 vColour;
out float vSolidity;
out float vAtmosphere;
// vQuadUv runs from 0 at body centre to 1 at the body edge, with values
// up to QUAD_OVERSIZE at the quad corner (atmosphere halo extent).
// Defined as the planar offset in body-radius units rather than [-1,1]
// so the fragment can compute radial distance via length(vQuadUv) cleanly.
out vec2 vQuadUv;

// Quad spans 1.5× body radius from centre so an additive atmosphere halo
// can fade out beyond the body edge without clipping at the quad's
// silhouette. Bodies without atmosphere don't use the outer ring; the
// extra fragments discard early.
const float QUAD_OVERSIZE = 1.5;

void main() {
  vec4 viewCenter = modelViewMatrix * vec4(iPosition, 1.0);
  float d = -viewCenter.z;
  // Camera is in front of (or in line with) the planet — kill the quad
  // by projecting outside the clip volume. The star pipeline does this
  // via the projection matrix; we replicate explicitly because we never
  // pass the centre through projectionMatrix until after the offset.
  if (d <= 0.0) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    return;
  }

  // True angular diameter (a7d.2 lineage): θ = 2·atan(R/d). Convert
  // to a pixel diameter via the viewport-pixels-per-radian rate, then
  // floor at uMinPxSize so far-away planets stay visible as discs of
  // the floor size rather than vanishing.
  float pxPerRad = uViewportH / uFovYRad;
  float thetaRad = 2.0 * atan(iRadiusPc, d);
  float physSizePx = thetaRad * pxPerRad;
  float pxSize = max(uMinPxSize, physSizePx);

  // Convert px diameter back to view-space half-extent at this depth so
  // the billboard quad corners land at the correct place after the
  // projection multiply.
  float vsHalf = pxSize * d / (pxPerRad * 2.0);
  vec3 cornerView = viewCenter.xyz
    + vec3(aCorner * vsHalf * 2.0 * QUAD_OVERSIZE, 0.0);
  gl_Position = projectionMatrix * vec4(cornerView, 1.0);

  vColour = iColour;
  vSolidity = iSolidity;
  vAtmosphere = iAtmosphere;
  // aCorner is [-0.5, 0.5] across the quad. Map to [-OVERSIZE, +OVERSIZE]
  // in body-radius units so length(vQuadUv) ranges [0, OVERSIZE].
  vQuadUv = aCorner * 2.0 * QUAD_OVERSIZE;

  #include <logdepthbuf_vertex>
}
