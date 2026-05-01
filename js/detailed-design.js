/**
 * Detailed-design extensions for the radial fan sizing tool.
 *
 *   1. lossModel()         - 1D Strömungs-Verlustmodell mit Aufteilung in
 *                            Reibungs-, Diffusions-, Inzidenz- und
 *                            Volutenverlust + parasitärer Radseitenreibung
 *                            und Spaltverlust.  Liefert einen ausgerechneten
 *                            Wirkungsgrad als Ersatz für die empirische
 *                            Schätzung in fan-design.js.
 *
 *   2. rotorStrength()     - Festigkeitsnachweis Laufrad (rotierende
 *                            Scheibe mit zentrischer Bohrung, freier
 *                            Außenrand) + Schaufel-Fliehkraftspannung
 *                            mit Sicherheitsfaktor gegen Streckgrenze
 *                            bei Betriebstemperatur.
 *
 *   3. criticalSpeed()     - 1. biegekritische Drehzahl (Jeffcott-Modell:
 *                            zwei Lager, Welle als Biegebalken, Laufrad
 *                            als konzentrierte Masse mittig).
 *
 *   4. voluteGeometry()    - Spiralgehäuse nach Stepanoff/Pfleiderer mit
 *                            konstanter mittlerer Volutengeschwindigkeit;
 *                            8 Querschnitte alle 45°.
 *
 * Quellen:
 *   - Pfleiderer C., "Die Kreiselpumpen", Springer, 1961
 *   - Stepanoff A.J., "Centrifugal and Axial Flow Pumps", Wiley, 1957
 *   - Aungier R.H., "Centrifugal Compressors", ASME Press, 2000
 *     (loss correlations)
 *   - Whitfield/Baines, "Design of Radial Turbomachines", Longman
 *   - DIN EN 13445 (rotierende Scheibe), AD 2000 W 13
 *   - Gasch/Knothe/Liebich, "Strukturdynamik", Springer
 *   - FKM-Richtlinie, 7. Aufl. (Sicherheitsfaktoren)
 *
 * Alles in SI-Einheiten.
 */

