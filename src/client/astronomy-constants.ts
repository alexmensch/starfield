// Canonical astronomical constants. One definition per quantity; consumers
// (client modules, tests, shaders via uniform) import from here so they
// can't silently drift apart on precision or value.

// 1 parsec in AU and its reciprocal. IAU 2015 parsec definition: 1 pc =
// 648000/π AU = 206264.80624709636 AU exactly. AU_PC is the float64
// reciprocal so callers can multiply a value-in-AU by AU_PC to get parsecs.
export const AU_PER_PC = 206264.80624709636;
export const AU_PC = 1 / AU_PER_PC;

// 1 AU in kilometres (IAU 2012 exact value).
export const AU_KM = 1.495978707e8;

// 1 km in parsecs. Used to convert physical body radii (catalogued in km)
// into scene units.
export const KM_PC = AU_PC / AU_KM;

// 1 solar radius in parsecs.
//   1 R_sun = 6.957e8 m, 1 pc = 3.0857e16 m  →  R_sun = 2.2543e-8 pc.
// Also uploaded to the star vertex shader as the `uRSunPc` uniform.
export const R_SUN_PC = 2.2543e-8;
