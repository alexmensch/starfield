precision highp float;

#include <common>
#include <logdepthbuf_pars_vertex>

// Three.js auto-injects: position (vec3), normal (vec3), modelMatrix,
// modelViewMatrix, projectionMatrix, normalMatrix. Don't redeclare them
// or the WebGL2 compile will reject the duplicate symbols.

out vec3 vNormalView;

void main() {
  // View-space surface normal — used in the fragment shader to estimate
  // optical depth through the ellipsoid (silhouettes thin, centre thick).
  vNormalView = normalize(normalMatrix * normal);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);

  #include <logdepthbuf_vertex>
}