// =====================================================================
// 1) 1D LOSS MODEL
// =====================================================================
//
// Total head loss in a centrifugal stage decomposes into:
//   ψ_loss,int = ψ_skin + ψ_diff + ψ_inc + ψ_volute
// plus parasitic shaft-power losses:
//   P_disk    (Radseitenreibung)
//   P_leak    (Spaltverlust am Saugauge)
//
// Each component is normalised by ψ_th = u2^2 / 2 so that
//   η_hyd = (ψ_th_real) / (ψ_th + ψ_loss,int)
// and the overall:
//   η_total = η_hyd · η_disk · η_leak · η_mech
// with η_mech ≈ 0.985 (bearings + seal).
//
function lossModel(r) {
  const a = r.aerodynamics;
  const g = r.geometry;
  const rho = r.state.rho_kg_m3;
  const omega = r.state.omega_rad_s;
  const D2 = g.D2_m, D1 = g.D1_m, b2 = g.b2_m;
  const u2 = a.u2_m_s;
  const psi_th = a.psi;                    // installed pressure coefficient

  // ---- (a) skin friction in the impeller channel ---------------------
  // Reynolds number based on hydraulic diameter and mean relative speed
  const w_avg = 0.5 * (a.w2_m_s + Math.hypot(a.cm1_m_s, a.u1_m_s));
  const D_h   = 2 * b2;                     // approx hydraulic diameter
  // Kinematic viscosity, T-corrected: nu = 1.5e-5 * (T/293)^1.7 @ 1 atm
  const T_K = (r.inputs.tempC || 20) + 273.15;
  const nu  = 1.5e-5 * Math.pow(T_K / 293.15, 1.7) * (101325 / (r.inputs.pressurePa || 101325));
  const Re  = w_avg * D_h / nu;
  // Blasius-like turbulent friction
  const cf  = Math.max(0.004, 0.046 * Math.pow(Math.max(1e4, Re), -0.2));
  // Channel length along the blade mean line
  const beta_avg = (g.beta1_calc_deg + g.beta2_deg) / 2 * Math.PI / 180;
  const L_blade  = (D2 - D1) / (2 * Math.sin(Math.max(0.2, beta_avg)));
  const psi_skin = cf * (L_blade / D_h) * Math.pow(w_avg / u2, 2);

  // ---- (b) diffusion / De Haller criterion ---------------------------
  // Healthy impeller: w2 / w1 >= 0.72.  Below that, separation losses.
  const w1 = Math.hypot(a.cm1_m_s, a.u1_m_s);
  const dh = a.w2_m_s / w1;
  const psi_diff = dh < 0.72 ? 1.5 * Math.pow(0.72 - dh, 2) : 0.02;

  // ---- (c) incidence loss --------------------------------------------
  // At design point ~ 0; off-design quadratic. Assume design point here:
  const psi_inc = 0.005;

  // ---- (d) volute / diffuser loss (Pfleiderer) -----------------------
  // ζ_vol ~ 0.15 (c2/u2)^2 for well-matched volute
  const psi_volute = 0.18 * Math.pow(a.c2_m_s / u2, 2);

  // ---- (e) disk friction (Daily & Nece) ------------------------------
  // P_df = K_df · ρ · ω³ · (D2/2)^5
  const Re_d  = u2 * (D2 / 2) / nu;
  const Kdf   = 0.102 / Math.pow(Math.max(1e5, Re_d), 0.2);  // Daily-Nece IV
  const P_df  = Kdf * rho * Math.pow(omega, 3) * Math.pow(D2 / 2, 5);

  // ---- (f) leakage at the shroud / seal gap --------------------------
  // Tip clearance ~ 0.001 + 0.0008 D2 m  (typical industrial fan)
  const s_gap = 0.001 + 0.0008 * D2;
  const A_lk  = Math.PI * D1 * s_gap;       // suction-eye seal area
  const dp    = r.inputs.dp;                 // total pressure rise (Pa)
  const c_lk  = 0.65 * Math.sqrt(2 * dp / rho); // discharge coeff 0.65
  const Q_lk  = A_lk * c_lk;
  const Q     = r.inputs.Q;                  // m³/s
  const P_lk  = Q_lk * dp;
  const eta_leak = Q / (Q + Q_lk);

  // ---- (g) total ------------------------------------------------------
  const psi_loss_int = psi_skin + psi_diff + psi_inc + psi_volute;
  const eta_hyd  = psi_th / (psi_th + psi_loss_int);
  const P_hyd    = Q * dp;
  const P_int    = P_hyd / eta_hyd;
  const eta_disk = P_int / (P_int + P_df);
  const eta_mech = 0.985;
  const eta_tot  = eta_hyd * eta_disk * eta_leak * eta_mech;
  const P_shaft  = P_hyd / eta_tot;

  return {
    Re_channel: Re, Re_disk: Re_d, cf,
    deHaller: dh,
    psi: { psi_th, skin: psi_skin, diff: psi_diff, inc: psi_inc, volute: psi_volute },
    eta: { hyd: eta_hyd, disk: eta_disk, leak: eta_leak, mech: eta_mech, total: eta_tot },
    parasitic: { P_diskFriction_W: P_df, P_leakage_W: P_lk, Q_leakage_m3s: Q_lk, gap_m: s_gap },
    P_shaft_W: P_shaft,
    P_motor_W: P_shaft * 1.15,
  };
}

