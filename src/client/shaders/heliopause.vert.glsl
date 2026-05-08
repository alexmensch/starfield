precision highp float;

#include <common>
#include <logdepthbuf_pars_vertex>

// View-space normal + position carried to the fragment for Fresnel.
out vec3 vNormalView;
out vec3 vPositionView;

void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vPositionView = mv.xyz;
  vNormalView = normalize(normalMatrix * normal);
  gl_Position = projectionMatrix * mv;

  #include <logdepthbuf_vertex>
}
