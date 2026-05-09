import { useState, useMemo, useEffect, useRef } from "react";
import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';

/* ── constants ── */
// Roof C&C areas per ASCE 7 Table 30.3 (h≤60)
const CC_AREAS_ROOF = [10, 100, 500];
const CC_AREAS_WALL = [10, 100, 200, 500];

const ZMETA = {
  "1":  { label: "Zone 1",  desc: "Roof Field" },
  "1p": { label: "Zone 1’", desc: "Roof Field (interior)" },
  "2":  { label: "Zone 2",  desc: "Roof Edge" },
  "3":  { label: "Zone 3",  desc: "Roof Corner" },
  "oh1": { label: "Overhang Zone 1&1’", desc: "Overhang - Field" },
  "oh2": { label: "Overhang Zone 2",    desc: "Overhang - Edge" },
  "oh3": { label: "Overhang Zone 3",    desc: "Overhang - Corner" },
  "4":  { label: "Zone 4",  desc: "Wall Field" },
  "5":  { label: "Zone 5",  desc: "Wall Corner" },
};

const CODE_VERS = [
  { value: "7-22", label: "ASCE 7-22" },
  { value: "7-16", label: "ASCE 7-16" },
  { value: "7-10", label: "ASCE 7-10" },
  { value: "7-05", label: "ASCE 7-05" },
];
/* Topographic feature types for Kzt (ASCE 7 §26.8) */
const TOPO_TYPES = [
  { value: "flat",       label: "Flat (Kzt = 1.0)" },
  { value: "2d_ridge",   label: "2D Ridge" },
  { value: "2d_escarp",  label: "2D Escarpment" },
  { value: "3d_hill",    label: "3D Axisym. Hill" },
];

/* Gust effect factor modes (ASCE 7 §26.11) */
const GUST_MODES = [
  { value: "rigid_fixed", label: "Rigid — Fixed G = 0.85" },
  { value: "rigid_calc",  label: "Rigid — Calculated Gf" },
  { value: "flexible",    label: "Flexible / Resonant Gf" },
];

const EXPOSURES = [
  { value: "B", label: "Exp B" },
  { value: "C", label: "Exp C" },
  { value: "D", label: "Exp D" },
];
const ENCLOSURES = [
  { value: "enclosed", label: "Enclosed" },
  { value: "partially_enclosed", label: "Part. Enclosed" },
  { value: "open", label: "Open" },
];
const ROOFS = [
  { value: "gable",     label: "Gable",     mn: 0, mx: 45 },
  { value: "hip",       label: "Hip",       mn: 7, mx: 27 },
  { value: "monoslope", label: "Monoslope", mn: 0, mx: 30 },
];
const TABS = [
  { id: "qz",  label: "qz Profile" },
  { id: "dir", label: "MWFRS Dir." },
  { id: "lr",  label: "MWFRS LR" },
  { id: "cc",  label: "C&C" },
  { id: "ob",  label: "Open Bldg" },
  { id: "rw",  label: "Roof W" },
  { id: "ow",  label: "Other W" },
];

/* ── helpers ── */
const r2 = (v) => Math.round(v * 10) / 10;
const r4 = (v) => Math.round(v * 1e4) / 1e4;
const r6 = (v) => Math.round(v * 1e6) / 1e6;
const gcpiOf = (enc) => ({ enclosed: 0.18, partially_enclosed: 0.55, open: 0, partially_open: 0.18 }[enc] || 0.18);
const keOf  = (cv, el) => (cv >= "7-16" ? Math.exp(-0.0000362 * el) : 1);
// ASCE 7-05 and earlier use Importance Factor I applied to velocity pressure
// 7-10 and later bake risk category into the wind speed map instead
const importanceFactorOf = (cv, rc) => {
  if (cv !== "7-05") return 1.0;  // 7-10+ uses risk-category wind speed maps, I=1
  const map = { "I": 0.87, "II": 1.00, "III": 1.15, "IV": 1.15 };
  return map[rc] || 1.0;
};

function tcOf(cv, exp) {
  const db = {
    B: cv === "7-22" ? { a: 7.5, zg: 2460, zm: 30 } : { a: 7, zg: 1200, zm: 30 },
    C: { a: 9.5, zg: 900, zm: 15 },
    D: { a: 11.5, zg: 700, zm: 7 },
  };
  return db[exp] || db.C;
}

function defZ(h) {
  const pts = [15,20,25,30,40,50,60,70,80,90,100,120,140,160,200,300].filter((z) => z <= h);
  if (!pts.length || pts[pts.length - 1] < h) pts.push(h);
  return pts;
}

function compQz(V, exp, z, kd, ke, cv, kzt = 1.0, iw = 1.0) {
  const tc = tcOf(cv, exp);
  const zE = Math.max(z, tc.zm);
  const kz  = 2.01 * Math.pow(zE / tc.zg, 2 / tc.a);
  // qz = 0.00256 * Ke * Kz * Kzt * Kd * Iw * V^2
  // For 7-05: Iw = Importance Factor (0.87/1.0/1.15), Kd included as normal.
  // apiCC divides by kd for 7-05 before multiplying by GCp_net (which has Kd baked in).
  const qz  = 0.00256 * ke * kz * kzt * kd * iw * V * V;
  return { z, zE, kz: r6(kz), qz: r4(qz), alpha: tc.a, zg: tc.zg, zm: tc.zm };
}

function cpLW(ratio) {
  if (ratio <= 1) return -0.5;
  if (ratio < 2)  return -0.5 + (ratio - 1) * 0.2;
  if (ratio < 4)  return -0.3 + (ratio - 2) * 0.05;
  return -0.2;
}

function logInterp(x, a0, a1, y0, y1) {
  if (a0 === a1) return y0;
  const t = (Math.log10(x) - Math.log10(a0)) / (Math.log10(a1) - Math.log10(a0));
  return y0 + (y1 - y0) * Math.max(0, Math.min(1, t));
}

const minPsf = (v) => (Math.abs(v) < 16 ? Math.sign(v || 1) * 16 : v);

/* ── Topographic Factor Kzt (ASCE 7-22 §26.8, Table 26.8-1) ──────────
   Inputs from the spreadsheet's Kzt section:
     topoType : "flat" | "2d_ridge" | "2d_escarp" | "3d_hill"
     H        : Hill / escarpment height (ft)
     Lh       : Half-length of hill / escarpment (ft) upwind of crest
     x        : Distance from crest to site (ft), upwind = negative
     z        : Height above ground (ft)
     upwind   : true = upwind side, false = downwind
   Returns { kzt, k1, k2, k3, hLh, xLh, zLh }
─────────────────────────────────────────────────────────────────── */
function calcKzt(topoType, H, Lh, x, z, upwind) {
  if (topoType === "flat" || !H || !Lh) return { kzt: 1.0, k1: 0, k2: 1, k3: 1, hLh: 0, xLh: 0, zLh: 0, note: "Flat — Kzt = 1.0" };

  // H/Lh ratio (clamped to 0.5 per ASCE 7 §26.8.2 note)
  const hLh_raw = H / Lh;
  const hLh = Math.min(hLh_raw, 0.5);          // per ASCE 7 §26.8.2

  // Modified Lh: if H/Lh > 0.5, use Lh_mod = 2H
  const LhMod = hLh_raw > 0.5 ? 2 * H : Lh;

  // K1 — Table 26.8-1 (linear interp on H/Lh for each feature)
  // Values at H/Lh = 0.2, 0.3, 0.4, 0.5
  const K1_table = {
    "2d_ridge":  { gamma: 1.30 },
    "2d_escarp": { gamma: 0.75 },
    "3d_hill":   { gamma: 0.95 },
  };
  const gamma = K1_table[topoType]?.gamma ?? 0.95;
  const k1 = r4(gamma * hLh);

  // K2 — rate of decay with horizontal distance from crest
  const mu = {
    "2d_ridge":  { up: 1.5, dn: 1.5 },
    "2d_escarp": { up: 2.5, dn: 1.5 },
    "3d_hill":   { up: 1.5, dn: 1.5 },
  }[topoType] ?? { up: 1.5, dn: 1.5 };

  const absX = Math.abs(x);
  const xLhMod = absX / LhMod;
  const muVal = upwind ? mu.up : mu.dn;
  const k2 = r4(Math.max(0, 1 - xLhMod / muVal));

  // K3 — rate of decay with height above ground
  const nu = { "2d_ridge": 3, "2d_escarp": 2.5, "3d_hill": 4 }[topoType] ?? 3;
  const zLh = z / LhMod;
  const k3 = r4(Math.exp(-nu * zLh));

  const kzt = r4(Math.pow(1 + k1 * k2 * k3, 2));
  return { kzt, k1, k2, k3, hLh: r4(hLh), xLh: r4(xLhMod), zLh: r4(zLh), LhMod: r2(LhMod) };
}

/* ── Gust Effect Factor G (ASCE 7-22 §26.11) ────────────────────────
   mode: "rigid_fixed" → G = 0.85
         "rigid_calc"  → calculated G for rigid buildings
         "flexible"    → Gf for flexible / resonant buildings
   Inputs: exposure, h_ft (mean roof height), n1 (nat. freq Hz),
           beta (damping ratio), V_mph, code_version
─────────────────────────────────────────────────────────────────── */
function calcG(mode, exposure, h_ft, n1, beta, V_mph) {
  if (mode === "rigid_fixed") return { G: 0.85, mode, note: "Fixed G = 0.85 per §26.11.1" };

  // Terrain constants (Table 26.11-1)
  const tc = {
    B: { Iz_ref_z: 0.45, Lz_c: 320, Lz_eps: 1/3, bg: 0.84, alpha_bar: 1/7, b_bar: 0.84, cg: 0.45, lz_c: 0.30, eps_bar: 1/3, zmin: 30 },
    C: { Iz_ref_z: 0.65, Lz_c: 500, Lz_eps: 1/5, bg: 0.93, alpha_bar: 1/9.5, b_bar: 1.0, cg: 0.65, lz_c: 0.20, eps_bar: 1/5, zmin: 15 },
    D: { Iz_ref_z: 0.80, Lz_c: 650, Lz_eps: 1/8, bg: 0.95, alpha_bar: 1/11.5, b_bar: 1.07, cg: 0.80, lz_c: 0.15, eps_bar: 1/8, zmin: 7 },
  }[exposure] || { Iz_ref_z: 0.65, Lz_c: 500, Lz_eps: 1/5, bg: 0.93, alpha_bar: 1/9.5, b_bar: 1.0, cg: 0.65, lz_c: 0.20, eps_bar: 1/5, zmin: 15 };

  const z_bar = Math.max(0.6 * h_ft, tc.zmin);  // §26.11.1
  const Iz    = tc.cg * Math.pow(33 / z_bar, tc.eps_bar);  // turbulence intensity §26.11.1
  const Lz    = tc.Lz_c * Math.pow(z_bar / 33, tc.Lz_eps); // integral length scale

  const Q_sq  = 1 / (1 + 0.63 * Math.pow((3 + h_ft) / Lz, 0.63)); // background response
  const Q     = Math.sqrt(Q_sq);

  const gQ = 3.4, gv = 3.4;

  if (mode === "rigid_calc") {
    const G = r4(0.925 * (1 + 1.7 * Iz * gQ * Q) / (1 + 1.7 * gv * Iz));
    return { G, mode, Iz: r4(Iz), Lz: r2(Lz), Q: r4(Q), z_bar: r2(z_bar), note: "Rigid G calculated §26.11.1" };
  }

  // Flexible / resonant Gf
  const V_bar_z = tc.b_bar * Math.pow(z_bar / 33, tc.alpha_bar) * V_mph;  // mean hourly speed
  const N1 = n1 * Lz / V_bar_z;  // reduced frequency

  // Rn, Rh, RB, RL (resonant response factors)
  const Rn = 7.47 * N1 / Math.pow(1 + 10.3 * N1, 5/3);
  const fnR = (nu) => nu <= 0 ? 1 : (1/(2*nu) - 1/(2*nu*nu)*(1 - Math.exp(-2*nu)));
  const eta_h = 4.6 * n1 * h_ft / V_bar_z;
  const eta_B = 4.6 * n1 * 3 / V_bar_z;   // using B = 3 placeholder; caller should pass B
  const eta_L = 15.4 * n1 * h_ft / V_bar_z;
  const Rh = fnR(eta_h), RB = fnR(eta_B), RL = fnR(eta_L);
  const R_sq = (1 / beta) * Rn * Rh * RB * (0.53 + 0.47 * RL);
  const R = Math.sqrt(R_sq);

  const gR = Math.sqrt(2 * Math.log(600 * n1)) + 0.5772 / Math.sqrt(2 * Math.log(600 * n1));
  const Gf = r4(0.925 * (1 + 1.7 * Iz * Math.sqrt(gQ*gQ*Q*Q + gR*gR*R*R)) / (1 + 1.7 * gv * Iz));

  return { G: Gf, mode, Iz: r4(Iz), Lz: r2(Lz), Q: r4(Q), R: r4(R), gR: r4(gR), z_bar: r2(z_bar), note: "Flexible Gf §26.11.2" };
}

/* ────────────────────────────────────────────────────────────
   C&C GCp functions  (ASCE 7-22 Fig 30.3-2A, h ≤ 60 ft)

   Uses EXACT log-linear formulas extracted from spreadsheet cells
   C&C!DD68–DW155 — not piecewise breakpoints.

   Formula pattern: m * LOG10(area) + b, capped at area=100 for most
   negative roof zones (value flattens beyond 100 sf).

   Parapet conditional: Zone 3 negative = Zone 2 negative when
     min_parapet_ht >= 3 ft  (ASCE 7-22 Fig 30.3-2A Note 6)
   Same rule applies to Overhang Zone 3 when min_parapet_ht >= 3 ft.

   Zone 1' (interior field) uses separate breakpoints for both roof types.

   GCpi is NOT included — added externally in apiCC().
   Overhangs use GCpi = 0 per ASCE 7 §30.6 (enforced in apiCC).
──────────────────────────────────────────────────────────── */

// Continuous log-linear GCp — matches spreadsheet exactly
// All functions return NET pressure coefficients: (GCp - GCpi) for neg, (GCp + GCpi) for pos
// so apiCC can multiply directly by qh without a separate gcpi term.
// GCpi = 0.18 (enclosed) is baked into every coefficient.
// Overhangs use GCpi = 0 per ASCE 7 §30.6 (raw GCp only).

function _gcpLogLinear(area, m, b, capArea) {
  const a = capArea ? Math.min(area, capArea) : area;
  return m * Math.log10(a) + b;
}

function gcpRoof_hle60(area, roofType, theta, zone, sign, min_parapet_ht, codeVer) {
  const par = (min_parapet_ht == null) ? 0 : min_parapet_ht;
  const a = Math.max(area, 10);
  const isOld = codeVer === "7-10" || codeVer === "7-05";

  // ── ASCE 7-10 / 7-05 ────────────────────────────────────────────────────
  // Two sub-tables: theta<=10 uses reduced GCp (10% reduction per ASCE 7-05 §6.5.12.2.1)
  // theta>10 uses unreduced GCp. No Zone 1' in either table.
  if (isOld) {
    const lowSlope = theta <= 10;
    if (sign === "neg") {
      if (zone === "1" || zone === "1p") {
        if (lowSlope) return a <= 100 ? _gcpLogLinear(a, 0.1, -1.28, null) : -1.08;
        return _gcpLogLinear(a, 0.294296, -1.694296, 500);
      }
      if (zone === "2" || zone === "3") {  // Z3=Z2 always in 7-10
        if (lowSlope) return a <= 100 ? _gcpLogLinear(a, 0.7, -2.68, null) : -1.28;
        return _gcpLogLinear(a, 0.412014, -2.712014, 500);
      }
      if (zone === "oh1" || zone === "oh2") {
        if (lowSlope) {
          if (a <= 100) return _gcpLogLinear(a, 0.1, -1.8, null);
          return Math.min(-1.1, _gcpLogLinear(a, 0.715338, -3.030677, 500));
        }
        if (a <= 100) return _gcpLogLinear(a, 0.394, -2.694, null);
        return _gcpLogLinear(a, 0.437787, -2.781574, 500);
      }
      if (zone === "oh3") {
        // 7-10 OH Zone 3 = OH Zone 2 (same table)
        if (lowSlope) {
          if (a <= 100) return _gcpLogLinear(a, 0.1, -1.8, null);
          return Math.min(-1.1, _gcpLogLinear(a, 0.715338, -3.030677, 500));
        }
        if (a <= 100) return _gcpLogLinear(a, 0.394, -2.694, null);
        return _gcpLogLinear(a, 0.437787, -2.781574, 500);
      }
    } else {
      if (zone === "1" || zone === "1p") {
        if (lowSlope) return a <= 100 ? _gcpLogLinear(a, -0.1, 0.58, null) : 0.38;
        return a <= 100 ? _gcpLogLinear(a, -0.1, 0.58, null) : 0.38;
      }
      if (zone === "2" || zone === "3") {
        if (lowSlope) return Math.max(0.81, _gcpLogLinear(a, -0.15892, 1.23892, 500));
        return Math.max(0.81, _gcpLogLinear(a, -0.15892, 1.23892, 500));
      }
      return 0.0;
    }
    return sign === "neg" ? -1.08 : 0.38;
  }

  // ── MONOSLOPE theta <= 3 deg  (Fig 30.3-2A) ─────────────────────────────
  if (roofType === "monoslope" && theta <= 3) {
    if (sign === "neg") {
      if (zone === "1")  return _gcpLogLinear(a, 0.412014, -2.292014, 500);
      if (zone === "1p") {
        if (a <= 100) return -1.08;
        return _gcpLogLinear(a, 0.5, -2.08, 1000);
      }
      if (zone === "2")  return _gcpLogLinear(a, 0.529733, -3.009733, 500);
      if (zone === "3")  return par >= 3
        ? gcpRoof_hle60(area, roofType, theta, "2", sign, par, codeVer)
        : (a <= 100 ? _gcpLogLinear(a, 1.4297, -4.8097, null) : _gcpLogLinear(a, 0.529733, -3.009733, 500));
      if (zone === "oh1") {
        if (a <= 100) return _gcpLogLinear(a, 0.1, -1.8, null);
        return _gcpLogLinear(a, 0.858406, -3.316812, 500);
      }
      if (zone === "oh2") {
        return _gcpLogLinear(a, 0.705886, -3.006686, 500);
      }
      if (zone === "oh3") return par >= 3
        ? gcpRoof_hle60(area, roofType, theta, "oh2", sign, par, codeVer)
        : _gcpLogLinear(a, 0.705886, -3.006686, 500);
    } else {
      if (zone === "1" || zone === "1p") return a <= 100 ? _gcpLogLinear(a, -0.1, 0.58, null) : 0.38;
      if (zone === "2" || zone === "3")  return _gcpLogLinear(a, -0.15892, 1.23892, 500);
      return 0.0;
    }
  }

  // ── MONOSLOPE 3 < theta <= 10 deg  (Fig 30.3-2A) ────────────────────────
  if (roofType === "monoslope" && theta > 3 && theta <= 10) {
    if (sign === "neg") {
      if (zone === "1")  return -1.28;  // raw -1.1 - 0.18 = -1.28, flat all areas
      if (zone === "1p") {
        if (a <= 100) return -1.08;
        return _gcpLogLinear(a, 0.5, -2.08, 1000);
      }
      if (zone === "2")  return _gcpLogLinear(a, 0.529733, -3.009733, 500);
      if (zone === "3")  return par >= 3
        ? gcpRoof_hle60(area, roofType, theta, "2", sign, par, codeVer)
        : _gcpLogLinear(a, 0.529733, -3.009733, 500);
      if (zone === "oh1") {
        if (a <= 100) return _gcpLogLinear(a, 0.1, -1.8, null);
        return _gcpLogLinear(a, 0.858406, -3.316812, 500);
      }
      if (zone === "oh2") {
        return _gcpLogLinear(a, 0.705886, -3.006686, 500);
      }
      if (zone === "oh3") return par >= 3
        ? gcpRoof_hle60(area, roofType, theta, "oh2", sign, par, codeVer)
        : _gcpLogLinear(a, 0.705886, -3.006686, 500);
    } else {
      if (zone === "1" || zone === "1p") return a <= 100 ? _gcpLogLinear(a, -0.1, 0.58, null) : 0.38;
      if (zone === "2" || zone === "3")  return _gcpLogLinear(a, -0.15892, 1.23892, 500);
      return 0.0;
    }
  }

  // ── GABLE / HIP theta <= 7 deg  (Fig 30.3-1) ────────────────────────────
  if ((roofType === "gable" || roofType === "hip") && theta <= 7) {
    if (sign === "neg") {
      if (zone === "1")  return _gcpLogLinear(a, 0.412014, -2.292014, 500);
      if (zone === "1p") {
        if (a <= 100) return -1.08;
        return _gcpLogLinear(a, 0.5, -2.08, 1000);
      }
      if (zone === "2")  return _gcpLogLinear(a, 0.529733, -3.009733, 500);
      if (zone === "3")  return par >= 3
        ? gcpRoof_hle60(area, roofType, theta, "2", sign, par, codeVer)
        : (a <= 100 ? _gcpLogLinear(a, 1.4297, -4.8097, null) : _gcpLogLinear(a, 0.529733, -3.009733, 500));
      if (zone === "oh1") {
        if (a <= 100) return _gcpLogLinear(a, 0.1, -1.8, null);
        return _gcpLogLinear(a, 0.858406, -3.316812, 500);
      }
      if (zone === "oh2") {
        return _gcpLogLinear(a, 0.705886, -3.006686, 500);
      }
      if (zone === "oh3") return par >= 3
        ? gcpRoof_hle60(area, roofType, theta, "oh2", sign, par, codeVer)
        : _gcpLogLinear(a, 0.705886, -3.006686, 500);
    } else {
      if (zone === "1" || zone === "1p") return a <= 100 ? _gcpLogLinear(a, -0.2, 0.68, null) : 0.48;
      if (zone === "2" || zone === "3")  return _gcpLogLinear(a, -0.15892, 1.23892, 500);
      return 0.0;
    }
  }

  // ── GABLE 7 < theta <= 27 deg  (Fig 30.3-1) ─────────────────────────────
  // Raw: Z1 -1.7@10/-0.9@500; Z2 -2.6@10/-1.3@500; Z3 -3.2@10/-1.3@500
  if (roofType === "gable" && theta > 7 && theta <= 27) {
    if (sign === "neg") {
      if (zone === "1")  return _gcpLogLinear(a, 0.470436, -2.350436, 500);
      if (zone === "1p") {
        if (a <= 100) return -1.08;
        return _gcpLogLinear(a, 0.5, -2.08, 1000);
      }
      if (zone === "2")  return _gcpLogLinear(a, 0.76782, -3.59782, 500);
      if (zone === "3")  return par >= 3
        ? gcpRoof_hle60(area, roofType, theta, "2", sign, par, codeVer)
        : _gcpLogLinear(a, 1.064468, -4.714468, 500);
      if (zone === "oh1") {
        if (a <= 100) return _gcpLogLinear(a, 0.1, -1.8, null);
        return _gcpLogLinear(a, 0.858406, -3.316812, 500);
      }
      if (zone === "oh2") {
        return _gcpLogLinear(a, 0.705886, -3.006686, 500);
      }
      if (zone === "oh3") return par >= 3
        ? gcpRoof_hle60(area, roofType, theta, "oh2", sign, par, codeVer)
        : _gcpLogLinear(a, 0.705886, -3.006686, 500);
    } else {
      if (zone === "1" || zone === "1p") return a <= 100 ? _gcpLogLinear(a, -0.1, 0.58, null) : 0.38;
      if (zone === "2" || zone === "3")  return _gcpLogLinear(a, -0.15892, 1.23892, 500);
      return 0.0;
    }
  }

  // ── GABLE 27 < theta <= 45 deg  (Fig 30.3-1) ────────────────────────────
  // Raw: Z1/2/3 neg -1.6@10/-1.1@500 (relatively flat); pos Z2/3 +1.7@10/+1.1@500
  if (roofType === "gable" && theta > 27 && theta <= 45) {
    if (sign === "neg") {
      if (zone === "1")  return _gcpLogLinear(a, 0.294118, -2.174118, 500);
      if (zone === "1p") {
        if (a <= 100) return -1.08;
        return _gcpLogLinear(a, 0.5, -2.08, 1000);
      }
      if (zone === "2")  return _gcpLogLinear(a, 0.294118, -2.174118, 500);
      if (zone === "3")  return _gcpLogLinear(a, 0.294118, -2.174118, 500);
      if (zone === "oh1") {
        if (a <= 100) return _gcpLogLinear(a, 0.1, -1.8, null);
        return _gcpLogLinear(a, 0.858406, -3.316812, 500);
      }
      if (zone === "oh2") {
        return _gcpLogLinear(a, 0.705886, -3.006686, 500);
      }
      if (zone === "oh3") return par >= 3
        ? gcpRoof_hle60(area, roofType, theta, "oh2", sign, par, codeVer)
        : _gcpLogLinear(a, 0.705886, -3.006686, 500);
    } else {
      if (zone === "1" || zone === "1p") return a <= 100 ? _gcpLogLinear(a, -0.1, 0.58, null) : 0.38;
      if (zone === "2" || zone === "3")  return _gcpLogLinear(a, -0.294118, 2.174118, 500);
      return 0.0;
    }
  }

  // ── HIP 7 < theta <= 45 deg  (Fig 30.3-1) ───────────────────────────────
  // Hip: similar to gable but with zone 3 = zone 2 pattern
  if (roofType === "hip" && theta > 7 && theta <= 45) {
    if (sign === "neg") {
      if (zone === "1")  return _gcpLogLinear(a, 0.412014, -2.292014, 500);
      if (zone === "1p") {
        if (a <= 100) return -1.08;
        return _gcpLogLinear(a, 0.5, -2.08, 1000);
      }
      if (zone === "2")  return _gcpLogLinear(a, 0.529733, -3.009733, 500);
      if (zone === "3")  return gcpRoof_hle60(area, roofType, theta, "2", sign, par, codeVer);
      if (zone === "oh1") {
        if (a <= 100) return _gcpLogLinear(a, 0.1, -1.8, null);
        return _gcpLogLinear(a, 0.858406, -3.316812, 500);
      }
      if (zone === "oh2") {
        return _gcpLogLinear(a, 0.705886, -3.006686, 500);
      }
      if (zone === "oh3") return gcpRoof_hle60(area, roofType, theta, "oh2", sign, par, codeVer);
    } else {
      if (zone === "1" || zone === "1p") return a <= 100 ? _gcpLogLinear(a, -0.1, 0.58, null) : 0.38;
      if (zone === "2" || zone === "3")  return _gcpLogLinear(a, -0.15892, 1.23892, 500);
      return 0.0;
    }
  }

  // ── Fallback ─────────────────────────────────────────────────────────────
  if (sign === "neg") {
    if (zone === "1" || zone === "1p") return _gcpLogLinear(a, 0.412014, -2.292014, 500);
    if (zone.startsWith("oh")) {
      if (a <= 100) return _gcpLogLinear(a, 0.1, -1.8, null);
      return _gcpLogLinear(a, 0.858406, -3.316812, 500);
    }
    return _gcpLogLinear(a, 0.529733, -3.009733, 500);
  }
  return a <= 100 ? _gcpLogLinear(a, -0.1, 0.58, null) : 0.38;
}

function gcpWall_hle60(area, zone, sign, codeVer) {
  // Net (GCp +/- GCpi) wall coefficients — ASCE 7 Fig 30.3-1, h<=60
  // Wall GCp values are the SAME for all code versions (7-05 through 7-22).
  // The code-version difference for 7-05 walls is handled via qhCC in apiCC.
  const a = Math.min(Math.max(area, 10), 500);
  if (sign === "neg") {
    if (zone === "4") return 0.15892 * Math.log10(a) - 1.32892;   // -1.17@10, -0.9@500
    if (zone === "5") return 0.31784 * Math.log10(a) - 1.75784;   // -1.44@10, -0.9@500
  } else {
    if (zone === "4" || zone === "5") return -0.15892 * Math.log10(a) + 1.23892; // +1.08@10, +0.81@500
  }
  return sign === "neg" ? -1.08 : 0.81;
}

// ── h > 60 ft C&C  — Ch.30 Part 3 (Fig 30.4-1) ────────────────────────────
// Standard procedure: external GCp only; GCpi applied separately in apiCC.
// Areas: [10, 50, 100, 500] sf.  Zone 3 = Zone 2 when parapet>=3ft & theta<=10.
// Verified against Struware spreadsheet (h=65, qh=36.22, GCpi=0.18).
function gcpRoof_hgt60(area, zone, sign) {
  const a = Math.max(area, 10);
  if (sign === "neg") {
    if (zone === "1") {
      // -1.40@10 -> -0.90@500, cap at 500
      return 0.2943 * Math.log10(Math.min(a, 500)) - 1.6943;
    }
    if (zone === "1p") {
      // flat -0.9 up to 100sf, log-linear to -0.58@1000 (ASCE 7-22 Fig 30.4-1)
      if (a <= 100) return -0.9;
      return Math.max(-0.58, 0.5 * Math.log10(Math.min(a, 500)) - 1.9);
    }
    if (zone === "2") {
      // -2.30@10 -> -1.60@500, cap at 500
      return 0.4120 * Math.log10(Math.min(a, 500)) - 2.7120;
    }
    if (zone === "3") {
      // Same as Zone 2 when parapet>=3ft & theta<=10 (enforced in apiCC via zone3eq2).
      // Standalone curve: -2.30@10 -> -1.60@500
      return 0.4120 * Math.log10(Math.min(a, 500)) - 2.7120;
    }
  } else {
    // Positive — min 16 psf enforced externally
    if (a <= 100) return Math.max(0.2, -0.1 * Math.log10(a) + 0.4);
    return 0.2;
  }
  return sign === "neg" ? -1.0 : 0.2;
}

// ── Alternate C&C for 60 ft < h < 90 ft  — Ch.30 Alternate Procedure ───────
// Uses h<=60 GCp curve shapes extended to 1000 sf (net GCp, GCpi already baked).
// Base pressure = Kd*qh.  Areas: [10, 100, 500, 1000] sf.
// Verified against Struware spreadsheet alternate section (rows 19-27).
function gcpRoof_alt(area, zone, sign, roof, theta, minPar, codeVer) {
  // Alternate procedure: 60 ft < h < 90 ft.
  // Returns EXTERNAL GCp for 7-10 (GCpi applied separately in apiCC).
  // Returns NET GCp (GCpi baked in) for 7-16/7-22 (apiCC multiplies directly by qh).
  // All curves verified against Struware spreadsheet.
  const a = Math.max(area, 10);
  const is710 = codeVer === "7-10" || codeVer === "7-05";

  if (is710) {
    // ── ASCE 7-10 / 7-05 Alternate ─────────────────────────────────────────
    // External GCp only. Areas [10,50,100,500]. Two-segment, breakpoint at 100sf.
    // All zones flat (slope=0) beyond 100sf except Oh1&2 and Z2+/Z3+.
    // Zone 1' does not exist. Oh3 = Oh1&2.
    if (sign === "neg") {
      if (zone === "1") {
        // -1.0@10 -> -0.9@100, flat -0.9 beyond
        if (a <= 100) return 0.1000 * Math.log10(a) - 1.1000;
        return -0.9000;
      }
      if (zone === "2" || zone === "3") {
        // -1.8@10 -> -1.1@100, flat -1.1 beyond
        if (a <= 100) return 0.7000 * Math.log10(a) - 2.5000;
        return -1.1000;
      }
      if (zone === "oh1" || zone === "oh2" || zone === "oh3") {
        // Oh1&2&3 identical: -1.70@10 -> -1.60@100, then -1.60->-1.10@500
        if (a <= 100) return 0.0999 * Math.log10(a) - 1.7999;
        return 0.7153 * Math.log10(Math.min(a, 500)) - 3.0308;
      }
    } else {
      if (zone === "1" || zone === "1p") {
        // +0.30@10 -> +0.20@100, flat beyond
        if (a <= 100) return -0.1000 * Math.log10(a) + 0.4000;
        return 0.2000;
      }
      if (zone === "2" || zone === "3") {
        // +0.90@10 -> +0.63@500, single log-linear
        return -0.1589 * Math.log10(Math.min(a, 500)) + 1.0589;
      }
      return 0.2;
    }
    return sign === "neg" ? -1.0 : 0.2;
  }

  // ── ASCE 7-16 / 7-22 Alternate ───────────────────────────────────────────
  // NET GCp (GCpi baked in). Areas [10,100,500,1000].
  // h<=60 curve shapes extended to 1000sf.
  // Verified against Struware spreadsheet (7-22, h=65ft, Kd*qh=35.97psf).
  if (sign === "neg") {
    if (zone === "1") {
      if (a <= 100) return 0.4120 * Math.log10(a) - 2.2920;
      return 0.2880 * Math.log10(Math.min(a, 1000)) - 2.0440;
    }
    if (zone === "1p") {
      // flat -1.08 to 100sf, then log-linear to -0.58@1000
      if (a <= 100) return -1.08;
      return Math.max(-0.58, 0.5 * Math.log10(Math.min(a, 1000)) - 2.08);
    }
    if (zone === "2" || zone === "3") {
      if (a <= 100) return 0.5297 * Math.log10(a) - 3.0097;
      return 0.3703 * Math.log10(Math.min(a, 1000)) - 2.6909;
    }
    if (zone === "oh1") {
      if (a <= 100) return 0.1 * Math.log10(a) - 1.8;
      return 0.6 * Math.log10(Math.min(a, 1000)) - 2.8;
    }
    if (zone === "oh2" || zone === "oh3") {
      if (a <= 100) return 0.7063 * Math.log10(a) - 3.0063;
      return 0.4937 * Math.log10(Math.min(a, 1000)) - 2.5811;
    }
  } else {
    if (zone === "1" || zone === "1p") {
      if (a <= 100) return Math.max(0.38, -0.1 * Math.log10(a) + 0.58);
      return 0.38;
    }
    if (zone === "2" || zone === "3") {
      if (a <= 100) return Math.max(0.81, -0.1589 * Math.log10(a) + 1.2389);
      return Math.max(0.81, -0.1111 * Math.log10(Math.min(a, 1000)) + 1.1432);
    }
    return 0.2;
  }
  return sign === "neg" ? -1.0 : 0.2;
}

function gcpWall_hgt60(area, zone, sign) {
  // Wall zones 4' and 5' for h>60 — ASCE 7 Fig 30.4-1
  // Areas: [20, 100, 200, 500] sf  (min eff. wind area = 20sf for h>60 walls)
  // GCp is external only — GCpi applied separately in apiCC.
  // Verified from Struware spreadsheet (h=65ft, 7-22, qh=26.62, GCpi=0.18).
  //   Z4 neg: slope=+0.1431, int=-1.0861  → -0.90@20sf, -0.70@500sf
  //   Z5 neg: slope=+0.5723, int=-2.5445  → -1.80@20sf, -1.00@500sf
  //   Pos(4&5): slope=-0.2146, int=+1.1792 → +0.90@20sf, +0.60@500sf
  const a = Math.min(Math.max(area, 20), 500);
  if (sign === "neg") {
    if (zone === "4p") return  0.143068 * Math.log10(a) - 1.086135;
    if (zone === "5p") return  0.572271 * Math.log10(a) - 2.544541;
  } else {
    // Positive same for both zones
    return -0.214601 * Math.log10(a) + 1.179203;
  }
  return sign === "neg" ? -0.70 : 0.60;
}

function interpGCp(area, table) {
  // table: [[area, GCp], ...]
  if (area <= table[0][0]) return table[0][1];
  if (area >= table[table.length - 1][0]) return table[table.length - 1][1];
  for (let i = 0; i < table.length - 1; i++) {
    const [a0, g0] = table[i];
    const [a1, g1] = table[i + 1];
    if (area >= a0 && area <= a1) return logInterp(area, a0, a1, g0, g1);
  }
  return table[table.length - 1][1];
}

/* ── mock API ── */
async function apiQz(P) {
  const { project: p, geometry: g, kd, kztInputs } = P;
  const ke  = keOf(p.code_version, 0);
  const iw = importanceFactorOf(p.code_version, p.risk_category);
  // Compute Kzt at each height
  const rows = defZ(g.h_ft).map((z) => {
    const kztR = calcKzt(kztInputs.topo_type, kztInputs.H_ft, kztInputs.Lh_ft,
                         kztInputs.x_ft, z, kztInputs.upwind);
    const c = compQz(p.V_mph, p.exposure, z, kd, ke, p.code_version, kztR.kzt, iw);
    return { z_ft: z, kz: c.kz, kzt: kztR.kzt, qz_psf: c.qz, alpha: c.alpha, zg_ft: c.zg, ke: r6(ke), kd };
  });
  // Kzt at mean roof height (for header chip)
  const kztH = calcKzt(kztInputs.topo_type, kztInputs.H_ft, kztInputs.Lh_ft,
                       kztInputs.x_ft, g.h_ft, kztInputs.upwind);
  return { code_version: p.code_version, V_mph: p.V_mph, exposure: p.exposure, pressures: rows, kztH: kztH.kzt };
}

async function apiDir(P) {
  const { project: p, geometry: g, kd, kztInputs, gustInputs } = P;
  const ke = keOf(p.code_version, 0);
  const iw = importanceFactorOf(p.code_version, p.risk_category);
  const kztH = calcKzt(kztInputs.topo_type, kztInputs.H_ft, kztInputs.Lh_ft,
                       kztInputs.x_ft, g.h_ft, kztInputs.upwind).kzt;
  const gRes = calcG(gustInputs.mode, p.exposure, g.h_ft, gustInputs.n1, gustInputs.beta, p.V_mph);
  const G    = gRes.G;
  const gcpi = gcpiOf(p.enclosure);
  const qhC  = compQz(p.V_mph, p.exposure, g.h_ft, kd, ke, p.code_version, kztH, iw);
  const qh   = qhC.qz;
  const isKdAtPressure = p.code_version === "7-05" || p.code_version === "7-10";
  const qhD  = isKdAtPressure ? qh / kd : qh; // 7-05 & 7-10: Kd applied at pressure level, not in qz

  const bl = g.B_ft / g.L_ft;
  const lb = g.L_ft / g.B_ft;
  const hb = g.h_ft / g.B_ft;
  const hl = g.h_ft / g.L_ft;

  const cLW_normal   = r4(cpLW(bl));
  const cLW_parallel = r4(cpLW(lb));

  const interpRoof = (ratio, cp05, cp10) => {
    if (ratio <= 0.5) return cp05;
    if (ratio >= 1.0) return cp10;
    return cp05 + (cp10 - cp05) * (ratio - 0.5) / 0.5;
  };
  const roofNormal = [
    { zone: "0 to h/2",   cp: interpRoof(hb, -0.9, -1.04) },
    { zone: "h/2 to h",   cp: interpRoof(hb, -0.9, -0.7) },
    { zone: "h to 2h",    cp: interpRoof(hb, -0.5, -0.7) },
    { zone: "> 2h",       cp: interpRoof(hb, -0.3, -0.7) },
    { zone: "WW pos/min", cp: -0.18 },
  ];
  const roofParallel = [
    { zone: "0 to h/2",   cp: interpRoof(hl, -0.9, -1.04) },
    { zone: "h/2 to h",   cp: interpRoof(hl, -0.9, -0.7) },
    { zone: "h to 2h",    cp: interpRoof(hl, -0.5, -0.7) },
    { zone: "> 2h",       cp: interpRoof(hl, -0.3, -0.7) },
    { zone: "WW pos/min", cp: -0.18 },
  ];

  // LW pressures (constant at all heights) for both directions
  const lwPrs = {
    normal:   { pN: r2(qhD*G*cLW_normal   - qhD*gcpi), pP: r2(qhD*G*cLW_normal   + qhD*gcpi) },
    parallel: { pN: r2(qhD*G*cLW_parallel  - qhD*gcpi), pP: r2(qhD*G*cLW_parallel  + qhD*gcpi) },
  };

  // Merge standard + user-added heights
  const allHeights = [...new Set([...defZ(g.h_ft), ...(g.extraHeights||[])])].sort((a,b)=>a-b);

  const profile = allHeights.map((z) => {
    const kztZ = calcKzt(kztInputs.topo_type, kztInputs.H_ft, kztInputs.Lh_ft,
                         kztInputs.x_ft, z, kztInputs.upwind).kzt;
    const c      = compQz(p.V_mph, p.exposure, z, kd, ke, p.code_version, kztZ, iw);
    const qzForPress = isKdAtPressure ? c.qz / kd : c.qz;
    const qzGCp  = qzForPress * G * 0.8;
    const pN_ww  = r2(qzGCp - qhD * gcpi);
    const pP_ww  = r2(qzGCp + qhD * gcpi);
    return {
      z_ft: z, kz: c.kz, kzt: kztZ,
      pN: pN_ww, pP: pP_ww,
      combN_normal:   r2(pN_ww - lwPrs.normal.pN),
      combP_normal:   r2(pP_ww - lwPrs.normal.pP),
      combN_parallel: r2(pN_ww - lwPrs.parallel.pN),
      combP_parallel: r2(pP_ww - lwPrs.parallel.pP),
    };
  });

  const gcpn = p.code_version === "7-02" ? [1.8, -1.1] : [1.5, -1.0];
  // qp for MWFRS parapet per §27.3.4: velocity pressure at top of parapet
  // parapet_height_ft = height above GROUND (Code!F38), not above roof
  const zParapet = g.parapet_height_ft || 0;  // absolute height above ground
  const kztPar   = calcKzt(kztInputs.topo_type, kztInputs.H_ft, kztInputs.Lh_ft, kztInputs.x_ft, zParapet, kztInputs.upwind).kzt;
  const qp_par_raw = compQz(p.V_mph, p.exposure, zParapet, kd, ke, p.code_version, kztPar, iw).qz;
  const qp_par = isKdAtPressure ? qp_par_raw / kd : qp_par_raw;
  const pLW_n = qhD * G * cLW_normal;
  const pSW   = qhD * G * -0.7;
  const pWW   = qhD * G * 0.8;
  const pR_n  = qhD * G * roofNormal[0].cp;
  const pLW_p = qhD * G * cLW_parallel;

  return {
    qh: r2(qhD), G, gcpi, kd, V: p.V_mph, L: g.L_ft, B: g.B_ft, h: g.h_ft,
    cWW: 0.8, cSW: -0.7,
    cLW_n: cLW_normal, ratioLW_n: r4(bl), ratioRoof_n: r4(hb), roofNormal,
    lwP_n: r2(pLW_n - qhD*gcpi), lwN_n: r2(pLW_n + qhD*gcpi),
    cLW_p: cLW_parallel, ratioLW_p: r4(lb), ratioRoof_p: r4(hl), roofParallel,
    lwP_p: r2(pLW_p - qhD*gcpi), lwN_p: r2(pLW_p + qhD*gcpi),
    swP: r2(pSW - qhD*gcpi), swN: r2(pSW + qhD*gcpi),
    profile, parWW: r2(qp_par*gcpn[0]), parLW: r2(qp_par*gcpn[1]),
    parZ: zParapet, parKz: r4(compQz(p.V_mph, p.exposure, zParapet, kd, ke, p.code_version, kztPar, iw).kz), parKzt: r4(kztPar), parQp: r2(qp_par),
    oh: r2(qhD * G * 0.8), G, gRes, kztH, lwPrs, qhD: r2(qhD),
    iw, code_version: p.code_version,
    pLW_n: r2(pLW_n),   // bare qhD·G·Cp_LW_normal   without GCpi — used by calcExtra combined
    pLW_p: r2(pLW_p),   // bare qhD·G·Cp_LW_parallel without GCpi — used by calcExtra combined
  };
}

async function apiLR(P) {
  const { project: p, geometry: g, kd } = P;
  const gcpi = gcpiOf(p.enclosure);
  if (g.h_ft > 60) return { ok:false, reason:"h > 60 ft", qh:0, gcpi, ez:0, cA:[], cB:[], pww:0, plw:0, sd:null };
  if (g.h_ft > g.B_ft) return { ok:false, reason:"h > B",   qh:0, gcpi, ez:0, cA:[], cB:[], pww:0, plw:0, sd:null };
  const ke   = keOf(p.code_version, 0);
  const iw = importanceFactorOf(p.code_version, p.risk_category);
  const kztH = calcKzt(P.kztInputs.topo_type, P.kztInputs.H_ft, P.kztInputs.Lh_ft,
                       P.kztInputs.x_ft, g.h_ft, P.kztInputs.upwind).kzt;
  const qh   = compQz(p.V_mph, p.exposure, g.h_ft, kd, ke, p.code_version, kztH, iw).qz;
  const isKdAtPressureLR = p.code_version === "7-05" || p.code_version === "7-10";
  const qhL = isKdAtPressureLR ? qh / kd : qh;
  const a    = Math.max(Math.min(0.1*Math.min(g.L_ft,g.B_ft), 0.4*g.h_ft), 3);
  const A  = { "1":0.4,"2":-0.69,"3":-0.37,"4":-0.29,"1E":0.61,"2E":-1.07,"3E":-0.53,"4E":-0.43 };
  const B  = { "1":-0.45,"2":-0.69,"3":-0.37,"4":-0.45,"5":0.4,"6":-0.29,"1E":-0.48,"2E":-1.07,"3E":-0.53,"4E":-0.48,"5E":0.61,"6E":-0.43 };
  const mk = (s) => Object.entries(s).map(([z,v]) => ({ zone:z, gcpf:v, pN:r2(qhL*(v+gcpi)), pP:r2(qhL*(v-gcpi)) }));
  const gcpn = p.code_version === "7-02" ? [1.8,-1.1] : [1.5,-1.0];
  // Horizontal MWFRS Simple Diaphragm (§28.4) — zones 5/6 for walls, 2/3 for roof
  const edgeA = r2(a), end2a = r2(2*a);
  const sd_tw_int = r2(qhL*(B["5"]-B["6"]));
  const sd_tw_end = r2(qhL*(B["5E"]-B["6E"]));
  const sd_tr_int = r2(qhL*(A["2"]-A["3"]));
  const sd_tr_end = r2(qhL*(A["2E"]-A["3E"]));
  const minH = 16;
  const sd = {
    a: edgeA, endZone2a: end2a,
    transverse:  { intWall:r2(Math.max(sd_tw_int,minH)), endWall:r2(Math.max(sd_tw_end,minH)), intRoof:sd_tr_int, endRoof:sd_tr_end },
    longitudinal:{ intWall:r2(Math.max(sd_tw_int,minH)), endWall:r2(Math.max(sd_tw_end,minH)) },
  };

  // ── Longitudinal Directional Force §28.4.4 (open/partially enclosed, transverse frames) ──
  const theta_rad = (g.roof_angle_deg || 0) * Math.PI / 180;
  const eave_ht   = g.h_ft;
  const ridge_ht  = g.roof_angle_deg <= 10
    ? eave_ht + Math.tan(theta_rad) * g.B_ft / 2
    : eave_ht + Math.tan(theta_rad) * g.B_ft / 4;
  const Ae_auto   = (ridge_ht + eave_ht) * g.B_ft / 2;
  const Ae        = Ae_auto;
  // As: user-supplied solid end wall area (incl. fascia). 0 means open frame.
  const As_raw    = g.lng_As_sf || 0;
  const As        = As_raw > 0 ? As_raw : 0;
  const n_raw     = g.lng_n_frames >= 1 ? g.lng_n_frames : 1;
  const n_eff     = Math.max(n_raw, 3);
  const phi       = Ae > 0 ? As / Ae : 0;
  const KB        = g.B_ft >= 100 ? 0.8 : 1.8 - 0.01 * g.B_ft;
  const KS        = 0.6 + 0.073 * (n_eff - 3) + 1.25 * Math.pow(phi, 1.8);
  // Zone 5E&6E area = a × eave_ht + (tan θ × B/4) × a/2
  const area5E6E  = a * eave_ht + (Math.tan(theta_rad) * g.B_ft / 4) * a / 2;
  const area56    = Ae - area5E6E;
  // GCpf values from Case B table: zone5=B["5"], zone6=B["6"], zone5E=B["5E"], zone6E=B["6E"]
  const gcpf_diff = Ae > 0
    ? ((B["5"] - B["6"]) * area56 + (B["5E"] - B["6E"]) * area5E6E) / Ae
    : 0;
  const p_lng  = r2(qhL * gcpf_diff * KB * KS);   // qh already includes Kd
  const F_lng  = r2(Ae * p_lng / 1000);   // kips
  const lng = { ridge_ht:r2(ridge_ht), eave_ht:r2(eave_ht), Ae:r2(Ae), As, phi:r4(phi),
                n_eff, KB:r2(KB), KS:r4(KS), area56:r2(area56), area5E6E:r2(area5E6E),
                gcpf_diff:r4(gcpf_diff), p_lng, F_lng };

  // Windward roof overhang — LR method:
  // 7-05: GCpf does NOT embed G → use qhL × G × 0.8  (same as Dir formula)
  // 7-10+: GCpf already embeds G → use qhL × 0.70  (≈ zone2 upward on soffit)
  const G_lr = 0.85;
  const oh_lr = r2(p.code_version === "7-05" ? qhL * G_lr * 0.8 : qhL * 0.70);
  return { ok:true, reason:"", qh:r2(qhL), gcpi, ez:r2(2*a), cA:mk(A), cB:mk(B), pww:r2(qhL*gcpn[0]), plw:r2(qhL*gcpn[1]), oh:oh_lr, sd, lng };
}

/* ─────────────────────────────────────────────────────────────────────
   ELEVATED BUILDING  —  ASCE 7-22 §27.1.5
───────────────────────────────────────────────────────────────────── */
async function apiElevated(P) {
  const { project: p, geometry: g, kd, kztInputs } = P;
  const hb = g.hb_ft || 0;
  if (hb <= 0) return { ok: false, reason: "hb = 0 — building is not elevated" };
  if (p.code_version !== "7-22") return { ok: false, reason: "Elevated building procedure is ASCE 7-22 only" };

  const ke = keOf(p.code_version, 0);
  const iw = importanceFactorOf(p.code_version, p.risk_category);
  const G  = 0.85;
  const gcpi = gcpiOf(p.enclosure);
  const L = g.L_ft, B = g.B_ft;

  // ── Geometry Limitation 1 — area ratio ─────────────────────────────
  const cols_area   = g.elev_cols_area_sf  || 0;
  const enc_area    = g.elev_enc_area_sf   || 0;
  const total_below = cols_area + enc_area;
  const footprint   = L * B;
  const area_ratio  = footprint > 0 ? total_below / footprint : 0;

  const LB_PTS = [[2.5,0.50],[3.0,0.45],[3.5,0.40],[4.0,0.36],[4.5,0.33],[5.0,0.30]];
  function maxRatio(lb) {
    if (lb <= LB_PTS[0][0]) return LB_PTS[0][1];
    for (let i = 0; i < LB_PTS.length - 1; i++) {
      const [a0,y0] = LB_PTS[i], [a1,y1] = LB_PTS[i+1];
      if (lb <= a1) return y0 + (lb - a0) / (a1 - a0) * (y1 - y0);
    }
    return 0.30;
  }
  const lb_d1 = B / L, lb_d2 = L / B;
  const maxR_d1 = maxRatio(lb_d1), maxR_d2 = maxRatio(lb_d2);
  const lim1_d1 = maxR_d1 > area_ratio;
  const lim1_d2 = maxR_d2 > area_ratio;

  // ── Geometry Limitation 2 — projected width ≤ 75% ──────────────────
  const colW_d1 = g.elev_col_width_d1_ft || 0;
  const encW_d1 = g.elev_enc_width_d1_ft || 0;
  const colW_d2 = g.elev_col_width_d2_ft || 0;
  const encW_d2 = g.elev_enc_width_d2_ft || 0;
  const projW_d1 = colW_d1 + encW_d1;
  const projW_d2 = colW_d2 + encW_d2;
  const projRatio_d1 = B > 0 ? projW_d1 / B : 0;
  const projRatio_d2 = L > 0 ? projW_d2 / L : 0;
  const lim2_d1 = projRatio_d1 <= 0.75;
  const lim2_d2 = projRatio_d2 <= 0.75;
  const elev_d1 = lim1_d1 && lim2_d1;
  const elev_d2 = lim1_d2 && lim2_d2;
  const anyElev = elev_d1 || elev_d2;

  // ── Horizontal pressure on objects 0 to hb ─────────────────────────
  const z_eval = Math.max(hb, 15);
  const qzRes  = compQz(p.V_mph, p.exposure, z_eval, kd, ke, p.code_version,
                        calcKzt(kztInputs.topo_type, kztInputs.H_ft, kztInputs.Lh_ft,
                                kztInputs.x_ft, z_eval, kztInputs.upwind).kzt);
  const qzEval = qzRes.qz, kzEval = qzRes.kz;
  const kztZ   = calcKzt(kztInputs.topo_type, kztInputs.H_ft, kztInputs.Lh_ft,
                          kztInputs.x_ft, z_eval, kztInputs.upwind).kzt;
  const p_horiz = r2(qzEval * G * 1.3);
  const force_d1 = projW_d1 > 0 ? r2(p_horiz * projW_d1 * hb / 2000) : null;
  const force_d2 = projW_d2 > 0 ? r2(p_horiz * projW_d2 * hb / 2000) : null;

  // ── Vertical pressure on bottom surface ────────────────────────────
  function areaReduction(area) {
    if (area <= 100) return 1.0;
    if (area < 200)  return 1.0 - (area - 100) * 0.1 / 100;
    if (area < 1000) return 0.9 - (area - 200) * 0.1 / 800;
    return 0.8;
  }
  const rf_n = areaReduction((g.h_ft / 2) * L);
  const rf_p = areaReduction((g.h_ft / 2) * B);
  const hbL_n = L > 0 ? hb / L : 0;
  const hbL_p = B > 0 ? hb / B : 0;

  function cpVert(zone, hbL, rf) {
    const left  = { 1: -0.90, 2: -0.90, 3: -0.50, 4: -0.30 };
    const right = { 1: -1.30 * rf, 2: -0.70, 3: -0.70, 4: -0.70 };
    if (hbL <= 0.5) return left[zone];
    if (hbL >= 1.0) return right[zone];
    const t = (hbL - 0.5) / 0.5;
    return left[zone] + t * (right[zone] - left[zone]);
  }

  function vertZones(hbL, rf) {
    const zones = [
      { label: "0 to hb/2*",  zone: 1 },
      { label: "hb/2 to hb*", zone: 2 },
      { label: "hb to 2hb*",  zone: 3 },
    ];
    if (hbL < 0.5) zones.push({ label: "> 2hb*", zone: 4 });
    const rows = zones.map(({ label, zone }) => {
      const cp    = r4(cpVert(zone, hbL, rf));
      const qhGCp = r2(qzEval * G * cp);
      const pPos  = r2(qzEval * G * cp - qzEval * gcpi);  // w/+GCpi
      const pNeg  = r2(qzEval * G * cp + qzEval * gcpi);  // w/-GCpi
      return { label, cp, qhGCp, pPos, pNeg };
    });
    // §27.1.5 minimum upward net pressure row (Cp = -GCpi)
    const cpMin  = -gcpi;
    rows.push({
      label:  "Upward or min wind pressure",
      cp:     r4(cpMin),
      qhGCp:  r2(qzEval * G * cpMin),
      pPos:   r2(qzEval * G * cpMin - qzEval * gcpi),
      pNeg:   r2(qzEval * G * cpMin + qzEval * gcpi),
      isMin:  true,
    });
    return rows;
  }

  return {
    ok: true, hb, anyElev, elev_d1, elev_d2,
    area_ratio: r4(area_ratio), footprint, total_below,
    lim1_d1, lim1_d2, maxR_d1: r4(maxR_d1), maxR_d2: r4(maxR_d2),
    projRatio_d1: r4(projRatio_d1), projRatio_d2: r4(projRatio_d2),
    lim2_d1, lim2_d2, projW_d1, projW_d2,
    z_eval, kzEval: r4(kzEval), kztZ: r4(kztZ), qzEval: r2(qzEval),
    p_horiz, force_d1, force_d2,
    hbL_n: r4(hbL_n), hbL_p: r4(hbL_p), rf_n: r4(rf_n), rf_p: r4(rf_p),
    vert_normal: vertZones(hbL_n, rf_n),
    vert_parallel: vertZones(hbL_p, rf_p),
    gcpi,
  };
}

/* ─────────────────────────────────────────────────────────────────────
   ROOF W  — Rooftop Structures, Canopies, Solar Panels
   §27.3.3 (rooftop equip), Ch.30 (canopy), §29.4.4 (solar parallel),
   §29.4.5 (solar not-parallel)
───────────────────────────────────────────────────────────────────── */
async function apiRW(P) {
  const { project: p, geometry: g, kd, kztInputs } = P;
  const ke   = keOf(p.code_version, 0);
  const iw = importanceFactorOf(p.code_version, p.risk_category);
  const kztH = calcKzt(kztInputs.topo_type, kztInputs.H_ft, kztInputs.Lh_ft,
                       kztInputs.x_ft, g.h_ft, kztInputs.upwind).kzt;
  const qh   = compQz(p.V_mph, p.exposure, g.h_ft, kd, ke, p.code_version, kztH, iw).qz; // Kd·qh

  const is705    = p.code_version === "7-05";
  const isKdAtPressureRW = p.code_version === "7-05" || p.code_version === "7-10";
  // Equipment §29.4.1: same Kd=0.85 as the building for all codes
  const qhEquip  = r2(qh);
  // Solar/canopy uses Kd=0.85 (C&C). For 7-05 & 7-10: remove Kd; others: qh as-is
  const qhSolar  = r2(isKdAtPressureRW ? qh / kd : qh);
  // Minimum solar panel pressure: 10 psf (ASD, 7-05 §6.1.4.1) vs 16 psf (LRFD, 7-10+ §29.4)
  const minSolar = is705 ? 10 : 16;
  // 7-16/7-22: GCr method — F = Kd·qh × GCr × A
  //   GCr = 1.5 vertical, 1.9 horizontal; Ar = plan area; Af = face area
  // 7-05 (§6.5.15.2): Cf method — F = qz_c × G × Cf × adj × Af
  //   qz_c at equipment centroid height; G=0.85; Cf from h/b table; adj from h_eq/h_bldg

  function interpCf7_05(hb) {
    // Cf table: breakpoints h/b = [1, 7, 25], Cf = [1.3, 1.4, 2.0]
    if (hb <= 1)  return 1.3;
    if (hb <= 7)  return 1.3 + (1.4 - 1.3) / 6 * (hb - 1);
    if (hb <= 25) return 1.4 + (2.0 - 1.4) / 18 * (hb - 7);
    return 2.0;
  }

  function adjFactor7_05(hEq, H) {
    // ASCE 7-05 §6.5.15: horizontal force amplification factor = 1.9
    // Consistent with GCr_h = 1.9 from §29.4.1 (applied on top of Cf from Table 6-8)
    return 1.9;
  }

  function calcEquip(lL, lB, hEq) {
    const Ar   = lL * lB;
    const Af_B = lB * hEq;
    const Af_L = lL * hEq;

    if (is705) {
      // 7-05: Cf/Af method at centroid height
      const G705 = 0.85;
      const Kd705 = 0.9;  // ASCE 7-05 Table 6-4 for rooftop structures
      const z_c = g.h_ft + hEq / 2;  // height to equipment centroid above ground
      const kztC = calcKzt(kztInputs.topo_type, kztInputs.H_ft, kztInputs.Lh_ft,
                            kztInputs.x_ft, Math.max(z_c, 15), kztInputs.upwind).kzt;
      // 7-05 §6.5.15.2: qz evaluated at mean roof height z=h, NO Kd in velocity pressure
      // Kd=0.9 for rooftop structures applied at force level via adj factor
      const qzC = compQz(p.V_mph, p.exposure, Math.max(g.h_ft, 15), 1.0, ke,
                          p.code_version, kztC, iw).qz;
      const adj = adjFactor7_05(hEq, g.h_ft);
      const Cf_B = interpCf7_05(hEq / lB);
      const Cf_L = interpCf7_05(hEq / lL);
      const unit_B = r2(qzC * G705 * adj);   // psf (unit pressure without Cf or Af)
      const unit_L = r2(qzC * G705 * adj);
      return {
        Ar: r2(Ar), Af_B: r2(Af_B), Af_L: r2(Af_L),
        method: "Cf", G: G705, qzC: r2(qzC), adj: r4(adj),
        Cf_B: r4(Cf_B), Cf_L: r4(Cf_L),
        unit_B, unit_L,
        Fh_B: r4(Af_B * unit_B * Cf_B / 1000),
        Fh_L: r4(Af_L * unit_L * Cf_L / 1000),
        Fv: 0,  // 7-05 §6.5.15 horizontal forces only from Cf method
      };
    }

    // 7-10/7-16/7-22: GCr method. For 7-10: Kd removed from qh (same as solar/C&C convention)
    const qhGCr = isKdAtPressureRW ? qhSolar : qhEquip;
    const GCr_v = 1.5, GCr_h = 1.9;
    const unit_v  = r2(qhGCr * GCr_v);
    const unit_hB = r2(qhGCr * GCr_h);
    const unit_hL = r2(qhGCr * GCr_h);
    return {
      Ar: r2(Ar), Af_B: r2(Af_B), Af_L: r2(Af_L),
      method: "GCr", GCr_v, GCr_h,
      unit_v, unit_hB, unit_hL,
      Fv:   r4(Ar   * unit_v  / 1000),
      Fh_B: r4(Af_B * unit_hB / 1000),
      Fh_L: r4(Af_L * unit_hL / 1000),
    };
  }
  // Compute forces for all equipment items in the dynamic array
  const equipList = (g.rw_equip && g.rw_equip.length) ? g.rw_equip : [{ lL:10, lB:5, h:5 }];
  const equip = equipList.map(e => calcEquip(e.lL||5, e.lB||5, e.h||5));
  // Keep legacy eq1/eq2 for backward compat with any other references
  const eq1 = equip[0] ?? null;
  const eq2 = equip[1] ?? null;

  // ── Attached Canopies h ≤ 60 ft ──────────────────────────────────────
  // GCp coefficients from ASCE 7 Fig. 30.9-1, log-interpolated over area
  // hc/he bracket: <0.5 → coeff=-0.6/-0.5; 0.5–0.9 → -0.9/-0.65; ≥0.9 → -1.4/etc.
  // Upper neg: -1.15 at ≤10sf, -0.75 at >100sf, interp: -1.55+0.4*ln(A)/ln(10) (approx)
  // Spreadsheet uses: upper neg = (-1.55 + 0.4*LOG(A))*qh, lower neg = (-0.95+0.15*LOG(A))*qh etc.
  // Combined net = hc_he_factor × qh (from table), pos = 0.9*qh at ≤10sf, 0.65*qh at >100sf
  function canopyGCp(area, hc_he) {
    const q = qhSolar; // Canopy §30.11 uses Kd=0.85 (C&C), not 0.9 (rooftop equip)
    const gcNet = hc_he >= 0.9 ? -1.4 : hc_he > 0.5 ? -0.9 : -0.6;
    // Upper neg: -1.15 at ≤10, -0.75 at >100, log-interp between
    const upperNeg = area <= 10 ? -1.15*q : area >= 100 ? -0.75*q
      : (-1.55 + 0.4*Math.log10(area))*q;
    // Lower neg: -0.80 at ≤10, -0.65 at >100, log-interp
    const lowerNeg = area <= 10 ? -0.80*q : area >= 100 ? -0.65*q
      : (-0.95 + 0.15*Math.log10(area))*q;
    // Pos (upper or lower): 0.8 at ≤10, 0.6 at >100
    const pos = area <= 10 ? 0.80*q : area >= 100 ? 0.60*q
      : (1.0 - 0.087*Math.log(area))*q;  // natural log
    // Combined net neg: gcNet * qh, pos: 0.9 at ≤10, 0.65 at >100
    const combNeg = gcNet * q;
    const combPos = area <= 10 ? 0.9*q : area >= 100 ? 0.65*q
      : (1.15 - 0.1086*Math.log(area))*q;  // natural log
    return {
      upperNeg:r2(upperNeg), lowerNeg:r2(lowerNeg), pos:r2(pos),
      combNeg:r2(combNeg), combPos:r2(combPos),
    };
  }
  let canopy = null;
  if (g.rw_can_en) {
    const he = g.rw_can_he || 60, hc = g.rw_can_hc || 45;
    const hc_he = he > 0 ? hc / he : 0;
    const areas = [10, 20, 50, 100];
    canopy = {
      he: r2(he), hc: r2(hc), hc_he: r4(hc_he),
      areas,
      rows: areas.map(a => ({ area:a, ...canopyGCp(a, hc_he) })),
    };
  }

  // ── Solar Panels — Parallel to Roof (w ≤ 2°) §29.4.4 ────────────────
  // ga formula (ASCE 7-22) from spreadsheet:
  //   ga_base  = A≤10→0.6, A≥100→0.4, else 0.7978−0.086·ln(A)
  //   ga_solid = A≤10→0.8, A≥100→0.4, else 1.201−0.174·ln(A)
  //   gap_f1   = gap_in<0.25→1, >0.75→0, else 1−(gap−0.25)/0.5
  //   gap_f2   = h2_in<5→0, >10→1, else 1−(10−h2_in)/5
  //   AO97     = (gap_f1+gap_f2)/2
  //   ga       = ga_base + (ga_solid−ga_base)·AO97
  const gap_in = g.rw_sol_np_gap || 0.25;
  const h2_in  = (g.rw_sol_np_h2 || 0.8) * 12;
  const d1_par = g.rw_sol_np_d1  || 18.4;
  const d2_par = g.rw_sol_np_d2  || 1;
  const h2_par = g.rw_sol_np_h2  || 0.8;
  const gap_f1 = gap_in < 0.25 ? 1 : gap_in > 0.75 ? 0 : 1 - (gap_in - 0.25) / 0.5;
  const gap_f2 = h2_in  < 5    ? 0 : h2_in  > 10   ? 1 : 1 - (10 - h2_in) / 5;
  const AO97   = (gap_f1 + gap_f2) / 2;

  function solarParGaAt(A) {
    const base   = A <= 10 ? 0.6  : A >= 100 ? 0.4 : 0.7978 - 0.086 * Math.log(A);
    const solid  = A <= 10 ? 0.8  : A >= 100 ? 0.4 : 1.201  - 0.174 * Math.log(A);
    return r4(base + (solid - base) * AO97);
  }

  // Exposure check for parallel solar (same criteria as not-parallel)
  const par_exposed = d1_par > 0.5 * g.h_ft && (d1_par > Math.max(4*h2_par, 4) || d2_par > Math.max(4*h2_par, 4));

  let solarPar = null;
  // Always compute (toggle controls UI only)
  {
    const userArea = g.rw_sol_par_area || 34;
    const ga_user  = solarParGaAt(userArea);
    const areas_std = [10, 20, 50, 100];
    solarPar = {
      userArea, ga_user,
      AO97: r4(AO97), gap_f1: r4(gap_f1), gap_f2: r4(gap_f2),
      exposed: par_exposed,
      table: areas_std.map(a => {
        const ga = solarParGaAt(a);
        return { area:a, ga, exp_up:r4(1.5*ga), nonexp_up:r4(1.0*ga), down:r4(1.0*ga) };
      }),
      user_row: { area:userArea, ga:ga_user, exp_up:r4(1.5*ga_user), nonexp_up:r4(1.0*ga_user), down:r4(1.0*ga_user) },
    };
  }

  // ── Solar Panels — Not Parallel to Roof §29.4.5 ─────────────────────
  // GCrn = gp × gc × gE × GCrn_nom
  // gp = 0.9 + hpt/h, capped at 1.2
  // gc = max(0.6+0.06*Lp, 0.8), capped — spreadsheet: IF(0.6+0.06*Lp<0.8,0.8,0.6+0.06*Lp)
  // GCrn_nom: log10-interp table vs An (normalized area = A×1000/Lb²)
  // Lb = min(0.4*(h*WL)^0.5, h, Ws)  where WL=L, Ws=B
  // An breakpoints: 0, 10, 100, 500, 1000, 5000
  // Two tables: w=0-5° (rows 110-112) and w=15-35° (rows 116-118), interp between for 5-15°
  // Panel angle w≤2° treated same as parallel; procedure applies for w>2° per note

  // GCrn_nom table (log10 formulas from spreadsheet)
  // GCrn_nom piecewise log10 formulas directly from spreadsheet cells
  // Exposed (w<=5 deg): formula1 covers 0<An<=500, formula2 covers 500<An<=5000
  // Non-exposed (w>=15 deg): separate formula coefficients
  const GCRNNOM_w5 = {
    z1: { f1:[1.5,      0.426088], f2:[1.02474, 0.25],     floor:0.1  },
    z2: { f1:[2.0,      0.574293], f2:[1.25969, 0.3],      floor:0.15 },
    z3: { f1:[2.3,      0.666921], f2:[1.445,   0.3501],   floor:0.15 },
  };
  const GCRNNOM_w15 = {
    z1: { f1:[2.0,      0.533537], f2:[1.2608,  0.2595],   floor:0.3  },
    z2: { f1:[2.88,     0.82624],  f2:[1.325,   0.25008],  floor:0.4  },
    z3: { f1:[3.5,      1.000382], f2:[1.61,    0.3],      floor:0.5  },
  };

  function gcrnNomAt(An, coeff) {
    if (An <= 0)    return coeff.f1[0];
    if (An <= 500)  return coeff.f1[0] - coeff.f1[1]*Math.log10(An);
    if (An <= 5000) return coeff.f2[0] - coeff.f2[1]*Math.log10(An);
    return coeff.floor;
  }

  function getGCrnNom(w, An) {
    const nom5  = { z1:gcrnNomAt(An,GCRNNOM_w5.z1),  z2:gcrnNomAt(An,GCRNNOM_w5.z2),  z3:gcrnNomAt(An,GCRNNOM_w5.z3)  };
    const nom15 = { z1:gcrnNomAt(An,GCRNNOM_w15.z1), z2:gcrnNomAt(An,GCRNNOM_w15.z2), z3:gcrnNomAt(An,GCRNNOM_w15.z3) };
    if (w <= 5)  return nom5;
    if (w >= 15) return nom15;
    const t = (w - 5) / 10;
    return {
      z1: nom5.z1 + t*(nom15.z1 - nom5.z1),
      z2: nom5.z2 + t*(nom15.z2 - nom5.z2),
      z3: nom5.z3 + t*(nom15.z3 - nom5.z3),
    };
  }

  let solarNP = null;
  // Always compute base geometry for the shared input panel (Lb, exposure thresholds)
  {
    const w    = g.rw_sol_np_w   || 0;
    const h1   = g.rw_sol_np_h1  || 0.8;
    const h2   = g.rw_sol_np_h2  || 0.8;
    const Lp   = g.rw_sol_np_Lp  || 6;
    const hpt  = g.rw_sol_np_hpt || 0;
    const d1   = g.rw_sol_np_d1  || 18.4;
    const d2   = g.rw_sol_np_d2  || 1;
    const WL   = g.L_ft, Ws = g.B_ft, hh = g.h_ft;
    const gp   = Math.min(1.2, 0.9 + hpt / hh);
    const gc   = Math.max(0.8, 0.6 + 0.06*Lp);
    const Lb   = Math.min(0.4*Math.sqrt(hh*WL), hh, Ws);
    const half_h = 0.5 * hh;
    const thresh4 = Math.max(4*h2, 4);
    const exposed = d1 > half_h && (d1 > thresh4 || d2 > thresh4);
    const gE_exp = 1.5, gE_nexp = 1.0;
    const std_areas = [0, 10, 100, 500, 1000, 5000];
    const area1 = g.rw_sol_np_area1 || 10;
    const area2 = g.rw_sol_np_area2 || 1000;
    const An1   = r2(area1 * 1000 / (Math.max(Lb, 15) ** 2));
    const An2   = r2(area2 * 1000 / (Math.max(Lb, 15) ** 2));
    function userCol(A, An_val) {
      const n = getGCrnNom(w, An_val);
      return {
        A, An: An_val,
        exp:  r2(-Math.max(Math.abs(qhSolar*gp*gc*gE_exp*n.z1),minSolar)),  exp_z2:  r2(-Math.max(Math.abs(qhSolar*gp*gc*gE_exp*n.z2),minSolar)),  exp_z3:  r2(-Math.max(Math.abs(qhSolar*gp*gc*gE_exp*n.z3),minSolar)),
        nexp: r2(-Math.max(Math.abs(qhSolar*gp*gc*gE_nexp*n.z1),minSolar)), nexp_z2: r2(-Math.max(Math.abs(qhSolar*gp*gc*gE_nexp*n.z2),minSolar)), nexp_z3: r2(-Math.max(Math.abs(qhSolar*gp*gc*gE_nexp*n.z3),minSolar)),
        down: r2(Math.max(qhSolar*gp*gc*gE_nexp*n.z1,minSolar)),            down_z2: r2(Math.max(qhSolar*gp*gc*gE_nexp*n.z2,minSolar)),            down_z3: r2(Math.max(qhSolar*gp*gc*gE_nexp*n.z3,minSolar)),
      };
    }
    if (true) {  // always compute full object; toggle controls UI only
      solarNP = {
        gp: r4(gp), gc: r4(gc), Lb: r2(Lb),
        exposed, half_h: r2(half_h), thresh4: r2(thresh4),
        std_areas,
        user1: userCol(area1, An1),
        user2: userCol(area2, An2),
        tbl_exp:  std_areas.map(An => { const n=getGCrnNom(w,An); return { z1:r2(-Math.max(Math.abs(qhSolar*gp*gc*gE_exp*n.z1),minSolar)), z2:r2(-Math.max(Math.abs(qhSolar*gp*gc*gE_exp*n.z2),minSolar)), z3:r2(-Math.max(Math.abs(qhSolar*gp*gc*gE_exp*n.z3),minSolar)) }; }),
        tbl_nexp: std_areas.map(An => { const n=getGCrnNom(w,An); return { z1:r2(-Math.max(Math.abs(qhSolar*gp*gc*gE_nexp*n.z1),minSolar)), z2:r2(-Math.max(Math.abs(qhSolar*gp*gc*gE_nexp*n.z2),minSolar)), z3:r2(-Math.max(Math.abs(qhSolar*gp*gc*gE_nexp*n.z3),minSolar)) }; }),
        tbl_down: std_areas.map(An => { const n=getGCrnNom(w,An); return { z1:r2(Math.max(qhSolar*gp*gc*gE_nexp*n.z1,minSolar)), z2:r2(Math.max(qhSolar*gp*gc*gE_nexp*n.z2,minSolar)), z3:r2(Math.max(qhSolar*gp*gc*gE_nexp*n.z3,minSolar)) }; }),
      };
    }
  }

  const qhGCr = isKdAtPressureRW ? qhSolar : qhEquip;
  return { ok:true, qh: r2(qhSolar), qhEquip, qhSolar, qhGCr, equip, eq1, eq2, canopy, solarPar, solarNP };
}

/* ─────────────────────────────────────────────────────────────────────
   OPEN BUILDINGS  —  ASCE 7 Ch.27 §27.4.1 / Ch.30 §30.8
───────────────────────────────────────────────────────────────────── */
async function apiOB(P) {
  const { project: p, geometry: g, kd, kztInputs } = P;
  const ke    = keOf(p.code_version, 0);
  const iw = importanceFactorOf(p.code_version, p.risk_category);
  const kztH  = calcKzt(kztInputs.topo_type, kztInputs.H_ft, kztInputs.Lh_ft,
                        kztInputs.x_ft, g.h_ft, kztInputs.upwind).kzt;
  const qh    = compQz(p.V_mph, p.exposure, g.h_ft, kd, ke, p.code_version, kztH, iw).qz;
  const qhOB = (p.code_version === "7-05" || p.code_version === "7-10") ? qh / kd : qh;
  const G     = 0.85;
  const theta = g.roof_angle_deg || 0;
  const h     = g.h_ft;
  const clear = (g.ob_wind_flow || "clear") === "clear";
  const roofType = g.ob_roof_type || "monoslope";

  if (theta > 45) return { ok:false, reason:"Roof angle > 45° — procedure not applicable" };

  function interp1(x, xArr, yArr) {
    if (x <= xArr[0]) return yArr[0];
    for (let i = 0; i < xArr.length - 1; i++) {
      if (x <= xArr[i+1]) return yArr[i] + (x - xArr[i]) / (xArr[i+1] - xArr[i]) * (yArr[i+1] - yArr[i]);
    }
    return yArr[yArr.length - 1];
  }

  // ── MWFRS Normal to Ridge ─────────────────────────────────────────────
  // Case A and Case B have SEPARATE 7-row angle tables (breakpoints 0,7.5,15,22.5,30,37.5,45°)
  // Each table: [CnwA, CnlA] for Case A, [CnwB, CnlB] for Case B
  // Monoslope also has γ=180° columns [CnwA_180, CnlA_180] appended to Case A table
  // Spreadsheet logic: angle<7.5 -> use row0 constant; 7.5-15 -> interp row0-row1, etc.
  // Breakpoints start at 7.5 so interp1's "x <= xArr[0]" catches anything below 7.5
  const ANG = [7.5, 15, 22.5, 30, 37.5, 45];

  // Monoslope Clear — Case A (rows 24-30 cols V-W + Z-AA for γ=180)
  //   [CnwA_γ0, CnlA_γ0, CnwA_γ180, CnlA_γ180]
  const MONO_A_CLR = [
    [ 1.2, 0.3, 1.2, 0.3],
    [-0.6,-1.0, 0.9, 1.5],
    [-0.9,-1.3, 1.3, 1.6],
    [-1.5,-1.6, 1.7, 1.8],
    [-1.8,-1.8, 2.1, 2.1],
    [-1.8,-1.8, 2.1, 2.2],
    [-1.6,-1.8, 2.2, 2.5],
  ];
  // Monoslope Clear — Case B (rows 40-46 cols V-W)  [CnwB, CnlB]
  const MONO_B_CLR = [
    [-1.1,-0.1],
    [-1.4, 0.0],
    [-1.9, 0.0],
    [-2.4,-0.3],
    [-2.5,-0.5],
    [-2.4,-0.6],
    [-2.3,-0.7],
  ];
  // Monoslope Obstructed — Case A (rows 24-30 cols AB-AC + AF-AG)
  //   [CnwA_γ0, CnlA_γ0, CnwA_γ180, CnlA_γ180]
  const MONO_A_OBS = [
    [-0.5,-1.2, 1.2, 0.3],
    [-0.2,-1.2, 1.1,-0.3],
    [ 0.4,-1.1, 1.1,-0.4],
    [ 0.5,-1.0, 1.1, 0.1],
    [ 0.6,-1.0, 1.3, 0.3],
    [ 0.7,-0.9, 1.3, 0.6],
    [ 0.8,-0.9, 1.1, 0.9],
  ];
  // Monoslope Obstructed — Case B (rows 40-46 cols AB-AC)  [CnwB, CnlB]
  const MONO_B_OBS = [
    [-1.1,-0.6],
    [ 0.8,-0.3],
    [ 1.2,-0.3],
    [ 1.3, 0.0],
    [ 1.6, 0.1],
    [ 1.9, 0.3],
    [ 2.1, 0.4],
  ];

  // Gable/Hip Clear — Case A (rows 24-30 cols AF-AG)  [CnwA, CnlA]
  const GABLE_A_CLR = [
    [ 1.2, 0.3],
    [ 1.1,-0.3],
    [ 1.1,-0.4],
    [ 1.1, 0.1],
    [ 1.3, 0.3],
    [ 1.3, 0.6],
    [ 1.1, 0.9],
  ];
  // Gable/Hip Clear — Case B (rows 40-46 cols AF-AG)  [CnwB, CnlB]
  const GABLE_B_CLR = [
    [-1.1,-0.1],
    [ 0.2,-1.2],
    [ 0.1,-1.1],
    [-0.1,-0.8],
    [-0.1,-0.9],
    [-0.2,-0.6],
    [-0.3,-0.5],
  ];
  // Gable/Hip Obstructed — Case A (rows 24-30 cols AH-AI)  [CnwA, CnlA]
  const GABLE_A_OBS = [
    [-0.5,-1.2],
    [-1.6,-1.0],
    [-1.2,-1.0],
    [-1.2,-1.2],
    [-0.7,-0.7],
    [-0.6,-0.6],
    [-0.5,-0.5],
  ];
  // Gable/Hip Obstructed — Case B (rows 40-46 cols AH-AI)  [CnwB, CnlB]
  const GABLE_B_OBS = [
    [-1.1,-0.6],
    [-0.9,-1.7],
    [-0.6,-1.6],
    [-0.8,-1.7],
    [-0.2,-1.1],
    [-0.3,-0.9],
    [-0.3,-0.7],
  ];

  // Troughed Clear — Case A (rows 24-30 cols AL-AM)  [CnwA, CnlA]
  const TROUG_A_CLR = [
    [ 1.2, 0.3],
    [-1.1, 0.3],
    [-1.1, 0.4],
    [-1.1,-0.1],
    [-1.3,-0.3],
    [-1.3,-0.6],
    [-1.1,-0.9],
  ];
  // Troughed Clear — Case B (rows 40-46 cols AL-AM)  [CnwB, CnlB]
  const TROUG_B_CLR = [
    [-1.1,-0.1],
    [-0.2, 1.2],
    [ 0.1, 1.1],
    [-0.1, 0.8],
    [-0.1, 0.9],
    [ 0.2, 0.6],
    [ 0.3, 0.5],
  ];
  // Troughed obstructed = same as clear per spreadsheet (no separate obstructed table)
  const TROUG_A_OBS = TROUG_A_CLR;
  const TROUG_B_OBS = TROUG_B_CLR;

  let mwfrs_normal;
  if (roofType === "monoslope") {
    const tblA = clear ? MONO_A_CLR : MONO_A_OBS;
    const tblB = clear ? MONO_B_CLR : MONO_B_OBS;
    const CnwA   = r4(interp1(theta, ANG, tblA.map(r => r[0])));
    const CnlA   = r4(interp1(theta, ANG, tblA.map(r => r[1])));
    const CnwA180 = r4(interp1(theta, ANG, tblA.map(r => r[2])));
    const CnlA180 = r4(interp1(theta, ANG, tblA.map(r => r[3])));
    const CnwB   = r4(interp1(theta, ANG, tblB.map(r => r[0])));
    const CnlB   = r4(interp1(theta, ANG, tblB.map(r => r[1])));
    mwfrs_normal = { cases: [
      { label:"A (γ=0°)",   Cnw:CnwA,    Cnl:CnlA,    pw:r2(qhOB*G*CnwA),    pl:r2(qhOB*G*CnlA)    },
      { label:"B (γ=0°)",   Cnw:CnwB,    Cnl:CnlB,    pw:r2(qhOB*G*CnwB),    pl:r2(qhOB*G*CnlB)    },
      { label:"A (γ=180°)", Cnw:CnwA180, Cnl:CnlA180, pw:r2(qhOB*G*CnwA180), pl:r2(qhOB*G*CnlA180) },
    ], monoGamma180: true };
  } else {
    const tblA = roofType === "gable" ? (clear ? GABLE_A_CLR : GABLE_A_OBS)
                                      : (clear ? TROUG_A_CLR : TROUG_A_OBS);
    const tblB = roofType === "gable" ? (clear ? GABLE_B_CLR : GABLE_B_OBS)
                                      : (clear ? TROUG_B_CLR : TROUG_B_OBS);
    const CnwA=r4(interp1(theta,ANG,tblA.map(r=>r[0]))), CnlA=r4(interp1(theta,ANG,tblA.map(r=>r[1])));
    const CnwB=r4(interp1(theta,ANG,tblB.map(r=>r[0]))), CnlB=r4(interp1(theta,ANG,tblB.map(r=>r[1])));
    mwfrs_normal = { cases: [
      { label:"A", Cnw:CnwA, Cnl:CnlA, pw:r2(qhOB*G*CnwA), pl:r2(qhOB*G*CnlA) },
      { label:"B", Cnw:CnwB, Cnl:CnlB, pw:r2(qhOB*G*CnwB), pl:r2(qhOB*G*CnlB) },
    ], monoGamma180: false };
  }

  // ── MWFRS Parallel to Ridge (γ=90°) — angle-independent ──────────────
  const PAR_CN = clear
    ? { A:[-0.8,-0.6,-0.3], B:[0.8,0.5,0.3] }
    : { A:[-1.2,-0.9,-0.6], B:[0.5,0.5,0.3] };
  const mwfrs_parallel = {
    h_val:r2(h), h2_val:r2(2*h),
    caseA_Cn:PAR_CN.A, caseB_Cn:PAR_CN.B,
    caseA_p: PAR_CN.A.map(cn => r2(qhOB*G*cn)),
    caseB_p: PAR_CN.B.map(cn => r2(qhOB*G*cn)),
  };

  // ── Fascia panels (θ ≤ 5° only) ──────────────────────────────────────
  const fascia_ok = theta <= 5;
  const fascia = fascia_ok ? { qp:r2(qhOB), ww:r2(qhOB*1.5), lw:r2(qhOB*-1.0) } : null;

  // ── C&C Zones 1/2/3 (§30.8) ──────────────────────────────────────────
  const a_cc = Math.max(Math.min(0.1*Math.min(g.L_ft,g.B_ft), 0.4*h), 3);
  const a2   = r2(a_cc*a_cc), a4a2 = r2(4*a_cc*a_cc);
  const ANG_CC = [0, 7.5, 15, 30, 45];
  // Tables: 3 area brackets, each 5 angle rows, 6 CN cols [z3+, z3-, z2+, z2-, z1+, z1-]
  const MONO_CC_CLR = {
    b1:[[2.4,-3.3,1.8,-1.7,1.2,-1.1],[3.2,-4.2,2.4,-2.1,1.6,-1.4],[3.6,-3.8,2.7,-2.9,1.8,-1.9],[5.2,-5.0,3.9,-3.8,2.6,-2.5],[5.2,-4.6,3.9,-3.5,2.6,-2.3]],
    b2:[[1.8,-1.7,1.8,-1.7,1.2,-1.1],[2.4,-2.1,2.4,-2.1,1.6,-1.4],[2.7,-2.9,2.7,-2.9,1.8,-1.9],[3.9,-3.8,3.9,-3.8,2.6,-2.5],[3.9,-3.5,3.9,-3.5,2.6,-2.3]],
    b3:[[1.2,-1.1,1.2,-1.1,1.2,-1.1],[1.6,-1.4,1.6,-1.4,1.6,-1.4],[1.8,-1.9,1.8,-1.9,1.8,-1.9],[2.6,-2.5,2.6,-2.5,2.6,-2.5],[2.6,-2.3,2.6,-2.3,2.6,-2.3]],
  };
  const MONO_CC_OBS = {
    b1:[[1.0,-3.6,0.8,-1.8,0.5,-1.2],[1.6,-5.1,1.2,-2.6,0.8,-1.7],[2.4,-4.2,1.8,-3.2,1.2,-2.1],[3.2,-4.6,2.4,-3.5,1.6,-2.3],[4.2,-3.8,3.2,-2.9,2.1,-1.9]],
    b2:[[0.8,-1.8,0.8,-1.8,0.5,-1.2],[1.2,-2.6,1.2,-2.6,0.8,-1.7],[1.8,-3.2,1.8,-3.2,1.2,-2.1],[2.4,-3.5,2.4,-3.5,1.6,-2.3],[3.2,-2.9,3.2,-2.9,2.1,-1.9]],
    b3:[[0.5,-1.2,0.5,-1.2,0.5,-1.2],[0.8,-1.7,0.8,-1.7,0.8,-1.7],[1.2,-2.1,1.2,-2.1,1.2,-2.1],[1.6,-2.3,1.6,-2.3,1.6,-2.3],[2.1,-1.9,2.1,-1.9,2.1,-1.9]],
  };
  const GABLE_CC_CLR = {
    b1:[[2.4,-3.3,1.8,-1.7,1.2,-1.1],[2.2,-3.6,1.7,-1.8,1.1,-1.2],[2.2,-2.2,1.7,-1.7,1.1,-1.1],[2.6,-1.8,2.0,-1.4,1.3,-0.9],[2.2,-1.6,1.7,-1.2,1.1,-0.8]],
    b2:[[1.8,-1.7,1.8,-1.7,1.2,-1.1],[1.7,-1.8,1.7,-1.8,1.1,-1.2],[1.7,-1.7,1.7,-1.7,1.1,-1.1],[2.0,-1.4,2.0,-1.4,1.3,-0.9],[1.7,-1.2,1.7,-1.2,1.1,-0.8]],
    b3:[[1.2,-1.1,1.2,-1.1,1.2,-1.1],[1.1,-1.2,1.1,-1.2,1.1,-1.2],[1.1,-1.1,1.1,-1.1,1.1,-1.1],[1.3,-0.9,1.3,-0.9,1.3,-0.9],[1.1,-0.8,1.1,-0.8,1.1,-0.8]],
  };
  const TROUG_CC_CLR = {
    b1:[[2.4,-3.3,1.8,-1.7,1.2,-1.1],[2.4,-3.3,1.8,-1.7,1.2,-1.1],[2.2,-2.2,1.7,-1.7,1.1,-1.1],[1.8,-2.6,1.4,-2.0,0.9,-1.3],[1.6,-2.2,1.2,-1.7,0.8,-1.1]],
    b2:[[1.8,-1.7,1.8,-1.7,1.2,-1.1],[1.8,-1.7,1.8,-1.7,1.2,-1.1],[1.7,-1.7,1.7,-1.7,1.1,-1.1],[1.4,-2.0,1.4,-2.0,0.9,-1.3],[1.2,-1.7,1.2,-1.7,0.8,-1.1]],
    b3:[[1.2,-1.1,1.2,-1.1,1.2,-1.1],[1.2,-1.1,1.2,-1.1,1.2,-1.1],[1.1,-1.1,1.1,-1.1,1.1,-1.1],[0.9,-1.3,0.9,-1.3,0.9,-1.3],[0.8,-1.1,0.8,-1.1,0.8,-1.1]],
  };

  const ccTbl = roofType === "monoslope" ? (clear ? MONO_CC_CLR : MONO_CC_OBS)
              : roofType === "gable"     ? GABLE_CC_CLR
              :                           TROUG_CC_CLR;

  function getCcCN(brk, col) {
    return interp1(theta, ANG_CC, ccTbl[brk].map(r => r[col]));
  }

  const cc_brackets = [
    { label:"≤ " + a2 + " sf (≤ a²)",           key:"b1" },
    { label:"> " + a2 + ", ≤ " + a4a2 + " sf",   key:"b2" },
    { label:"> " + a4a2 + " sf (> 4a²)",          key:"b3" },
  ];
  const cc_zones = cc_brackets.map(({ label, key }) => {
    const [z3p,z3n,z2p,z2n,z1p,z1n] = [0,1,2,3,4,5].map(c => r4(getCcCN(key,c)));
    const minOB = (p.code_version === "7-05") ? 10 : 16;
    const ap = v => v < 0 && Math.abs(v) < minOB ? -minOB : v;
    return { area_label:label,
      CN:  { z3p, z3n, z2p, z2n, z1p, z1n },
      psf: {
        z3p:r2(qhOB*G*z3p), z3n:r2(ap(qhOB*G*z3n)),
        z2p:r2(qhOB*G*z2p), z2n:r2(ap(qhOB*G*z2n)),
        z1p:r2(qhOB*G*z1p), z1n:r2(ap(qhOB*G*z1n)),
      },
    };
  });

  return {
    ok:true, qh:r2(qhOB), G, theta, a_cc:r2(a_cc), a2, a4a2,
    roofType, clear,
    mwfrs_normal, mwfrs_parallel,
    fascia, fascia_ok,
    cc_zones, minP: (p.code_version === "7-05") ? 10 : 16,
  };
}

/* ─────────────────────────────────────────────────────────────────
   OTHER STRUCTURES — §29.3 / §29.4 / §29.5 / Table 29.3-1/2
   A. Solid Freestanding Walls & Solid Signs (§29.3)
   B. Open Signs & Single-Plane Open Frames (§29.4)
   C. Chimneys, Tanks & Similar Structures (§29.5)
   D. Trussed Towers (§29.6)
─────────────────────────────────────────────────────────────────── */
async function apiOtherW(P) {
  const { project: p, geometry: g, kd, kztInputs } = P;
  const ke  = keOf(p.code_version, 0);
  const iw  = importanceFactorOf(p.code_version, p.risk_category);
  const G   = 0.85;
  const isKdAtP = p.code_version === "7-05" || p.code_version === "7-10";

  function qzAt(z, kd_local, kzt_local) {
    return compQz(p.V_mph, p.exposure, z, kd_local, ke, p.code_version, kzt_local, iw).qz;
  }
  function kzAt(z) {
    return compQz(p.V_mph, p.exposure, z, kd, ke, p.code_version, 1.0, iw).kz;
  }

  // ── A. Solid Freestanding Walls & Solid Signs ──────────────────
  // §29.3.1 / Table 29.3-1  F = qz·G·Cf·As  (7-22)
  // Cf from Table 29.3-1: rows=s/h (0.16–1.0), cols=B/s (s/h from sheet)
  const SH_ROWS  = [1, 0.9, 0.7, 0.5, 0.3, 0.2, 0.16];
  const BS_COLS  = [0.05, 0.1, 0.2, 0.5, 1, 2, 4, 5, 10, 20, 30, 45];
  const CF_AB = [
    [1.80,1.70,1.65,1.55,1.45,1.40,1.35,1.35,1.30,1.30,1.30,1.30],
    [1.85,1.75,1.70,1.60,1.55,1.50,1.45,1.45,1.40,1.40,1.40,1.40],
    [1.90,1.85,1.75,1.70,1.65,1.60,1.60,1.55,1.55,1.55,1.55,1.55],
    [1.95,1.85,1.80,1.75,1.75,1.70,1.70,1.70,1.70,1.70,1.70,1.75],
    [1.95,1.90,1.85,1.80,1.80,1.80,1.80,1.80,1.80,1.85,1.85,1.85],
    [1.95,1.90,1.85,1.80,1.80,1.80,1.80,1.80,1.85,1.90,1.90,1.95],
    [1.95,1.90,1.85,1.85,1.80,1.80,1.85,1.85,1.85,1.90,1.90,1.95],
  ];
  // Case C Cf (horizontal distribution from windward edge, B/s cols 2-10)
  const CC_BS_COLS = [2,3,4,5,6,7,8,9,10,13];
  const CC_ZONES   = ["0 to s","s to 2s","2s to 3s","3s to 10s"];
  const CF_CC = [
    [2.25,2.60,2.90,3.10,3.30,3.40,3.55,3.65,3.75,4.00],
    [1.50,1.70,1.90,2.00,2.15,2.25,2.30,2.35,2.45,2.60],
    [0.00,1.15,1.30,1.45,1.55,1.65,1.70,1.75,1.85,2.00],
    [0.00,0.00,1.10,1.05,1.05,1.05,1.05,1.00,0.95,0.90],
  ];

  function interpLinear(x, xs, ys) {
    if (x <= xs[0]) return ys[0];
    if (x >= xs[xs.length-1]) return ys[xs.length-1];
    for (let i=0;i<xs.length-1;i++) {
      if (x >= xs[i] && x <= xs[i+1]) {
        const t = (x-xs[i])/(xs[i+1]-xs[i]);
        return ys[i] + t*(ys[i+1]-ys[i]);
      }
    }
    return ys[ys.length-1];
  }
  function cfSolidAB(sh, bs) {
    // Bilinear interpolation in Table 29.3-1
    // clamp
    const shC = Math.min(Math.max(sh, 0.16), 1.0);
    const bsC = Math.min(Math.max(bs, 0.05), 45);
    // find bracket rows (SH_ROWS is descending)
    let r0=0, r1=0;
    for (let i=0;i<SH_ROWS.length-1;i++) {
      if (shC <= SH_ROWS[i] && shC >= SH_ROWS[i+1]) { r0=i; r1=i+1; break; }
      if (i===SH_ROWS.length-2) { r0=i; r1=i+1; }
    }
    const tSH = SH_ROWS[r0]===SH_ROWS[r1] ? 0 : (SH_ROWS[r0]-shC)/(SH_ROWS[r0]-SH_ROWS[r1]);
    // interpolate each row across BS_COLS
    const vr0 = interpLinear(bsC, BS_COLS, CF_AB[r0]);
    const vr1 = interpLinear(bsC, BS_COLS, CF_AB[r1]);
    return vr0 + tSH*(vr1-vr0);
  }
  function cfCaseC(bs, zoneIdx) {
    // CF_CC zeros indicate a zone doesn't start until a higher B/s threshold.
    // Rule: zone is DISPLAYED when bs >= CC_BS_COLS[firstValidIdx-1] (prev col),
    // i.e. when bs enters the bracket containing the first non-zero value.
    // Cf is computed by clamping bs to [firstValidCol, 13] so we never interpolate
    // through the leading zeros — we use the first-valid-col value for lower B/s.
    if (bs < CC_BS_COLS[0]) return 0;  // Case C requires B/s >= 2
    const row = CF_CC[zoneIdx];
    const firstValidIdx = row.findIndex(v => v > 0);
    if (firstValidIdx < 0) return 0;
    // Zone activates when bs has entered the bracket of the first non-zero col.
    // Bracket entry = bs >= CC_BS_COLS[firstValidIdx - 1] (or >=2 if firstValidIdx=0).
    const activationBs = firstValidIdx > 0 ? CC_BS_COLS[firstValidIdx - 1] : CC_BS_COLS[0];
    if (bs < activationBs) return 0;
    const bsC = Math.min(Math.max(bs, CC_BS_COLS[firstValidIdx]), 13);
    const validBs = CC_BS_COLS.slice(firstValidIdx);
    const validCf = row.slice(firstValidIdx);
    return interpLinear(bsC, validBs, validCf);
  }
  // Wall return factor (Lr/s): 0→1.0, ≤0.3→0.9, ≤1→0.75, ≤≥1→0.6
  function wallReturnFactor(lr, s) {
    if (!s || s===0) return 1.0;
    const ratio = lr/s;
    if (ratio === 0) return 1.0;
    if (ratio <= 0.3) return 0.9;
    if (ratio <= 1.0) return 0.75;
    return 0.6;
  }
  // s/h > 0.8 reduction: (1.8 - s/h) per note
  function shReduction(sh) { return sh > 0.8 ? Math.max(0, 1.8 - sh) : 1.0; }

  // ow fields come from geo flat keys (ow_ss_*, ow_os_*, etc)
  const ss = { h_top: g.ow_ss_h_top, s: g.ow_ss_s, B: g.ow_ss_B, Lr: g.ow_ss_Lr, pctOpen: g.ow_ss_pctOpen };
  let solidSign = null;
  {
    const h_top = ss.h_top || 20;   // dist from ground to top
    const s     = ss.s     || 10;   // height of sign/wall
    const B     = ss.B     || 25;   // width
    const Lr    = ss.Lr    || 0;    // wall return length
    const pctOpen = ss.pctOpen || 0;
    const kztZ  = calcKzt(kztInputs.topo_type, kztInputs.H_ft, kztInputs.Lh_ft, kztInputs.x_ft, h_top, kztInputs.upwind).kzt;
    const qzRaw = qzAt(h_top, kd, kztZ);
    const qzBase = isKdAtP ? qzRaw/kd : qzRaw;  // strip Kd for display if needed
    const kdqz  = isKdAtP ? qzRaw/kd*kd : qzRaw; // = qzRaw always
    const kz    = kzAt(h_top);
    const sh    = Math.min(Math.max(s/h_top, 0.16), 1.0);
    const bs    = B/s;
    const openFactor = 1 - (pctOpen/100);  // open-area reduction
    const wrf   = wallReturnFactor(Lr, s);
    const shr   = shReduction(sh);
    const cfAB  = r4(cfSolidAB(sh, bs) * wrf * shr * openFactor);
    const F_per_sf = r2(qzRaw * G * cfAB); // psf per unit area
    // Case C: horizontal zones
    const caseCRows = CC_ZONES.map((zone, zi) => ({
      zone,
      cf: r4(cfCaseC(bs, zi) * wrf * shr * openFactor),
      f_psf: r2(qzRaw * G * cfCaseC(bs, zi) * wrf * shr * openFactor),
    }));
    solidSign = { h_top, s, B, Lr, pctOpen, kz:r4(kz), kztZ:r4(kztZ), qzRaw:r2(qzRaw), kdqz:r2(qzRaw), sh:r4(sh), bs:r4(bs), cfAB, F_per_sf, caseCRows, wrf:r4(wrf), shr:r4(shr) };
  }

  // ── B. Open Signs & Single-Plane Open Frames ──────────────────
  // §29.4  F = Kd·qz·G·Cf·Af  (epsilon = solid/gross ratio)
  // Cf from Table 29.4-1: rows=epsilon, cols=member shape vs D√qz
  const OPEN_EPS_ROWS   = [0.1, 0.2, 0.3, 0.65]; // epsilon breakpoints (≤0.1, .1-.29, .3-.7, >=0.65)
  const CF_OPEN_FLAT    = [2.0, 1.8, 1.6, 1.6];
  const CF_OPEN_LE25    = [1.2, 1.3, 1.5, 1.5];
  const CF_OPEN_GT25    = [0.8, 0.9, 1.1, 1.1];
  function cfOpen(eps, dSqrtQz, isRound) {
    const epsC = Math.min(Math.max(eps, 0.1), 0.65);
    // Find row
    let idx = 0;
    if (epsC <= 0.1) idx=0;
    else if (epsC < 0.3) idx=1;
    else idx=2; // .3-.7 and >=0.65 same Cf
    if (isRound) {
      return dSqrtQz <= 2.5 ? CF_OPEN_LE25[idx] : CF_OPEN_GT25[idx];
    }
    return CF_OPEN_FLAT[idx];
  }

  const os = { z: g.ow_os_z, w: g.ow_os_w, d: g.ow_os_d, pct: g.ow_os_pct, Af: g.ow_os_Af };
  let openSign = null;
  {
    const z      = os.z   || 15;
    const width  = os.w   || 0;   // 0=flat/rect
    const diam   = os.d   || 2;   // diameter if round
    const pctOpen= os.pct || 35;
    const Af     = os.Af  || 10;
    const kztZ   = calcKzt(kztInputs.topo_type, kztInputs.H_ft, kztInputs.Lh_ft, kztInputs.x_ft, z, kztInputs.upwind).kzt;
    const qzRaw  = qzAt(z, kd, kztZ);
    const kz     = kzAt(z);
    const kdqz   = isKdAtP ? qzRaw/kd*kd : qzRaw;
    const eps    = (100-pctOpen)/100; // solid ratio
    const isRound= diam > 0 && width === 0;
    const D      = isRound ? diam : 0;
    const dSqQz  = r4(D * Math.sqrt(qzRaw));
    const cf     = r4(cfOpen(eps, dSqQz, isRound));
    const F_per_sf = r2(qzRaw * G * cf);
    openSign = { z, width, diam, pctOpen, Af, kz:r4(kz), kztZ:r4(kztZ), qzRaw:r2(qzRaw), kdqz:r2(qzRaw), eps:r4(eps), isRound, dSqQz, cf, F_per_sf };
  }

  // ── C. Chimneys, Tanks & Similar Structures ───────────────────
  // §29.5  F = qz·G·Cf·Af  (no Kd in Cf — included in qz for 7-22)
  // Cf from Table 29.5-1: cross-section × h/D bracket
  const CHIM_HD_COLS  = [1, 7, 25];   // h/D breakpoints per Table 29.5-1
  const CHIM_CF_TABLE = {
    "square_normal": [1.3, 1.4, 2.0],
    "square_diag":   [1.0, 1.1, 1.5],
    "hexagonal":     [1.0, 1.2, 1.4],
    "round_smooth":  [0.5, 0.6, 0.7],
    "round_rough":   [0.7, 0.8, 0.9],
    "round_vrough":  [0.8, 1.0, 1.2],
  };
  function cfChimney(section, hd) {
    const row = CHIM_CF_TABLE[section] || CHIM_CF_TABLE["square_normal"];
    return interpLinear(hd, CHIM_HD_COLS, row);
  }

  const ch = { z: g.ow_ch_z, h: g.ow_ch_h, D: g.ow_ch_D, sec: g.ow_ch_sec };
  let chimney = null;
  {
    const z       = ch.z   || 15;
    const h       = ch.h   || 15;
    const D       = ch.D   || 1;
    const section = ch.sec || "square";
    // ASCE 7-22 Table 26.6-1: Kd for chimneys, tanks & similar structures
    // Square = 0.90; Hexagonal/Octagonal & Round (all surface types) = 0.95
    const KD_CHIMNEY = (section === "square") ? 0.90 : 0.95;
    const kztZ    = calcKzt(kztInputs.topo_type, kztInputs.H_ft, kztInputs.Lh_ft, kztInputs.x_ft, z, kztInputs.upwind).kzt;
    const qzRaw   = qzAt(z, KD_CHIMNEY, kztZ);   // uses Kd=0.90
    const kz      = kzAt(z);
    const hd      = r4(h/D);
    const isSquare = section === "square";
    // Square always produces two outputs: wind normal to face + wind along diagonal
    const cfNormal = isSquare ? r4(cfChimney("square_normal", hd)) : null;
    const cfDiag   = isSquare ? r4(cfChimney("square_diag",   hd)) : null;
    const cf       = isSquare ? null : r4(cfChimney(section, hd));
    const F_normal  = isSquare ? r2(qzRaw * G * cfNormal) : null;
    const F_diag    = isSquare ? r2(qzRaw * G * cfDiag)   : null;
    const F_per_sf  = isSquare ? null : r2(qzRaw * G * cf);
    chimney = { z, h, D, section, isSquare, kz:r4(kz), kztZ:r4(kztZ), qzRaw:r2(qzRaw), hd,
                cf, F_per_sf, cfNormal, cfDiag, F_normal, F_diag, kdUsed: KD_CHIMNEY };
  }

  // ── D. Trussed Towers ─────────────────────────────────────────
  // §29.6 / Table 29.6-1  F = Kd·qz·G·Cf·Af
  // Cf depends on: tower cross-section, member shape, phi (solidity)
  // Normal: Cf = 4phi^2 - 5.9phi + 4.0  (square, flat members, wind normal)
  // Diag:   Cf_diag = Cf_normal × 1.2 (square diagonal) or use formula
  // Triangle: Cf = 3.4phi^2 - 4.7phi + 3.4
  function cfTowerNormal(phi, section) {
    if (section === "triangle") return 3.4*phi*phi - 4.7*phi + 3.4;
    return 4.0*phi*phi - 5.9*phi + 4.0; // square
  }
  function cfTowerDiag(phi) { return 3.4*phi*phi - 4.7*phi + 3.4; } // same as triangle wind on square diagonal
  function roundMemberFactor(memberShape, phi) {
    // ASCE 7-22 §29.6 Note 2: for round members, Cf multiplied by (0.51φ² + 0.57)
    return memberShape === "round" ? 0.51 * phi * phi + 0.57 : 1.0;
  }

  const tt = { z: g.ow_tt_z, phi: g.ow_tt_phi, sec: g.ow_tt_sec, mem: g.ow_tt_mem, dir: g.ow_tt_dir };
  let tower = null;
  {
    const z         = tt.z    || 15;
    const phi       = Math.min(Math.max(tt.phi || 0.27, 0.1), 0.9);
    const section   = tt.sec  || "square";  // square | triangle
    const memberShape = tt.mem || "flat";   // flat | round
    const windDir   = tt.dir  || "normal";  // normal | diagonal
    // ASCE 7-22 Table 26.6-1: Kd for trussed towers
    // Triangular, square, rectangular = 0.85; all other cross sections = 0.95
    const KD_TOWER = (section === "square" || section === "triangle") ? 0.85 : 0.95;
    const kztZ      = calcKzt(kztInputs.topo_type, kztInputs.H_ft, kztInputs.Lh_ft, kztInputs.x_ft, z, kztInputs.upwind).kzt;
    const qzRaw     = qzAt(z, KD_TOWER, kztZ);
    const kz        = kzAt(z);
    const rmf       = roundMemberFactor(memberShape, phi);
    const isSquareTower = section === "square";
    // Square tower: always show both normal + diagonal (diagonal = normal × 1.2 per §29.6)
    // Triangle tower: single output only (normal to face)
    const cfNormal  = r4(cfTowerNormal(phi, section) * rmf);
    const cfDiag    = isSquareTower ? r4(cfNormal * 1.2) : null;  // §29.6: diagonal = normal × 1.2
    const F_normal  = r2(qzRaw * G * cfNormal);
    const F_diag    = isSquareTower ? r2(qzRaw * G * cfDiag) : null;
    tower = { z, phi:r4(phi), section, memberShape, isSquareTower,
              kz:r4(kz), kztZ:r4(kztZ), qzRaw:r2(qzRaw), rmf:r4(rmf),
              cfNormal, cfDiag, F_normal, F_diag, kdUsed: KD_TOWER };
  }

  return { ok:true, solidSign, openSign, chimney, tower };
}


async function apiCC(P) {
  const { project: p, geometry: g, kd, kztInputs } = P;
  const ke   = keOf(p.code_version, 0);
  const iw = importanceFactorOf(p.code_version, p.risk_category);
  const kztH = calcKzt(kztInputs.topo_type, kztInputs.H_ft, kztInputs.Lh_ft,
                       kztInputs.x_ft, g.h_ft, kztInputs.upwind).kzt;
  const qh   = compQz(p.V_mph, p.exposure, g.h_ft, kd, ke, p.code_version, kztH, iw).qz;
  // ASCE 7-05: GCp net values have Kd baked in, so use qz (no Kd) for C&C pressure
  // All other codes: GCp net values also have Kd baked in via compQz (Kd inside qh)
  // For 7-05: qh = Kd*qz*I, so qz_no_kd = qh/kd -- this is what multiplies GCp_net
  const isKdAtPressureCC = p.code_version === "7-05" || p.code_version === "7-10";
  const qhCC = isKdAtPressureCC ? qh / kd : qh;
  // Minimum C&C pressure: 10 psf (ASD, 7-05 §6.1.4.1) vs 16 psf (LRFD, 7-10+ §30.2.2)
  const minCC = (p.code_version === "7-05") ? 10 : 16;
  const minPsfCC = (v) => (Math.abs(v) < minCC ? Math.sign(v || 1) * minCC : v);
  const gcpi = gcpiOf(p.enclosure);
  const a    = r2(Math.max(Math.min(0.1*Math.min(g.L_ft,g.B_ft), 0.4*g.h_ft), 3));
  const roof  = g.roof_type;
  const theta = g.roof_angle_deg;
  const hle60 = g.h_ft <= 60;
  // Alternate procedure: permitted when 60 < h < 90 (Ch.30 Alternate)
  // Uses h<=60 GCp curve shapes extended to 1000sf; base = Kd*qh (net GCp)
  const altEligible = g.h_ft > 60 && g.h_ft < 90;
  const useAlt = altEligible && (P.useAltCC === true);

  // Roof zones to compute
  const roofZones = ["1","1p","2","3","oh1","oh2","oh3"];
  const minPar = g.min_parapet_ht_ft || 0;  // parapet ht above roof for Zone 3 conditional
  const zone3eq2 = minPar >= 3 && theta <= 10; // flag for UI note

  const prs = [];

  if (hle60) {
    const areas = CC_AREAS_ROOF; // [10, 100, 500]
    for (const zone of roofZones) {
      const isOverhang = zone.startsWith("oh");
      for (const ar of areas) {
        const gn = r4(gcpRoof_hle60(ar, roof, theta, zone, "neg", minPar, p.code_version));
        const gp = r4(gcpRoof_hle60(ar, roof, theta, zone, "pos", minPar, p.code_version));
        prs.push({
          zone, area: ar, gn, gp, isOverhang,
          pnN: r2(minPsfCC(qhCC * gn)),
          ppP: r2(minPsfCC(qhCC * gp)),
        });
      }
    }
    // Wall zones 4 & 5
    const wallAreas = CC_AREAS_WALL;
    for (const zone of ["4","5"]) {
      for (const ar of wallAreas) {
        const gn = r4(gcpWall_hle60(ar, zone, "neg", p.code_version));
        const gp = r4(gcpWall_hle60(ar, zone, "pos", p.code_version));
        prs.push({
          zone, area: ar, gn, gp, isOverhang: false,
          pnN: r2(minPsfCC(qhCC * gn)),
          ppP: r2(minPsfCC(qhCC * gp)),
        });
      }
    }
  }

  if (!hle60 && useAlt) {
    // Ch.30 Alternate Procedure — 60 ft < h < 90 ft
    // 7-16/7-22: net GCp (GCpi baked in), areas [10,100,500,1000], Zone 1' exists
    // 7-10/7-05: external GCp, GCpi applied separately, areas [10,50,100,500], no Zone 1', Oh3=Oh1&2
    const is710alt = isKdAtPressureCC; // 7-05 or 7-10
    const areas    = is710alt ? [10, 50, 100, 500] : [10, 100, 500, 1000];
    const altZones = is710alt ? ["1","2","3","oh1","oh2","oh3"] : ["1","1p","2","3","oh1","oh2","oh3"];
    for (const zone of altZones) {
      const isOverhang = zone.startsWith("oh");
      for (const ar of areas) {
        const gn = r4(gcpRoof_alt(ar, zone, "neg", roof, theta, minPar, p.code_version));
        const gp = r4(gcpRoof_alt(ar, zone, "pos", roof, theta, minPar, p.code_version));
        let pnN, ppP;
        if (is710alt) {
          // External GCp — apply GCpi separately; overhangs GCpi=0
          const gcpiEff = isOverhang ? 0 : gcpi;
          pnN = r2(minPsfCC(qhCC * (gn - gcpiEff)));
          ppP = r2(minPsfCC(qhCC * (gp + gcpiEff)));
        } else {
          // Net GCp — GCpi already baked in
          pnN = r2(minPsfCC(qhCC * gn));
          ppP = r2(minPsfCC(qhCC * gp));
        }
        prs.push({ zone, area: ar, gn, gp, isOverhang, pnN, ppP });
      }
    }
    // Wall zones 4 & 5 — alternate procedure uses h<=60 wall C&C curves (net GCp, GCpi baked in)
    // Same figures as h<=60 procedure; areas [10,100,200,500] sf.
    // Net GCp curves (verified from Struware spreadsheet, 7-10, theta<=10, 10% reduction applied):
    //   Z4 neg: slope=+0.1589, int=-1.3289  → -1.17@10sf, -0.90@500sf
    //   Z5 neg: slope=+0.3178, int=-1.7578  → -1.44@10sf, -0.90@500sf
    //   Pos(4&5): slope=-0.1589, int=+1.2389 → +1.08@10sf, +0.81@500sf
    // For 7-16/7-22 alternate, same curve structure applies (different GCp values per edition).
    // Delegate to gcpWall_hle60 which already handles edition and theta reduction.
    const wallAreas = CC_AREAS_WALL; // [10,100,200,500]
    for (const zone of ["4", "5"]) {
      for (const ar of wallAreas) {
        const gn = r4(gcpWall_hle60(ar, zone, "neg", p.code_version));
        const gp = r4(gcpWall_hle60(ar, zone, "pos", p.code_version));
        prs.push({
          zone, area: ar, gn, gp, isOverhang: false,
          pnN: r2(minPsfCC(qhCC * gn)),
          ppP: r2(minPsfCC(qhCC * gp)),
        });
      }
    }
  }

  if (!hle60 && !useAlt) {
    // Ch.30 Part 3 — Fig 30.4-1  (h > 60 ft, standard procedure)
    // External GCp only; GCpi applied separately below.
    // Areas: [10, 50, 100, 500] sf.
    const areas = [10, 50, 100, 500];
    for (const zone of ["1","1p","2","3"]) {
      for (const ar of areas) {
        const gcpExt_n = r4(gcpRoof_hgt60(ar, zone, "neg"));
        const gcpExt_p = r4(gcpRoof_hgt60(ar, zone, "pos"));
        // p = qh * (GCp_ext - GCpi)  for neg;  qh * (GCp_ext + GCpi) for pos
        prs.push({
          zone, area: ar, gn: gcpExt_n, gp: gcpExt_p, isOverhang: false,
          pnN: r2(minPsfCC(qhCC * (gcpExt_n - gcpi))),
          ppP: r2(minPsfCC(qhCC * (gcpExt_p + gcpi))),
        });
      }
    }
    // Overhangs — h>60 standard procedure (GCpi = 0)
    // oh1: -2.30@10 -> -1.60@500;  oh2/oh3_z4: -3.20@10 -> -2.30@500
    // oh3_z5: -4.10@10 -> -2.60@500  (all external GCp, GCpi=0)
    const ohAreas = [10, 50, 100, 500];
    function gcpOh_hgt60(ar, zone) {
      const a = Math.min(Math.max(ar, 10), 500);
      if (zone === "oh1") {                                            // two-segment: knee at 20sf
        if (a <= 20) return 0.294323 * Math.log10(a) - 2.594323;     // -2.30@10 -> -2.2114@20
        return 0.437358 * Math.log10(a) - 2.780416;                  // -2.2114@20 -> -1.60@500
      }
      if (zone === "oh2" || zone === "oh3z4") {                       // two-segment: knee at 20sf
        if (a <= 20) return 0.411919 * Math.log10(a) - 3.611919;     // -3.20@10 -> -3.076@20
        return 0.555103 * Math.log10(a) - 3.798205;                  // -3.076@20 -> -2.30@500
      }
      if (zone === "oh3z5") {                                          // two-segment: knee at 20sf
        if (a <= 20) return 0.411919 * Math.log10(a) - 4.511919;      // -4.10@10 -> -3.976@20
        return 0.984305 * Math.log10(a) - 5.256611;                   // -3.976@20 -> -2.60@500
      }
      return 0;
    }
    for (const zone of ["oh1","oh2","oh3z4","oh3z5"]) {
      for (const ar of ohAreas) {
        const gcpExt = r4(gcpOh_hgt60(ar, zone));
        prs.push({
          zone, area: ar, gn: gcpExt, gp: 0, isOverhang: true,
          pnN: r2(minPsfCC(qhCC * gcpExt)),  // GCpi=0 for overhangs
          ppP: 0,
        });
      }
    }
    // Wall zones 4' and 5' — areas [20,100,200,500] sf per Fig 30.4-1
    // GCp external only; GCpi applied separately (same convention as roof h>60)
    const wallAreas = [20, 100, 200, 500];
    for (const zone of ["4p", "5p"]) {
      for (const ar of wallAreas) {
        const gn = r4(gcpWall_hgt60(ar, zone, "neg"));
        const gp = r4(gcpWall_hgt60(ar, zone, "pos"));
        prs.push({
          zone, area: ar, gn, gp, isOverhang: false,
          pnN: r2(minPsfCC(qhCC * (gn - gcpi))),
          ppP: r2(minPsfCC(qhCC * (gp + gcpi))),
        });
      }
    }
  }

  const parAreas=[10,20,50,100,200,500];
  // qp at parapet height — evaluate at absolute height above ground
  const zPar = Math.max((g.parapet_height_ft || 0) > 0 ? g.parapet_height_ft : g.h_ft + (g.min_parapet_ht_ft || 0), g.h_ft);
  const kztPar2 = calcKzt(kztInputs.topo_type, kztInputs.H_ft, kztInputs.Lh_ft, kztInputs.x_ft, zPar, kztInputs.upwind).kzt;
  const qp_raw = compQz(p.V_mph, p.exposure, zPar, kd, ke, p.code_version, kztPar2, iw).qz;
  // Parapet qpCC:
  // 7-16/7-22: qp_raw already includes Kd — use directly.
  // 7-10/7-05: qp_raw includes Kd; strip it so display = qz (no Kd), Kd reapplied via GCpn.
  //            Net: qpCC = qp_raw/kd.  p = qpCC * GCpnA  (GCpnA is net — no separate Kd needed).
  const qpCC = isKdAtPressureCC ? qp_raw / kd : qp_raw;

  // Case A GCpn source depends on code version AND procedure:
  // 7-05 conventional:  7-22 Fig 30.9-1 curve (confirmed from spreadsheet — same as 7-22)
  // 7-05 alternate:     7-05 Fig 6-19 curve (two-segment)
  // 7-10 conventional:  7-22 Fig 30.9-1 curve
  // 7-10 alternate:     7-10 Fig 30.9-1 curve
  // 7-16/7-22:          7-22 Fig 30.9-1 curve (always)
  const is705par    = p.code_version === "7-05";
  const is710par    = p.code_version === "7-10";
  const is710altPar = is710par && useAlt;
  const is705altPar = is705par && useAlt;
  function parGCpnA(ar) {
    if (is705altPar) {
      // 7-05 alternate: ASCE 7-05 Fig 6-19 two-segment log-linear
      if (ar <= 100) return 3.5569 - 0.8578 * Math.log10(Math.max(ar, 10));
      return 2.163202 - 0.160951 * Math.log10(Math.min(ar, 500));
    }
    if (is710altPar) {
      // ASCE 7-10 Fig 30.9-1 (alternate only): two-segment, breakpoint at 100sf
      // Seg 1 (10-100sf): slope=-0.8589, int=3.5589  → 2.700@10sf, 1.841@100sf
      // Seg 2 (100-500sf): slope=-0.1589, int=2.1590 → 1.841@100sf, 1.730@500sf
      if (ar <= 100) return -0.858900 * Math.log10(Math.max(ar, 10)) + 3.558900;
      return -0.158948 * Math.log10(Math.min(ar, 500)) + 2.158996;
    }
    // 7-05 conv / 7-10 conv / 7-16 / 7-22 — all use 7-22 Fig 30.9-1 curve:
    // two-segment, breakpoint at 20sf
    // Seg 1 (10-20sf): slope=-0.4120, int=3.6120  → 3.200@10sf, 3.076@20sf
    // Seg 2 (20-500sf): slope=-0.6266, int=3.8912 → 3.076@20sf, 2.200@500sf
    if (ar <= 20) return -0.411999 * Math.log10(Math.max(ar, 10)) + 3.611999;
    return -0.626619 * Math.log10(Math.min(ar, 500)) + 3.891226;
  }

  // Case B GCpn curves depend on procedure (confirmed from spreadsheet):
  // hle60 / alt6090 / 7-10 alt: INT -1.89@10sf→-1.35@500; COR -2.16→-1.35@500
  // hgt60 std (ALL codes conv incl 7-05): INT flat -1.80→-1.30@500; COR flat -2.70→-1.60@500
  const useHgt60ParB = !hle60 && !useAlt;
  function parGCpnB_int(ar) {
    if (useHgt60ParB) {
      // Two-segment: flat -1.80 for 10-20sf, log-linear to -1.30@500
      if (ar <= 20) return -1.8000;
      return 0.357669 * Math.log10(Math.min(ar, 500)) - 2.265338;
    }
    return interpGCp(ar, [[10,-1.8876],[500,-1.3483]]);
  }
  function parGCpnB_cor(ar) {
    if (useHgt60ParB) {
      // Two-segment: flat -2.70 for 10-20sf, log-linear to -1.60@500
      if (ar <= 20) return -2.7000;
      return 0.786872 * Math.log10(Math.min(ar, 500)) - 3.723744;
    }
    return interpGCp(ar, [[10,-2.1573],[500,-1.3483]]);
  }
  const parPrs = parAreas.map((ar) => ({
    area: ar,
    caseA:    r2(qpCC * parGCpnA(ar)),
    caseBint: r2(qpCC * parGCpnB_int(ar)),
    caseBcor: r2(qpCC * parGCpnB_cor(ar)),
  }));
  const proc = hle60 ? "hle60" : useAlt ? "alt6090" : "hgt60";
  const altIs710 = useAlt && isKdAtPressureCC;

  // Wall positive pressure height profile — h>60 standard procedure only
  // Positive wall C&C varies with height (qz at z); negative applies at all heights at qh.
  // Heights: standard profile heights up to h, capped at h.
  let wallPosProfile = null;
  if (!hle60 && !useAlt) {
    const profileHeights = [15, 20, 25, 30, 40, 50, 60].filter(z => z < g.h_ft);
    profileHeights.push(g.h_ft);
    const posAreas = [20, 100, 200, 500];
    // §30.1.3: p_pos = qzDisp(z)·GCp_pos + qhCC·GCpi
    // qzDisp: for 7-10/7-05, compQz includes Kd — strip it (matches ASCE 7-10 display convention)
    // qhCC: already the correct base for GCpi for all codes (qz_noKd at h for 7-10, qz_withKd for 7-22)
    wallPosProfile = profileHeights.map(z => {
      const kztZ = calcKzt(kztInputs.topo_type, kztInputs.H_ft, kztInputs.Lh_ft, kztInputs.x_ft, z, kztInputs.upwind).kzt;
      const qzObj = compQz(p.V_mph, p.exposure, z, kd, ke, p.code_version, kztZ, iw);
      const qzDisp = isKdAtPressureCC ? qzObj.qz / kd : qzObj.qz;
      return {
        z,
        kz: Math.round(qzObj.kz * 100) / 100,  // 2 decimal places per ASCE 7 table
        kzt: r4(kztZ),
        qz: r2(qzDisp),
        // p = qzDisp(z)·GCp + qhCC·GCpi  (GCpi anchored to qh, GCp scales with qz(z))
        pressures: posAreas.map(a => r2(minPsfCC(qzDisp * gcpWall_hgt60(a, "4p", "pos") + qhCC * gcpi))),
      };
    });
  }

  return { qh: r2(qhCC), qp: r2(qpCC), gcpi, a, prs, proc, altEligible, useAlt, altIs710, theta, roof, minPar, zone3eq2, parPrs, parAreas, wallPosProfile, codeVer: p.code_version, minP: minCC };
}

function validate(p, g) {
  const e = {};
  if (p.V_mph < 85)  e.V_mph = "≥85 mph";
  if (p.V_mph > 300) e.V_mph = "≤300 mph";
  if (g.h_ft  <= 0)  e.h_ft  = ">0";
  if (g.L_ft  <= 0)  e.L_ft  = ">0";
  if (g.B_ft  <= 0)  e.B_ft  = ">0";
  return e;
}

/* ── UI primitives ── */
function Psf({ v }) {
  if (v == null) return (<span className="text-slate-600">—</span>);
  const color = v < 0 ? "text-sky-400" : v > 0 ? "text-amber-300" : "text-slate-400";
  return (<span className={"font-mono tabular-nums " + color}>{Number(v).toFixed(1)}</span>);
}

function Field({ label, unit, error, hint, children }) {
  return (
    <div className="mb-3">
      <label className="block text-xs font-semibold tracking-wide text-slate-400 uppercase mb-1">
        {label}{unit ? <span className="text-slate-500 font-normal normal-case"> ({unit})</span> : null}
      </label>
      {children}
      {hint && !error ? <p className="text-xs text-slate-500 mt-0.5">{hint}</p> : null}
      {error ? <p className="text-xs text-red-400 mt-0.5 font-medium">{error}</p> : null}
    </div>
  );
}

function NInput({ value, onChange, min, max, step, error }) {
  return (
    <input type="number" value={value} onChange={(e) => onChange(parseFloat(e.target.value) || 0)}
      onWheel={(e) => e.target.blur()}
      min={min} max={max} step={step || "any"}
      className={"w-full bg-slate-800 border rounded px-3 py-1.5 text-sm text-slate-100 font-mono tabular-nums focus:outline-none focus:border-sky-500/70 focus:ring-1 focus:ring-sky-500/30 transition-colors " + (error ? "border-red-500/60" : "border-slate-600/50")} />
  );
}

function Sel({ value, onChange, options }) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)}
      className="w-full bg-slate-800 border border-slate-600/50 rounded px-3 py-1.5 text-sm text-slate-100 focus:outline-none focus:border-sky-500/70 transition-colors">
      {options.map((o) => <option key={o.value||o} value={o.value||o}>{o.label||o}</option>)}
    </select>
  );
}

function Divider({ label }) {
  return (
    <div className="flex items-center gap-2 mt-5 mb-3">
      <div className="h-px flex-1 bg-slate-700" />
      <span className="text-[10px] font-bold tracking-widest text-slate-500 uppercase">{label}</span>
      <div className="h-px flex-1 bg-slate-700" />
    </div>
  );
}

function Chip({ label, value }) {
  return (
    <div className="bg-slate-800/80 border border-slate-700/60 rounded px-2.5 py-1 text-center min-w-[68px]">
      <div className="text-[10px] text-slate-500 uppercase tracking-wide font-semibold">{label}</div>
      <div className="text-sm font-mono text-slate-200 tabular-nums">{value}</div>
    </div>
  );
}

function Acc({ title, open: initOpen, badge, children }) {
  const [open, setOpen] = useState(!!initOpen);
  return (
    <div className="border border-slate-700/50 rounded overflow-hidden">
      <button onClick={() => setOpen(!open)} className="w-full flex items-center justify-between px-3 py-2 bg-slate-800/60 hover:bg-slate-800 transition-colors text-left">
        <span className="text-xs font-bold text-slate-300 uppercase tracking-wide">{title}</span>
        <div className="flex items-center gap-2">
          {badge}
          <svg className={"w-3.5 h-3.5 text-slate-500 transition-transform " + (open ? "rotate-180" : "")} fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
          </svg>
        </div>
      </button>
      {open ? <div className="px-3 py-2.5 bg-slate-900/40">{children}</div> : null}
    </div>
  );
}

function STabs({ tabs, active, onChange }) {
  return (
    <div className="flex gap-0.5 mb-3">
      {tabs.map((t) => (
        <button key={t.id} onClick={() => onChange(t.id)}
          className={"px-3 py-1 text-[10px] font-bold uppercase tracking-wider rounded-sm transition-colors " + (active === t.id ? "bg-sky-900/50 text-sky-400 border border-sky-700/50" : "text-slate-500 hover:text-slate-300 border border-transparent")}>
          {t.label}
        </button>
      ))}
    </div>
  );
}

function TRow({ cells, alt }) {
  return (
    <tr className={"border-b border-slate-800/50 " + (alt ? "bg-slate-900/20" : "")}>
      {cells.map((c, i) => (
        <td key={i} className={"px-2 py-1 text-xs font-mono tabular-nums whitespace-nowrap " + (i > 0 ? "text-right" : "")}>{c}</td>
      ))}
    </tr>
  );
}

function THead({ cols }) {
  return (
    <thead>
      <tr className="border-b-2 border-slate-700">
        {cols.map((c, i) => (
          <th key={i} className={"px-2 py-1 text-[10px] font-bold text-slate-400 uppercase tracking-wider whitespace-nowrap " + (i === 0 ? "text-left" : "text-right")}>{c}</th>
        ))}
      </tr>
    </thead>
  );
}

/* ── Revised C&C Matrix — shows all zones with correct areas ── */
function CCMatrix({ pressures, title, areas, userAreas, onUserAreaChange, labelOverrides = {} }) {
  const zones = [...new Set(pressures.map((p) => p.zone))];

  function interpUserPressure(zd, userArea, sign) {
    const pts = zd.map(p => ({ a: p.area, v: sign === "neg" ? p.pnN : p.ppP }))
                  .sort((x,y) => x.a - y.a);
    if (pts.length === 0) return null;
    const ua = Math.max(userArea, 1);
    if (ua <= pts[0].a) return pts[0].v;
    if (ua >= pts[pts.length-1].a) return pts[pts.length-1].v;
    for (let i = 0; i < pts.length - 1; i++) {
      const lo = pts[i], hi = pts[i+1];
      if (ua >= lo.a && ua <= hi.a) {
        const t = (Math.log10(ua) - Math.log10(lo.a)) / (Math.log10(hi.a) - Math.log10(lo.a));
        return lo.v + t * (hi.v - lo.v);
      }
    }
    return pts[pts.length-1].v;
  }

  const hasUser = userAreas && userAreas.length > 0 && onUserAreaChange;

  return (
    <div className="overflow-x-auto">
      {title ? <p className="text-xs text-slate-400 mb-1.5 font-semibold">{title}</p> : null}
      <table className="w-auto min-w-full text-xs font-mono tabular-nums border-collapse">
        <thead>
          <tr className="border-b border-slate-700/50">
            <th className="px-1 py-0.5 text-left w-20"></th>
            <th className="px-1 py-0.5 text-center text-[10px] font-bold text-slate-400 uppercase" colSpan={areas.length}>Eff. Wind Area (sf)</th>
            {hasUser && <th className="text-center py-0.5 text-[10px] text-amber-400 font-bold border-b border-amber-500/40 border-l border-slate-700/60" colSpan={userAreas.length}>User Input</th>}
          </tr>
          <tr className="border-b border-slate-700">
            <th className="px-1 py-1 text-left text-[10px] font-bold text-slate-400 uppercase w-20">Zone</th>
            {areas.map((a) => <th key={a} className="px-0.5 py-1 text-center text-[10px] font-bold text-sky-500/70 w-[52px]">{a}</th>)}
            {hasUser && userAreas.map((ua, i) => (
              <th key={"u"+i} className={"py-1 text-center text-[10px] text-amber-400 font-bold w-[52px] " + (i===0 ? "border-l border-slate-700/60 pl-1" : "")}>
                <input
                  type="number" min="1" value={ua}
                  onChange={e => onUserAreaChange(i, parseFloat(e.target.value)||1)}
                  onWheel={e => e.target.blur()}
                  className="w-12 text-center bg-transparent border-b border-amber-500/60 text-amber-300 text-[10px] font-bold outline-none"
                /> sf
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {zones.map((zone, zi) => {
            const m  = labelOverrides[zone] || ZMETA[zone] || { label: zone, desc: "" };
            const zd = pressures.filter((p) => p.zone === zone);
            const isOh = zd[0]?.isOverhang;
            return (
              <tr key={zone} className={"border-b border-slate-800/50 " + (zi % 2 === 0 ? "bg-slate-900/25" : "") + (isOh ? " opacity-80" : "")}>
                <td className="px-1 py-1">
                  <div className="text-slate-200 font-bold text-[11px]">{m.label}</div>
                  <div className="text-[9px] text-slate-500">{m.desc}{isOh ? " (GCpi=0)" : ""}</div>
                </td>
                {areas.map((a) => {
                  const c = zd.find((p) => p.area === a);
                  if (!c) return (<td key={a} className="text-center text-slate-700">—</td>);
                  return (
                    <td key={a} className="px-0.5 py-1 text-center">
                      {!isOh && <div className="text-amber-300/90 leading-tight">{c.ppP.toFixed(1)}</div>}
                      <div className="text-sky-400/90 leading-tight">{c.pnN.toFixed(1)}</div>
                    </td>
                  );
                })}
                {hasUser && userAreas.map((ua, i) => {
                  const pn = interpUserPressure(zd, ua, "neg");
                  const pp = interpUserPressure(zd, ua, "pos");
                  return (
                    <td key={"u"+i} className={"px-0.5 py-1 text-center " + (i===0 ? "border-l border-slate-700/60" : "")}>
                      {pp != null && !isOh && <div className="text-amber-300 font-bold leading-tight">{pp.toFixed(1)}</div>}
                      {pn != null && <div className="text-sky-400 font-bold leading-tight">{pn.toFixed(1)}</div>}
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
      <div className="flex gap-4 mt-1.5 text-[9px] text-slate-600">
        {pressures.some(p => !p.isOverhang) && <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-sm bg-amber-300/50" />Positive (+GCpi)</span>}
        <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-sm bg-sky-400/50" />{pressures.every(p => p.isOverhang) ? "Uplift (GCpi=0, upward)" : "Suction (−GCpi)"}</span>
        <span>psf per cell: +max / −max</span>
      </div>
    </div>
  );
}


/* ── Wall Profile — rows state lifted to parent (WindCalculator) to survive tab switches ── */
function WallProfile({ d, isNormal, rows, addRow, removeRow, updateRow, lockRow }) {

  const combN = isNormal ? "combN_normal"   : "combN_parallel";
  const combP = isNormal ? "combP_normal"   : "combP_parallel";
  const lwPrs = isNormal ? d.lwPrs?.normal  : d.lwPrs?.parallel;
  const lwPn  = lwPrs?.pN ?? 0;
  const lwPp  = lwPrs?.pP ?? 0;

  function calcExtra(z_ft) {
    const alpha=9.5, zg=900, zm=15;
    const kz = 2.01 * Math.pow(Math.max(z_ft, zm) / zg, 2 / alpha);
    const kd  = d.kd  || 0.85;
    const iw  = d.iw  || 1.0;   // importance factor (1.15 for 7-05, 1.0 for 7-10+)
    const qzRaw = 0.00256 * kz * kd * iw * (d.V||120) * (d.V||120);
    // For 7-05 & 7-10: Kd applied at pressure level, not in qz — remove it from qzRaw
    const isKdAtPressureExtra = d.code_version === "7-05" || d.code_version === "7-10";
    const qzForPress = isKdAtPressureExtra ? qzRaw / kd : qzRaw;
    const G = d.G || 0.85;
    const gcpi = d.gcpi || 0.18;
    const qhRef = d.qhD ?? d.qh;   // qhD for 7-05 (no Kd), qh for all others
    const qzGCp = Math.round(qzForPress * G * 0.8 * 10) / 10;
    const pN = Math.round((qzGCp - qhRef * gcpi) * 10) / 10;
    const pP = Math.round((qzGCp + qhRef * gcpi) * 10) / 10;
    // Combined WW+LW: GCpi cancels — use bare pLW_n/p (no GCpi), not lwPrs.pN
    const lwBare = (isNormal ? d.pLW_n : d.pLW_p) ?? (lwPn + qhRef * gcpi);
    const combined = Math.round((qzGCp - lwBare) * 10) / 10;
    return { kz, kzt: 1.0, qzGCp, pN, pP, combined };
  }

  /* Base profile rows from apiDir */
  const baseEntries = (d.profile || []).map((r) => ({
    key: "b-" + r.z_ft,
    z_ft: r.z_ft, kz: r.kz, kzt: r.kzt ?? 1.0,
    qzGCp: r.pN != null ? r2(r.pN + (d.qhD ?? d.qh) * (d.gcpi||0.18)) : null,  // q·G·Cp = pN + qhD·GCpi
    pN: r.pN,   // w/+GCpi (suction case)
    pP: r.pP,   // w/−GCpi (pressure case)
    combined: r[combN],
    isBase: true,
  }));

  /* Extra rows: locked ones sort into the table; unlocked ones stay at bottom */
  const lockedExtras = rows
    .filter((r) => r.locked && !isNaN(parseFloat(r.val)) && parseFloat(r.val) > 0)
    .map((r) => {
      const z    = parseFloat(r.val);
      const calc = calcExtra(z);
      return { key: "e-" + r.id, id: r.id, val: r.val, z_ft: z, kz: calc.kz, kzt: calc.kzt, qzGCp: calc.qzGCp, pN: calc.pN, pP: calc.pP, combined: calc.combined, isBase: false, locked: true };
    });

  const sortedRows = [...baseEntries, ...lockedExtras].sort((a, b) => a.z_ft - b.z_ft);

  /* Unlocked rows always stay at the bottom — no jumping */
  const unlockedRows = rows
    .filter((r) => !r.locked)
    .map((r) => {
      const z     = parseFloat(r.val);
      const valid = !isNaN(z) && z > 0;
      const calc  = valid ? calcExtra(z) : null;
      return { key: "u-" + r.id, id: r.id, val: r.val, valid, calc };
    });

  return (
    <div className="border border-slate-700/50 rounded overflow-hidden">
      <div className="px-3 py-2 bg-slate-800/60 flex items-center justify-between">
        <span className="text-xs font-bold text-slate-300 uppercase tracking-wide">Wall Profile — Combined WW + LW (psf)</span>
        <button
          onClick={addRow}
          className="text-[10px] px-2.5 py-0.5 bg-sky-900/40 border border-sky-700/50 rounded text-sky-400 hover:bg-sky-800/60 transition-colors font-semibold tracking-wide">
          + Add Height (Z)
        </button>
      </div>

      <div className="px-3 py-2.5 bg-slate-900/40 space-y-2">
        {lwPrs ? (
          <div className="flex flex-wrap gap-x-5 gap-y-0.5 text-[10px] font-mono text-slate-500 pb-1.5 border-b border-slate-800/60">
            <span>LW Cp = {isNormal ? (d.cLW_n||0).toFixed(3) : (d.cLW_p||0).toFixed(3)}</span>
            <span>LW w/+GCpi: <span className="text-slate-400">{lwPn.toFixed(1)} psf</span></span>
            <span>LW w/−GCpi: <span className="text-slate-400">{lwPp.toFixed(1)} psf</span></span>
            <span className="text-slate-600">Combined = |WW| + |LW| = WW − LW</span>
          </div>
        ) : null}

        <table className="w-full text-xs font-mono tabular-nums">
          <thead>
            <tr className="border-b border-slate-700/50">
              <th className="px-2 py-1 text-left text-[10px] font-bold text-slate-400 uppercase tracking-wider" rowSpan={2}>z (ft)</th>
              <th className="px-2 py-1 text-right text-[10px] font-bold text-slate-400 uppercase tracking-wider" rowSpan={2}>Kz</th>
              <th className="px-2 py-1 text-right text-[10px] font-bold text-slate-400 uppercase tracking-wider" rowSpan={2}>Kzt</th>
              <th className="px-1 py-1 text-center text-[10px] font-bold text-sky-500/70 uppercase tracking-wider border-l border-slate-700/50" colSpan={3}>Windward Wall (psf)</th>
              <th className="px-2 py-1 text-right text-[10px] font-bold text-amber-500/70 uppercase tracking-wider border-l border-slate-700/50" rowSpan={2}>Combined WW+LW</th>
              <th className="w-5" rowSpan={2}/>
            </tr>
            <tr className="border-b-2 border-slate-700">
              <th className="px-2 py-1 text-right text-[10px] font-bold text-sky-500/70 border-l border-slate-700/50">q·G·Cp</th>
              <th className="px-2 py-1 text-right text-[10px] font-bold text-sky-500/70">w/+GCpi</th>
              <th className="px-2 py-1 text-right text-[10px] font-bold text-sky-500/70">w/−GCpi</th>
            </tr>
          </thead>
          <tbody>
            {/* Sorted base + locked extra rows */}
            {sortedRows.map((r, i) => (
              <tr key={r.key}
                className={"border-b border-slate-800/50 " + (i%2===1 ? "bg-slate-900/20" : "") + (!r.isBase ? " bg-sky-950/20" : "")}>
                <td className="px-2 py-1 whitespace-nowrap">
                  {r.isBase ? (
                    <span className="text-slate-300">{r.z_ft.toFixed(1)}</span>
                  ) : (
                    <input
                      type="number" min="1" step="1"
                      value={r.val}
                      onChange={(e) => updateRow(r.id, e.target.value)}
                      onBlur={() => lockRow(r.id)}
                      onKeyDown={(e) => { if (e.key === "Enter") { lockRow(r.id); e.target.blur(); } }}
                      className="w-16 bg-transparent border-b border-sky-600/40 text-sky-300 font-mono text-xs focus:outline-none focus:border-sky-400 tabular-nums" />
                  )}
                </td>
                <td className="px-2 py-1 text-right text-slate-400">{r.kz != null ? r.kz.toFixed(2) : "—"}</td>
                <td className="px-2 py-1 text-right text-slate-400">{r.kzt != null ? r.kzt.toFixed(2) : "—"}</td>
                <td className="px-2 py-1 text-right border-l border-slate-700/50 text-slate-400">{r.qzGCp != null ? r.qzGCp.toFixed(1) : "—"}</td>
                <td className="px-2 py-1 text-right text-sky-400/80">{r.pN != null ? r.pN.toFixed(1) : "—"}</td>
                <td className="px-2 py-1 text-right text-sky-400/80">{r.pP != null ? r.pP.toFixed(1) : "—"}</td>
                <td className="px-2 py-1 text-right border-l border-slate-700/50">{r.combined != null ? <Psf v={r.combined} /> : <span className="text-slate-600">—</span>}</td>
                <td className="px-1 py-1 text-center w-5">
                  {!r.isBase ? (
                    <button onClick={() => removeRow(r.id)} className="text-red-500/50 hover:text-red-400 text-[11px]">✕</button>
                  ) : null}
                </td>
              </tr>
            ))}

            {/* Unlocked (being typed) rows — pinned at bottom, never jump */}
            {unlockedRows.map((r) => (
              <tr key={r.key} className="border-b border-slate-800/30 bg-sky-950/10">
                <td className="px-2 py-1">
                  <input
                    type="number" min="1" step="1"
                    value={r.val}
                    onChange={(e) => updateRow(r.id, e.target.value)}
                    onBlur={() => lockRow(r.id)}
                    onKeyDown={(e) => { if (e.key === "Enter") { lockRow(r.id); e.target.blur(); } }}
                    autoFocus
                    placeholder="z ft"
                    className="w-16 bg-transparent border-b border-sky-500/60 text-sky-300 font-mono text-xs focus:outline-none focus:border-sky-300 tabular-nums" />
                </td>
                <td className="px-2 py-1 text-right text-slate-500">{r.valid ? r.calc.kz.toFixed(2) : "—"}</td>
                <td className="px-2 py-1 text-right text-slate-500">{r.valid ? r.calc.kzt.toFixed(2) : "—"}</td>
                <td className="px-2 py-1 text-right border-l border-slate-700/50 text-slate-500">{r.valid ? r.calc.qzGCp?.toFixed(1) : "—"}</td>
                <td className="px-2 py-1 text-right text-slate-500">{r.valid ? r.calc.pN?.toFixed(1) : "—"}</td>
                <td className="px-2 py-1 text-right text-slate-500">{r.valid ? r.calc.pP?.toFixed(1) : "—"}</td>
                <td className="px-2 py-1 text-right border-l border-slate-700/50">{r.valid ? <span className="opacity-60"><Psf v={r.calc.combined} /></span> : <span className="text-slate-600">—</span>}</td>
                <td className="px-1 py-1 text-center w-5">
                  <button onClick={() => removeRow(r.id)} className="text-red-500/50 hover:text-red-400 text-[11px]">✕</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        <p className="text-[10px] text-slate-600 pt-0.5">
          Combined = p_WW(z) − p_LW = |WW|+|LW|. At z = h GCpi cancels. GCpi = ±{d.gcpi}.
          <span className="text-sky-700/70 ml-2">Type height then press Enter or click away to sort into table.</span>
        </p>
      </div>
    </div>
  );
}

/* ── MWFRS Directional tab ── */
function DirTab({ d, elev, geo, ug, sub, setSub, rows, addRow, removeRow, updateRow, lockRow }) {
  const isNormal   = sub === "normal";
  const cpLw      = d && (isNormal ? d.cLW_n : d.cLW_p);
  const lwRatio   = d && (isNormal ? d.ratioLW_n : d.ratioLW_p);
  const roofRatio = d && (isNormal ? d.ratioRoof_n : d.ratioRoof_p);
  const rz        = d && (isNormal ? d.roofNormal : d.roofParallel);
  const lwP       = d && (isNormal ? d.lwP_n : d.lwP_p);
  const lwN       = d && (isNormal ? d.lwN_n : d.lwN_p);
  const dirLabel  = isNormal ? "Normal to Ridge" : "Parallel to Ridge";
  const ratioLabel = isNormal ? "B/L" : "L/B";
  const roofLabel  = isNormal ? "h/B" : "h/L";

  const tabs = [
    { id:"normal",   label:"Normal to Ridge" },
    { id:"parallel", label:"Parallel to Ridge" },
  ];
  if (elev !== null) tabs.push({ id:"elevated", label:"Elevated Bldg §27.1.5" });

  // Geometry check row helper
  const GeoRow = ({ label, pass, detail }) => (
    <div className="flex items-center justify-between text-xs px-2 py-1.5 rounded border border-slate-700/40 bg-slate-900/30">
      <span className="text-slate-400">{label}</span>
      <div className="flex items-center gap-2">
        {detail ? <span className="text-slate-500 font-mono text-[10px]">{detail}</span> : null}
        <span className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase ${pass ? "bg-emerald-900/40 border border-emerald-700/40 text-emerald-400" : "bg-red-900/40 border border-red-700/40 text-red-400"}`}>
          {pass ? "OK" : "FAIL"}
        </span>
      </div>
    </div>
  );

  return (
    <div className="space-y-4">
      {d ? (
        <>
          <h2 className="text-sm font-bold text-slate-300">
            MWFRS Directional — Ch. 27 | L = {d.L} ft | B = {d.B} ft | h = {d.h} ft
          </h2>
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs font-mono text-slate-400">
            <span>qh = {d.qh.toFixed(1)} psf</span>
            <span>G = <span className="text-sky-400 font-bold">{d.G.toFixed(4)}</span></span>
            {d.kztH && d.kztH !== 1.0 ? <span className="text-amber-400/80">Kzt = {d.kztH.toFixed(4)}</span> : null}
            <span className="text-slate-600 text-[9px]">{d.gRes?.note}</span>
          </div>
        </>
      ) : elev?.ok ? (
        <h2 className="text-sm font-bold text-slate-300">MWFRS — Elevated Building §27.1.5</h2>
      ) : null}
      {(sub === "normal" || sub === "parallel") && d ? (
        <>
          <div className="px-3 py-1.5 bg-slate-800/40 border border-slate-700/30 rounded text-[10px] text-slate-400 flex flex-wrap gap-x-4 gap-y-0.5 font-mono">
            <span>{dirLabel}</span>
            <span>LW ratio ({ratioLabel}) = {lwRatio}</span>
            <span>Roof ratio ({roofLabel}) = {roofRatio}</span>
          </div>

          <div className="grid grid-cols-3 gap-2">
            {[{ l:"Windward", cp:d.cWW }, { l:"Leeward", cp:cpLw }, { l:"Side", cp:d.cSW }].map((w) => (
              <div key={w.l} className="bg-slate-800/60 border border-slate-700/50 rounded p-2.5">
                <div className="text-[10px] text-slate-500 font-semibold uppercase">{w.l}</div>
                <div className="text-base font-bold text-slate-200 font-mono">{w.cp.toFixed(2)} <span className="text-[10px] text-slate-600">Cp</span></div>
              </div>
            ))}
          </div>

          <Acc title={"Surface Pressures — " + dirLabel + " (psf)"} open={true}>
            <table className="w-full text-xs font-mono tabular-nums">
              <THead cols={["Surface", "Cp", "qGCp", "w/ +GCpi", "w/ −GCpi"]} />
              <tbody>
                <TRow cells={["Windward","0.80",(d.qh*d.G*0.8).toFixed(1),<Psf v={d.qh*d.G*0.8 - d.qh*d.gcpi} />,<Psf v={d.qh*d.G*0.8 + d.qh*d.gcpi} />]} />
                <TRow cells={["Leeward",cpLw.toFixed(4),(d.qh*d.G*cpLw).toFixed(1),<Psf v={lwP} />,<Psf v={lwN} />]} alt />
                <TRow cells={["Side","−0.70",(d.qh*d.G*-0.7).toFixed(1),<Psf v={d.swP} />,<Psf v={d.swN} />]} />
              </tbody>
            </table>
          </Acc>

          {rz ? (
            <Acc title={"Roof Zones — " + dirLabel + " (" + roofLabel + " = " + roofRatio + ")"} open={true}>
              <table className="w-full text-xs font-mono tabular-nums">
                <THead cols={["Zone","Cp","qhGCp","w/ +GCpi","w/ −GCpi"]} />
                <tbody>
                  {rz.map((r, i) => {
                    const q = d.qh * d.G * r.cp;
                    return (<TRow key={i} alt={i%2===1} cells={[r.zone, r.cp.toFixed(2), q.toFixed(1), <Psf v={q - d.qh*d.gcpi} />, <Psf v={q + d.qh*d.gcpi} />]} />);
                  })}
                </tbody>
              </table>
            </Acc>
          ) : null}

          <WallProfile d={d} isNormal={isNormal} rows={rows} addRow={addRow} removeRow={removeRow} updateRow={updateRow} lockRow={lockRow} />

          {/* ── Parapet §27.3.4 ── */}
          {d.parZ > 0 ? (
            <div className="border border-slate-700/50 rounded overflow-hidden">
              <div className="px-3 py-2 bg-slate-800/60">
                <span className="text-xs font-bold text-slate-300 uppercase tracking-wide">Parapet Pressures — §27.3.4</span>
              </div>
              <div className="px-3 py-2.5 bg-slate-900/40 space-y-2">
                <table className="w-full text-xs font-mono tabular-nums">
                  <THead cols={["z (ft)", "Kz", "Kzt", "qp (psf)"]} />
                  <tbody>
                    <TRow cells={[d.parZ.toFixed(1), d.parKz?.toFixed(4) ?? "—", d.parKzt?.toFixed(4) ?? "—", d.parQp?.toFixed(1) ?? "—"]} />
                  </tbody>
                </table>
                <div className="grid grid-cols-2 gap-2 pt-1">
                  <div className="bg-slate-800/60 border border-slate-700/50 rounded p-2.5">
                    <div className="text-[10px] text-slate-500 uppercase font-semibold">Windward Parapet</div>
                    <div className="text-base font-bold font-mono"><span className="text-amber-300">{d.parWW?.toFixed(1)} psf</span></div>
                    <div className="text-[9px] text-slate-600 mt-0.5">GCpn = +{d.code_version === "7-02" ? "1.8" : "1.5"} × qp</div>
                  </div>
                  <div className="bg-slate-800/60 border border-slate-700/50 rounded p-2.5">
                    <div className="text-[10px] text-slate-500 uppercase font-semibold">Leeward Parapet</div>
                    <div className="text-base font-bold font-mono"><span className="text-sky-400">{d.parLW?.toFixed(1)} psf</span></div>
                    <div className="text-[9px] text-slate-600 mt-0.5">GCpn = {d.code_version === "7-02" ? "-1.1" : "-1.0"} × qp</div>
                  </div>
                </div>
                <p className="text-[10px] text-slate-600">qp evaluated at z = {d.parZ.toFixed(1)} ft (top of parapet above ground) per §27.3.4.</p>
              </div>
            </div>
          ) : null}
        </>
      ) : null}

      {/* ── Elevated Building §27.1.5 ─────────────────────────────── */}
      {sub === "elevated" && elev !== null ? (
        <div className="space-y-4">
          {/* ── Inputs ── */}
          <div className="border border-slate-700/50 rounded overflow-hidden">
            <div className="px-3 py-2 bg-slate-800/60 text-xs font-bold text-slate-300 uppercase tracking-wide">
              Elevated Building Inputs — ASCE 7-22 §27.1.5
            </div>
            <div className="p-3 grid grid-cols-2 gap-x-4 gap-y-2.5">
              <div className="col-span-2 text-[10px] text-slate-500 font-semibold uppercase tracking-wide">Building</div>
              <Field label="hb — ht to bottom of structure" unit="ft" hint="Height above grade to underside of elevated floor">
                <NInput value={geo.hb_ft} onChange={(v) => ug("hb_ft", v)} min={0} step={1} />
              </Field>
              <div className="col-span-2 text-[10px] text-slate-500 font-semibold uppercase tracking-wide pt-1">Sub-structure cross-sectional areas</div>
              <Field label="Column cross-section area" unit="sf">
                <NInput value={geo.elev_cols_area_sf} onChange={(v) => ug("elev_cols_area_sf", v)} min={0} />
              </Field>
              <Field label="Enclosed area below bldg" unit="sf">
                <NInput value={geo.elev_enc_area_sf} onChange={(v) => ug("elev_enc_area_sf", v)} min={0} />
              </Field>
              <div className="col-span-2 text-[10px] text-slate-500 font-semibold uppercase tracking-wide pt-1">Projected widths facing each wind direction</div>
              <Field label="Col. proj. width — Dir 1 (normal to ridge)" unit="ft">
                <NInput value={geo.elev_col_width_d1_ft} onChange={(v) => ug("elev_col_width_d1_ft", v)} min={0} />
              </Field>
              <Field label="Enc. proj. width — Dir 1 (normal to ridge)" unit="ft">
                <NInput value={geo.elev_enc_width_d1_ft} onChange={(v) => ug("elev_enc_width_d1_ft", v)} min={0} />
              </Field>
              <Field label="Col. proj. width — Dir 2 (parallel to ridge)" unit="ft">
                <NInput value={geo.elev_col_width_d2_ft} onChange={(v) => ug("elev_col_width_d2_ft", v)} min={0} />
              </Field>
              <Field label="Enc. proj. width — Dir 2 (parallel to ridge)" unit="ft">
                <NInput value={geo.elev_enc_width_d2_ft} onChange={(v) => ug("elev_enc_width_d2_ft", v)} min={0} />
              </Field>
            </div>
          </div>

          {!elev.ok ? (
            <div className="px-3 py-3 rounded border border-slate-700/40 bg-slate-800/30 text-xs text-slate-400">
              {elev.reason}
            </div>
          ) : (<>
          <div className="px-3 py-2 rounded border border-slate-700/40 bg-slate-800/30 text-[10px] font-mono text-slate-400 flex flex-wrap gap-x-4 gap-y-0.5">
            <span>hb = <span className="text-white font-bold">{elev.hb} ft</span></span>
            <span>GCpi = ±{elev.gcpi}</span>
            <span className={elev.anyElev ? "text-emerald-400" : "text-red-400 font-bold"}>
              {elev.anyElev
                ? (elev.elev_d1 && elev.elev_d2 ? "Both directions eligible" : elev.elev_d1 ? "Dir 1 eligible only" : "Dir 2 eligible only")
                : "Neither direction eligible — treat as continuous to grade"}
            </span>
          </div>

          {/* Geometry checks */}
          <div className="border border-slate-700/50 rounded overflow-hidden">
            <div className="px-3 py-2 bg-slate-800/60 text-xs font-bold text-slate-300 uppercase tracking-wide">
              Geometry Eligibility Checks
            </div>
            <div className="p-3 space-y-4">
              {/* Limitation 1 */}
              <div>
                <p className="text-[10px] text-slate-500 mb-2 font-semibold">
                  Limitation 1 — Area ratio: (cols + enclosed) / footprint ≤ max (L/B-dependent)
                </p>
                <div className="text-[10px] font-mono text-slate-500 mb-2 px-1">
                  Footprint = {elev.footprint.toFixed(0)} sf &nbsp;|&nbsp;
                  Below area = {elev.total_below.toFixed(0)} sf &nbsp;|&nbsp;
                  Ratio = {(elev.area_ratio * 100).toFixed(1)}%
                </div>
                <div className="space-y-1.5">
                  <GeoRow label={`Dir 1 (Normal to Ridge) — L/B = ${(elev.elev_d1 || !elev.lim1_d1 ? (1/1).toFixed(0) : "")}B/L, max ratio = ${(elev.maxR_d1 * 100).toFixed(0)}%`}
                    pass={elev.lim1_d1}
                    detail={`ratio ${(elev.area_ratio*100).toFixed(1)}% vs max ${(elev.maxR_d1*100).toFixed(0)}%`} />
                  <GeoRow label={`Dir 2 (Parallel to Ridge) — L/B, max ratio = ${(elev.maxR_d2 * 100).toFixed(0)}%`}
                    pass={elev.lim1_d2}
                    detail={`ratio ${(elev.area_ratio*100).toFixed(1)}% vs max ${(elev.maxR_d2*100).toFixed(0)}%`} />
                </div>
              </div>
              {/* Limitation 2 */}
              <div>
                <p className="text-[10px] text-slate-500 mb-2 font-semibold">
                  Limitation 2 — Projected width ratio ≤ 75% of building dimension
                </p>
                <div className="space-y-1.5">
                  <GeoRow label={`Dir 1 — proj. width ${elev.projW_d1} ft / B = ${(elev.projRatio_d1*100).toFixed(0)}%`}
                    pass={elev.lim2_d1}
                    detail={`≤ 75%?`} />
                  <GeoRow label={`Dir 2 — proj. width ${elev.projW_d2} ft / L = ${(elev.projRatio_d2*100).toFixed(0)}%`}
                    pass={elev.lim2_d2}
                    detail={`≤ 75%?`} />
                </div>
              </div>
              {/* Combined result */}
              <div className="space-y-1.5">
                <GeoRow label="Direction 1 (Normal to Ridge) — design as elevated?" pass={elev.elev_d1} />
                <GeoRow label="Direction 2 (Parallel to Ridge) — design as elevated?" pass={elev.elev_d2} />
              </div>
            </div>
          </div>

          {/* Horizontal pressure */}
          <div className="border border-slate-700/50 rounded overflow-hidden">
            <div className="px-3 py-2 bg-slate-800/60 text-xs font-bold text-slate-300 uppercase tracking-wide">
              Horizontal Pressure on Sub-structure (0 to hb) — Cp = 1.3
            </div>
            <div className="p-3 space-y-3">
              <table className="w-full text-xs font-mono tabular-nums">
                <THead cols={["z (ft)", "Kz", "Kzt", "qz (psf)", "qzG·Cp (psf)"]} />
                <tbody>
                  <TRow cells={[
                    elev.z_eval.toFixed(1),
                    elev.kzEval.toFixed(4),
                    elev.kztZ.toFixed(4),
                    elev.qzEval.toFixed(1),
                    <span className="text-amber-300 font-bold">{elev.p_horiz.toFixed(1)}</span>
                  ]} />
                </tbody>
              </table>
              <p className="text-[10px] text-slate-500">z evaluated at max(hb, 15) = {elev.z_eval} ft per §27.1.5. Applied to all objects below hb.</p>
              {(elev.force_d1 !== null || elev.force_d2 !== null) ? (
                <div className="grid grid-cols-2 gap-3 pt-1">
                  {elev.force_d1 !== null ? (
                    <div className="bg-slate-800/60 border border-slate-700/50 rounded p-2.5">
                      <div className="text-[10px] text-slate-500 uppercase font-semibold">Dir 1 Total Force</div>
                      <div className="text-base font-bold font-mono text-amber-300">{elev.force_d1.toFixed(1)} k</div>
                      <div className="text-[9px] text-slate-600 mt-0.5">p × proj_width_d1 × hb / 2</div>
                    </div>
                  ) : null}
                  {elev.force_d2 !== null ? (
                    <div className="bg-slate-800/60 border border-slate-700/50 rounded p-2.5">
                      <div className="text-[10px] text-slate-500 uppercase font-semibold">Dir 2 Total Force</div>
                      <div className="text-base font-bold font-mono text-amber-300">{elev.force_d2.toFixed(1)} k</div>
                      <div className="text-[9px] text-slate-600 mt-0.5">p × proj_width_d2 × hb / 2</div>
                    </div>
                  ) : null}
                </div>
              ) : (
                <p className="text-[10px] text-slate-600">Enter projected widths to compute total forces.</p>
              )}
            </div>
          </div>

          {/* Vertical pressure — bottom surface */}
          <div className="border border-slate-700/50 rounded overflow-hidden">
            <div className="px-3 py-2 bg-slate-800/60 text-xs font-bold text-slate-300 uppercase tracking-wide">
              Vertical Pressure — Bottom Surface of Elevated Structure
            </div>
            <div className="p-3 space-y-4">
              <p className="text-[10px] text-slate-500">* Horizontal distance from windward edge. Negative = upward (suction). w/+GCpi = more critical uplift.</p>
              {[
                { label: "Wind Normal to Ridge", zones: elev.vert_normal,   hbL: elev.hbL_n, rf: elev.rf_n },
                { label: "Wind Parallel to Ridge", zones: elev.vert_parallel, hbL: elev.hbL_p, rf: elev.rf_p },
              ].map(({ label, zones, hbL, rf }) => (
                <div key={label}>
                  <div className="text-[10px] font-semibold text-slate-400 mb-1.5">
                    {label} &nbsp;<span className="font-mono text-slate-600">hb/L = {hbL.toFixed(3)} | RF = {rf.toFixed(4)}</span>
                  </div>
                  <table className="w-full text-xs font-mono tabular-nums">
                    <THead cols={["Zone", "Cp", "q·GCp (psf)", "w/+GCpi (psf)", "w/−GCpi (psf)"]} />
                    <tbody>
                      {zones.map((z) => (
                        <tr key={z.label} className={`border-t border-slate-700/30${z.isMin ? " bg-slate-800/40" : ""}`}>
                          <td className={`px-2 py-1 ${z.isMin ? "text-slate-400 italic" : "text-slate-400"}`}>{z.label}</td>
                          <td className="px-2 py-1 text-slate-300">{z.cp.toFixed(3)}</td>
                          <td className="px-2 py-1 text-slate-400">{z.qhGCp.toFixed(1)}</td>
                          <td className="px-2 py-1"><Psf v={z.pPos} /></td>
                          <td className="px-2 py-1"><Psf v={z.pNeg} /></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ))}
            </div>
          </div>
          </>)}
        </div>
      ) : null}

    </div>
  );
}

/* ══════════════════════════════════════════════════════════════════ */
/*  MAIN COMPONENT                                                   */
/* ══════════════════════════════════════════════════════════════════ */

function WindCalcInputs({ wssData, sideTab, onSideTab, onWssResult }) {
  const [proj, setProj] = useState({ code_version:"7-22", risk_category:"III", V_mph:120, exposure:"C", enclosure:"enclosed" });
  const [geo, setGeo]   = useState({ L_ft:100, B_ft:60, h_ft:15, roof_type:"monoslope", roof_angle_deg:1.2, parapet_height_ft:20, min_parapet_ht_ft:5,
    hb_ft:0,
    elev_cols_area_sf:0, elev_enc_area_sf:0,
    elev_col_width_d1_ft:0, elev_enc_width_d1_ft:0,
    elev_col_width_d2_ft:0, elev_enc_width_d2_ft:0,
    lng_n_frames:4, lng_As_sf:0,
    ob_roof_type:"monoslope", ob_wind_flow:"clear",
    // Rooftop equipment #1
    ow_ss_h_top:20, ow_ss_s:10, ow_ss_B:25, ow_ss_Lr:0, ow_ss_pctOpen:0,
    ow_os_z:15, ow_os_w:0, ow_os_d:2, ow_os_pct:35, ow_os_Af:10,
    ow_ch_z:15, ow_ch_h:15, ow_ch_D:1, ow_ch_sec:"square",
    ow_tt_z:15, ow_tt_phi:0.27, ow_tt_sec:"square", ow_tt_mem:"flat", ow_tt_dir:"normal",
    rw_eq1_lL:10, rw_eq1_lB:5, rw_eq1_h:5,
    // Rooftop equipment #2
    rw_eq2_en:false, rw_eq2_lL:3, rw_eq2_lB:3, rw_eq2_h:10,
    rw_equip:[{ lL:10, lB:5, h:5 }],
    // Canopy
    rw_can_en:false, rw_can_he:60, rw_can_hc:45,
    // Solar parallel to roof
    rw_sol_par_en:false, rw_sol_par_area:21,
    // Solar not parallel to roof
    rw_sol_np_en:false, rw_sol_np_w:0, rw_sol_np_h1:0.8, rw_sol_np_h2:0.8,
    rw_sol_np_gap:0.25, rw_sol_np_area1:10, rw_sol_np_area2:1000,
    rw_sol_np_Lp:6, rw_sol_np_hpt:0, rw_sol_np_d1:18.4, rw_sol_np_d2:1, rw_sol_np_area:10,
    // C&C user input columns
    cc_user_area1: 500, cc_user_area2: 100,
  });
  const [kd]  = useState(0.85);
  // Topographic factor inputs (§26.8)
  const [kztIn, setKztIn] = useState({
    topo_type: "flat",
    H_ft:   80,    // hill/escarpment height
    Lh_ft:  100,   // half-length of hill
    x_ft:   50,    // distance from crest (+ve = downwind)
    upwind: false,
  });
  // Gust effect factor inputs (§26.11)
  const [gustIn, setGustIn] = useState({
    mode:  "rigid_fixed",
    n1:    1.0,    // natural frequency (Hz)
    beta:  0.02,   // damping ratio
  });
  const ukzt = (f,v) => setKztIn((s) => ({...s,[f]:v}));
  const ugust = (f,v) => setGustIn((s) => ({...s,[f]:v}));
  const [extraHeights, setExtraHeights] = useState([]);
  const addHeight = () => setExtraHeights((h) => [...h, { id: Date.now(), val: "" }]);
  const removeHeight = (id) => setExtraHeights((h) => h.filter((r) => r.id !== id));
  const updateHeight = (id, val) => setExtraHeights((h) => h.map((r) => r.id === id ? {...r, val} : r));
  // WallProfile rows lifted here so custom heights survive tab switches
  const [wallRows, setWallRows] = useState([]);
  const addWallRow    = () => setWallRows((p) => [...p, { id: Date.now(), val: "", locked: false }]);
  const removeWallRow = (id) => setWallRows((p) => p.filter((r) => r.id !== id));
  const updateWallRow = (id, val) => setWallRows((p) => p.map((r) => r.id === id ? { ...r, val, locked: false } : r));
  const lockWallRow   = (id) => setWallRows((p) => p.map((r) => r.id === id ? { ...r, locked: true } : r));
  const [tab, setTab] = useState("qz");
  const [dirSub, setDirSub] = useState("normal");
  const [ccSub,  setCcSub]  = useState("roof");
  const [rwSub,  setRwSub]  = useState("equip");
  const [owSub,  setOwSub]  = useState("solid");
  const [errs, setErrs] = useState({});
  const [apiE, setApiE] = useState(null);
  const [qzR,  setQzR]  = useState(null);
  const [dirR, setDirR] = useState(null);
  const [lrR,  setLrR]  = useState(null);
  const [ccR,  setCcR]  = useState(null);
  const [useAltCC, setUseAltCC] = useState(false);
  const [elevR,setElevR]= useState(null);
  const [obR,  setObR]  = useState(null);
  const [rwR,  setRwR]  = useState(null);
  const [owR,  setOwR]  = useState(null);

  const up = (f,v) => { setProj((p) => ({...p,[f]:v})); setErrs((e) => ({...e,[f]:undefined})); };

  // ── WSS auto-populate ──
  const [wssLocked, setWssLocked] = useState(true); // true = grayed/read-only
  const [wssOverridden, setWssOverridden] = useState(false);

  useEffect(() => {
    if (!wssData) return;
    up("V_mph", wssData.V_mph);
    up("risk_category", wssData.risk_category);
    up("code_version", wssData.code_version);
    setWssLocked(true);
    setWssOverridden(false);
  }, [wssData]);

  const wssActive = !!wssData && !wssOverridden;
  const wssFieldLocked = wssActive && wssLocked;
  const ug = (f,v) => { setGeo((p)  => ({...p,[f]:v})); setErrs((e) => ({...e,[f]:undefined})); };

  const shared = useMemo(() => {
    if (!qzR) return null;
    const q = qzR.pressures[qzR.pressures.length - 1];
    const isKdAtPressure = qzR.code_version === "7-05" || qzR.code_version === "7-10";
    const qhDisplay = isKdAtPressure ? q.qz_psf / q.kd : q.qz_psf;
    return { ke: q.ke, kd: q.kd, alpha: q.alpha, zg: q.zg_ft, qh: qhDisplay, kztH: qzR.kztH };
  }, [qzR]);

  // Auto-calculate on any input change, debounced 300ms
  useEffect(() => {
    const ve = validate(proj, geo);
    if (Object.keys(ve).length > 0) { setErrs(ve); return; }
    setErrs({});
    const timer = setTimeout(async () => {
      const bp = { project:{...proj, importance_factor:1}, geometry:{...geo, extraHeights: extraHeights.map(r=>parseFloat(r.val)).filter(v=>!isNaN(v)&&v>0)}, kd, kztInputs:kztIn, gustInputs:gustIn, useAltCC };
      try {
        const [a,b,c,d,e,f2,g2,h2] = await Promise.allSettled([apiQz(bp), apiDir(bp), apiLR(bp), apiCC(bp), apiElevated(bp), apiOB(bp), apiRW(bp), apiOtherW(bp)]);
        if (a.status==="fulfilled") setQzR(a.value);
        if (b.status==="fulfilled") setDirR(b.value);
        if (c.status==="fulfilled") setLrR(c.value);
        if (d.status==="fulfilled") setCcR(d.value);
        if (e.status==="fulfilled") setElevR(e.value);
        if (f2.status==="fulfilled") setObR(f2.value);
        if (g2.status==="fulfilled") setRwR(g2.value);
        if (h2.status==="fulfilled") setOwR(h2.value);
      } catch (err) { setApiE(err.message); }
    }, 300);
    return () => clearTimeout(timer);
  }, [proj, geo, kd, kztIn, gustIn, extraHeights, useAltCC]);

  const lrOk = lrR ? lrR.ok : null;

  // Determine areas for C&C display
  const ccRoofAreas = CC_AREAS_ROOF;
  const ccWallAreas = CC_AREAS_WALL;

  function renderWindPanel() {
    return (
      <div className="px-4 py-3 flex-1">
          <Divider label="Project" />
          {/* WSS lock banner */}
          {wssActive && (
            <div style={{ marginBottom: 8, padding: "6px 8px", background: wssOverridden ? "#422006" : "#0c2340", borderRadius: 4, border: wssOverridden ? "1px solid #92400e" : "1px solid #1e4d7b", fontSize: 10, color: wssOverridden ? "#fbbf24" : "#7dd3fc" }}>
              {wssLocked
                ? <><span style={{ fontWeight: 700 }}>🔗 From WSS Lookup</span><br />Edition, RC &amp; V are pre-filled.<br /><button onClick={() => setWssLocked(false)} style={{ marginTop: 4, fontSize: 10, color: "#38bdf8", background: "none", border: "none", cursor: "pointer", textDecoration: "underline", padding: 0 }}>Edit manually</button></>
                : <><span style={{ fontWeight: 700, color: "#fbbf24" }}>⚠ Manually overridden</span><br /><button onClick={() => { up("V_mph", wssData.V_mph); up("risk_category", wssData.risk_category); up("code_version", wssData.code_version); setWssLocked(true); setWssOverridden(false); }} style={{ marginTop: 4, fontSize: 10, color: "#7dd3fc", background: "none", border: "none", cursor: "pointer", textDecoration: "underline", padding: 0 }}>Restore WSS values</button></>
              }
            </div>
          )}
          <Field label="Edition">
            {wssFieldLocked
              ? <div style={{ padding: "4px 8px", background: "#0f172a", border: "1px solid #1e3a5f", borderRadius: 4, fontSize: 12, color: "#475569", fontFamily: "inherit" }}>{CODE_VERS.find(c => c.value === proj.code_version)?.label ?? proj.code_version}</div>
              : <Sel value={proj.code_version} onChange={(v) => { up("code_version",v); setWssOverridden(true); }} options={CODE_VERS} />
            }
          </Field>
          <div className="grid grid-cols-2 gap-2">
            <Field label="Risk Cat">
              {wssFieldLocked
                ? <div style={{ padding: "4px 8px", background: "#0f172a", border: "1px solid #1e3a5f", borderRadius: 4, fontSize: 12, color: "#475569", fontFamily: "inherit" }}>{proj.risk_category}</div>
                : <Sel value={proj.risk_category} onChange={(v) => { up("risk_category",v); setWssOverridden(true); }} options={["I","II","III","IV"].map((v) => ({value:v,label:v}))} />
              }
            </Field>
            <Field label="Exposure"><Sel value={proj.exposure} onChange={(v) => up("exposure",v)} options={EXPOSURES} /></Field>
          </div>
          <Field label="V" unit="mph" error={errs.V_mph}>
            {wssFieldLocked
              ? <div style={{ padding: "4px 8px", background: "#0f172a", border: "1px solid #1e3a5f", borderRadius: 4, fontSize: 12, color: "#475569", fontFamily: "inherit" }}>{proj.V_mph}</div>
              : <NInput value={proj.V_mph} onChange={(v) => { up("V_mph",v); setWssOverridden(true); }} min={85} max={300} error={errs.V_mph} />
            }
          </Field>
          <Field label="Enclosure"><Sel value={proj.enclosure} onChange={(v) => up("enclosure",v)} options={ENCLOSURES} /></Field>
          <Divider label="Geometry" />
          <div className="grid grid-cols-2 gap-2">
            <Field label="L" unit="ft" error={errs.L_ft}><NInput value={geo.L_ft} onChange={(v) => ug("L_ft",v)} min={1} error={errs.L_ft} /></Field>
            <Field label="B" unit="ft" error={errs.B_ft}><NInput value={geo.B_ft} onChange={(v) => ug("B_ft",v)} min={1} error={errs.B_ft} /></Field>
          </div>
          <Field label="h" unit="ft" error={errs.h_ft}><NInput value={geo.h_ft} onChange={(v) => ug("h_ft",v)} min={1} error={errs.h_ft} /></Field>
          <Field label="Roof"><Sel value={geo.roof_type} onChange={(v) => ug("roof_type",v)} options={ROOFS.map((r) => ({value:r.value,label:r.label}))} /></Field>
          <Field label="θ" unit="deg"><NInput value={geo.roof_angle_deg} onChange={(v) => ug("roof_angle_deg",v)} min={0} max={90} step={0.1} /></Field>
          <Field label="Parapet ht above grd" unit="ft"><NInput value={geo.parapet_height_ft} onChange={(v) => ug("parapet_height_ft",v)} min={0} step={0.5} /></Field>
          <Field label="Min parapet ht above roof" unit="ft" hint="≥3 ft → Zone 3 neg = Zone 2 (§30.3 Note 6)"><NInput value={geo.min_parapet_ht_ft} onChange={(v) => ug("min_parapet_ht_ft",v)} min={0} step={0.5} /></Field>

          {/* ── Topographic Factor ── */}
          <Divider label="Topographic Factor Kzt" />
          <Field label="Topography">
            <Sel value={kztIn.topo_type} onChange={(v) => ukzt("topo_type", v)} options={TOPO_TYPES} />
          </Field>
          {kztIn.topo_type !== "flat" ? (
            <>
              <div className="grid grid-cols-2 gap-2">
                <Field label="H" unit="ft"><NInput value={kztIn.H_ft} onChange={(v) => ukzt("H_ft", v)} min={0} step={1} /></Field>
                <Field label="Lh" unit="ft"><NInput value={kztIn.Lh_ft} onChange={(v) => ukzt("Lh_ft", v)} min={1} step={1} /></Field>
              </div>
              <Field label="x from crest" unit="ft">
                <NInput value={kztIn.x_ft} onChange={(v) => ukzt("x_ft", v)} step={1} />
              </Field>
              <Field label="Location">
                <Sel value={kztIn.upwind ? "upwind" : "downwind"} onChange={(v) => ukzt("upwind", v === "upwind")}
                  options={[{value:"upwind",label:"Upwind of crest"},{value:"downwind",label:"Downwind of crest"}]} />
              </Field>
              {/* live Kzt preview */}
              {(() => {
                const r = calcKzt(kztIn.topo_type, kztIn.H_ft, kztIn.Lh_ft, kztIn.x_ft, geo.h_ft, kztIn.upwind);
                return (
                  <div className="px-3 py-2 bg-sky-950/30 border border-sky-800/40 rounded text-xs font-mono text-slate-300 space-y-0.5">
                    <div className="flex justify-between"><span className="text-slate-500">H/Lh</span><span>{r.hLh.toFixed(4)}</span></div>
                    <div className="flex justify-between"><span className="text-slate-500">K1</span><span>{r.k1.toFixed(4)}</span></div>
                    <div className="flex justify-between"><span className="text-slate-500">K2</span><span>{r.k2.toFixed(4)}</span></div>
                    <div className="flex justify-between"><span className="text-slate-500">K3</span><span>{r.k3.toFixed(4)}</span></div>
                    <div className="flex justify-between font-bold text-sky-300"><span>Kzt @ h</span><span>{r.kzt.toFixed(4)}</span></div>
                  </div>
                );
              })()}
            </>
          ) : (
            <div className="px-3 py-2 bg-slate-800/30 rounded text-xs font-mono text-slate-500">Kzt = 1.0 (flat terrain)</div>
          )}

          {/* ── Gust Effect Factor ── */}
          <Divider label="Gust Effect Factor G" />
          <Field label="Method">
            <Sel value={gustIn.mode} onChange={(v) => ugust("mode", v)} options={GUST_MODES} />
          </Field>
          {gustIn.mode !== "rigid_fixed" ? (
            <>
              {gustIn.mode === "flexible" ? (
                <>
                  <div className="grid grid-cols-2 gap-2">
                    <Field label="n₁" unit="Hz"><NInput value={gustIn.n1} onChange={(v) => ugust("n1", v)} min={0.01} step={0.05} /></Field>
                    <Field label="β" unit="ratio"><NInput value={gustIn.beta} onChange={(v) => ugust("beta", v)} min={0.005} max={0.2} step={0.005} /></Field>
                  </div>
                </>
              ) : null}
              {/* live G preview */}
              {(() => {
                const r = calcG(gustIn.mode, proj.exposure, geo.h_ft, gustIn.n1, gustIn.beta, proj.V_mph);
                return (
                  <div className="px-3 py-2 bg-sky-950/30 border border-sky-800/40 rounded text-xs font-mono text-slate-300 space-y-0.5">
                    {r.Iz  != null ? <div className="flex justify-between"><span className="text-slate-500">Iz</span><span>{r.Iz.toFixed(4)}</span></div> : null}
                    {r.Lz  != null ? <div className="flex justify-between"><span className="text-slate-500">Lz (ft)</span><span>{r.Lz.toFixed(2)}</span></div> : null}
                    {r.Q   != null ? <div className="flex justify-between"><span className="text-slate-500">Q</span><span>{r.Q.toFixed(4)}</span></div> : null}
                    {r.R   != null ? <div className="flex justify-between"><span className="text-slate-500">R</span><span>{r.R.toFixed(4)}</span></div> : null}
                    <div className="flex justify-between font-bold text-sky-300"><span>G</span><span>{r.G.toFixed(4)}</span></div>
                    <div className="text-slate-600 text-[9px] mt-0.5">{r.note}</div>
                  </div>
                );
              })()}
            </>
          ) : (
            <div className="px-3 py-2 bg-slate-800/30 rounded text-xs font-mono text-slate-500">G = 0.85 (§26.11.1 fixed)</div>
          )}
        </div>
    );
  }

  return (
    <div className="flex h-screen bg-slate-950 text-slate-200" style={{ fontFamily:"'JetBrains Mono','Fira Code','SF Mono',monospace" }}>
      {/* ── SIDEBAR ── */}
      <aside className="w-72 shrink-0 bg-slate-900 border-r border-slate-800 flex flex-col overflow-y-auto">
        <div className="px-4 py-3 border-b border-slate-800 sticky top-0 bg-slate-900/90 backdrop-blur-sm z-10">
          <div className="flex items-baseline gap-2 mb-2">
            <span className="text-sm font-bold text-slate-100">WIND LOADS</span>
            <span className="text-[10px] text-sky-500 font-semibold">ASCE 7</span>
          </div>
          {/* Left sidebar tab strip */}
          <div className="flex gap-0 rounded overflow-hidden border border-slate-700" style={{ fontSize: 10 }}>
            <button
              onClick={() => onSideTab("wss")}
              style={{ flex:1, padding:"4px 0", background: sideTab==="wss" ? "#0369a1" : "#1e293b", color: sideTab==="wss" ? "#fff" : "#94a3b8", border:"none", cursor:"pointer", fontWeight: sideTab==="wss" ? 700 : 400, fontFamily:"inherit", fontSize:10 }}
            >🌐 Site Hazards</button>
            <button
              onClick={() => onSideTab("wind")}
              style={{ flex:1, padding:"4px 0", background: sideTab==="wind" ? "#0369a1" : "#1e293b", color: sideTab==="wind" ? "#fff" : "#94a3b8", border:"none", borderLeft:"1px solid #334155", cursor:"pointer", fontWeight: sideTab==="wind" ? 700 : 400, fontFamily:"inherit", fontSize:10 }}
            >💨 Wind Inputs</button>
          </div>
        </div>
        <div style={{ display: sideTab === "wind" ? "flex" : "none", flex: 1, overflowY: "auto", flexDirection: "column" }}>{renderWindPanel()}</div>
        <div style={{ display: sideTab === "wss" ? "flex" : "none", flex: 1, overflowY: "auto", flexDirection: "column" }}>{/* always mounted so WSS state persists */}
          <div className="px-4 py-3 flex-1 overflow-y-auto">
            <WSSLookup onWindResult={(d) => { onWssResult(d); }} />
          </div>
        </div>
      </aside>

      {/* ── MAIN ── */}
      <main className="flex-1 flex flex-col overflow-hidden">
        {/* ── Sticky header: chips + main tabs + active sub-tabs ── */}
        <div className="sticky top-0 z-20 bg-slate-900 border-b border-slate-800 shadow-md shadow-slate-950/60">
          {shared ? (
            <div className="px-4 py-2 border-b border-slate-800/60 bg-slate-900/80 flex flex-wrap gap-1.5">
              <Chip label="Ke"   value={shared.ke.toFixed(4)} />
              <Chip label="Kd"   value={shared.kd.toFixed(2)} />
              <Chip label="Kzt"  value={shared.kztH != null ? shared.kztH.toFixed(4) : "1.0000"} />
              <Chip label="α"    value={shared.alpha.toFixed(1)} />
              <Chip label="zg"   value={shared.zg + "'"} />
              <Chip label="qh"   value={shared.qh.toFixed(1) + " psf"} />
              <Chip label="G"    value={dirR ? dirR.G.toFixed(4) : (gustIn.mode==="rigid_fixed" ? "0.8500" : "—")} />
              <Chip label="GCpi" value={"±" + gcpiOf(proj.enclosure)} />
            </div>
          ) : null}

          {/* Main tabs */}
          <div className="px-4 pt-2 flex gap-0.5">
            {TABS.map((t) => {
              const dis = t.id === "lr" && lrOk === false;
              const act = tab === t.id;
              return (
                <button key={t.id} onClick={() => !dis && setTab(t.id)} disabled={dis}
                  title={dis && lrR ? lrR.reason : ""}
                  className={"px-3 py-1.5 text-[10px] font-bold tracking-wider uppercase rounded-t transition-all " + (act ? "bg-slate-800 text-sky-400 border border-slate-700 border-b-transparent -mb-px" : dis ? "text-slate-600 cursor-not-allowed opacity-40" : "text-slate-400 hover:text-slate-200 hover:bg-slate-800/40")}>
                  {t.label}{t.id==="lr" && lrOk===false ? <span className="ml-1 text-[8px] text-amber-500">N/A</span> : null}
                </button>
              );
            })}
          </div>

          {/* Sub-tab row — only for tabs that have sub-tabs */}
          {tab === "dir" && dirR ? (() => {
            const dtabs = [
              { id:"normal",   label:"Normal to Ridge" },
              { id:"parallel", label:"Parallel to Ridge" },
              ...(elevR !== null ? [{ id:"elevated", label:"Elevated Bldg §​27.1.5" }] : []),
            ];
            return (
              <div className="px-4 pt-2 pb-1.5 flex gap-0.5 border-t border-slate-800/70">
                {dtabs.map(t => (
                  <button key={t.id} onClick={() => setDirSub(t.id)}
                    className={"px-3 py-1 text-[10px] font-bold uppercase tracking-wider rounded-sm transition-colors " + (dirSub === t.id ? "bg-sky-900/50 text-sky-400 border border-sky-700/50" : "text-slate-500 hover:text-slate-300 border border-transparent")}>
                    {t.label}
                  </button>
                ))}
              </div>
            );
          })() : null}

          {tab === "cc" && ccR ? (() => {
            const ctabs = [
              { id:"roof",     label:"Roof (1, 1’, 2, 3)" },
              { id:"overhang", label:"Overhangs" },
              { id:"wall",     label: "Walls" },
              { id:"parapet",  label:"Parapet" },
            ];
            return (
              <div className="px-4 pt-2 pb-1.5 flex gap-0.5 border-t border-slate-800/70">
                {ctabs.map(t => (
                  <button key={t.id} onClick={() => setCcSub(t.id)}
                    className={"px-3 py-1 text-[10px] font-bold uppercase tracking-wider rounded-sm transition-colors " + (ccSub === t.id ? "bg-sky-900/50 text-sky-400 border border-sky-700/50" : "text-slate-500 hover:text-slate-300 border border-transparent")}>
                    {t.label}
                  </button>
                ))}
              </div>
            );
          })() : null}

          {tab === "rw" ? (
            <div className="px-4 pt-2 pb-1.5 flex gap-0.5 border-t border-slate-800/70">
              {[
                { id:"equip",  label:"Rooftop Structures" },
                { id:"canopy", label:"Attached Canopies" },
                { id:"solar",  label:"Solar Panels" },
              ].map(t => (
                <button key={t.id} onClick={() => setRwSub(t.id)}
                  className={"px-3 py-1 text-[10px] font-bold uppercase tracking-wider rounded-sm transition-colors " + (rwSub === t.id ? "bg-amber-900/50 text-amber-400 border border-amber-700/50" : "text-slate-500 hover:text-slate-300 border border-transparent")}>
                  {t.label}
                </button>
              ))}
            </div>
          ) : null}
          {tab === "ow" ? (
            <div className="px-4 pt-2 pb-1.5 flex gap-0.5 border-t border-slate-800/70">
              {[
                { id:"solid",   label:"Solid Signs & Walls" },
                { id:"open",    label:"Open Signs & Frames" },
                { id:"chimney", label:"Chimneys & Tanks" },
                { id:"tower",   label:"Trussed Towers" },
              ].map(t => (
                <button key={t.id} onClick={() => setOwSub(t.id)}
                  className={"px-3 py-1 text-[10px] font-bold uppercase tracking-wider rounded-sm transition-colors " + (owSub === t.id ? "bg-sky-900/50 text-sky-400 border border-sky-700/50" : "text-slate-500 hover:text-slate-300 border border-transparent")}>
                  {t.label}
                </button>
              ))}
            </div>
          ) : null}
        </div>

        {/* content */}
        <div className="flex-1 overflow-y-auto px-5 py-4">
          {apiE ? <div className="mb-3 px-2.5 py-1.5 bg-red-950/40 border border-red-800/50 rounded text-xs text-red-400">{apiE}</div> : null}
          {!qzR ? <div className="flex flex-col items-center justify-center h-full opacity-30"><p className="text-sm text-slate-600">Results update automatically as you change inputs</p></div> : null}

          {/* ── qz Profile ── */}
          {tab === "qz" && qzR ? (
            <div>
              <h2 className="text-sm font-bold text-slate-300 mb-3">Velocity Pressure — {qzR.code_version}, Exp {qzR.exposure}, V={qzR.V_mph} mph</h2>
              <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs font-mono text-slate-400 mb-3">
                <span>Kd = {shared.kd.toFixed(2)}</span>
                <span>Ke = {shared.ke.toFixed(4)}</span>
                <span>Kzt @ h = {qzR.kztH != null ? qzR.kztH.toFixed(4) : "1.0000"}</span>
                {kztIn.topo_type !== "flat" ? <span className="text-amber-400/80">Topo: {TOPO_TYPES.find(t=>t.value===kztIn.topo_type)?.label}</span> : null}
              </div>
              <table className="w-full text-xs font-mono tabular-nums">
                <THead cols={["z (ft)","Kz","Kzt","qz (psf)","α","zg (ft)"]} />
                <tbody>
                  {qzR.pressures.map((r, i) => (
                    <TRow key={i} alt={i%2===1} cells={[r.z_ft.toFixed(1), r.kz.toFixed(4), r.kzt != null ? r.kzt.toFixed(4) : "1.0000", r.qz_psf.toFixed(1), r.alpha.toFixed(1), r.zg_ft.toFixed(0)]} />
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}

          {/* ── MWFRS Dir ── */}
          {tab === "dir" && (dirR || elevR) ? <DirTab d={dirR} elev={elevR} geo={geo} ug={ug} sub={dirSub} setSub={setDirSub} rows={wallRows} addRow={addWallRow} removeRow={removeWallRow} updateRow={updateWallRow} lockRow={lockWallRow} /> : null}

          {/* ── MWFRS LR ── */}
          {tab === "lr" ? (
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <h2 className="text-sm font-bold text-slate-300">MWFRS Low-Rise — Ch. 28</h2>
                {lrR ? (lrR.ok ? <span className="text-xs font-semibold text-emerald-400">Applicable</span> : <span className="text-xs font-semibold text-amber-400">N/A: {lrR.reason}</span>) : null}
              </div>
              {lrR && !lrR.ok ? <div className="px-4 py-3 bg-amber-950/20 border border-amber-800/30 rounded"><p className="text-sm text-amber-400">{lrR.reason}</p></div> : null}
              {lrR && lrR.ok ? (
                <>
                  <div className="flex gap-3 text-xs font-mono text-slate-400"><span>qh = {lrR.qh} psf</span><span>2a = {lrR.ez} ft</span></div>
                  <Acc title="Case A — Transverse" open={true}>
                    <table className="w-full text-xs font-mono tabular-nums">
                      <THead cols={["Zone","GCpf","+GCpi","−GCpi"]} />
                      <tbody>{lrR.cA.map((r, i) => <TRow key={i} alt={i%2===1} cells={[r.zone, r.gcpf.toFixed(4), <Psf v={r.pN} />, <Psf v={r.pP} />]} />)}</tbody>
                    </table>
                  </Acc>
                  <Acc title="Case B — Longitudinal" open={true}>
                    <table className="w-full text-xs font-mono tabular-nums">
                      <THead cols={["Zone","GCpf","+GCpi","−GCpi"]} />
                      <tbody>{lrR.cB.map((r, i) => <TRow key={i} alt={i%2===1} cells={[r.zone, r.gcpf.toFixed(4), <Psf v={r.pN} />, <Psf v={r.pP} />]} />)}</tbody>
                    </table>
                  </Acc>
                  {/* Horizontal MWFRS Simple Diaphragm Pressures */}
                  {lrR.sd ? (
                    <Acc title="Horizontal MWFRS Simple Diaphragm Pressures (psf)" open={true}>
                      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs font-mono text-slate-500 mb-3">
                        <span>qh = {lrR.qh.toFixed(1)} psf</span>
                        <span>Edge strip a = {lrR.sd.a} ft</span>
                        <span>End zone 2a = {lrR.sd.endZone2a} ft</span>
                      </div>
                      <p className="text-[11px] font-bold text-slate-300 mb-2 tracking-wide">Transverse direction (normal to L)</p>
                      <div className="space-y-1 mb-4 pl-2 font-mono text-xs">
                        <div className="flex justify-between"><span className="text-slate-400">Interior Zone: &nbsp; Wall</span><span className="text-amber-300 font-bold">{lrR.sd.transverse.intWall.toFixed(1)} psf</span></div>
                        <div className="flex justify-between"><span className="text-slate-500">&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;Roof</span><span className="text-sky-400">{lrR.sd.transverse.intRoof.toFixed(1)} psf **</span></div>
                        <div className="flex justify-between"><span className="text-slate-400">End Zone: &nbsp;&nbsp;&nbsp;&nbsp;&nbsp; Wall</span><span className="text-amber-300 font-bold">{lrR.sd.transverse.endWall.toFixed(1)} psf</span></div>
                        <div className="flex justify-between"><span className="text-slate-500">&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;Roof</span><span className="text-sky-400">{lrR.sd.transverse.endRoof.toFixed(1)} psf **</span></div>
                      </div>
                      <p className="text-[11px] font-bold text-slate-300 mb-2 tracking-wide">Longitudinal direction (parallel to L)</p>
                      <div className="space-y-1 mb-3 pl-2 font-mono text-xs">
                        <div className="flex justify-between"><span className="text-slate-400">Interior Zone: &nbsp; Wall</span><span className="text-amber-300 font-bold">{lrR.sd.longitudinal.intWall.toFixed(1)} psf</span></div>
                        <div className="flex justify-between"><span className="text-slate-400">End Zone: &nbsp;&nbsp;&nbsp;&nbsp;&nbsp; Wall</span><span className="text-amber-300 font-bold">{lrR.sd.longitudinal.endWall.toFixed(1)} psf</span></div>
                      </div>
                      {/* Parapet & windward roof overhang — from Dir result */}
                      {dirR && dirR.parWW != null && dirR.parZ > (geo.h_ft || 0) ? (
                        <div className="mb-3 pt-2.5 border-t border-slate-700/40">
                          <p className="text-[11px] font-bold text-slate-300 mb-2 tracking-wide">Parapet</p>
                          <div className="space-y-1 pl-2 font-mono text-xs">
                            <div className="flex justify-between">
                              <span className="text-slate-400">Windward parapet &nbsp;<span className="text-slate-600">(GCpn = +1.5)</span></span>
                              <span className="text-amber-300 font-bold">{dirR.parWW.toFixed(1)} psf</span>
                            </div>
                            <div className="flex justify-between">
                              <span className="text-slate-400">Leeward parapet &nbsp;&nbsp;<span className="text-slate-600">(GCpn = −1.0)</span></span>
                              <span className="text-sky-400">{dirR.parLW.toFixed(1)} psf</span>
                            </div>
                            {lrR.oh != null ? (
                              <div className="flex justify-between pt-1 border-t border-slate-800/40">
                                <span className="text-slate-400">Windward roof overhangs <span className="text-slate-600 text-[10px]">(upward — add to windward roof pressure)</span></span>
                                <span className="text-sky-400">{lrR.oh.toFixed(1)} psf</span>
                              </div>
                            ) : null}
                          </div>
                        </div>
                      ) : null}
                      <div className="space-y-1 pt-1.5 border-t border-slate-800/60 text-[10px] text-slate-500">
                        <p>** NOTE: Total horiz force shall not be less than that determined by neglecting roof forces (except for MWFRS moment frames).</p>
                        <p className="text-amber-400/80 font-medium">The code requires the MWFRS be designed for a min ultimate force of 16 psf multiplied by the wall area plus an 8 psf force applied to the vertical projection of the roof.</p>
                      </div>
                    </Acc>
                  ) : null}

                  {/* ── Longitudinal Directional Force (open/partially enclosed) ── */}
                  {lrR.lng ? (
                    <Acc title="Longitudinal Direction — Open/Partially Enclosed (§28.4.4)" open={false}>
                      {/* Inputs inline */}
                      <div className="border border-slate-700/40 rounded p-3 mb-3 space-y-2">
                        <p className="text-[10px] font-bold text-slate-400 uppercase tracking-wide mb-2">Frame Geometry Inputs</p>
                        <div className="flex items-center justify-between gap-3 text-xs">
                          <span className="text-slate-400 whitespace-nowrap"># of frames (n)</span>
                          <NInput value={geo.lng_n_frames} onChange={(v) => ug("lng_n_frames", v)} min={1} step={1} className="w-20 text-right" />
                        </div>
                        <div className="flex items-center justify-between gap-3 text-xs">
                          <span className="text-slate-400 whitespace-nowrap">Solid end wall area incl. fascia (As)</span>
                          <div className="flex items-center gap-1">
                            <NInput value={geo.lng_As_sf} onChange={(v) => ug("lng_As_sf", v)} min={0} className="w-20 text-right" />
                            <span className="text-slate-500 text-[10px]">sf</span>
                          </div>
                        </div>
                      </div>

                      {/* Computed intermediates */}
                      <div className="space-y-1 font-mono text-xs mb-3">
                        <div className="flex justify-between text-slate-500"><span>Eave height</span><span>{lrR.lng.eave_ht.toFixed(2)} ft</span></div>
                        <div className="flex justify-between text-slate-500"><span>Ridge height</span><span>{lrR.lng.ridge_ht.toFixed(2)} ft</span></div>
                        <div className="flex justify-between text-slate-500"><span>Total end wall area (Ae)</span><span>{lrR.lng.Ae.toFixed(2)} sf</span></div>
                        <div className="flex justify-between text-slate-500"><span>Solidity ratio (Φ = As/Ae)</span><span>{lrR.lng.phi.toFixed(4)}</span></div>
                        <div className="flex justify-between text-slate-500"><span>n (effective, min 3)</span><span>{lrR.lng.n_eff}</span></div>
                        <div className="flex justify-between text-slate-500"><span>KB</span><span>{lrR.lng.KB.toFixed(2)}</span></div>
                        <div className="flex justify-between text-slate-500"><span>KS</span><span>{lrR.lng.KS.toFixed(4)}</span></div>
                        <div className="flex justify-between text-slate-500"><span>Zones 5&amp;6 area</span><span>{lrR.lng.area56.toFixed(2)} sf</span></div>
                        <div className="flex justify-between text-slate-500"><span>Zones 5E&amp;6E area</span><span>{lrR.lng.area5E6E.toFixed(2)} sf</span></div>
                        <div className="flex justify-between text-slate-500"><span>(GCpf)ww − (GCpf)lw</span><span>{lrR.lng.gcpf_diff.toFixed(4)}</span></div>
                      </div>

                      {/* Results */}
                      <div className="border-t border-slate-700/60 pt-3 space-y-2 font-mono text-xs">
                        <div className="flex justify-between">
                          <span className="text-slate-400">p = Kd·qh·(ΔGCpf)·KB·KS</span>
                          <span className="text-amber-300 font-bold">{lrR.lng.p_lng.toFixed(1)} psf</span>
                        </div>
                        <div className="flex justify-between items-baseline">
                          <span className="text-slate-400">F = p × Ae</span>
                          <span className="text-emerald-300 font-bold text-sm">{lrR.lng.F_lng.toFixed(1)} kips</span>
                        </div>
                        <p className="text-[10px] text-slate-500 pt-1">Force applied at centroid of end wall area Ae. Acts in combination with roof loads for open/partially enclosed buildings per §28.4.4.</p>
                      </div>
                    </Acc>
                  ) : null}

                  <p className="text-[10px] text-slate-500 px-1">Light-frame construction or flexible diaphragms need not be designed for the torsional load cases per §28.3.4.</p>
                </>
              ) : null}
            </div>
          ) : null}

          {/* ── C&C ── */}
          {tab === "cc" && ccR ? (
            <div className="space-y-4">
              <h2 className="text-sm font-bold text-slate-300">C&C — {ccR.proc === "hle60" ? "h≤60 ft" : ccR.proc === "alt6090" ? "Alt 60– 90 ft" : "h>60 ft"}</h2>
              <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs font-mono text-slate-400">
                <span>qh = {ccR.qh} psf</span>
                <span>GCpi = ±{ccR.gcpi}</span>
                <span>a = {ccR.a} ft</span>
                <span>θ = {ccR.theta}°</span>
                <span>Min = {ccR.minP} psf</span>
              </div>
              {ccR.altEligible ? (
                <div className="flex items-center gap-2 px-2 py-1.5 bg-sky-950/40 border border-sky-800/40 rounded text-[10px]">
                  <label className="flex items-center gap-1.5 cursor-pointer select-none text-slate-300">
                    <input type="checkbox" checked={useAltCC} onChange={e => setUseAltCC(e.target.checked)}
                      className="accent-sky-500 w-3 h-3" />
                    Use Alternate Procedure (60 ft &lt; h &lt; 90 ft) — Ch.30 Alt.
                  </label>
                  <span className="text-slate-500 ml-1">Aₑₙₑ = B²/3 = {(geo.B_ft**2/3).toFixed(0)} sf — {ccR.altIs710 ? "areas [10,50,100,500] sf, GCpi applied separately" : "curves extend to 1000 sf, base = Kᵈ·qʰ"}</span>
                </div>
              ) : null}
              {ccR.theta <= 10 ? (
                <div className="text-[10px] text-amber-500/80 px-1">Note: GCp values from {ccR.proc === "hgt60" && ["7-10","7-05"].includes(ccR.codeVer) ? ccR.codeVer + " Fig 6-17A/B" : ["7-10","7-05"].includes(ccR.codeVer) ? ccR.codeVer + " Fig 6-11A/B" : ccR.proc === "hgt60" ? "ASCE 7-22 Fig 30.4-1" : ccR.proc === "alt6090" ? "ASCE 7 Alt 60–90ft" : "ASCE 7-22 Fig 30.3-2A"} (final design values for \u03b8 \u2264 10\u00b0)</div>
              ) : null}
              {ccR.prs.some(p => p.zone === "3") ? (
                <div className={`text-[10px] px-1 ${ccR.zone3eq2 ? "text-amber-400/90" : "text-slate-500"}`}>
                  {ccR.zone3eq2
                    ? `Zone 3 neg = Zone 2 neg (min parapet = ${ccR.minPar} ft ≥ 3 ft — §30.3 Note 6 applied)`
                    : `Note: Zone 3 neg = Zone 2 when min parapet ≥ 3 ft (current = ${ccR.minPar} ft)`}
                </div>
              ) : null}
                            {ccSub === "roof" ? (
                <CCMatrix
                  pressures={ccR.prs.filter((p) => ["1","1p","2","3"].includes(p.zone) && !(["7-10","7-05"].includes(ccR.codeVer) && p.zone === "1p") && !(ccR.proc === "hgt60" && p.zone === "1p"))}
                  title={ccR.proc === "hle60" ? "Roof C&C (psf) \u2014 Fig 30.3-1/2" : ccR.proc === "alt6090" ? "Roof C&C (psf) \u2014 Alt 60\u201390 ft" : "Roof C&C (psf) \u2014 Fig 30.4-1"}
                  areas={ccR.proc === "hgt60" ? [10,50,100,500] : ccR.proc === "alt6090" ? (ccR.altIs710 ? [10,50,100,500] : [10,100,500,1000]) : ccRoofAreas}
                  userAreas={[geo.cc_user_area1, geo.cc_user_area2]}
                  onUserAreaChange={(i,v) => ug(i===0 ? "cc_user_area1" : "cc_user_area2", v)}
                />
              ) : null}

              {ccSub === "overhang" ? (() => {
                const isOldCode = ccR.codeVer === "7-05" || ccR.codeVer === "7-10";
                // h>60 standard: oh1/oh2/oh3z4/oh3z5 zones
                // h<=60 and alt: oh1/oh2/oh3 zones (7-05/7-10 collapse oh1&oh2)
                const isHgt60Std = ccR.proc === "hgt60";
                const isAlt = ccR.proc === "alt6090";
                const ohPressures = isHgt60Std
                  ? ccR.prs.filter(p => ["oh1","oh2","oh3z4","oh3z5"].includes(p.zone))
                  : ccR.prs.filter(p => ["oh1","oh2","oh3"].includes(p.zone) && !(isOldCode && p.zone === "oh2"));
                const labelOverrides = isHgt60Std ? {
                  oh1:    { label: "Overhang Zone 1",       desc: "adj. Zone 2 (GCpi=0)" },
                  oh2:    { label: "Overhang Zone 2",       desc: "adj. Zone 3 (GCpi=0)" },
                  oh3z4:  { label: "Overhang Zone 3 @Z4",   desc: "adj. Zone 3 @wall Z4 (GCpi=0)" },
                  oh3z5:  { label: "Overhang Zone 3 @Z5",   desc: "adj. Zone 3 @wall Z5 (GCpi=0)" },
                } : isOldCode ? {
                  oh1: { label: "Overhang Zone 1 & 2", desc: "Overhang - Field & Edge (GCpi=0)" },
                  oh3: { label: "Overhang Zone 3",     desc: "Overhang - Corner (GCpi=0)" },
                } : {};
                const ohAreas = isHgt60Std ? [10, 50, 100, 500] : isAlt ? (ccR.altIs710 ? [10, 50, 100, 500] : [10, 100, 500, 1000]) : ccRoofAreas;
                const ohTitle = isHgt60Std
                  ? "Roof Overhang C&C (psf) — Fig 30.4-1 (GCpi=0)"
                  : isAlt
                  ? "Roof Overhang C&C (psf) — Alt 60–90 ft (GCpi=0)"
                  : "Roof Overhang C&C (psf) — GCpi = 0 (uplift only)";
                return (
                  <>
                  <div className="text-[10px] text-slate-500 px-1 mb-1">
                    Overhang pressure is <span className="text-sky-400 font-semibold">uplift only</span> — negative (upward) GCp values only. GCpi = 0 on soffit. No positive pressure case is defined.
                  </div>
                  <CCMatrix
                    pressures={ohPressures}
                    title={ohTitle}
                    areas={ohAreas}
                    userAreas={[geo.cc_user_area1, geo.cc_user_area2]}
                    onUserAreaChange={(i,v) => ug(i===0 ? "cc_user_area1" : "cc_user_area2", v)}
                    labelOverrides={labelOverrides}
                  />
                  </>
                );
              })() : null}

              {ccSub === "wall" ? (
                <CCMatrix
                  pressures={ccR.prs.filter((p) => (ccR.proc === "hle60" || ccR.proc === "alt6090") ? ["4","5"].includes(p.zone) : ["4p","5p"].includes(p.zone))}
                  title={(ccR.proc === "hle60" || ccR.proc === "alt6090") ? "Wall C&C (psf) — Fig 30.3-1" : "Wall C&C (psf) — Zones 4’ & 5’ (Fig 30.4-1)"}
                  areas={(ccR.proc === "hle60" || ccR.proc === "alt6090") ? ccWallAreas : [20, 100, 200, 500]}
                  labelOverrides={ccR.proc === "hgt60" ? {
                    "4p": { label: "Negative Zone 4’", desc: "Wall Zone 4’ (field)" },
                    "5p": { label: "Negative Zone 5’", desc: "Wall Zone 5’ (corner)" },
                  } : {}}
                  userAreas={[geo.cc_user_area1, geo.cc_user_area2]}
                  onUserAreaChange={(i,v) => ug(i===0 ? "cc_user_area1" : "cc_user_area2", v)}
                />
              ) : null}

              {ccSub === "wall" && ccR.wallPosProfile ? (
                <div className="mt-3">
                  <p className="text-[11px] font-semibold text-slate-400 mb-1.5">Wall surface pressure at z — Positive Zone 4’ & 5’ (psf)</p>
                  <p className="text-[10px] text-slate-500 mb-1">Negative zone pressures apply at all heights (shown above). Positive pressures vary with height.</p>
                  <table className="w-full text-[10px] font-mono border-collapse">
                    <thead>
                      <tr className="border-b border-slate-700">
                        <th className="px-2 py-1 text-left text-slate-400">z (ft)</th>
                        <th className="px-2 py-1 text-center text-slate-400">Kz</th>
                        <th className="px-2 py-1 text-center text-slate-400">Kzt</th>
                        <th className="px-2 py-1 text-center text-slate-400">qz (psf)</th>
                        {[20,100,200,500].map(a => <th key={a} className="px-2 py-1 text-center text-sky-500/70">{a} sf</th>)}
                      </tr>
                    </thead>
                    <tbody>
                      {ccR.wallPosProfile.map((row, i) => (
                        <tr key={i} className={"border-b border-slate-800/50 " + (row.z === ccR.theta ? "bg-sky-950/20" : "")}>
                          <td className="px-2 py-1 text-slate-300">{row.z === ccR.theta || i === ccR.wallPosProfile.length-1 ? `h = ${row.z}` : `${row.z === 15 ? "0 to 15'" : row.z + " ft"}`}</td>
                          <td className="px-2 py-1 text-center text-slate-400">{row.kz}</td>
                          <td className="px-2 py-1 text-center text-slate-400">{row.kzt}</td>
                          <td className="px-2 py-1 text-center text-slate-400">{row.qz}</td>
                          {row.pressures.map((p, j) => <td key={j} className="px-2 py-1 text-center text-amber-300/90">{p}</td>)}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : null}

              {ccSub === "parapet" && ccR.parPrs ? (
                <div>
                  <p className="text-xs font-semibold text-slate-400 mb-1.5">Solid Parapet Pressure (psf) — §30.9 / Fig 30.9-1</p>
                  <div className="text-[10px] font-mono text-slate-500 mb-2">Kd × qp = {ccR.qp} psf (qp at parapet height)</div>
                  <table className="w-full text-xs font-mono tabular-nums">
                    <thead>
                      <tr className="border-b-2 border-slate-700">
                        <th className="px-2 py-1.5 text-left text-[10px] font-bold text-slate-400 uppercase w-36" rowSpan={2}>Case</th>
                        <th className="px-1 py-0.5 text-center text-[10px] font-bold text-slate-400 uppercase" colSpan={ccR.parAreas.length}>Eff. Wind Area (sf)</th>
                      </tr>
                      <tr className="border-b border-slate-700">
                        {ccR.parAreas.map((a) => <th key={a} className="px-1.5 py-1 text-center text-[10px] font-bold text-sky-500/70">{a}</th>)}
                      </tr>
                    </thead>
                    <tbody>
                      <tr className="border-b border-slate-800/50 bg-slate-900/25">
                        <td className="px-2 py-1.5 text-[11px] font-bold text-slate-200">CASE A: Zone 2 &amp; 3</td>
                        {ccR.parPrs.map((r) => <td key={r.area} className="px-1 py-1.5 text-center text-amber-300/90">{r.caseA.toFixed(1)}</td>)}
                      </tr>
                      <tr className="border-b border-slate-800/50">
                        <td className="px-2 py-1.5 text-[11px] font-bold text-slate-200">CASE B: Interior zone</td>
                        {ccR.parPrs.map((r) => <td key={r.area} className="px-1 py-1.5 text-center text-sky-400/90">{r.caseBint.toFixed(1)}</td>)}
                      </tr>
                      <tr className="border-b border-slate-800/50 bg-slate-900/25">
                        <td className="px-2 py-1.5 text-[11px] font-bold text-slate-200">CASE B: Corner zone</td>
                        {ccR.parPrs.map((r) => <td key={r.area} className="px-1 py-1.5 text-center text-sky-400/90">{r.caseBcor.toFixed(1)}</td>)}
                      </tr>
                    </tbody>
                  </table>
                  <p className="text-[10px] text-slate-500 mt-1.5">Case A = combined WW+LW. Case B = suction; corner zone within a = {ccR.a} ft.</p>
                </div>
              ) : null}
            </div>
          ) : null}


          {/* ── Open Building ── */}
          {tab === "ob" ? (
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <h2 className="text-sm font-bold text-slate-300">Open Buildings — Ch.27 &amp; Ch.30</h2>
                {obR ? (obR.ok ? <span className="text-xs font-semibold text-emerald-400">✓</span> : <span className="text-xs font-semibold text-amber-400">N/A</span>) : null}
              </div>

              <div className="border border-slate-700/50 rounded overflow-hidden">
                <div className="px-3 py-2 bg-slate-800/60 text-xs font-bold text-slate-300 uppercase tracking-wide">Open Building Inputs</div>
                <div className="p-3 space-y-3">
                  <div className="flex items-center justify-between gap-2 text-xs">
                    <span className="text-slate-400">Roof Type</span>
                    <select value={geo.ob_roof_type} onChange={e => ug("ob_roof_type", e.target.value)}
                      className="bg-slate-800 border border-slate-600 rounded px-2 py-1 text-slate-200 text-xs">
                      <option value="monoslope">Monoslope Free Roof</option>
                      <option value="gable">Gable / Hip Free Roof</option>
                      <option value="troughed">Troughed Free Roof</option>
                    </select>
                  </div>
                  <div className="flex items-center justify-between gap-2 text-xs">
                    <span className="text-slate-400">Wind Flow</span>
                    <select value={geo.ob_wind_flow} onChange={e => ug("ob_wind_flow", e.target.value)}
                      className="bg-slate-800 border border-slate-600 rounded px-2 py-1 text-slate-200 text-xs">
                      <option value="clear">Clear Wind Flow</option>
                      <option value="obstructed">Obstructed Wind Flow</option>
                    </select>
                  </div>
                  <p className="text-[10px] text-slate-500">θ and h pulled from main geometry. θ = {geo.roof_angle_deg.toFixed(1)}°, h = {geo.h_ft} ft.</p>
                </div>
              </div>

              {obR && !obR.ok && <div className="px-3 py-2 bg-amber-950/20 border border-amber-700/30 rounded text-xs text-amber-400">{obR.reason}</div>}

              {obR && obR.ok ? (
                <>
                  <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs font-mono text-slate-400">
                    <span>Kd·qh = {obR.qh.toFixed(1)} psf</span>
                    <span>G = {obR.G}</span>
                    <span>θ = {obR.theta.toFixed(1)}°</span>
                    <span>{obR.clear ? "Clear" : "Obstructed"} wind flow</span>
                  </div>

                  <Acc title="MWFRS — Wind Normal to Ridge (γ=0° &amp; 180°)" open={true}>
                    <p className="text-[10px] text-slate-500 mb-2">p = Kd·qh × G × Cn. Cnw = windward half, Cnl = leeward half of roof.</p>
                    <table className="w-full text-xs font-mono tabular-nums">
                      <thead>
                        <tr className="border-b border-slate-700">
                          <th className="text-left py-1 text-[10px] text-slate-400 font-bold uppercase">Case</th>
                          <th className="text-center py-1 text-[10px] text-slate-400 font-bold uppercase">Cnw</th>
                          <th className="text-center py-1 text-[10px] text-slate-400 font-bold uppercase">Cnl</th>
                          <th className="text-right py-1 text-[10px] text-slate-400 font-bold uppercase">pₜ (psf)</th>
                          <th className="text-right py-1 text-[10px] text-slate-400 font-bold uppercase">pₗ (psf)</th>
                        </tr>
                      </thead>
                      <tbody>
                        {obR.mwfrs_normal.cases.map((c, i) => (
                          <tr key={i} className={"border-b border-slate-800/40 " + (i%2===1 ? "bg-slate-800/20" : "")}>
                            <td className="py-1 text-slate-300 font-medium">{c.label}</td>
                            <td className="text-center py-1 text-slate-400">{c.Cnw.toFixed(2)}</td>
                            <td className="text-center py-1 text-slate-400">{c.Cnl.toFixed(2)}</td>
                            <td className={"text-right py-1 font-bold " + (c.pw >= 0 ? "text-amber-300" : "text-sky-400")}>{c.pw.toFixed(1)}</td>
                            <td className={"text-right py-1 font-bold " + (c.pl >= 0 ? "text-amber-300" : "text-sky-400")}>{c.pl.toFixed(1)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    <p className="text-[10px] text-slate-500 mt-2">+ = toward roof. − = away from roof. Design for the worst of all applicable load cases.</p>
                    {obR.mwfrs_normal.monoGamma180 && <p className="text-[10px] text-amber-500/80 mt-1">Monoslope: γ=0° and γ=180° cases must both be checked per Fig.27.3-5.</p>}
                  </Acc>

                  <Acc title="MWFRS — Wind Parallel to Ridge (γ=90°)" open={true}>
                    <p className="text-[10px] text-slate-500 mb-2">p = Kd·qh × G × Cn. Distance zones from windward edge. h={obR.mwfrs_parallel.h_val} ft, 2h={obR.mwfrs_parallel.h2_val} ft.</p>
                    <table className="w-full text-xs font-mono tabular-nums">
                      <thead>
                        <tr className="border-b border-slate-700">
                          <th className="text-left py-1 text-[10px] text-slate-400 font-bold uppercase w-20">Case</th>
                          <th className="text-center py-1 text-[10px] text-slate-400 font-bold uppercase">≤ h</th>
                          <th className="text-center py-1 text-[10px] text-slate-400 font-bold uppercase">&gt;h≤ 2h</th>
                          <th className="text-center py-1 text-[10px] text-slate-400 font-bold uppercase">&gt; 2h</th>
                        </tr>
                      </thead>
                      <tbody>
                        <tr className="border-b border-slate-800/40">
                          <td className="py-1 text-slate-400">A — Cn</td>
                          {obR.mwfrs_parallel.caseA_Cn.map((v,i) => <td key={i} className="text-center py-1 text-slate-500">{v.toFixed(1)}</td>)}
                        </tr>
                        <tr className="border-b border-slate-800/40 bg-slate-800/20">
                          <td className="py-1 text-slate-300 font-medium">A — p (psf)</td>
                          {obR.mwfrs_parallel.caseA_p.map((v,i) => <td key={i} className={"text-center py-1 font-bold " + (v>=0?"text-amber-300":"text-sky-400")}>{v.toFixed(1)}</td>)}
                        </tr>
                        <tr className="border-b border-slate-800/40">
                          <td className="py-1 text-slate-400">B — Cn</td>
                          {obR.mwfrs_parallel.caseB_Cn.map((v,i) => <td key={i} className="text-center py-1 text-slate-500">{v.toFixed(1)}</td>)}
                        </tr>
                        <tr className="border-b border-slate-800/40 bg-slate-800/20">
                          <td className="py-1 text-slate-300 font-medium">B — p (psf)</td>
                          {obR.mwfrs_parallel.caseB_p.map((v,i) => <td key={i} className={"text-center py-1 font-bold " + (v>=0?"text-amber-300":"text-sky-400")}>{v.toFixed(1)}</td>)}
                        </tr>
                      </tbody>
                    </table>
                  </Acc>

                  {obR.fascia_ok && obR.fascia ? (
                    <Acc title="Fascia Panels — Horizontal Pressures" open={true}>
                      <p className="text-[10px] text-slate-500 mb-2">Applicable only when θ ≤ 5°. GCpn = +1.5 windward, −1.0 leeward.</p>
                      <div className="font-mono text-xs space-y-2">
                        <div className="flex justify-between"><span className="text-slate-400">qp = Kd·qh</span><span className="text-slate-300">{obR.fascia.qp.toFixed(1)} psf</span></div>
                        <div className="flex justify-between"><span className="text-slate-400">Windward fascia (GCpn = +1.5)</span><span className="text-amber-300 font-bold">{obR.fascia.ww.toFixed(1)} psf</span></div>
                        <div className="flex justify-between"><span className="text-slate-400">Leeward fascia (GCpn = −1.0)</span><span className="text-sky-400 font-bold">{obR.fascia.lw.toFixed(1)} psf</span></div>
                      </div>
                    </Acc>
                  ) : <p className="text-[10px] text-slate-500 px-1">Fascia pressures not applicable — roof angle exceeds 5°.</p>}

                  <Acc title={"C&C — Roof Zones 1/2/3 (§30.8) — a = " + obR.a_cc + " ft"} open={true}>
                    <p className="text-[10px] text-slate-500 mb-2">p = Kd·qh × G × CN. Min {obR.minP} psf on negatives. a² = {obR.a2} sf, 4a² = {obR.a4a2} sf.</p>
                    <table className="w-full text-xs font-mono tabular-nums">
                      <thead>
                        <tr className="border-b border-slate-700">
                          <th className="text-left py-1 text-[10px] text-slate-400 font-bold uppercase w-32">Area Bracket</th>
                          <th className="text-center py-1 text-[10px] font-bold uppercase" colSpan={2}><span className="text-slate-400">Zone 3</span></th>
                          <th className="text-center py-1 text-[10px] font-bold uppercase" colSpan={2}><span className="text-slate-400">Zone 2</span></th>
                          <th className="text-center py-1 text-[10px] font-bold uppercase" colSpan={2}><span className="text-slate-400">Zone 1</span></th>
                        </tr>
                        <tr className="border-b border-slate-700">
                          <th></th>
                          <th className="text-center text-[9px] text-emerald-500/70 py-0.5">+</th>
                          <th className="text-center text-[9px] text-sky-500/70 py-0.5">−</th>
                          <th className="text-center text-[9px] text-emerald-500/70 py-0.5">+</th>
                          <th className="text-center text-[9px] text-sky-500/70 py-0.5">−</th>
                          <th className="text-center text-[9px] text-emerald-500/70 py-0.5">+</th>
                          <th className="text-center text-[9px] text-sky-500/70 py-0.5">−</th>
                        </tr>
                      </thead>
                      <tbody>
                        {obR.cc_zones.map((z, i) => (
                          <tr key={i} className={"border-b border-slate-800/40 " + (i%2===1?"bg-slate-800/20":"")}>
                            <td className="py-1 text-[10px] text-slate-400">{z.area_label}</td>
                            <td className="text-center py-1 text-amber-300/90">{z.psf.z3p.toFixed(1)}</td>
                            <td className="text-center py-1 text-sky-400/90">{z.psf.z3n.toFixed(1)}</td>
                            <td className="text-center py-1 text-amber-300/90">{z.psf.z2p.toFixed(1)}</td>
                            <td className="text-center py-1 text-sky-400/90">{z.psf.z2n.toFixed(1)}</td>
                            <td className="text-center py-1 text-amber-300/90">{z.psf.z1p.toFixed(1)}</td>
                            <td className="text-center py-1 text-sky-400/90">{z.psf.z1n.toFixed(1)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    <p className="text-[10px] text-slate-500 mt-1.5">Zone 3 = corner (within a of 2 edges). Zone 2 = edge. Zone 1 = interior. + toward roof, − away from roof.</p>
                  </Acc>
                </>
              ) : null}
            </div>
          ) : null}


          {/* ── Roof W ── */}
          {tab === "rw" ? (() => {
            const equip = geo.rw_equip && geo.rw_equip.length ? geo.rw_equip : [{ lL:10, lB:5, h:5 }];
            const addEquip    = () => ug("rw_equip", [...equip, { lL:5, lB:5, h:5 }]);
            const removeEquip = (i) => ug("rw_equip", equip.filter((_,idx)=>idx!==i));
            const updateEquip = (i, field, val) => ug("rw_equip", equip.map((e,idx)=>idx===i?{...e,[field]:val}:e));
            return (
            <div className="space-y-3">

              {/* ── Rooftop Structures sub-tab ── */}
              {rwSub === "equip" && (
              <div className="space-y-3">
              <h2 className="text-sm font-bold text-slate-300">Rooftop Structures &amp; Equipment — Ch.29 §29.4.1</h2>
              <div>
                {rwR && rwR.equip && rwR.equip[0]?.method === "Cf" ? (
                  <p className="text-[10px] text-slate-500 mb-3">
                    7-05 Cf method — F = qz·G·Cf·adj·Af. G=0.85, Kd=0.9. qz at centroid height.
                    {rwR.equip[0]?.qzC != null && (
                      <> &nbsp;<span className="text-slate-400 font-bold">qz = {rwR.equip[0].qzC.toFixed(1)} psf</span>{rwR.equip.length > 1 ? " (Item #1)" : ""}.</>
                    )}
                  </p>
                ) : (
                  <p className="text-[10px] text-slate-500 mb-3">GCr = 1.5 vertical, 1.9 horizontal. F = qh × GCr × A. qh = {rwR ? rwR.qhGCr.toFixed(1) : "—"} psf.</p>
                )}

                {equip.map((eq, i) => {
                  const res = rwR?.equip?.[i] ?? null;
                  return (
                    <div key={i} className="border border-slate-700/40 rounded p-2 mb-2 space-y-2">
                      <div className="flex items-center justify-between">
                        <p className="text-[10px] font-bold text-amber-400/80 uppercase tracking-wide">Equipment/Structure #{i+1}</p>
                        {equip.length > 1 && (
                          <button onClick={()=>removeEquip(i)}
                            className="text-[10px] text-red-400/60 hover:text-red-400 px-1">✕ Remove</button>
                        )}
                      </div>
                      <div className="grid grid-cols-3 gap-2 text-xs">
                        <div><p className="text-slate-500 text-[10px]">Length ∥ L (ft)</p><NInput value={eq.lL} onChange={v=>updateEquip(i,"lL",v)} min={0.1}/></div>
                        <div><p className="text-slate-500 text-[10px]">Length ∥ B (ft)</p><NInput value={eq.lB} onChange={v=>updateEquip(i,"lB",v)} min={0.1}/></div>
                        <div><p className="text-slate-500 text-[10px]">Height (ft)</p><NInput value={eq.h}  onChange={v=>updateEquip(i,"h",  v)} min={0.1}/></div>
                      </div>
                      {res && res.method === "Cf" ? (
                        <div className="font-mono text-xs space-y-1 pt-1 border-t border-slate-700/40">
                          <div className="text-[10px] text-slate-500 pb-0.5">qz={res.qzC} psf · G={res.G} · adj={res.adj}</div>
                          <div className="grid grid-cols-4 gap-1 text-[10px] text-slate-500 font-bold uppercase pb-1">
                            <span>Direction</span><span className="text-right">Cf</span><span className="text-right">Af (sf)</span><span className="text-right">F (kips)</span>
                          </div>
                          <div className="grid grid-cols-4 gap-1"><span className="text-slate-400">Horiz ⊥ B-face</span><span className="text-right text-slate-400">{res.Cf_B}</span><span className="text-right text-slate-500">{res.Af_B}</span><span className="text-right text-amber-300 font-bold">{res.Fh_B.toFixed(1)}</span></div>
                          <div className="grid grid-cols-4 gap-1"><span className="text-slate-400">Horiz ⊥ L-face</span><span className="text-right text-slate-400">{res.Cf_L}</span><span className="text-right text-slate-500">{res.Af_L}</span><span className="text-right text-amber-300 font-bold">{res.Fh_L.toFixed(1)}</span></div>
                        </div>
                      ) : res ? (
                        <div className="font-mono text-xs space-y-1 pt-1 border-t border-slate-700/40">
                          <div className="grid grid-cols-3 gap-1 text-[10px] text-slate-500 font-bold uppercase pb-1">
                            <span>Direction</span><span className="text-right">Area (sf)</span><span className="text-right">Force (kips)</span>
                          </div>
                          <div className="grid grid-cols-3 gap-1"><span className="text-slate-400">Vertical (GCr=1.5)</span><span className="text-right text-slate-500">{res.Ar}</span><span className="text-right text-amber-300 font-bold">{res.Fv.toFixed(1)}</span></div>
                          <div className="grid grid-cols-3 gap-1"><span className="text-slate-400">Horiz ∥ B (GCr=1.9)</span><span className="text-right text-slate-500">{res.Af_B}</span><span className="text-right text-amber-300 font-bold">{res.Fh_B.toFixed(1)}</span></div>
                          <div className="grid grid-cols-3 gap-1"><span className="text-slate-400">Horiz ∥ L (GCr=1.9)</span><span className="text-right text-slate-500">{res.Af_L}</span><span className="text-right text-amber-300 font-bold">{res.Fh_L.toFixed(1)}</span></div>
                        </div>
                      ) : null}
                    </div>
                  );
                })}

                <button onClick={addEquip}
                  className="w-full mt-1 py-1.5 text-xs text-amber-400/80 border border-amber-500/30 border-dashed rounded hover:border-amber-400/60 hover:text-amber-300 transition-colors">
                  + Add Equipment / Structure
                </button>
                <p className="text-[10px] text-slate-500 mt-2">{rwR?.equip?.[0]?.method === "Cf" ? "§6.5.15 ASCE 7-05 — Cf/Af horizontal force method." : "§29.4.1 — ASCE 7-22/7-16. Also applicable for roof screen walls away from edges."}</p>
              </div>
              </div>
              )}

              {/* ── Attached Canopies sub-tab ── */}
              {rwSub === "canopy" && (
              <div className="space-y-3">
              <h2 className="text-sm font-bold text-slate-300">Attached Canopies — h ≤ 60 ft — §30.11</h2>
              <div>
                <div className="flex items-center gap-2 mb-2">
                  <input type="checkbox" checked={!!geo.rw_can_en} onChange={e=>ug("rw_can_en",e.target.checked)} className="accent-amber-400"/>
                  <span className="text-xs text-slate-400">Enable canopy calculation</span>
                </div>
                {geo.rw_can_en && (
                  <>
                    <div className="grid grid-cols-2 gap-3 mb-3 text-xs">
                      <div><p className="text-slate-500 text-[10px]">Mean eave height he (ft)</p><NInput value={geo.rw_can_he} onChange={v=>ug("rw_can_he",v)} min={0.1}/></div>
                      <div><p className="text-slate-500 text-[10px]">Mean canopy height hc (ft)</p><NInput value={geo.rw_can_hc} onChange={v=>ug("rw_can_hc",v)} min={0.1}/></div>
                    </div>
                    {rwR && rwR.canopy && (
                      <>
                        <div className="text-xs font-mono text-slate-400 mb-2">
                          hc/he = {rwR.canopy.hc_he.toFixed(3)} —
                          {rwR.canopy.hc_he >= 0.9 ? " bracket ≥ 0.9" : rwR.canopy.hc_he > 0.5 ? " bracket 0.5 < hc/he < 0.9" : " bracket ≤ 0.5"}
                        </div>
                        <p className="text-[10px] text-slate-500 mb-1 font-bold uppercase tracking-wide">Pressures (psf) — qh = {rwR.qhSolar.toFixed(1)} psf</p>
                        <table className="w-full text-xs font-mono tabular-nums mb-2">
                          <thead>
                            <tr className="border-b border-slate-700">
                              <th className="text-left py-1 text-[10px] text-slate-400 font-bold">Area (sf)</th>
                              <th className="text-right py-1 text-[10px] text-slate-400 font-bold">Upper−</th>
                              <th className="text-right py-1 text-[10px] text-slate-400 font-bold">Lower−</th>
                              <th className="text-right py-1 text-[10px] text-slate-400 font-bold">Pos</th>
                              <th className="text-right py-1 text-[10px] text-slate-400 font-bold">Net−</th>
                              <th className="text-right py-1 text-[10px] text-slate-400 font-bold">Net+</th>
                            </tr>
                          </thead>
                          <tbody>
                            {rwR.canopy.rows.map((row,i) => (
                              <tr key={i} className={"border-b border-slate-800/40 " + (i%2===1?"bg-slate-800/20":"")}>
                                <td className="py-0.5 text-slate-400">{row.area}</td>
                                <td className="text-right py-0.5 text-sky-400">{row.upperNeg.toFixed(1)}</td>
                                <td className="text-right py-0.5 text-sky-400">{row.lowerNeg.toFixed(1)}</td>
                                <td className="text-right py-0.5 text-amber-300">{row.pos.toFixed(1)}</td>
                                <td className="text-right py-0.5 text-sky-400 font-bold">{row.combNeg.toFixed(1)}</td>
                                <td className="text-right py-0.5 text-amber-300 font-bold">{row.combPos.toFixed(1)}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                        <p className="text-[10px] text-slate-500">Upper− / Lower− = separate individual surfaces. Net = combined upper + lower. Min pressure 16 psf.</p>
                      </>
                    )}
                  </>
                )}
              </div>
              </div>
              )}

              {/* ── Solar Panels sub-tab ── */}
              {rwSub === "solar" && (
              <div className="space-y-3">
              <h2 className="text-sm font-bold text-slate-300">Solar Panels — Ch.29 §29.4.3 &amp; §29.4.4</h2>

              {/* ── Solar Panels — shared geometry inputs ── */}
              <div className="border border-slate-700/50 rounded overflow-hidden">
                <div className="px-3 py-2 bg-slate-800/60 text-xs font-bold text-slate-300 uppercase tracking-wide">Solar Panel Geometry</div>
                <div className="p-3 space-y-2">
                  <div className="grid grid-cols-2 gap-2 text-xs">
                    <div><p className="text-slate-500 text-[10px]">d1 — to roof edge / array (ft)</p><NInput value={geo.rw_sol_np_d1}  onChange={v=>ug("rw_sol_np_d1",v)}  min={0}/></div>
                    <div><p className="text-slate-500 text-[10px]">d2 — to adj. panel (ft)</p><NInput value={geo.rw_sol_np_d2}  onChange={v=>ug("rw_sol_np_d2",v)}  min={0}/></div>
                    <div><p className="text-slate-500 text-[10px]">Panel chord length Lp (ft)</p><NInput value={geo.rw_sol_np_Lp}  onChange={v=>ug("rw_sol_np_Lp",v)}  min={0.1}/></div>
                    <div><p className="text-slate-500 text-[10px]">Parapet above roof hpt (ft)</p><NInput value={geo.rw_sol_np_hpt} onChange={v=>ug("rw_sol_np_hpt",v)} min={0}/></div>
                    <div><p className="text-slate-500 text-[10px]">h1 — low edge to roof (ft)</p><NInput value={geo.rw_sol_np_h1}  onChange={v=>ug("rw_sol_np_h1",v)}  min={0}/></div>
                    <div><p className="text-slate-500 text-[10px]">h2 — high edge to roof (ft)</p><NInput value={geo.rw_sol_np_h2}  onChange={v=>ug("rw_sol_np_h2",v)}  min={0}/></div>
                    <div><p className="text-slate-500 text-[10px]">Panel angle to roof ω (°)</p><NInput value={geo.rw_sol_np_w}   onChange={v=>ug("rw_sol_np_w",v)}   min={0} max={35}/></div>
                    <div><p className="text-slate-500 text-[10px]">Panel gap — min 0.25 in (in)</p><NInput value={geo.rw_sol_np_gap} onChange={v=>ug("rw_sol_np_gap",v)} min={0.25}/></div>
                  </div>
                  <p className="text-[10px] text-slate-500">Lb = min(0.4·√(h·WL), h, Ws) = {rwR ? rwR.solarNP ? rwR.solarNP.Lb + ' ft' : '—' : '—'}. Used by both parallel and not-parallel procedures.</p>
                </div>
              </div>

              {/* ── Solar Panels Parallel ── */}
              <div className="border border-slate-700/50 rounded overflow-hidden">
                <div className="px-3 py-2 bg-slate-800/60 text-xs font-bold text-slate-300 uppercase tracking-wide">Parallel to Roof (ω ≤ 2°) — §29.4.4</div>
                <div className="p-3 space-y-2">
                <div className="flex items-center gap-2 mb-2">
                  <input type="checkbox" checked={!!geo.rw_sol_par_en} onChange={e=>ug("rw_sol_par_en",e.target.checked)} className="accent-amber-400"/>
                  <span className="text-xs text-slate-400">Enable parallel solar calculation</span>
                </div>
                {geo.rw_sol_par_en && rwR && rwR.solarPar && (() => {
                  const s = rwR.solarPar;
                  return (
                    <>
                      <p className="text-[10px] text-slate-500 mb-2">
                        Wind pressure = qh·(Cp)·(γE)·(γa). qh = {rwR.qhSolar.toFixed(1)} psf.
                      </p>
                      <p className="text-[10px] text-slate-500 mb-2">
                        Subtract 4.8 psf internal pressure from roof pressures, then multiply by factors below. Min pressure = 16 psf.
                      </p>

                      <p className="text-[10px] text-slate-400 font-bold uppercase tracking-wide mb-1">Adjustment Factor (γE)(γa)</p>
                      <table className="w-full text-xs font-mono tabular-nums mb-2">
                        <thead>
                          <tr className="border-b border-slate-700">
                            <th className="text-left py-1 text-[10px] text-slate-400 font-bold">Location</th>
                            <th className="text-center py-1 text-[10px] text-slate-400 font-bold">&lt;10 sf</th>
                            <th className="text-center py-1 text-[10px] text-slate-400 font-bold">20 sf</th>
                            <th className="text-center py-1 text-[10px] text-slate-400 font-bold">50 sf</th>
                            <th className="text-center py-1 text-[10px] text-slate-400 font-bold">&gt;100 sf</th>
                            <th className="text-center py-1 text-[10px] text-amber-400 font-bold">
                              <input
                                type="number" min="1"
                                value={geo.rw_sol_par_area}
                                onChange={e => ug("rw_sol_par_area", parseFloat(e.target.value)||1)}
                                onWheel={e => e.target.blur()}
                                className="w-9 text-center bg-transparent border-b border-amber-500/60 text-amber-300 text-[10px] font-bold outline-none"
                              /> sf
                            </th>
                            <th className="text-right py-1 text-[10px] text-slate-400 font-bold w-14">γE</th>
                          </tr>
                        </thead>
                        <tbody>
                          <tr className="border-b border-slate-800/40">
                            <td className="py-1 text-slate-300">Exposed Uplift</td>
                            {s.table.map((r,i) => <td key={i} className="text-center py-1 text-slate-300">{r.exp_up.toFixed(1)}</td>)}
                            <td className="text-center py-1 text-amber-300 font-bold">{s.user_row.exp_up.toFixed(1)}</td>
                            <td className="text-right py-1 text-[10px] text-slate-500 whitespace-nowrap">γE = 1.5</td>
                          </tr>
                          <tr className="border-b border-slate-800/40 bg-slate-800/20">
                            <td className="py-1 text-slate-300">Non-exposed Uplift</td>
                            {s.table.map((r,i) => <td key={i} className="text-center py-1 text-slate-300">{r.nonexp_up.toFixed(1)}</td>)}
                            <td className="text-center py-1 text-amber-300 font-bold">{s.user_row.nonexp_up.toFixed(1)}</td>
                            <td className="text-right py-1 text-[10px] text-slate-500 whitespace-nowrap">γE = 1.0</td>
                          </tr>
                          <tr className="border-b border-slate-800/40">
                            <td className="py-1 text-slate-300">All panels downward</td>
                            {s.table.map((r,i) => <td key={i} className="text-center py-1 text-slate-300">{r.down.toFixed(1)}</td>)}
                            <td className="text-center py-1 text-amber-300 font-bold">{s.user_row.down.toFixed(1)}</td>
                            <td className="text-right py-1 text-[10px] text-slate-500 whitespace-nowrap">γE = 1.0</td>
                          </tr>
                        </tbody>
                      </table>

                      <div className="text-[10px] text-slate-500 space-y-0.5">
                        <p>A panel is <span className={s.exposed?"text-amber-300 font-bold":"text-slate-400"}>
                          {s.exposed?"EXPOSED":"non-exposed"}
                        </span> — exposed if d1 to roof edge &gt; 0.5h = {(geo.h_ft*0.5).toFixed(1)} ft</p>
                        <p className="pl-3">and either 1) d1 to adjacent array &gt; {Math.max(4*(geo.rw_sol_np_h2||0.8),4).toFixed(1)} ft</p>
                        <p className="pl-3">or 2) d2 to next adjacent panel &gt; {Math.max(4*(geo.rw_sol_np_h2||0.8),4).toFixed(1)} ft</p>
                      </div>
                    </>
                  );
                })()}
                </div>
              </div>

              {/* ── Solar Panels Not Parallel ── */}
              <div className="border border-slate-700/50 rounded overflow-hidden">
                <div className="px-3 py-2 bg-slate-800/60 text-xs font-bold text-slate-300 uppercase tracking-wide">Not Parallel to Roof — §29.4.3</div>
                <div className="p-3 space-y-2">
                <div className="flex items-center gap-2 mb-2">
                  <input type="checkbox" checked={!!geo.rw_sol_np_en} onChange={e=>ug("rw_sol_np_en",e.target.checked)} className="accent-amber-400"/>
                  <span className="text-xs text-slate-400">Enable not-parallel solar calculation</span>
                </div>
                {geo.rw_sol_np_en && rwR && rwR.solarNP && (() => {
                  const s = rwR.solarNP;
                  const zones = ["z1","z2","z3"];
                  const zoneLabels = ["Zone 1","Zone 2","Zone 3"];
                  const uKeys = { exp:["exp","exp_z2","exp_z3"], nexp:["nexp","nexp_z2","nexp_z3"], down:["down","down_z2","down_z3"] };
                  return (
                    <>
                      <div className="flex flex-wrap gap-x-4 gap-y-0.5 text-xs font-mono text-slate-400 mb-3">
                        <span>gp={s.gp}</span><span>gc={s.gc}</span><span>Lb={s.Lb} ft</span>
                        <span className={s.exposed?"text-amber-300 font-bold":"text-slate-500"}>
                          {s.exposed?"EXPOSED":"Non-exposed"} (0.5h={s.half_h} ft, thresh={s.thresh4} ft)
                        </span>
                      </div>

                      {/* Single unified table matching spreadsheet layout */}
                      <table className="w-full text-xs font-mono tabular-nums">
                        <thead>
                          {/* "User Input" label row spanning the 2 user cols */}
                          <tr>
                            <th colSpan={2} className="text-left py-0.5 text-[10px] text-slate-500"></th>
                            <th colSpan={6} className="text-center py-0.5 text-[10px] text-slate-400 border-b border-slate-700">Wind pressure for normalized area An</th>
                            <th colSpan={2} className="text-center py-0.5 text-[10px] text-amber-400 font-bold border-b border-amber-500/40 border-l border-slate-700/60">User Input</th>
                          </tr>
                          {/* Column headers: γE | Location | 0 sf ... 5000 sf | A= inputs */}
                          <tr className="border-b border-slate-700">
                            <th className="text-left py-0.5 text-[10px] text-slate-500 w-12">γE</th>
                            <th className="text-left py-0.5 text-[10px] text-slate-400">Location</th>
                            {s.std_areas.map((a,i)=><th key={i} className="text-right py-0.5 text-[10px] text-slate-400">{a} sf</th>)}
                            <th className="text-right py-0.5 text-[10px] text-amber-400 border-l border-slate-700/60 pl-1">
                              A=<input type="number" min="1" value={geo.rw_sol_np_area1}
                                onChange={e=>ug("rw_sol_np_area1", parseFloat(e.target.value)||1)}
                                onWheel={e=>e.target.blur()}
                                className="w-8 ml-0.5 text-center bg-transparent border-b border-amber-500/60 text-amber-300 text-[10px] font-bold outline-none"/> sf
                            </th>
                            <th className="text-right py-0.5 text-[10px] text-amber-400">
                              A=<input type="number" min="1" value={geo.rw_sol_np_area2}
                                onChange={e=>ug("rw_sol_np_area2", parseFloat(e.target.value)||1)}
                                onWheel={e=>e.target.blur()}
                                className="w-10 ml-0.5 text-center bg-transparent border-b border-amber-500/60 text-amber-300 text-[10px] font-bold outline-none"/> sf
                            </th>
                          </tr>
                          {/* An= sub-row */}
                          <tr className="border-b border-slate-700/40">
                            <th className="py-0.5 text-[9px] text-slate-600">An=</th>
                            <th></th>
                            {s.std_areas.map((a,i)=><th key={i} className="text-right py-0.5 text-[9px] text-slate-600">{a}</th>)}
                            <th className="text-right py-0.5 text-[9px] text-slate-500 border-l border-slate-700/60 pl-1">{s.user1.An}</th>
                            <th className="text-right py-0.5 text-[9px] text-slate-500">{s.user2.An}</th>
                          </tr>
                        </thead>
                        <tbody>
                          {/* Exposed Zones */}
                          <tr className="border-b border-slate-700/30 bg-slate-800/30">
                            <td colSpan={10} className="py-0.5 text-[10px] font-bold text-slate-300 pl-1">Exposed Zones</td>
                          </tr>
                          {zones.map((zk,zi) => (
                            <tr key={"exp"+zi} className={"border-b border-slate-800/40 "+(zi%2===1?"bg-slate-800/20":"")}>
                              {zi===0 && <td rowSpan={3} className="py-0.5 text-[10px] text-slate-500 align-middle">γE=1.5</td>}
                              <td className="py-0.5 text-slate-400">{zoneLabels[zi]}</td>
                              {s.tbl_exp.map((r,i)=><td key={i} className="text-right py-0.5 text-sky-400/90">{r[zk].toFixed(1)}</td>)}
                              <td className="text-right py-0.5 font-bold text-sky-400 border-l border-slate-700/60 pl-1">{s.user1[uKeys.exp[zi]].toFixed(1)}</td>
                              <td className="text-right py-0.5 font-bold text-sky-400">{s.user2[uKeys.exp[zi]].toFixed(1)}</td>
                            </tr>
                          ))}
                          {/* Non-Exposed Zones */}
                          <tr className="border-b border-slate-700/30 bg-slate-800/30">
                            <td colSpan={10} className="py-0.5 text-[10px] font-bold text-slate-300 pl-1">Non Exposed Zones</td>
                          </tr>
                          {zones.map((zk,zi) => (
                            <tr key={"nexp"+zi} className={"border-b border-slate-800/40 "+(zi%2===1?"bg-slate-800/20":"")}>
                              {zi===0 && <td rowSpan={3} className="py-0.5 text-[10px] text-slate-500 align-middle">γE=1.0</td>}
                              <td className="py-0.5 text-slate-400">{zoneLabels[zi]}</td>
                              {s.tbl_nexp.map((r,i)=><td key={i} className="text-right py-0.5 text-sky-400/80">{r[zk].toFixed(1)}</td>)}
                              <td className="text-right py-0.5 font-bold text-sky-400/80 border-l border-slate-700/60 pl-1">{s.user1[uKeys.nexp[zi]].toFixed(1)}</td>
                              <td className="text-right py-0.5 font-bold text-sky-400/80">{s.user2[uKeys.nexp[zi]].toFixed(1)}</td>
                            </tr>
                          ))}
                          {/* All Zones Downward */}
                          <tr className="border-b border-slate-700/30 bg-slate-800/30">
                            <td colSpan={10} className="py-0.5 text-[10px] font-bold text-slate-300 pl-1">All Zones</td>
                          </tr>
                          {zones.map((zk,zi) => (
                            <tr key={"down"+zi} className={"border-b border-slate-800/40 "+(zi%2===1?"bg-slate-800/20":"")}>
                              {zi===0 && <td rowSpan={3} className="py-0.5 text-[10px] text-slate-500 align-middle">γE=1.0</td>}
                              <td className="py-0.5 text-slate-400">{zoneLabels[zi]}</td>
                              {s.tbl_down.map((r,i)=><td key={i} className="text-right py-0.5 text-amber-300/90">{r[zk].toFixed(1)}</td>)}
                              <td className="text-right py-0.5 font-bold text-amber-300 border-l border-slate-700/60 pl-1">{s.user1[uKeys.down[zi]].toFixed(1)}</td>
                              <td className="text-right py-0.5 font-bold text-amber-300">{s.user2[uKeys.down[zi]].toFixed(1)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                      <p className="text-[10px] text-slate-500 mt-1.5">Zone 1 = interior, Zone 2 = edge, Zone 3 = corner. An = A×1000/Lb². Min ±16 psf enforced.</p>
                      <p className="text-[10px] text-amber-500/80 mt-0.5 font-medium">Design for both: (1) panels present + uncovered roof areas, and (2) panels removed.</p>
                    </>
                  );
                })()}
                </div>
              </div>
              </div>
              )}
            </div>
          );
          })() : null}

          {/* ── Other W ── */}
          {tab === "ow" ? (() => {
            const ug = (k,v) => setGeo(g => ({...g, [k]:v}));
            const Row = ({label, val, unit=""}) => (
              <div className="flex justify-between items-baseline py-0.5 border-b border-slate-800/40">
                <span className="text-[11px] text-slate-400">{label}</span>
                <span className="font-mono text-[11px] text-slate-200">{val}{unit ? <span className="text-slate-500 ml-0.5 text-[10px]">{unit}</span> : null}</span>
              </div>
            );
            const Inp = ({label, geoKey, type="number", step, min, options}) => (
              <div className="flex items-center gap-2 py-0.5">
                <label className="text-[11px] text-slate-400 flex-1">{label}</label>
                {options ? (
                  <select value={geo[geoKey]||""} onChange={e=>ug(geoKey, e.target.value)}
                    className="w-36 bg-slate-800 border border-slate-700 rounded px-1.5 py-0.5 text-[11px] text-slate-200 outline-none">
                    {options.map(o=><option key={o.value} value={o.value}>{o.label}</option>)}
                  </select>
                ) : (
                  <input type={type} step={step||"any"} min={min||0}
                    value={geo[geoKey]||0} onChange={e=>ug(geoKey, parseFloat(e.target.value)||0)}
                    className="w-20 bg-slate-800 border border-slate-700 rounded px-1.5 py-0.5 text-[11px] text-slate-200 font-mono outline-none text-right" />
                )}
              </div>
            );
            const ResultBox = ({label, val, unit, highlight}) => (
              <div className={`flex items-center justify-between px-2 py-1 rounded ${highlight ? "bg-sky-900/30 border border-sky-700/40" : "bg-slate-800/50 border border-slate-700/30"}`}>
                <span className="text-[11px] text-slate-400">{label}</span>
                <span className={`font-mono font-bold text-sm ${highlight ? "text-sky-300" : "text-slate-200"}`}>{val} <span className="text-[10px] font-normal text-slate-500">{unit}</span></span>
              </div>
            );

            return (
              <div className="space-y-4">

                {/* ── A. Solid Signs & Freestanding Walls ── */}
                {owSub === "solid" && owR?.solidSign ? (() => {
                  const ss = owR.solidSign;
                  return (
                    <div>
                      <h2 className="text-sm font-bold text-slate-300 mb-1">A. Solid Freestanding Walls & Solid Signs</h2>
                      <p className="text-[10px] text-slate-500 mb-3">§29.3 — F = q<sub>z</sub>·G·C<sub>f</sub>·A<sub>s</sub> &nbsp;|&nbsp; Table 29.3-1</p>
                      <div className="grid grid-cols-2 gap-4">
                        <div className="space-y-1">
                          <div className="text-[10px] font-bold text-slate-500 uppercase tracking-wider mb-1">Inputs</div>
                          <Inp label="Dist to sign top h (ft)" geoKey="ow_ss_h_top" min={1} />
                          <Inp label="Sign/wall height s (ft)" geoKey="ow_ss_s" min={1} />
                          <Inp label="Sign width B (ft)" geoKey="ow_ss_B" min={1} />
                          <Inp label="Wall return Lr (ft)" geoKey="ow_ss_Lr" min={0} />
                          <Inp label="Open area (%)" geoKey="ow_ss_pctOpen" min={0} max={29} />
                        </div>
                        <div className="space-y-1">
                          <div className="text-[10px] font-bold text-slate-500 uppercase tracking-wider mb-1">Parameters</div>
                          <Row label="Kz" val={ss.kz.toFixed(2)} />
                          <Row label="Kzt" val={ss.kztZ.toFixed(2)} />
                          <Row label="qz" val={ss.qzRaw.toFixed(1)} unit="psf" />
                          <Row label="s/h" val={ss.sh.toFixed(2)} />
                          <Row label="B/s" val={ss.bs.toFixed(2)} />
                          {ss.wrf < 1 && <Row label="Wall return factor" val={ss.wrf.toFixed(2)} />}
                          {ss.shr < 1 && <Row label="s/h>0.8 reduction" val={ss.shr.toFixed(2)} />}
                        </div>
                      </div>
                      <div className="mt-3 space-y-1.5">
                        <div className="text-[10px] font-bold text-slate-500 uppercase tracking-wider">Case A & B Results (§29.3.1)</div>
                        <ResultBox label={`Cf (Table 29.3-1, s/h=${ss.sh.toFixed(2)}, B/s=${ss.bs.toFixed(1)})`} val={ss.cfAB.toFixed(2)} />
                        <ResultBox label="F = qz·G·Cf  (per sf of sign area)" val={ss.F_per_sf.toFixed(1)} unit="psf" highlight />
                        <p className="text-[10px] text-slate-500">Multiply by net sign area A<sub>s</sub> for total force (lbs). Min 16 psf for §29.3.1.</p>
                      </div>
                      <div className="mt-3">
                        <div className="text-[10px] font-bold text-slate-500 uppercase tracking-wider mb-1">Case C — Horizontal Distribution (§29.3.2)</div>
                        <table className="w-full text-xs font-mono tabular-nums">
                          <thead>
                            <tr className="border-b border-slate-700/60">
                              <th className="text-left py-1 text-[10px] font-bold text-slate-400">Zone (from windward edge)</th>
                              <th className="text-right py-1 text-[10px] font-bold text-slate-400">Cf</th>
                              <th className="text-right py-1 text-[10px] font-bold text-slate-400">F (psf)</th>
                            </tr>
                          </thead>
                          <tbody>
                            {ss.caseCRows.filter(row => row.cf > 0).map((row, i) => (
                              <tr key={i} className={"border-b border-slate-800/40 " + (i%2===1?"bg-slate-800/20":"")}>
                                <td className="py-0.5 text-slate-400">{row.zone}</td>
                                <td className="text-right py-0.5 text-slate-300">{row.cf.toFixed(2)}</td>
                                <td className="text-right py-0.5 text-sky-400 font-bold">{row.f_psf.toFixed(1)}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                        <p className="text-[10px] text-slate-500 mt-1">B/s={ss.bs.toFixed(2)} — Case C applies to signs with B/s ≥ 2. Zones measured from windward edge in multiples of s.</p>
                      </div>
                    </div>
                  );
                })() : null}

                {/* ── B. Open Signs & Open Frames ── */}
                {owSub === "open" && owR?.openSign ? (() => {
                  const os = owR.openSign;
                  return (
                    <div>
                      <h2 className="text-sm font-bold text-slate-300 mb-1">B. Open Signs & Single-Plane Open Frames</h2>
                      <p className="text-[10px] text-slate-500 mb-3">§29.4 — F = K<sub>d</sub>·q<sub>z</sub>·G·C<sub>f</sub>·A<sub>f</sub> &nbsp;|&nbsp; Open area ≥ 30% of gross</p>
                      <div className="grid grid-cols-2 gap-4">
                        <div className="space-y-1">
                          <div className="text-[10px] font-bold text-slate-500 uppercase tracking-wider mb-1">Inputs</div>
                          <Inp label="Height to centroid z (ft)" geoKey="ow_os_z" min={1} />
                          <Inp label="Width if rect (ft, 0=round)" geoKey="ow_os_w" min={0} />
                          <Inp label="Diameter if round (ft)" geoKey="ow_os_d" min={0} />
                          <Inp label="Open area (% of gross)" geoKey="ow_os_pct" min={30} max={100} />
                        </div>
                        <div className="space-y-1">
                          <div className="text-[10px] font-bold text-slate-500 uppercase tracking-wider mb-1">Parameters</div>
                          <Row label="Kz" val={os.kz.toFixed(2)} />
                          <Row label="Kzt" val={os.kztZ.toFixed(2)} />
                          <Row label="qz" val={os.qzRaw.toFixed(1)} unit="psf" />
                          <Row label="ε (solid/gross ratio)" val={os.eps.toFixed(2)} />
                          {os.isRound && <Row label="D√qz" val={os.dSqQz.toFixed(2)} />}
                          <Row label="Member type" val={os.isRound ? "Round" : "Flat/Rect"} />
                        </div>
                      </div>
                      <div className="mt-3 space-y-1.5">
                        <div className="text-[10px] font-bold text-slate-500 uppercase tracking-wider">Results</div>
                        <ResultBox label={`Cf (Table 29.4-1, ε=${os.eps.toFixed(2)}, ${os.isRound ? "D√qz="+os.dSqQz.toFixed(2) : "flat member"})`} val={os.cf.toFixed(2)} />
                        <ResultBox label="F = Kd·qz·G·Cf  (per sf of solid area Af)" val={os.F_per_sf.toFixed(1)} unit="psf" highlight />
                        <p className="text-[10px] text-slate-500">Multiply by solid projected area A<sub>f</sub> (sf) for total force (lbs). Min 16 psf per §29.4.</p>
                      </div>
                    </div>
                  );
                })() : null}

                {/* ── C. Chimneys & Tanks ── */}
                {owSub === "chimney" && owR?.chimney ? (() => {
                  const ch = owR.chimney;
                  return (
                    <div>
                      <h2 className="text-sm font-bold text-slate-300 mb-1">C. Chimneys, Tanks & Similar Structures</h2>
                      <p className="text-[10px] text-slate-500 mb-3">§29.5 — F = q<sub>z</sub>·G·C<sub>f</sub>·A<sub>f</sub> &nbsp;|&nbsp; Table 29.5-1</p>
                      <div className="grid grid-cols-2 gap-4">
                        <div className="space-y-1">
                          <div className="text-[10px] font-bold text-slate-500 uppercase tracking-wider mb-1">Inputs</div>
                          <Inp label="Height to centroid z (ft)" geoKey="ow_ch_z" min={1} />
                          <Inp label="Total height h (ft)" geoKey="ow_ch_h" min={1} />
                          <Inp label="Diameter / width D (ft)" geoKey="ow_ch_D" min={0.1} step={0.1} />
                          <Inp label="Cross-section" geoKey="ow_ch_sec" options={[
                            {value:"square",       label:"Square"},
                            {value:"hexagonal",    label:"Hexagonal / Octagonal"},
                            {value:"round_smooth", label:"Round — smooth"},
                            {value:"round_rough",  label:"Round — rough"},
                            {value:"round_vrough", label:"Round — very rough"},
                          ]} />
                        </div>
                        <div className="space-y-1">
                          <div className="text-[10px] font-bold text-slate-500 uppercase tracking-wider mb-1">Parameters</div>
                          <Row label="Kd (Table 26.6-1)" val={ch.kdUsed.toFixed(2)} />
                          <Row label="Kz" val={ch.kz.toFixed(2)} />
                          <Row label="Kzt" val={ch.kztZ.toFixed(2)} />
                          <Row label="qz" val={ch.qzRaw.toFixed(1)} unit="psf" />
                          <Row label="h/D" val={ch.hd.toFixed(2)} />
                        </div>
                      </div>
                      <div className="mt-3 space-y-1.5">
                        <div className="text-[10px] font-bold text-slate-500 uppercase tracking-wider">Results</div>
                        {ch.isSquare ? (
                          <>
                            <div className="text-[10px] text-slate-500 font-semibold mt-1">Wind normal to face</div>
                            <ResultBox label={`Cf (Table 29.5-1, h/D=${ch.hd.toFixed(2)}, square — normal)`} val={ch.cfNormal.toFixed(2)} />
                            <ResultBox label="F = qz·G·Cf  (per sf of projected area Af)" val={ch.F_normal.toFixed(1)} unit="psf" highlight />
                            <div className="text-[10px] text-slate-500 font-semibold mt-2">Wind along diagonal</div>
                            <ResultBox label={`Cf (Table 29.5-1, h/D=${ch.hd.toFixed(2)}, square — diagonal)`} val={ch.cfDiag.toFixed(2)} />
                            <ResultBox label="F = qz·G·Cf  (per sf of projected area Af)" val={ch.F_diag.toFixed(1)} unit="psf" highlight />
                          </>
                        ) : (
                          <>
                            <ResultBox label={`Cf (Table 29.5-1, h/D=${ch.hd.toFixed(2)}, ${geo.ow_ch_sec||"square"})`} val={ch.cf.toFixed(2)} />
                            <ResultBox label="F = qz·G·Cf  (per sf of projected area Af)" val={ch.F_per_sf.toFixed(1)} unit="psf" highlight />
                          </>
                        )}
                        <p className="text-[10px] text-slate-500">Multiply by projected area A<sub>f</sub> = h × D for total force. Min 16 psf per §29.5.</p>
                      </div>
                    </div>
                  );
                })() : null}

                {/* ── D. Trussed Towers ── */}
                {owSub === "tower" && owR?.tower ? (() => {
                  const tt = owR.tower;
                  return (
                    <div>
                      <h2 className="text-sm font-bold text-slate-300 mb-1">D. Trussed Towers</h2>
                      <p className="text-[10px] text-slate-500 mb-3">§29.6 — F = K<sub>d</sub>·q<sub>z</sub>·G·C<sub>f</sub>·A<sub>f</sub> &nbsp;|&nbsp; Table 29.6-1</p>
                      <div className="grid grid-cols-2 gap-4">
                        <div className="space-y-1">
                          <div className="text-[10px] font-bold text-slate-500 uppercase tracking-wider mb-1">Inputs</div>
                          <Inp label="Height to centroid z (ft)" geoKey="ow_tt_z" min={1} />
                          <Inp label="Solidity ratio φ" geoKey="ow_tt_phi" min={0.1} max={0.9} step={0.01} />
                          <Inp label="Tower cross-section" geoKey="ow_tt_sec" options={[
                            {value:"square",   label:"Square / Rectangular"},
                            {value:"triangle", label:"Triangular"},
                          ]} />
                          <Inp label="Member shape" geoKey="ow_tt_mem" options={[
                            {value:"flat",  label:"Flat / Angle"},
                            {value:"round", label:"Round"},
                          ]} />

                        </div>
                        <div className="space-y-1">
                          <div className="text-[10px] font-bold text-slate-500 uppercase tracking-wider mb-1">Parameters</div>
                          <Row label="Kd (Table 26.6-1)" val={tt.kdUsed.toFixed(2)} />
                          <Row label="Kz" val={tt.kz.toFixed(2)} />
                          <Row label="Kzt" val={tt.kztZ.toFixed(2)} />
                          <Row label="qz" val={tt.qzRaw.toFixed(1)} unit="psf" />
                          <Row label="φ (solidity)" val={tt.phi.toFixed(2)} />
                          {tt.rmf < 1 && <Row label="Round member factor" val={tt.rmf.toFixed(2)} />}
                        </div>
                      </div>
                      <div className="mt-3 space-y-1.5">
                        <div className="text-[10px] font-bold text-slate-500 uppercase tracking-wider">Results</div>
                        {tt.isSquareTower ? (
                          <>
                            <div className="text-[10px] text-slate-500 font-semibold mt-1">Wind normal to face</div>
                            <ResultBox label={`Cf (Table 29.6-1, φ=${tt.phi.toFixed(2)}, square — normal)`} val={tt.cfNormal.toFixed(2)} />
                            <ResultBox label="F = Kd·qz·G·Cf  (per sf of solid projected area Af)" val={tt.F_normal.toFixed(1)} unit="psf" highlight />
                            <div className="text-[10px] text-slate-500 font-semibold mt-2">Wind along diagonal</div>
                            <ResultBox label={`Cf (Table 29.6-1, φ=${tt.phi.toFixed(2)}, square — diagonal = normal × 1.2)`} val={tt.cfDiag.toFixed(2)} />
                            <ResultBox label="F = Kd·qz·G·Cf  (per sf of solid projected area Af)" val={tt.F_diag.toFixed(1)} unit="psf" highlight />
                          </>
                        ) : (
                          <>
                            <ResultBox label={`Cf (Table 29.6-1, φ=${tt.phi.toFixed(2)}, triangle)`} val={tt.cfNormal.toFixed(2)} />
                            <ResultBox label="F = Kd·qz·G·Cf  (per sf of solid projected area Af)" val={tt.F_normal.toFixed(1)} unit="psf" highlight />
                          </>
                        )}
                        <p className="text-[10px] text-slate-500">Cf = 4φ²−5.9φ+4.0 (square normal); diagonal = normal×1.2; 3.4φ²−4.7φ+3.4 (triangle). Multiply by solid area A<sub>f</sub> for total force.</p>
                      </div>
                    </div>
                  );
                })() : null}

              </div>
            );
          })() : null}

        </div>
      </main>
    </div>
  );
}


// ═══════════════════════════════════════════════════════════════════════════════
// WSS LOAD LOOKUP — inlined
// ═══════════════════════════════════════════════════════════════════════════════

const WSS_PROXY = (url) => `/api/proxy?target=${encodeURIComponent(url)}`;

// Fetch with 15-second timeout so a hung API call doesn't freeze the whole run
async function wssFetch(url, opts) {
  const controller = new AbortController();
  // Race the fetch against a 10s timeout promise
  const timeoutId = setTimeout(() => controller.abort(), 10000);
  try {
    const r = await fetch(url, { ...opts, signal: controller.signal });
    clearTimeout(timeoutId);
    return r;
  } catch (e) {
    clearTimeout(timeoutId);
    if (e.name === 'AbortError') throw new Error('Timed out (10s) — proxy may be unreachable');
    throw e;
  }
}

async function wssGeocode(address) {
  try {
    const censusUrl = `https://geocoding.geo.census.gov/geocoder/locations/onelineaddress?address=${encodeURIComponent(address)}&benchmark=Public_AR_Current&format=json`;
    const r = await wssFetch(WSS_PROXY(censusUrl));
    const data = await r.json();
    const matches = data?.result?.addressMatches;
    if (matches?.length > 0) {
      const m = matches[0];
      return { lat: parseFloat(m.coordinates.y), lon: parseFloat(m.coordinates.x), displayName: m.matchedAddress };
    }
  } catch (e) {}
  const r = await wssFetch(WSS_PROXY(`https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(address)}&format=json&limit=1`));
  const data = await r.json();
  if (!data.length) throw new Error('Address not found. Try adding city and state, or use Lat/Lon.');
  return { lat: parseFloat(data[0].lat), lon: parseFloat(data[0].lon), displayName: data[0].display_name };
}

function wssArcgisGetSamples(service, lat, lon) {
  const geom = JSON.stringify({ x: lon, y: lat, spatialReference: { wkid: 4326 } });
  const url = `https://gis.asce.org/arcgis/rest/services/${service}/getSamples?geometry=${encodeURIComponent(geom)}&geometryType=esriGeometryPoint&returnFirstValueOnly=true&f=json`;
  return wssFetch(WSS_PROXY(url)).then(r => r.json());
}
function wssArcgisIdentify(service, lat, lon, layers = 'all') {
  const ext = `${lon-0.5},${lat-0.5},${lon+0.5},${lat+0.5}`;
  const url = `https://gis.asce.org/arcgis/rest/services/${service}/identify?geometry=${lon},${lat}&geometryType=esriGeometryPoint&sr=4326&layers=${layers}&tolerance=3&mapExtent=${ext}&imageDisplay=800,600,96&returnGeometry=false&f=json`;
  return wssFetch(WSS_PROXY(url)).then(r => r.json());
}

// Seismic
const WSS_SEISMIC_SLUG = { '7-22': 'asce7-22', '7-16': 'asce7-16', '7-10': 'asce7-10' };
async function wssFetchSeismic(lat, lon, standard, riskCategory, siteClass) {
  const slug = WSS_SEISMIC_SLUG[standard];
  const url = `https://earthquake.usgs.gov/ws/designmaps/${slug}.json?latitude=${lat}&longitude=${lon}&riskCategory=${riskCategory}&siteClass=${siteClass}&title=WSS`;
  const r = await wssFetch(WSS_PROXY(url));
  const data = await r.json();
  if (data.response?.data) {
    const d = data.response.data;
    const sa = (d.underlyingData?.siteAmplification) || {};
    return { ss: d.ss, s1: d.s1, fa: d.fa ?? sa.fa ?? null, fv: d.fv ?? sa.fv ?? null, sms: d.sms, sm1: d.sm1, sds: d.sds, sd1: d.sd1, sdc: d.sdc, tl: d.tl, pga: d.pga, pgam: d.pgam, t0: d.t0, ts: d.ts };
  }
  const resp = Array.isArray(data.response) ? data.response[0] : data.response;
  const d = resp?.data || {};
  return { ss: d.ss, s1: d.s1, fa: d.fa, fv: d.fv, sms: d.sms, sm1: d.sm1, sds: d.sds, sd1: d.sd1, sdc: d.sdc, tl: d.tl || d['t-sub-l'], pga: d.pga, pgam: d.pgam, t0: d.t0, ts: d.ts };
}

// Wind
const WSS_WIND_722 = { I:'ASCE722/w2022_mri300/ImageServer', II:'ASCE722/w2022_mri700/ImageServer', III:'ASCE722/w2022_mri1700/ImageServer', IV:'ASCE722/w2022_mri3000/ImageServer' };
const WSS_WIND_716 = { I:'ASCE/wind2016_300/ImageServer', II:'ASCE/wind2016_700/ImageServer', III:'ASCE/wind2016_1700/ImageServer', IV:'ASCE/wind2016_3000/ImageServer' };
const WSS_WIND_710 = { I:'ASCE/wind2010_A/ImageServer', II:'ASCE/wind2010_C/ImageServer', III:'ASCE/wind2010_B/ImageServer', IV:'ASCE/wind2010_C/ImageServer' };
async function wssFetchWind(lat, lon, standard, riskCategory) {
  let windSpeed = null;
  const svcMap = standard === '7-22' ? WSS_WIND_722 : standard === '7-16' ? WSS_WIND_716 : WSS_WIND_710;
  try { const data = await wssArcgisGetSamples(svcMap[riskCategory], lat, lon); windSpeed = (data.samples||[])[0] ? parseFloat(data.samples[0].value) : null; } catch(e) {}
  let isHurricane = false;
  try { const h = await wssArcgisIdentify('ASCE/ASCE_Hurricane_WindBorneDebris/MapServer', lat, lon); isHurricane = (h.results||[]).length > 0; } catch(e) {}
  let isSpecialWind = false;
  try { const s = await wssArcgisIdentify('ASCE722/w2022_Special_Wind_Regions/MapServer', lat, lon); isSpecialWind = (s.results||[]).length > 0; } catch(e) {}
  return { windSpeed, isHurricane, isSpecialWind };
}

// Snow helpers
async function wssFetchSiteElevFt(lat, lon) {
  try { const d = await wssArcgisGetSamples('ASCE722/s2022_Elevation/ImageServer', lat, lon); const v = d.samples?.[0]?.value; if (v != null && v !== 'NoData') return parseFloat(v) * 3.28084; } catch(e) {}
  return null;
}
function wssExtractSnowLoad(attrs, siteElevFt) {
  const elevTable = [];
  for (let i = 1; i <= 4; i++) {
    const elev = attrs[`Elevation${i}`], load = attrs[`Load${i}`];
    if (elev != null && String(elev) !== 'Null' && parseFloat(elev) > 0 && load != null && String(load) !== 'Null')
      elevTable.push({ elevation: parseFloat(elev), load: parseFloat(load) });
  }
  let selectedLoad = null;
  if (elevTable.length > 0 && siteElevFt != null) {
    elevTable.sort((a,b) => a.elevation - b.elevation);
    if (siteElevFt <= elevTable[0].elevation) { selectedLoad = parseFloat(attrs['Display'] ?? 0); }
    else { selectedLoad = elevTable[elevTable.length-1].load; for (let i=1;i<elevTable.length;i++) { if (siteElevFt <= elevTable[i].elevation) { selectedLoad = elevTable[i].load; break; } } }
  } else { const d = attrs['Display']; selectedLoad = (d != null && d !== 'Null' && d !== '') ? parseFloat(d) : null; }
  return { load: selectedLoad, elevTable: elevTable.length > 0 ? elevTable : null };
}
const WSS_SNOW_722 = { I:'ASCE722/s2022_RiskCategory1/ImageServer', II:'ASCE722/s2022_RiskCategory2/ImageServer', III:'ASCE722/s2022_RiskCategory3/ImageServer', IV:'ASCE722/s2022_RiskCategory4/ImageServer' };
async function wssFetchSnow(lat, lon, standard, riskCategory) {
  let groundSnowLoad = null, winterWind = null, specialCase = false, elevationTable = null, siteElevFt = null;
  if (standard === '7-22') {
    const [ss, wD, spD, eFt] = await Promise.allSettled([wssArcgisGetSamples(WSS_SNOW_722[riskCategory], lat, lon), wssArcgisIdentify(`ASCE722/s2022_Tile_RC_${riskCategory}/MapServer`, lat, lon, 'all:0'), wssArcgisIdentify(`ASCE722/s2022_Tile_RC_${riskCategory}/MapServer`, lat, lon, 'all:1'), wssFetchSiteElevFt(lat, lon)]);
    if (ss.status==='fulfilled') { const rawVal = (ss.value.samples||[])[0]?.value; const n = rawVal != null && String(rawVal).trim() !== 'NoData' ? parseFloat(String(rawVal).trim()) : null; if (n != null && !isNaN(n)) groundSnowLoad = n; }
    if (wD.status==='fulfilled') { const r = (wD.value.results||[])[0]; if (r) winterWind = r.attributes?.value ?? r.attributes?.SI_Label ?? null; }
    if (spD.status==='fulfilled') specialCase = (spD.value.results||[]).length > 0;
    if (eFt.status==='fulfilled' && eFt.value != null) siteElevFt = eFt.value;
  } else if (standard === '7-16') {
    try {
      const [s716, sp716, eFt] = await Promise.all([wssArcgisIdentify('ASCE/Snow_2016_Tile/MapServer', lat, lon, 'all:1'), wssArcgisIdentify('ASCE/Snow_2016_Tile/MapServer', lat, lon, 'all:2'), wssFetchSiteElevFt(lat, lon)]);
      siteElevFt = eFt;
      const r = (s716.results||[])[0]; if (r) { const ex = wssExtractSnowLoad(r.attributes||{}, siteElevFt); groundSnowLoad = ex.load; if (ex.elevTable) elevationTable = ex.elevTable; }
      const sp = (sp716.results||[])[0]; if (sp) { const hasReal = [1,2,3,4].some(i => sp.attributes?.[`Load${i}`] && parseFloat(sp.attributes[`Load${i}`]) > 0); specialCase = !hasReal && groundSnowLoad === null; }
    } catch(e) {}
  } else {
    try { const [s710, eFt] = await Promise.all([wssArcgisIdentify('ASCE/SnowLoad/MapServer', lat, lon, 'all:2'), wssFetchSiteElevFt(lat, lon)]); siteElevFt = eFt; const r = (s710.results||[])[0]; if (r) { const ex = wssExtractSnowLoad(r.attributes||{}, siteElevFt); groundSnowLoad = ex.load; if (ex.elevTable) elevationTable = ex.elevTable; } } catch(e) {}
    try { const sp = await wssArcgisIdentify('ASCE/SnowLoad/MapServer', lat, lon, 'all:1'); specialCase = (sp.results||[]).length > 0; } catch(e) {}
  }
  return { groundSnowLoad, winterWind, specialCase, elevationTable, siteElevFt };
}

// Ice
const WSS_ICE_MRI = { I:'0250', II:'0500', III:'1000', IV:'1400' };
async function wssFetchIce(lat, lon, standard, riskCategory) {
  if (standard === '7-10') { const d = await wssArcgisIdentify('ASCE/IceLoad/MapServer', lat, lon); const a = (d.results||[])[0]?.attributes||{}; return { iceThickness: parseFloat(a['Classify.Pixel Value'] ?? a.value ?? 0)||null, concurrentTemp: null, concurrentGust: null }; }
  const mri = WSS_ICE_MRI[riskCategory];
  const [thD, guD, tmD] = await Promise.all([wssArcgisGetSamples(`ASCE722/i2022_mri${mri}/ImageServer`, lat, lon), wssArcgisGetSamples('ASCE722/i2022_gust/ImageServer', lat, lon), wssArcgisIdentify('ASCE722/i2022_ConcurrentTemp/MapServer', lat, lon)]);
  return { iceThickness: parseFloat(thD.samples?.[0]?.value??0)||null, concurrentGust: parseFloat(guD.samples?.[0]?.value??0)||null, concurrentTemp: (tmD.results?.[0]?.attributes||{}).conc_temp??null };
}

// Rain
async function wssFetchRain(lat, lon) {
  const r = await wssFetch(WSS_PROXY(`https://hdsc.nws.noaa.gov/cgi-bin/hdsc/new/cgi_readH5.py?lat=${lat}&lon=${lon}&type=pf&data=intensity&units=english&series=pds`));
  const text = await r.text();
  const match = text.match(/quantiles\s*=\s*(\[[\s\S]+?\]);/);
  if (!match) return { error: 'No rain data' };
  const jsonStr = match[1].replace(/'/g,'"').replace(/,\s*]/g,']').replace(/,\s*}/g,'}');
  let raw;
  try { raw = JSON.parse(jsonStr); } catch(e) { try { raw = Function('"use strict"; return (' + match[1] + ')')(); } catch(e2) { return { error: 'Parse error' }; } }
  const durs = ['5-min','10-min','15-min','30-min','60-min','2-hr','3-hr','6-hr','12-hr','24-hr','2-day','3-day','4-day','7-day','10-day','20-day','30-day','45-day','60-day'];
  const pers = ['1yr','2yr','5yr','10yr','25yr','50yr','100yr','200yr','500yr','1000yr'];
  return { table: raw.map((row,i) => ({ duration: durs[i]||`row${i}`, values: Object.fromEntries(row.map((v,j) => [pers[j]||`p${j}`, parseFloat(v)])) })) };
}

// Flood
async function wssFetchFlood(lat, lon) {
  const r = await wssFetch(WSS_PROXY(`https://hazards.fema.gov/arcgis/rest/services/public/NFHL/MapServer/28/query?geometry=${lon},${lat}&geometryType=esriGeometryPoint&inSR=4326&spatialRel=esriSpatialRelIntersects&outFields=FLD_ZONE,STATIC_BFE,V_DATUM,ZONE_SUBTY,SFHA_TF&returnGeometry=false&f=json`));
  const data = await r.json();
  const f = (data.features||[])[0];
  if (!f) return { floodZone:'Not Available', bfe:null, datum:null, sfha:false, subtype:null };
  const a = f.attributes;
  return { floodZone:a.FLD_ZONE, bfe:a.STATIC_BFE===-9999?null:a.STATIC_BFE, datum:a.V_DATUM||null, sfha:a.SFHA_TF==='T', subtype:a.ZONE_SUBTY };
}

// Tornado
const WSS_TRP = ['RP1700','RP3K','RP10K','RP100K','RP1M','RP10M'];
async function wssFetchTornado(lat, lon, riskCategory) {
  if (riskCategory==='I'||riskCategory==='II') return { applicable:false, message:'Tornado hazard data only applies to Risk Category III or IV.' };
  const results = {};
  await Promise.all(WSS_TRP.map(async (rp) => { try { const d = await wssArcgisGetSamples(`ASCE722/t2022_PT_${rp}/ImageServer`, lat, lon); const v = d.samples?.[0]?.value; results[rp] = (v!=null&&v!=='NoData')?parseFloat(v):null; } catch { results[rp]=null; } }));
  let inPronArea = false;
  try { const p = await wssArcgisIdentify('ASCE722/t2022_tornado_prone_area/MapServer', lat, lon); inPronArea = (p.results||[]).length > 0; } catch(e) {}
  return { applicable:true, speeds:results, inPronArea };
}

// Tsunami
async function wssFetchTsunami(lat, lon, standard) {
  if (standard==='7-10') return { applicable:false, message:'Tsunami data not available for ASCE 7-10.' };
  const data = await wssArcgisIdentify('TDZ_Call_20211112/MapServer', lat, lon);
  const results = data.results||[];
  const inZone = results.length > 0;
  const attrs = results[0]?.attributes||{};
  return { applicable:true, inTDZ:inZone, runupMHW:inZone?parseFloat(attrs.runup_mhw):null, runupNAVD:inZone?(attrs.runup_navd!=='Null'?parseFloat(attrs.runup_navd):null):null };
}

// ─── WSS UI helpers ───────────────────────────────────────────────────────────
function WssFmt(v, d=3) { if (v==null||isNaN(v)) return 'N/A'; return typeof v==='number'?v.toFixed(d):String(v); }

function WssStatusBadge({ status }) {
  const map = { loading:['#3b82f6','…'], success:['#22c55e','✓'], error:['#ef4444','✗'], idle:['#64748b','—'] };
  const [color, sym] = map[status]||map.idle;
  return <span style={{ marginLeft:4, fontWeight:700, color }}>{sym}</span>;
}

function WssCard({ title, icon, status, children }) {
  const borderColor = { loading:'#1e40af', success:'#166534', error:'#991b1b', idle:'#334155' }[status]||'#334155';
  return (
    <div style={{ background:'#0f172a', border:`1px solid ${borderColor}`, borderRadius:6, marginBottom:10 }}>
      <div style={{ display:'flex', alignItems:'center', gap:6, padding:'6px 10px', borderBottom:`1px solid ${borderColor}` }}>
        <span style={{ fontSize:14 }}>{icon}</span>
        <span style={{ fontWeight:700, fontSize:11, color:'#cbd5e1', flex:1 }}>{title}</span>
        <WssStatusBadge status={status} />
      </div>
      <div style={{ padding:'8px 10px', fontSize:11 }}>{children}</div>
    </div>
  );
}

function WssRow({ label, value, highlight }) {
  return (
    <div style={{ display:'flex', justifyContent:'space-between', padding:'2px 0', borderBottom:'1px solid #1e293b', background: highlight?'#0c2340':'transparent' }}>
      <span style={{ color:'#94a3b8' }}>{label}</span>
      <span style={{ color: highlight?'#7dd3fc':'#e2e8f0', fontWeight: highlight?700:400 }}>{value ?? 'N/A'}</span>
    </div>
  );
}

function WssAutocomplete({ value, onChange, onSelect }) {
  const [sugg, setSugg] = useState([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [activeIdx, setActiveIdx] = useState(-1);
  const debRef = useRef(null);
  const wrapRef = useRef(null);
  useEffect(() => {
    const h = (e) => { if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, []);
  async function fetchSugg(q) {
    if (q.length < 3) { setSugg([]); setOpen(false); return; }
    setLoading(true);
    try { const r = await wssFetch(WSS_PROXY(`https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}&format=json&limit=6&addressdetails=1&countrycodes=us`)); const d = await r.json(); setSugg(d||[]); setOpen((d||[]).length>0); setActiveIdx(-1); } catch(e) { setSugg([]); setOpen(false); }
    setLoading(false);
  }
  function sel(item) { onChange(item.display_name); setSugg([]); setOpen(false); onSelect({ lat:parseFloat(item.lat), lon:parseFloat(item.lon), displayName:item.display_name }); }
  function handleKey(e) {
    if (!open) return;
    if (e.key==='ArrowDown') { e.preventDefault(); setActiveIdx(i=>Math.min(i+1,sugg.length-1)); }
    else if (e.key==='ArrowUp') { e.preventDefault(); setActiveIdx(i=>Math.max(i-1,0)); }
    else if (e.key==='Enter'&&activeIdx>=0) { e.preventDefault(); sel(sugg[activeIdx]); }
    else if (e.key==='Escape') setOpen(false);
  }
  return (
    <div style={{ position:'relative' }} ref={wrapRef}>
      <div style={{ display:'flex', gap:4 }}>
        <input
          style={{ flex:1, background:'#1e293b', border:'1px solid #334155', borderRadius:4, padding:'5px 8px', color:'#e2e8f0', fontSize:11, fontFamily:'inherit' }}
          placeholder="e.g. 1234 Main St, Houston TX"
          value={value}
          onChange={e => { onChange(e.target.value); clearTimeout(debRef.current); debRef.current = setTimeout(()=>fetchSugg(e.target.value),320); }}
          onKeyDown={handleKey}
          onFocus={() => sugg.length>0&&setOpen(true)}
          autoComplete="off"
        />
        {loading && <span style={{ color:'#64748b', fontSize:10, alignSelf:'center' }}>…</span>}
      </div>
      {open && sugg.length>0 && (
        <ul style={{ position:'absolute', top:'100%', left:0, right:0, background:'#1e293b', border:'1px solid #334155', borderRadius:4, zIndex:999, listStyle:'none', margin:'2px 0 0', padding:0, maxHeight:200, overflowY:'auto' }}>
          {sugg.map((item,i) => {
            const parts = item.display_name.split(', ');
            return (
              <li key={item.place_id} onMouseDown={()=>sel(item)} onMouseEnter={()=>setActiveIdx(i)}
                style={{ padding:'6px 10px', cursor:'pointer', background:i===activeIdx?'#0f2040':'transparent', borderBottom:'1px solid #0f172a' }}>
                <div style={{ fontSize:11, color:'#e2e8f0', fontWeight:600 }}>{parts.slice(0,2).join(', ')}</div>
                {parts.length>2&&<div style={{ fontSize:10, color:'#64748b' }}>{parts.slice(2,4).join(', ')}</div>}
              </li>
            );
          })}
          <li style={{ padding:'4px 10px', fontSize:9, color:'#475569' }}>Powered by OpenStreetMap</li>
        </ul>
      )}
    </div>
  );
}

function WssMapPicker({ onLocationSelect, syncLocation }) {
  const mapRef = useRef(null);
  const leafletMap = useRef(null);
  const markerRef = useRef(null);
  const [pinLabel, setPinLabel] = useState('Click map to drop a pin');
  useEffect(() => {
    const init = () => {
      if (!window.L || leafletMap.current) return;
      const L = window.L;
      const map = L.map(mapRef.current, { center:[38.5,-96], zoom:4 });
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution:'© OpenStreetMap', maxZoom:19 }).addTo(map);
      const icon = L.divIcon({ className:'', html:'<div style="width:14px;height:14px;background:#e8a020;border:2px solid #fff;border-radius:50%;box-shadow:0 2px 6px rgba(0,0,0,0.5)"></div>', iconSize:[14,14], iconAnchor:[7,7] });
      map.on('click', async (e) => {
        const { lat, lng } = e.latlng;
        if (markerRef.current) { markerRef.current.setLatLng([lat,lng]); } else { markerRef.current = L.marker([lat,lng],{icon}).addTo(map); }
        let dn = `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
        try { const r = await wssFetch(WSS_PROXY(`https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lng}&format=json`)); const d = await r.json(); if (d.display_name) dn = d.display_name; } catch(e) {}
        setPinLabel(dn);
        onLocationSelect({ lat, lon:lng, displayName:dn });
      });
      leafletMap.current = map;
      if (syncLocation?.lat) { map.flyTo([syncLocation.lat, syncLocation.lon], 14); setPinLabel(syncLocation.displayName||''); }
    };
    if (window.L) { init(); } else { const iv = setInterval(()=>{ if(window.L){clearInterval(iv);init();} },100); return ()=>clearInterval(iv); }
    return () => { if (leafletMap.current) { leafletMap.current.remove(); leafletMap.current=null; markerRef.current=null; } };
  }, []);
  useEffect(() => {
    if (!syncLocation?.lat || !leafletMap.current) return;
    leafletMap.current.flyTo([syncLocation.lat, syncLocation.lon], 14, {animate:true,duration:1.2});
    if (markerRef.current) { markerRef.current.setLatLng([syncLocation.lat, syncLocation.lon]); }
    setPinLabel(syncLocation.displayName||'');
  }, [syncLocation]);
  return (
    <div>
      <div ref={mapRef} style={{ height:260, borderRadius:4, border:'1px solid #334155', overflow:'hidden' }} />
      <div style={{ marginTop:4, fontSize:10, color:'#64748b' }}>📍 {pinLabel}</div>
    </div>
  );
}

function WssRainCard({ rain }) {
  const [show, setShow] = useState(false);
  const table = rain.table||[];
  const get = (dur,per) => { const row=table.find(r=>r.duration===dur); return row?WssFmt(row.values[per],3):'N/A'; };
  const pers = ['1yr','2yr','5yr','10yr','25yr','50yr','100yr','200yr','500yr','1000yr'];
  const hdrs = ['1-yr','2-yr','5-yr','10-yr','25-yr','50-yr','100-yr','200-yr','500-yr','1000-yr'];
  return (
    <div>
      <div style={{ display:'flex', gap:16, marginBottom:8 }}>
        <div style={{ flex:1, background:'#0c2040', borderRadius:4, padding:8 }}>
          <div style={{ fontSize:9, color:'#64748b', marginBottom:2 }}>15-min (100-yr)</div>
          <div style={{ fontSize:14, fontWeight:700, color:'#7dd3fc' }}>{get('15-min','100yr')} <span style={{ fontSize:10, fontWeight:400 }}>in/hr</span></div>
        </div>
        <div style={{ flex:1, background:'#0c2040', borderRadius:4, padding:8 }}>
          <div style={{ fontSize:9, color:'#64748b', marginBottom:2 }}>60-min (100-yr)</div>
          <div style={{ fontSize:14, fontWeight:700, color:'#7dd3fc' }}>{get('60-min','100yr')} <span style={{ fontSize:10, fontWeight:400 }}>in/hr</span></div>
        </div>
      </div>
      <button onClick={()=>setShow(s=>!s)} style={{ fontSize:10, color:'#38bdf8', background:'none', border:'none', cursor:'pointer', padding:0 }}>
        {show?'▲ Hide Atlas 14 Table':'▼ Show Full Atlas 14 Table'}
      </button>
      {show && (
        <div style={{ overflowX:'auto', marginTop:6 }}>
          <table style={{ width:'100%', fontSize:9, borderCollapse:'collapse' }}>
            <thead><tr style={{ borderBottom:'1px solid #334155' }}><th style={{ textAlign:'left', padding:'2px 4px', color:'#64748b' }}>Dur</th>{hdrs.map((h,i)=><th key={h} style={{ textAlign:'right', padding:'2px 4px', color:i===6?'#7dd3fc':'#64748b' }}>{h}</th>)}</tr></thead>
            <tbody>{table.map(row=>{const hl=['15-min','60-min'].includes(row.duration);return(<tr key={row.duration} style={{ background:hl?'#0c1a30':'transparent' }}><td style={{ padding:'2px 4px', color:'#94a3b8' }}>{row.duration}</td>{pers.map((p,i)=><td key={p} style={{ textAlign:'right', padding:'2px 4px', color:hl&&i===6?'#7dd3fc':'#cbd5e1' }}>{WssFmt(row.values[p],3)}</td>)}</tr>);})}</tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ─── PDF REPORT ─────────────────────────────────────────────────────────────────



function wssPdfFmt(val, decimals = 3) {
  if (val == null || val === undefined || isNaN(val)) return 'N/A';
  return typeof val === 'number' ? val.toFixed(decimals) : String(val);
}

function sectionHeader(doc, text, y) {
  doc.setFillColor(15, 40, 80);
  doc.rect(14, y, 182, 7, 'F');
  doc.setTextColor(255, 255, 255);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(9);
  doc.text(text, 16, y + 5);
  doc.setTextColor(30, 30, 30);
  doc.setFont('helvetica', 'normal');
  return y + 10;
}

function wssGeneratePDF(inputs, results) {
  const doc = new jsPDF({ unit: 'mm', format: 'letter' });
  const pageW = doc.internal.pageSize.getWidth();
  let y = 14;

  // ── Header ──
  doc.setFillColor(15, 40, 80);
  doc.rect(0, 0, pageW, 28, 'F');
  doc.setTextColor(255, 255, 255);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(18);
  doc.text('WSS Load Lookup', 14, 13);
  doc.setFontSize(9);
  doc.setFont('helvetica', 'normal');
  doc.text('Site Hazard Report  |  Wind · Seismic · Snow · Ice · Rain · Flood · Tsunami · Tornado', 14, 21);
  doc.text(`Generated: ${new Date().toLocaleString()}`, pageW - 14, 21, { align: 'right' });
  doc.setTextColor(30, 30, 30);
  y = 36;

  // ── Site Info ──
  y = sectionHeader(doc, 'SITE INFORMATION', y);
  const snowResult = results.snow || {};
  const elevFt = snowResult.siteElevFt != null ? `${Math.round(snowResult.siteElevFt).toLocaleString()} ft NAVD88` : 'N/A';
  const latStr = inputs.lat != null ? inputs.lat.toFixed(6) : 'N/A';
  const lonStr = inputs.lon != null ? inputs.lon.toFixed(6) : 'N/A';
  autoTable(doc, {
    startY: y,
    head: [],
    body: [
      ['Address', inputs.address || 'N/A', 'Standard', `ASCE 7-${inputs.standard}`],
      ['Latitude', latStr, 'Risk Category', `RC ${inputs.riskCategory}`],
      ['Longitude', lonStr, 'Site Class', inputs.siteClass],
      ['Site Elevation', elevFt, 'Report Date', new Date().toLocaleDateString()],
    ],
    theme: 'plain',
    styles: { fontSize: 9, cellPadding: 2 },
    columnStyles: {
      0: { fontStyle: 'bold', cellWidth: 35 },
      2: { fontStyle: 'bold', cellWidth: 35 },
    },
    margin: { left: 14, right: 14 },
  });
  y = doc.lastAutoTable.finalY + 6;

  // ── Wind ──
  if (results.wind) {
    y = sectionHeader(doc, 'WIND', y);
    const w = results.wind;
    autoTable(doc, {
      startY: y,
      head: [['Parameter', 'Value', 'Notes']],
      body: [
        ['Ultimate Wind Speed (V)', w.windSpeed ? `${wssPdfFmt(w.windSpeed, 0)} mph` : 'N/A', `ASCE 7-${inputs.standard} Fig. 26.5-1`],
        ['Hurricane-Prone Region', w.isHurricane ? 'YES' : 'NO', w.isHurricane ? 'Wind-borne debris requirements apply' : ''],
        ['Special Wind Region', w.isSpecialWind ? 'YES — See Authority Having Jurisdiction' : 'NO', w.isSpecialWind ? 'Site-specific study may be required' : ''],
      ],
      theme: 'striped',
      headStyles: { fillColor: [15, 40, 80], fontSize: 9 },
      styles: { fontSize: 9, cellPadding: 2 },
      margin: { left: 14, right: 14 },
    });
    y = doc.lastAutoTable.finalY + 6;
  }

  // ── Seismic ──
  if (results.seismic) {
    y = sectionHeader(doc, 'SEISMIC', y);
    const s = results.seismic;
    autoTable(doc, {
      startY: y,
      head: [['Parameter', 'Value', 'Parameter', 'Value']],
      body: [
        ['Ss (0.2 sec)', wssPdfFmt(s.ss), 'S1 (1.0 sec)', wssPdfFmt(s.s1)],
        ['Fa', s.fa != null ? wssPdfFmt(s.fa) : (inputs.standard === '7-22' ? 'N/A (multi-period)' : 'N/A'), 'Fv', s.fv != null ? wssPdfFmt(s.fv) : (inputs.standard === '7-22' ? 'N/A (multi-period)' : 'N/A')],
        ['SMS', wssPdfFmt(s.sms), 'SM1', wssPdfFmt(s.sm1)],
        ['SDS', wssPdfFmt(s.sds), 'SD1', wssPdfFmt(s.sd1)],
        ['SDC', s.sdc ?? 'N/A', 'TL (sec)', wssPdfFmt(s.tl, 1)],
        ['PGA (g)', wssPdfFmt(s.pga), 'PGAm (g)', wssPdfFmt(s.pgam)],
        ['T0 (sec)', wssPdfFmt(s.t0), 'Ts (sec)', wssPdfFmt(s.ts)],
      ],
      theme: 'striped',
      headStyles: { fillColor: [15, 40, 80], fontSize: 9 },
      styles: { fontSize: 9, cellPadding: 2 },
      margin: { left: 14, right: 14 },
    });
    y = doc.lastAutoTable.finalY + 6;
  }

  // ── Snow ──
  if (results.snow) {
    y = sectionHeader(doc, 'GROUND SNOW LOAD', y);
    const sn = results.snow;
    autoTable(doc, {
      startY: y,
      head: [['Parameter', 'Value', 'Notes']],
      body: [
        ['Ground Snow Load (pg)', sn.groundSnowLoad != null ? `${Math.round(sn.groundSnowLoad)} psf` : 'N/A', `ASCE 7-${inputs.standard}`],
        ['Winter Wind Parameter', sn.winterWind ?? 'N/A', ''],
        ['Special Case', sn.specialCase ? 'YES — Site study required' : 'NO', ''],
      ],
      theme: 'striped',
      headStyles: { fillColor: [15, 40, 80], fontSize: 9 },
      styles: { fontSize: 9, cellPadding: 2 },
      margin: { left: 14, right: 14 },
    });
    y = doc.lastAutoTable.finalY + 6;
  }

  // ── Ice ──
  if (results.ice) {
    const ic = results.ice;
    y = sectionHeader(doc, 'ICE', y);
    autoTable(doc, {
      startY: y,
      head: [['Parameter', 'Value']],
      body: [
        ['Radial Ice Thickness', ic.iceThickness != null ? `${wssPdfFmt(ic.iceThickness, 3)} in` : 'N/A'],
        ['Concurrent Temperature', ic.concurrentTemp != null ? `${ic.concurrentTemp} °F` : 'N/A'],
        ['Concurrent 3-s Gust', ic.concurrentGust != null ? `${wssPdfFmt(ic.concurrentGust, 1)} mph` : 'N/A'],
      ],
      theme: 'striped',
      headStyles: { fillColor: [15, 40, 80], fontSize: 9 },
      styles: { fontSize: 9, cellPadding: 2 },
      margin: { left: 14, right: 14 },
    });
    y = doc.lastAutoTable.finalY + 6;
  }

  // Check if new page needed
  if (y > 220) { doc.addPage(); y = 14; }

  // ── Flood ──
  if (results.flood) {
    const fl = results.flood;
    y = sectionHeader(doc, 'FLOOD', y);
    autoTable(doc, {
      startY: y,
      head: [['Parameter', 'Value']],
      body: [
        ['FEMA Flood Zone', fl.floodZone ?? 'N/A'],
        ['Special Flood Hazard Area (SFHA)', fl.sfha ? 'YES' : 'NO'],
        ['Base Flood Elevation (BFE)', fl.bfe != null ? `${fl.bfe} ft (${fl.datum})` : 'N/A'],
        ['Zone Subtype', fl.subtype ?? 'N/A'],
      ],
      theme: 'striped',
      headStyles: { fillColor: [15, 40, 80], fontSize: 9 },
      styles: { fontSize: 9, cellPadding: 2 },
      margin: { left: 14, right: 14 },
    });
    y = doc.lastAutoTable.finalY + 6;
  }

  // ── Tsunami ──
  if (results.tsunami) {
    const ts = results.tsunami;
    y = sectionHeader(doc, 'TSUNAMI', y);
    if (!ts.applicable) {
      autoTable(doc, { startY: y, body: [[ts.message]], theme: 'plain', styles: { fontSize: 9 }, margin: { left: 14, right: 14 } });
    } else {
      autoTable(doc, {
        startY: y,
        head: [['Parameter', 'Value']],
        body: [
          ['In Tsunami Design Zone (TDZ)', ts.inTDZ ? 'YES' : 'NO'],
          ['Runup Elevation (MHW)', ts.runupMHW != null ? `${wssPdfFmt(ts.runupMHW, 2)} ft` : 'N/A'],
          ['Runup Elevation (NAVD88)', ts.runupNAVD != null ? `${wssPdfFmt(ts.runupNAVD, 2)} ft` : 'N/A'],
        ],
        theme: 'striped',
        headStyles: { fillColor: [15, 40, 80], fontSize: 9 },
        styles: { fontSize: 9, cellPadding: 2 },
        margin: { left: 14, right: 14 },
      });
    }
    y = doc.lastAutoTable.finalY + 6;
  }

  // ── Tornado ──
  if (results.tornado) {
    const tor = results.tornado;
    y = sectionHeader(doc, 'TORNADO', y);
    if (!tor.applicable) {
      autoTable(doc, { startY: y, body: [[tor.message]], theme: 'plain', styles: { fontSize: 9 }, margin: { left: 14, right: 14 } });
    } else {
      const rows = Object.entries(tor.speeds || {}).map(([rp, v]) => [
        rp.replace('RP', '').replace('K', ',000').replace('M', ',000,000') + '-yr MRI',
        v != null ? `${wssPdfFmt(v, 0)} mph` : 'N/A',
      ]);
      autoTable(doc, {
        startY: y,
        head: [['Return Period (PT — 1 sq ft)', 'Tornado Wind Speed']],
        body: [['In Tornado-Prone Area', tor.inPronArea ? 'YES' : 'NO'], ...rows],
        theme: 'striped',
        headStyles: { fillColor: [15, 40, 80], fontSize: 9 },
        styles: { fontSize: 9, cellPadding: 2 },
        margin: { left: 14, right: 14 },
      });
    }
    y = doc.lastAutoTable.finalY + 6;
  }

  // ── Rain ──
  if (results.rain?.table) {
    if (y > 220) { doc.addPage(); y = 14; }
    y = sectionHeader(doc, 'RAIN (NOAA Atlas 14)', y);

    // Helper to get a value from the table
    const rainGet = (duration, period) => {
      const row = results.rain.table.find(r => r.duration === duration);
      return row ? wssPdfFmt(row.values[period], 3) : 'N/A';
    };

    autoTable(doc, {
      startY: y,
      head: [['Parameter', 'Value', 'Reference']],
      body: [
        [
          '15-min Rainfall Intensity (100-yr MRI)',
          `${rainGet('15-min', '100yr')} in/hr`,
          'NOAA Atlas 14, PDS'
        ],
        [
          '60-min Rainfall Intensity (100-yr MRI)',
          `${rainGet('60-min', '100yr')} in/hr`,
          'NOAA Atlas 14, PDS · ASCE 7 §8.3'
        ],
      ],
      theme: 'striped',
      headStyles: { fillColor: [15, 40, 80], fontSize: 9 },
      styles: { fontSize: 9, cellPadding: 2 },
      columnStyles: { 1: { fontStyle: 'bold' } },
      margin: { left: 14, right: 14 },
      didParseCell: (data) => {
        if (data.row.index >= 0 && data.column.index === 1) {
          data.cell.styles.fillColor = [255, 243, 220];
          data.cell.styles.textColor = [15, 40, 80];
        }
      },
    });
    y = doc.lastAutoTable.finalY + 4;

    // Note
    doc.setFontSize(7.5);
    doc.setTextColor(120);
    doc.setFont('helvetica', 'italic');
    doc.text(
      'Full precipitation frequency table (19 durations × 10 return periods) available in the WSS Load Lookup app.',
      14, y
    );
    doc.setFont('helvetica', 'normal');
    y += 8;
  }

  // ── Footer ──
  const pageCount = doc.internal.getNumberOfPages();
  for (let i = 1; i <= pageCount; i++) {
    doc.setPage(i);
    doc.setFontSize(7.5);
    doc.setTextColor(120);
    doc.text(
      'WSS Load Lookup  |  Data sourced from USGS, ASCE GIS, FEMA NFHL, NOAA Atlas 14  |  Verify all values against governing code before use.',
      14, doc.internal.pageSize.getHeight() - 8
    );
    doc.text(`Page ${i} of ${pageCount}`, pageW - 14, doc.internal.pageSize.getHeight() - 8, { align: 'right' });
  }

  const siteName = (inputs.address || 'site').replace(/[^a-z0-9]/gi, '_').substring(0, 30);
  doc.save(`WSS_Report_${siteName}_${new Date().toISOString().slice(0,10)}.pdf`);
}

// ─── WSSLookup — main embedded component ─────────────────────────────────────
const WSS_STDS = ['7-22','7-16','7-10'];
const WSS_RCS  = ['I','II','III','IV'];
const WSS_SC_722 = ['A','B','BC','C','CD','D','DE','E'];
const WSS_SC_OLD = ['A','B','C','D','E','F'];

function WSSLookup({ onWindResult }) {
  const [address, setAddress] = useState('');
  const [lat, setLat] = useState('');
  const [lon, setLon] = useState('');
  const [locMode, setLocMode] = useState('address');
  const [syncLoc, setSyncLoc] = useState(null);
  const [standard, setStandard] = useState('7-22');
  const [riskCategory, setRiskCategory] = useState('II');
  const [siteClass, setSiteClass] = useState('D');
  const [resolvedAddr, setResolvedAddr] = useState('');
  const [resolvedLat, setResolvedLat] = useState(null);
  const [resolvedLon, setResolvedLon] = useState(null);
  const [siteElevFt, setSiteElevFt] = useState(null);
  const [statuses, setStatuses] = useState({});
  const [results, setResults] = useState({});
  const [running, setRunning] = useState(false);
  const [globalErr, setGlobalErr] = useState('');

  const siteClasses = standard === '7-22' ? WSS_SC_722 : WSS_SC_OLD;

  function setStatus(h, s) { setStatuses(p=>({...p,[h]:s})); }
  function setResult(h, d) { setResults(p=>({...p,[h]:d})); }

  async function handleRun() {
    setGlobalErr(''); setResults({}); setStatuses({}); setSiteElevFt(null); setRunning(true); setSent(false);
    let fLat, fLon, dispAddr;
    try {
      if (locMode==='latlon') {
        fLat=parseFloat(lat); fLon=parseFloat(lon);
        if (isNaN(fLat)||isNaN(fLon)) throw new Error('Invalid lat/lon values');
        dispAddr=`${fLat.toFixed(5)}, ${fLon.toFixed(5)}`;
      } else if (locMode==='map') {
        fLat=parseFloat(lat); fLon=parseFloat(lon);
        if (isNaN(fLat)||isNaN(fLon)) throw new Error('Please click a location on the map first');
        dispAddr=address||`${fLat.toFixed(5)}, ${fLon.toFixed(5)}`;
      } else {
        if (!address.trim()) throw new Error('Please enter an address');
        if (lat&&lon&&!isNaN(parseFloat(lat))&&!isNaN(parseFloat(lon))) { fLat=parseFloat(lat); fLon=parseFloat(lon); dispAddr=address; }
        else { const geo=await wssGeocode(address); fLat=geo.lat; fLon=geo.lon; dispAddr=geo.displayName; }
      }
      setResolvedAddr(dispAddr); setResolvedLat(fLat); setResolvedLon(fLon);
    } catch(e) { setGlobalErr(e.message); setRunning(false); return; }

    // Quick proxy health check before running all hazards
    try {
      const testUrl = WSS_PROXY('https://nominatim.openstreetmap.org/search?q=test&format=json&limit=1');
      const testR = await wssFetch(testUrl);
      if (!testR.ok) throw new Error('Proxy returned ' + testR.status);
    } catch(e) {
      setGlobalErr('API proxy unreachable: ' + e.message + '. Check Vercel function logs.');
      setRunning(false);
      return;
    }

    const run = async (hazard, fn) => {
      setStatus(hazard,'loading');
      try {
        const d = await Promise.race([
          fn(),
          new Promise((_,rej) => setTimeout(() => rej(new Error('Hazard timed out (12s)')), 12000))
        ]);
        setResult(hazard,d); setStatus(hazard,'success');
      }
      catch(e) { setResult(hazard,{error:e.message}); setStatus(hazard,'error'); }
    };

    let windData = null;
    try {
      await Promise.all([
        run('wind',    async()=>{ const d=await wssFetchWind(fLat,fLon,standard,riskCategory); windData=d; return d; }),
        run('seismic', ()=>wssFetchSeismic(fLat,fLon,standard,riskCategory,siteClass)),
        run('snow',    async()=>{ const d=await wssFetchSnow(fLat,fLon,standard,riskCategory); if(d.siteElevFt!=null)setSiteElevFt(d.siteElevFt); return d; }),
        run('ice',     ()=>wssFetchIce(fLat,fLon,standard,riskCategory)),
        run('rain',    ()=>wssFetchRain(fLat,fLon)),
        run('flood',   ()=>wssFetchFlood(fLat,fLon)),
        run('tsunami', ()=>wssFetchTsunami(fLat,fLon,standard)),
        run('tornado', ()=>wssFetchTornado(fLat,fLon,riskCategory)),
      ]);
    } catch(e) {
      setGlobalErr('Lookup error: ' + e.message);
    }
    setRunning(false);
    if (windData && windData.windSpeed != null && onWindResult) {
      onWindResult({ V_mph: Math.round(windData.windSpeed), risk_category: riskCategory, code_version: standard });
      setSent(true);
    }
  }

  function handleDownloadPDF() {
    wssGeneratePDF(
      { address: resolvedAddr, lat: resolvedLat, lon: resolvedLon, standard, riskCategory, siteClass },
      results
    );
  }

  const hasResults = Object.keys(results).length > 0;
  const allDone = hasResults && !running;
  const w=results.wind||{}, s=results.seismic||{}, sn=results.snow||{}, ic=results.ice||{}, fl=results.flood||{}, ts=results.tsunami||{}, tor=results.tornado||{}, rain=results.rain||{};

  const inp = (label, content) => (
    <div style={{ marginBottom:8 }}>
      <div style={{ fontSize:9, color:'#64748b', textTransform:'uppercase', letterSpacing:1, marginBottom:3 }}>{label}</div>
      {content}
    </div>
  );

  const iStyle = { width:'100%', background:'#1e293b', border:'1px solid #334155', borderRadius:4, padding:'5px 8px', color:'#e2e8f0', fontSize:11, fontFamily:'inherit', boxSizing:'border-box' };
  const tabBtn = (mode, label) => (
    <button key={mode} onClick={()=>setLocMode(mode)}
      style={{ flex:1, padding:'5px 0', background:locMode===mode?'#0369a1':'#1e293b', color:locMode===mode?'#fff':'#64748b', border:'none', borderRadius:0, cursor:'pointer', fontSize:10, fontFamily:'inherit', fontWeight:locMode===mode?700:400 }}>
      {label}
    </button>
  );

  return (
    <div style={{ fontSize:11, color:'#e2e8f0' }}>

      {/* Send-to-Wind banner */}
      {allDone && w.windSpeed!=null && (
        <div style={{ marginBottom:10, padding:'8px 10px', background: sent?'#052e16':'#0c2040', border:`1px solid ${sent?'#166534':'#1e4d7b'}`, borderRadius:6, display:'flex', alignItems:'center', justifyContent:'space-between', gap:8, flexWrap:'wrap' }}>
          <div style={{ fontSize:10 }}>
            <span style={{ fontWeight:700, color:'#7dd3fc' }}>V = {Math.round(w.windSpeed)} mph</span>
            <span style={{ color:'#475569', margin:'0 4px' }}>·</span>
            <span style={{ color:'#cbd5e1' }}>RC {riskCategory}</span>
            <span style={{ color:'#475569', margin:'0 4px' }}>·</span>
            <span style={{ color:'#cbd5e1' }}>ASCE 7-{standard}</span>
            {w.isHurricane && <span style={{ marginLeft:8, color:'#fbbf24' }}>⚠ Hurricane Region</span>}
            {w.isSpecialWind && <span style={{ marginLeft:8, color:'#fbbf24' }}>⚠ Special Wind Region</span>}
          </div>
          <span style={{ fontSize:10, color:'#4ade80', fontWeight:700 }}>✓ Auto-sent to Wind Inputs</span>
          <button onClick={handleDownloadPDF}
            style={{ padding:'4px 10px', background:'#1e293b', color:'#7dd3fc', border:'1px solid #334155', borderRadius:4, cursor:'pointer', fontSize:10, fontWeight:700, fontFamily:'inherit', whiteSpace:'nowrap' }}>
            ↓ PDF Report
          </button>
        </div>
      )}

      {/* Location mode tabs */}
      <div style={{ display:'flex', borderRadius:4, overflow:'hidden', border:'1px solid #334155', marginBottom:8 }}>
        {[['address','Address'],['latlon','Lat / Lon'],['map','Map']].map(([m,l])=>tabBtn(m,l))}
      </div>

      {locMode==='address' && inp('Street Address',
        <WssAutocomplete value={address} onChange={setAddress} onSelect={({lat:lt,lon:ln,displayName})=>{ setAddress(displayName); setLat(String(lt)); setLon(String(ln)); setSyncLoc({lat:lt,lon:ln,displayName}); }} />
      )}
      {locMode==='latlon' && (
        <div style={{ display:'flex', gap:6, marginBottom:8 }}>
          {inp('Latitude', <input style={iStyle} placeholder="32.7767" value={lat} onChange={e=>setLat(e.target.value)} />)}
          {inp('Longitude', <input style={iStyle} placeholder="-96.7970" value={lon} onChange={e=>setLon(e.target.value)} />)}
        </div>
      )}
      {locMode==='map' && inp('', <WssMapPicker syncLocation={syncLoc} onLocationSelect={({lat:lt,lon:ln,displayName})=>{ setLat(String(lt)); setLon(String(ln)); setAddress(displayName); setSyncLoc({lat:lt,lon:ln,displayName}); }} />)}

      <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:6, marginBottom:8 }}>
        {inp('ASCE Standard',
          <select style={iStyle} value={standard} onChange={e=>{ setStandard(e.target.value); setSiteClass('D'); }}>
            {WSS_STDS.map(s=><option key={s} value={s}>ASCE 7-{s}</option>)}
          </select>
        )}
        {inp('Risk Category',
          <select style={iStyle} value={riskCategory} onChange={e=>setRiskCategory(e.target.value)}>
            {WSS_RCS.map(rc=><option key={rc} value={rc}>RC {rc}</option>)}
          </select>
        )}
      </div>
      {inp('Site Soil Class',
        <select style={iStyle} value={siteClass} onChange={e=>setSiteClass(e.target.value)}>
          {siteClasses.map(sc=><option key={sc} value={sc}>{sc}</option>)}
        </select>
      )}

      {globalErr && <div style={{ padding:'6px 8px', background:'#450a0a', border:'1px solid #991b1b', borderRadius:4, color:'#fca5a5', fontSize:10, marginBottom:8 }}>{globalErr}</div>}

      <button onClick={handleRun} disabled={running}
        style={{ width:'100%', padding:'8px 0', background:running?'#1e293b':'#0369a1', color:running?'#64748b':'#fff', border:'none', borderRadius:4, cursor:running?'default':'pointer', fontWeight:700, fontSize:11, fontFamily:'inherit', marginBottom:12 }}>
        {running?'Running…':'Run Hazard Lookup'}
      </button>

      {/* Results */}
      {hasResults && (
        <div>
          {resolvedAddr && (
            <div style={{ marginBottom:8, padding:'6px 8px', background:'#0f172a', border:'1px solid #1e293b', borderRadius:4, fontSize:10, color:'#64748b' }}>
              📍 {resolvedAddr}
              {siteElevFt!=null && <span style={{ marginLeft:8, color:'#475569' }}>⛰ {Math.round(siteElevFt).toLocaleString()} ft NAVD88</span>}
            </div>
          )}

          <WssCard title="Wind" icon="🌬" status={statuses.wind||'idle'}>
            {w.error?<div style={{color:'#fca5a5'}}>{w.error}</div>:<>
              <WssRow label="V (mph)" value={w.windSpeed?`${WssFmt(w.windSpeed,0)} mph`:'N/A'} highlight />
              <WssRow label="Hurricane-Prone Region" value={w.isHurricane?'⚠ YES':'No'} />
              <WssRow label="Special Wind Region" value={w.isSpecialWind?'⚠ YES — Verify AHJ':'No'} />
            </>}
          </WssCard>

          <WssCard title="Seismic" icon="🌍" status={statuses.seismic||'idle'}>
            {s.error?<div style={{color:'#fca5a5'}}>{s.error}</div>:<>
              <WssRow label="Ss (0.2 sec)" value={WssFmt(s.ss)} highlight />
              <WssRow label="S1 (1.0 sec)" value={WssFmt(s.s1)} highlight />
              <WssRow label="SDS" value={WssFmt(s.sds)} />
              <WssRow label="SD1" value={WssFmt(s.sd1)} />
              <WssRow label="SDC" value={s.sdc??'N/A'} />
              <WssRow label="Fa / Fv" value={s.fa!=null&&s.fv!=null?`${WssFmt(s.fa)} / ${WssFmt(s.fv)}`:standard==='7-22'?'N/A (multi-period)':'N/A'} />
              <WssRow label="TL (sec)" value={WssFmt(s.tl,1)} />
            </>}
          </WssCard>

          <WssCard title="Snow" icon="❄" status={statuses.snow||'idle'}>
            {sn.error?<div style={{color:'#fca5a5'}}>{sn.error}</div>:<>
              <WssRow label="Ground Snow Load (pg)" value={sn.groundSnowLoad!=null?`${Math.round(sn.groundSnowLoad)} psf`:'N/A'} highlight />
              {sn.siteElevFt!=null&&<WssRow label="Site Elevation" value={`${Math.round(sn.siteElevFt).toLocaleString()} ft`} />}
              {sn.elevationTable&&(
                <div style={{ marginTop:6, fontSize:9 }}>
                  <div style={{ color:'#64748b', marginBottom:3 }}>* Elevation-dependent pg:</div>
                  <table style={{ width:'100%', borderCollapse:'collapse' }}>
                    <thead><tr><th style={{ textAlign:'left', color:'#64748b', padding:'2px 4px' }}>Up to Elev (ft)</th><th style={{ textAlign:'right', color:'#64748b', padding:'2px 4px' }}>pg (psf)</th></tr></thead>
                    <tbody>{sn.elevationTable.map((row,i)=><tr key={i}><td style={{ padding:'2px 4px', color:'#94a3b8' }}>{row.elevation.toLocaleString()}</td><td style={{ textAlign:'right', padding:'2px 4px', color:'#cbd5e1' }}>{WssFmt(row.load,1)}</td></tr>)}</tbody>
                  </table>
                </div>
              )}
              <WssRow label="Winter Wind" value={sn.winterWind??'N/A'} />
              <WssRow label="Special Case" value={sn.specialCase?'⚠ Site study required':'No'} />
            </>}
          </WssCard>

          <WssCard title="Ice" icon="🧊" status={statuses.ice||'idle'}>
            {ic.error?<div style={{color:'#fca5a5'}}>{ic.error}</div>:<>
              <WssRow label="Radial Ice Thickness" value={ic.iceThickness!=null?`${WssFmt(ic.iceThickness,3)} in`:'N/A'} highlight />
              <WssRow label="Concurrent Temp" value={ic.concurrentTemp!=null?`${ic.concurrentTemp} °F`:'N/A'} />
              <WssRow label="Concurrent Gust" value={ic.concurrentGust!=null?`${WssFmt(ic.concurrentGust,1)} mph`:'N/A'} />
            </>}
          </WssCard>

          <WssCard title="Flood" icon="🌊" status={statuses.flood||'idle'}>
            {fl.error?<div style={{color:'#fca5a5'}}>{fl.error}</div>:<>
              <WssRow label="FEMA Flood Zone" value={fl.floodZone??'N/A'} highlight />
              <WssRow label="SFHA" value={fl.sfha?'⚠ YES':'No'} />
              <WssRow label="BFE" value={fl.bfe!=null?`${fl.bfe} ft (${fl.datum})`:'N/A'} />
              <WssRow label="Zone Subtype" value={fl.subtype??'N/A'} />
            </>}
          </WssCard>

          <WssCard title="Tsunami" icon="🌊" status={statuses.tsunami||'idle'}>
            {ts.error?<div style={{color:'#fca5a5'}}>{ts.error}</div>
              :!ts.applicable?<div style={{color:'#64748b',fontSize:10}}>{ts.message}</div>:<>
              <WssRow label="In Tsunami Design Zone" value={ts.inTDZ?'⚠ YES':'No'} highlight />
              <WssRow label="Runup (MHW)" value={ts.runupMHW!=null?`${WssFmt(ts.runupMHW,2)} ft`:'N/A'} />
              <WssRow label="Runup (NAVD88)" value={ts.runupNAVD!=null?`${WssFmt(ts.runupNAVD,2)} ft`:'N/A'} />
            </>}
          </WssCard>

          <WssCard title="Tornado" icon="🌪" status={statuses.tornado||'idle'}>
            {tor.error?<div style={{color:'#fca5a5'}}>{tor.error}</div>
              :!tor.applicable?<div style={{color:'#64748b',fontSize:10}}>{tor.message}</div>:<>
              <WssRow label="In Tornado-Prone Area" value={tor.inPronArea?'⚠ YES':'No'} highlight />
              {Object.entries(tor.speeds||{}).map(([rp,v])=><WssRow key={rp} label={rp.replace('RP','').replace('K',',000').replace('M',',000,000')+'-yr MRI'} value={v!=null?`${WssFmt(v,0)} mph`:'N/A'} />)}
            </>}
          </WssCard>

          <WssCard title="Rain (NOAA Atlas 14)" icon="🌧" status={statuses.rain||'idle'}>
            {rain.error?<div style={{color:'#fca5a5'}}>{rain.error}</div>
              :rain.table?<WssRainCard rain={rain} />:<div style={{color:'#64748b'}}>No data</div>}
          </WssCard>

          <button onClick={handleDownloadPDF}
            style={{ width:'100%', padding:'7px 0', background:'#0f172a', color:'#7dd3fc', border:'1px solid #1e3a5f', borderRadius:4, cursor:'pointer', fontSize:11, fontWeight:700, fontFamily:'inherit', marginBottom:8 }}>
            ↓ Download PDF Report
          </button>
          <div style={{ padding:'8px 0', fontSize:9, color:'#334155', textAlign:'center' }}>
            Data: USGS · ASCE GIS · FEMA NFHL · NOAA Atlas 14 — Verify before use in design.
          </div>
        </div>
      )}
    </div>
  );
}

// ─── ROOT APP ────────────────────────────────────────────────────────────────
export default function WindSuiteApp() {
  const [sideTab, setSideTab] = useState('wss');
  const [wssData, setWssData] = useState(null);

  function handleWssResult(data) {
    setWssData(data);
    // Stay on WSS tab so user can see results; values populate Wind Inputs silently
  }

  return (
    <WindCalcInputs
      wssData={wssData}
      sideTab={sideTab}
      onSideTab={setSideTab}
      onWssResult={handleWssResult}
    />
  );
}
