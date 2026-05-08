import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { Heliopause, HELIOPAUSE_APEX_LOCAL_PC } from './heliopause';

const AU_PC = 1 / 206264.80624709636;

describe('HELIOPAUSE_APEX_LOCAL_PC', () => {
  it('lies 122 AU from Sol (the upwind heliopause boundary distance)', () => {
    const r = Math.hypot(
      HELIOPAUSE_APEX_LOCAL_PC.x,
      HELIOPAUSE_APEX_LOCAL_PC.y,
      HELIOPAUSE_APEX_LOCAL_PC.z,
    );
    expect(r).toBeCloseTo(122 * AU_PC, 12);
  });

  it('points toward the solar apex (RA 17h53m, Dec +27.4°)', () => {
    // Apex direction: cos(Dec)cos(RA), cos(Dec)sin(RA), sin(Dec).
    const ra = (17 + 53 / 60) * 15 * Math.PI / 180;
    const dec = 27.4 * Math.PI / 180;
    const expectedX = Math.cos(dec) * Math.cos(ra);
    const expectedY = Math.cos(dec) * Math.sin(ra);
    const expectedZ = Math.sin(dec);

    const r = Math.hypot(
      HELIOPAUSE_APEX_LOCAL_PC.x,
      HELIOPAUSE_APEX_LOCAL_PC.y,
      HELIOPAUSE_APEX_LOCAL_PC.z,
    );
    expect(HELIOPAUSE_APEX_LOCAL_PC.x / r).toBeCloseTo(expectedX, 12);
    expect(HELIOPAUSE_APEX_LOCAL_PC.y / r).toBeCloseTo(expectedY, 12);
    expect(HELIOPAUSE_APEX_LOCAL_PC.z / r).toBeCloseTo(expectedZ, 12);
  });
});

describe('Heliopause', () => {
  it('group is hidden by default — gated on Sol-focus', () => {
    const h = new Heliopause();
    expect(h.group.visible).toBe(false);
    h.dispose();
  });

  it('setVisible(true) reveals the group', () => {
    const h = new Heliopause();
    h.setVisible(true);
    expect(h.group.visible).toBe(true);
    h.dispose();
  });

  it('setMonochrome hides the group even when otherwise visible', () => {
    const h = new Heliopause();
    h.setVisible(true);
    h.setMonochrome(true);
    expect(h.group.visible).toBe(false);
    h.setMonochrome(false);
    expect(h.group.visible).toBe(true);
    h.dispose();
  });

  it('group rotation maps local +Z onto the antiapex direction (forward heliotail)', () => {
    const h = new Heliopause();
    // The group's quaternion was built via setFromUnitVectors(+Z, antiapex).
    // Applying it to (0, 0, 1) should yield the antiapex direction.
    const localZ = new THREE.Vector3(0, 0, 1);
    localZ.applyQuaternion(h.group.quaternion);
    const apex = new THREE.Vector3(
      HELIOPAUSE_APEX_LOCAL_PC.x,
      HELIOPAUSE_APEX_LOCAL_PC.y,
      HELIOPAUSE_APEX_LOCAL_PC.z,
    ).normalize();
    expect(localZ.x).toBeCloseTo(-apex.x, 12);
    expect(localZ.y).toBeCloseTo(-apex.y, 12);
    expect(localZ.z).toBeCloseTo(-apex.z, 12);
    h.dispose();
  });

  it('mesh apex point in world coordinates lands at +122 AU along apex direction', () => {
    const h = new Heliopause();
    // The mesh sits at local (0, 0, +offset_AU) inside the group, and
    // local +Z = antiapex. The "upwind" surface point is at local
    // (0, 0, -semiMajor) = (0, 0, -161 AU). After translate (+39 AU on
    // local +Z) → mesh-relative (0, 0, -161 + 39) = (0, 0, -122 AU).
    // After group rotation (+Z → antiapex), that maps to apex × 122 AU.
    const apexLocalAu = new THREE.Vector3(0, 0, -122)
      .applyQuaternion(h.group.quaternion);
    const apex = new THREE.Vector3(
      HELIOPAUSE_APEX_LOCAL_PC.x,
      HELIOPAUSE_APEX_LOCAL_PC.y,
      HELIOPAUSE_APEX_LOCAL_PC.z,
    ).normalize();
    apexLocalAu.normalize();
    expect(apexLocalAu.x).toBeCloseTo(apex.x, 12);
    expect(apexLocalAu.y).toBeCloseTo(apex.y, 12);
    expect(apexLocalAu.z).toBeCloseTo(apex.z, 12);
    h.dispose();
  });
});
