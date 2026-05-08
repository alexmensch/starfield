precision highp float;

#include <common>
#include <logdepthbuf_pars_vertex>

// Volumetric raymarch through proxy meshes.
//
// Each mesh (disc + bulge) is a unit sphere scaled non-uniformly into
// the component's volume in galactic-frame parsecs, then rotated by
// GAL_TO_ICRS so the local frame's axes align with galactic axes.
// Under that construction `position * uMeshScalePc` IS the fragment's
// galactocentric galactic position in pc — directly usable by density
// functions in the fragment shader.
//
// We pass the back-face fragment in mesh-local frame (vMeshLocalPos)
// and renderer-local world frame (vWorldPos). The fragment shader
// performs ray-sphere intersection in mesh-local (where the volume is
// the unit sphere — trivial) to find the entry point, then raymarches
// from entry to back-face exit in world parsecs.

uniform vec3 uMeshScalePc;

out vec3 vMeshLocalPos;
out vec3 vWorldPos;

void main() {
  vMeshLocalPos = position;
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorldPos = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;

  #include <logdepthbuf_vertex>
}