// =====================================================================
// 2) ROTOR STRENGTH (rotating disk + blade pull)
// =====================================================================
//
// Thin rotating disk with a central bore (R_i), free outer edge (R_o):
//
//   σ_θ(r) = ((3+ν)/8) ρ ω²  · ( R_o² + R_i² + R_i² R_o² / r²
//                                - ((1+3ν)/(3+ν)) r² )
//
// Maximum tangential stress is at the inner bore r = R_i:
//   σ_θ,max = ((3+ν)/4) ρ ω²  · ( R_o² + ((1-ν)/(3+ν)) R_i² )
//
// For the impeller blades (radially attached strips):
//   σ_blade ≈ ρ_m ω² (R_o² - R_i²) / 2
//
// Combined Mises stress at the disk bore:
//   σ_v = sqrt( σ_θ² + σ_blade²  + thermal² )    (uniaxial dominant)
//
// Allowed stress (FKM, AD 2000 W 13): σ_perm = R_p0.2(T) / SF
// with SF ≥ 1.5 for ductile steels in industrial fan duty.
//
function rotorStrength(r, materialKey) {
  const m = window.MATERIALS[materialKey];
  if (!m) return null;
  const omega = r.state.omega_rad_s;
  const rho_m = m.density;
  const nu    = m.poisson;
  const R_o   = r.geometry.D2_m / 2;
  // Inner bore: take 30 % of D1 as a conservative shaft hole radius
  // (real impellers have a hub; this gives the worst-case stress at
  // the bore of a one-piece welded disk).
  const R_i   = 0.30 * r.geometry.D1_m / 2;

  const k = (3 + nu) / 8;
  // Disk tangential stress at inner bore
  const sigma_theta_max =
    (3 + nu) / 4 * rho_m * omega * omega *
    (R_o * R_o + ((1 - nu) / (3 + nu)) * R_i * R_i);   // N/m²

  // Disk radial stress: zero at bore (free), peaks inside
  const sigma_radial_peak =
    (3 + nu) / 8 * rho_m * omega * omega *
    Math.pow(R_o - R_i, 2) / 2;

  // Blade root pull (centrifugal force on blade strip of length R_o-R_i)
  const sigma_blade = rho_m * omega * omega *
    (R_o * R_o - R_i * R_i) / 2;

  // Thermal stress: simplified ΔT = 30 K across radius
  const dT_radial = 30;
  const sigma_thermal = m.E_modulus * m.alpha * dT_radial / (1 - nu) / 4;

  // Combined: tangential + blade pull + thermal (all roughly tensile)
  const sigma_max = sigma_theta_max + 0.5 * sigma_blade + sigma_thermal;
  const sigma_max_MPa = sigma_max / 1e6;

  // Yield at temperature
  const Rp02_T_MPa = window.yieldAtTemperature(materialKey, r.inputs.tempC);
  const SF = Rp02_T_MPa / sigma_max_MPa;
  const required_SF = 1.5;

  return {
    R_i_m: R_i, R_o_m: R_o,
    sigma_theta_max_MPa: sigma_theta_max / 1e6,
    sigma_radial_peak_MPa: sigma_radial_peak / 1e6,
    sigma_blade_MPa: sigma_blade / 1e6,
    sigma_thermal_MPa: sigma_thermal / 1e6,
    sigma_max_MPa,
    Rp02_T_MPa,
    safetyFactor: SF,
    requiredSF: required_SF,
    pass: SF >= required_SF,
  };
}

// =====================================================================
// 3) CRITICAL SPEED (1st lateral natural frequency, Jeffcott rotor)
// =====================================================================
//
// Shaft sized from torque (T = P / ω):
//   d_shaft = ( 16 T / (π τ_perm SF_T) )^(1/3)
// with τ_perm = 80 N/mm² for general-purpose shaft steel and SF_T = 2.
//
// Bearing span L ≈ 1.6 D2 (typical between-bearing arrangement).
//
// Stiffness of a simply-supported beam with central load:
//   k = 48 E I / L³,   I = π d⁴ / 64
//
// Impeller mass approximated as a solid disk D2 × b2 plus 30 %
// allowance for blades and shrouds:
//   m_imp = 1.3 · ρ_m · π R_o² · b2
//
// First lateral natural frequency:
//   ω_n = √(k/m),    n_crit = 60 ω_n / (2π)
//
function criticalSpeed(r, materialKey) {
  const m = window.MATERIALS[materialKey];
  if (!m) return null;
  const omega = r.state.omega_rad_s;
  const P = r.power.P_shaft_W;

  // ---- shaft sizing -------------------------------------------------
  // Pure torsion gives a lower bound; real fan shafts also resist
  // bending from impeller weight and gas-flow side load, so they end
  // up considerably larger.  Common empirical rule for industrial
  // process fans:  d_shaft ≈ 0.06..0.08 · D2.
  const T_torque = P / Math.max(omega, 1);
  const tau_perm = 80e6;
  const SF_T = 2.5;
  const d_torque = Math.pow(16 * T_torque * SF_T / (Math.PI * tau_perm), 1 / 3);
  const d_geom   = 0.07 * r.geometry.D2_m;     // empirical minimum
  const d_shaft  = Math.max(d_torque, d_geom);
  // round up to nearest 10 mm
  const d_round  = Math.ceil(d_shaft * 100) / 100;

  // ---- impeller mass (realistic, not solid cylinder) ----------------
  // Two cover plates of thickness t_d ≈ 0.012 · D2 plus Z blades of
  // thickness t_b ≈ 0.005 · D2 spanning R_o − R_i_blade.  Hub, bolts,
  // shrouding, fillets add ~ 40 %.
  const R_o    = r.geometry.D2_m / 2;
  const R_b_in = r.geometry.D1_m / 2;          // blade root radius
  const b2     = r.geometry.b2_m;
  const t_disk = 0.012 * r.geometry.D2_m;
  const t_blade = 0.005 * r.geometry.D2_m;
  const m_disks  = 2 * Math.PI * R_o * R_o * t_disk * m.density;
  const m_blades = r.geometry.Z * b2 *
                   Math.max(0, R_o - R_b_in) * t_blade * m.density;
  const m_imp = 1.4 * (m_disks + m_blades);

  // ---- bearing layout ----------------------------------------------
  // Between-bearings configuration with the impeller closer to one
  // bearing.  Effective span for the simply-supported / Jeffcott
  // approximation:  L_span ≈ 0.7 · D2.
  const L_span = 0.7 * r.geometry.D2_m;
  const E = m.E_modulus;
  const I = Math.PI * Math.pow(d_round, 4) / 64;
  const k_beam = 48 * E * I / Math.pow(L_span, 3);

  const omega_n = Math.sqrt(k_beam / Math.max(m_imp, 1));
  const n_crit_rpm = 60 * omega_n / (2 * Math.PI);
  const n_op_rpm = r.inputs.n_rpm;
  const ratio = n_op_rpm / n_crit_rpm;

  // Subkritisch: ratio ≤ 0.85 (typical for fans).
  // Bereich 0.85..1.15 ist kritisch und zu meiden.
  let regime = 'subkritisch (sicher)';
  if (ratio > 1.15) regime = 'überkritisch (zu vermeiden bei Lüftern)';
  else if (ratio > 0.85) regime = 'KRITISCHER BEREICH (0.85..1.15 n_crit)';

  return {
    d_shaft_m: d_round,
    L_span_m: L_span,
    impellerMass_kg: m_imp,
    shaftStiffness_N_m: k_beam,
    n_crit_rpm,
    n_op_rpm,
    ratio,
    regime,
    pass: ratio < 0.85,
  };
}

// =====================================================================
// 4) VOLUTE GEOMETRY (Stepanoff)
// =====================================================================
//
// Constant mean velocity in the volute:
//   c_3 = K · u2,   K ≈ 0.5..0.55 for backward-curved fans
//
// Cross-sectional area at azimuth φ:
//   A(φ) = (φ / 360°) · Q / c_3
//
// Volute width usually 1.5..2.0 · b2.
// Tongue clearance from D2: 0.04..0.08 · D2 (Stepanoff: 5 %).
//
function voluteGeometry(r) {
  const u2 = r.aerodynamics.u2_m_s;
  const c3 = 0.50 * u2;
  const Q  = r.inputs.Q;
  const D2 = r.geometry.D2_m;
  const b2 = r.geometry.b2_m;
  const b_v = 1.6 * b2;  // volute width
  const sections = [];
  for (let phi = 45; phi <= 360; phi += 45) {
    const A = (phi / 360) * Q / c3;
    // rectangular cross-section, growing radially outward from D2/2
    const r_outer = D2 / 2 + A / b_v;
    sections.push({
      phi_deg: phi,
      A_m2: A,
      r_outer_m: r_outer,
    });
  }
  return {
    c_volute_m_s: c3,
    width_b_v_m: b_v,
    tongueClearance_m: 0.05 * D2,
    sections,
  };
}

// =====================================================================
// PUBLIC ENTRY POINT
// =====================================================================
function detailedAnalysis(result, materialKey) {
  return {
    losses:   lossModel(result),
    strength: rotorStrength(result, materialKey),
    rotorDyn: criticalSpeed(result, materialKey),
    volute:   voluteGeometry(result),
  };
}

window.DetailedDesign = {
  lossModel,
  rotorStrength,
  criticalSpeed,
  voluteGeometry,
  detailedAnalysis,
};
