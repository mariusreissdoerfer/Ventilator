/**
 * Radial Fan Design Engine for Cement Industry Applications
 *
 * Implements aerodynamic and geometric sizing of single-stage centrifugal
 * (radial) fans following the classical turbomachinery framework:
 *
 *   - Euler turbomachine equation                (Euler 1754)
 *   - Cordier diagram for dimensionless sizing   (Cordier 1953)
 *   - Slip factor according to Wiesner (1967) or Stodola (1924)
 *   - Pressure / flow coefficients (psi, phi)
 *   - Empirical blade-number relation (Pfleiderer)
 *
 * All calculations are done in SI units internally:
 *   Volume flow Q  [m^3/s]
 *   Pressure   dp  [Pa]
 *   Density    rho [kg/m^3]
 *   Speed      n   [1/s]   (the UI uses rpm and converts)
 *   Diameter   D   [m]
 *   Power      P   [W]
 *
 * References:
 *   Bommes/Fricke/Grundmann, "Ventilatoren", Vulkan-Verlag, 2003
 *   Eck, B., "Ventilatoren", 5. Aufl., Springer
 *   Bohl/Elmendorf, "Stroemungsmaschinen 2", Vogel
 *   Cordier, O., "Aehnlichkeitsbedingungen fuer Stroemungsmaschinen",
 *     BWK Bd. 5, 1953
 *   Wiesner, F.J., "A Review of Slip Factors for Centrifugal Impellers",
 *     ASME J. Eng. Power, 1967
 *   ISO 5801 - Industrial fans, performance testing
 *   VDI 3731 Bl. 2 - Emissionskennwerte technischer Schallquellen
 */

const PHYS = {
  R_AIR: 287.058,        // J/(kg K) specific gas constant of dry air
  G: 9.80665,            // m/s^2
  P0: 101325,            // Pa, standard atmosphere
  T0: 293.15,            // K = 20 degC, reference for fan ratings (ISO 5801)
  RHO0: 1.2,             // kg/m^3, standard fan inlet density
};

/**
 * Compute gas density from inlet conditions for a dust-laden cement-process
 * gas. Treats the gas as an ideal gas; for moist gas a mean R can be passed.
 */
function inletDensity({ tempC, pressurePa = PHYS.P0, rGas = PHYS.R_AIR, dustLoading_g_m3 = 0 }) {
  const T = tempC + 273.15;
  const rhoGas = pressurePa / (rGas * T);
  // Two-phase suspension density: rho_mix ~ rho_gas + c_dust (kg/m^3)
  const rhoDust = (dustLoading_g_m3 || 0) / 1000.0;
  return rhoGas + rhoDust;
}

/**
 * Convert a fan duty given at site conditions to the standard ISO duty.
 * The fan develops a pressure proportional to density, so for selection
 * we work with site density directly; this helper is informational.
 */
function densityCorrection(rhoSite) {
  return PHYS.RHO0 / rhoSite;  // multiplier on rated dp_iso to get dp_site
}

/**
 * Cordier diagram (empirical mean curve) for high-efficiency single-stage
 * radial machines. Returns the optimum specific diameter delta for a given
 * specific speed sigma. Definitions (dimensionless, Marcinowski form):
 *
 *   sigma = 2*omega * sqrt(Q) / (2*Y)^(3/4)
 *   delta = D2 * (2*Y)^(1/4) / sqrt(Q)
 *
 * with omega = 2 pi n, Y = dp_t / rho (specific work, J/kg).
 *
 * Here we use a piecewise log-log fit through canonical Cordier points
 * for centrifugal machines (sigma 0.1 ... 1.5).
 */
function cordierDelta(sigma) {
  // anchor points (sigma, delta) on Cordier mean curve, radial range
  const pts = [
    [0.10, 12.0],
    [0.15,  8.5],
    [0.20,  6.4],
    [0.30,  4.6],
    [0.45,  3.4],
    [0.60,  2.7],
    [0.80,  2.25],
    [1.00,  2.00],
    [1.30,  1.78],
    [1.60,  1.62],
    [2.00,  1.50],
  ];
  const x = Math.log(Math.max(0.05, Math.min(2.5, sigma)));
  for (let i = 0; i < pts.length - 1; i++) {
    const x1 = Math.log(pts[i][0]);
    const x2 = Math.log(pts[i + 1][0]);
    if (x >= x1 && x <= x2) {
      const y1 = Math.log(pts[i][1]);
      const y2 = Math.log(pts[i + 1][1]);
      const t = (x - x1) / (x2 - x1);
      return Math.exp(y1 + t * (y2 - y1));
    }
  }
  return Math.exp(Math.log(pts[pts.length - 1][1]));
}

/**
 * Recommended blade type as a function of specific speed sigma.
 * Boundaries follow Eck/Bommes:
 *   sigma < 0.25  -> radial straight (paddle), high pressure, low eta
 *   0.25..0.45    -> radial / forward-curved transition
 *   0.45..0.85    -> backward-curved (highest efficiency for cement gas)
 *   > 0.85        -> mixed flow (radial fan boundary)
 */
function recommendBladeType(sigma) {
  if (sigma < 0.25) return 'radial-straight';
  if (sigma < 0.45) return 'radial-curved';
  if (sigma < 0.85) return 'backward-curved';
  return 'backward-curved-airfoil';
}

const BLADE_TYPE_LABEL = {
  'radial-straight': 'Radial gerade Schaufeln (Paddelrad)',
  'radial-curved': 'Radial / vorwaerts gekruemmt',
  'backward-curved': 'Rueckwaerts gekruemmt',
  'backward-curved-airfoil': 'Rueckwaerts gekruemmt, Profilschaufel',
  'forward-curved': 'Vorwaerts gekruemmt (Trommellaeufer)',
};

/**
 * Default outlet blade angle beta2 (vs. tangential direction) in deg
 * by blade type. Smaller beta2 means more backward sweep.
 */
function defaultBeta2(bladeType) {
  switch (bladeType) {
    case 'radial-straight': return 90;
    case 'radial-curved':   return 75;
    case 'backward-curved': return 35;
    case 'backward-curved-airfoil': return 28;
    case 'forward-curved':  return 135;
    default: return 35;
  }
}

/**
 * Slip factor according to Wiesner (1967), valid for Z >= 4 and beta2 in deg.
 *   sigma_s = 1 - sqrt(sin(beta2)) / Z^0.7
 *
 * Stodola (1924) alternative:
 *   sigma_s = 1 - (pi * sin(beta2)) / Z
 */
function slipFactor(beta2_deg, z, model = 'wiesner') {
  const beta = beta2_deg * Math.PI / 180;
  if (model === 'stodola') {
    return Math.max(0.4, 1 - Math.PI * Math.sin(beta) / Math.max(3, z));
  }
  return Math.max(0.4, 1 - Math.sqrt(Math.sin(beta)) / Math.pow(Math.max(3, z), 0.7));
}

/**
 * Number of blades: Pfleiderer empirical relation
 *   Z ~ 6.5 * (D2 + D1) / (D2 - D1) * sin( (beta1 + beta2)/2 )
 * Rounded to nearest even integer (common manufacturing practice on
 * cement plant fans to avoid odd resonances).
 */
function bladeNumber(D1, D2, beta1_deg, beta2_deg) {
  const ratio = (D2 + D1) / Math.max(1e-6, (D2 - D1));
  const meanAngle = (beta1_deg + beta2_deg) / 2 * Math.PI / 180;
  const z = 6.5 * ratio * Math.sin(meanAngle);
  // clamp 6 .. 16 -> typical for industrial radial fans
  const zClamped = Math.max(6, Math.min(16, Math.round(z)));
  return zClamped % 2 === 0 ? zClamped : zClamped + 1;
}

/**
 * Heuristic for total fan efficiency by blade type and dust loading.
 * Cement applications lose 2..6 percentage points to the clean-gas
 * laboratory value because of dust, wear plates and tip clearance.
 */
function expectedEfficiency(bladeType, dustLoading_g_m3) {
  const base = {
    'radial-straight': 0.62,
    'radial-curved':   0.70,
    'backward-curved': 0.83,
    'backward-curved-airfoil': 0.86,
    'forward-curved':  0.66,
  }[bladeType] ?? 0.78;
  // Dust loading penalty: typical cement raw gas 30..80 g/m^3
  const dustPenalty = Math.min(0.08, (dustLoading_g_m3 || 0) / 1000);
  return Math.max(0.45, base - dustPenalty);
}

/**
 * Maximum allowable tip speed u2 [m/s] for the chosen wheel material.
 * Conservative values from manufacturer catalogues (TLT, Howden, Venti
 * Oelde, Reitz). Above these speeds an FEM verification is mandatory.
 */
const TIP_SPEED_LIMIT = {
  'S235JR':       110,
  'S355J2':       145,
  '16Mo3':        135,   // boiler steel, hot service
  'Hardox450':    160,   // wear-resistant
  'Hardox500':    150,
  '1.4571':       150,   // 316Ti stainless
  'Inconel625':   170,
};

/**
 * Choose a base wheel material from gas temperature, dust load and
 * recommended tip speed. Wear plates are added on top in materials.js.
 */
function recommendWheelMaterial({ tempC, dustLoading_g_m3, requiredU2 }) {
  // Pick smallest acceptable material that has a tip-speed limit covering
  // requiredU2 with reasonable margin. The limits table is the source of
  // truth: stay >= 5 m/s below catalog limit so the warning only fires
  // when even an upgrade would be needed.
  const margin = 5;
  if (tempC > 400) return 'Inconel625';
  if (tempC > 300) return '16Mo3';
  if (dustLoading_g_m3 > 30) {
    // Verschleissbestaendiger Stahl noetig
    return requiredU2 > TIP_SPEED_LIMIT['Hardox500'] - margin
      ? 'Hardox450'
      : 'Hardox500';
  }
  if (requiredU2 > TIP_SPEED_LIMIT['S235JR'] - margin) return 'S355J2';
  return 'S235JR';
}

/**
 * Main sizing routine.
 *
 * Inputs (object):
 *   Q_m3h          - volume flow at fan inlet [m^3/h]
 *   dp_total_Pa    - total pressure rise [Pa]
 *   tempC          - gas temperature at fan inlet [degC]
 *   pressurePa     - ambient absolute pressure [Pa]   (default 101325)
 *   rGas           - specific gas constant [J/(kg K)] (default air)
 *   dustLoading    - dust load at inlet [g/m^3]
 *   n_rpm          - shaft speed [1/min]
 *   bladeType      - 'radial-straight' | 'backward-curved' | ... | 'auto'
 *   slipModel      - 'wiesner' | 'stodola'
 *
 * Returns a result object with all geometry, performance and material data.
 */
function sizeFan(inp) {
  // ---- 1) Process state ------------------------------------------------
  const Q = inp.Q_m3h / 3600;                                  // m^3/s
  const dp = inp.dp_total_Pa;                                  // Pa
  const rho = inletDensity({
    tempC: inp.tempC,
    pressurePa: inp.pressurePa ?? PHYS.P0,
    rGas: inp.rGas ?? PHYS.R_AIR,
    dustLoading_g_m3: inp.dustLoading ?? 0,
  });
  const Y = dp / rho;                                          // J/kg
  const omega = 2 * Math.PI * (inp.n_rpm / 60);                // rad/s
  const n = inp.n_rpm / 60;                                    // 1/s

  // ---- 2) Dimensionless similarity (Cordier) --------------------------
  // sigma = omega * sqrt(Q) / (2 Y)^(3/4)
  const sigma = omega * Math.sqrt(Q) / Math.pow(2 * Y, 0.75);
  const delta = cordierDelta(sigma);
  // Recommended outer diameter from Cordier
  const D2_cordier = delta * Math.sqrt(Q) / Math.pow(2 * Y, 0.25);

  // ---- 3) Blade type -------------------------------------------------
  const bladeType = (inp.bladeType && inp.bladeType !== 'auto')
    ? inp.bladeType
    : recommendBladeType(sigma);
  const beta2 = inp.beta2_deg ?? defaultBeta2(bladeType);
  const beta1 = inp.beta1_deg ?? 22;   // typical inlet angle

  // ---- 4) Pressure coefficient psi for chosen blade type --------------
  // Empirical from Bommes/Eck for clean operating point
  const PSI = {
    'radial-straight': 1.05,
    'radial-curved':   1.00,
    'backward-curved': 0.85,
    'backward-curved-airfoil': 0.80,
    'forward-curved':  1.50,
  }[bladeType] ?? 0.85;

  // psi = 2 dp / (rho u2^2)  =>  u2 = sqrt(2 dp / (rho psi))
  const u2 = Math.sqrt(2 * dp / (rho * PSI));

  // ---- 5) Outer diameter ---------------------------------------------
  // u2 = pi * D2 * n  =>  D2 = u2 / (pi n)
  const D2 = u2 / (Math.PI * n);

  // ---- 6) Inlet eye geometry -----------------------------------------
  // Optimum hub/tip ratio for radial fan ~ 0.55..0.65 (Bommes)
  const D1_over_D2 = 0.62;
  const D1 = D1_over_D2 * D2;
  const u1 = Math.PI * D1 * n;

  // ---- 7) Number of blades & slip ------------------------------------
  const Z = inp.Z ?? bladeNumber(D1, D2, beta1, beta2);
  const slip = slipFactor(beta2, Z, inp.slipModel || 'wiesner');

  // ---- 8) Velocity triangle at outlet --------------------------------
  // Ideal whirl with infinite blades:
  //   cu2_inf = u2 - cm2 / tan(beta2)
  // Real whirl:
  //   cu2 = slip * cu2_inf      (zero pre-swirl)
  // From Euler: dp = rho * eta_h * u2 * cu2
  //
  // Choose cm2/u2 ~ 0.25..0.30 (typical for radial fans, Bommes)
  const cm2_over_u2 = 0.27;
  const cm2 = cm2_over_u2 * u2;
  const cu2_inf = u2 - cm2 / Math.tan(beta2 * Math.PI / 180);
  const cu2 = slip * cu2_inf;
  const c2 = Math.sqrt(cu2 * cu2 + cm2 * cm2);
  const w2 = Math.sqrt(cm2 * cm2 + Math.pow(u2 - cu2, 2));

  // ---- 9) Outlet width b2 from continuity ----------------------------
  // Q = pi * D2 * b2 * cm2 * tau   ; tau = blade blockage 0.92..0.96
  const tau = 0.94;
  const b2 = Q / (Math.PI * D2 * cm2 * tau);

  // ---- 10) Inlet vane angle beta1 from velocity triangle -------------
  // Assume axial inlet (no pre-swirl): cu1 = 0  ->  tan(beta1) = cm1/u1
  // Continuity: Q = pi/4 * D1^2 * cm1   (eye)
  const cm1 = 4 * Q / (Math.PI * D1 * D1);
  const beta1_calc = Math.atan2(cm1, u1) * 180 / Math.PI;

  // ---- 11) Power & efficiency ----------------------------------------
  const eta = inp.eta_total ?? expectedEfficiency(bladeType, inp.dustLoading);
  const P_hyd = Q * dp;            // useful gas power
  const P_shaft = P_hyd / eta;     // mechanical shaft power
  // Service factor for cement plant duty (variable load, dust)
  const serviceFactor = 1.15;
  const P_motor = P_shaft * serviceFactor;

  // ---- 12) Material recommendation -----------------------------------
  const wheelMaterial = recommendWheelMaterial({
    tempC: inp.tempC,
    dustLoading_g_m3: inp.dustLoading || 0,
    requiredU2: u2,
  });
  const u2_limit = TIP_SPEED_LIMIT[wheelMaterial];
  const tipSpeedOK = u2 <= u2_limit;

  // ---- 13) Approximate sound power level (VDI 3731) ------------------
  // L_W ~ K + 10 lg(Q/Q0) + 20 lg(dp/dp0); K ~ 5 dB(A) for radial fans
  const Lw = 5 + 10 * Math.log10(Q / 1.0) + 20 * Math.log10(dp / 1.0);

  // ---- 14) Performance curve points ----------------------------------
  // Parabolic approximation: dp(Q) = dp0 - k * Q^2 for backward-curved,
  // with a rising part for forward/radial. We use:
  //   dp(q) = dp_design * ( a + b * q - c * q^2 )    q = Q/Q_design
  const curve = [];
  const isForward = bladeType.startsWith('forward') || bladeType === 'radial-straight';
  for (let q = 0.2; q <= 1.5; q += 0.05) {
    let factor;
    if (isForward) {
      factor = 1.0 + 0.18 * (q - 1) - 0.55 * Math.pow(q - 1, 2);
    } else {
      // backward / radial-curved : monotonically falling
      factor = 1.18 - 0.28 * q - 0.42 * q * q + 0.52 * q * (1 - q);
    }
    const power = (q * Q) * (factor * dp) / eta;
    curve.push({
      q_rel: q,
      Q_m3h: q * Q * 3600,
      dp_Pa: factor * dp,
      P_W: power,
    });
  }

  return {
    inputs: { ...inp, Q, dp, rho, Y, n },
    state: {
      rho_kg_m3: rho,
      Y_J_kg: Y,
      omega_rad_s: omega,
      sigma, delta,
    },
    geometry: {
      D2_m: D2,
      D2_cordier_m: D2_cordier,
      D1_m: D1,
      b2_m: b2,
      Z,
      beta1_deg: beta1,
      beta1_calc_deg: beta1_calc,
      beta2_deg: beta2,
      tau_blockage: tau,
    },
    aerodynamics: {
      bladeType,
      bladeTypeLabel: BLADE_TYPE_LABEL[bladeType],
      psi: PSI,
      phi: Q / (Math.PI / 4 * D2 * D2 * u2),
      u1_m_s: u1,
      u2_m_s: u2,
      cm1_m_s: cm1,
      cm2_m_s: cm2,
      cu2_inf_m_s: cu2_inf,
      cu2_m_s: cu2,
      c2_m_s: c2,
      w2_m_s: w2,
      slipFactor: slip,
      eta_total: eta,
    },
    power: {
      P_hydraulic_W: P_hyd,
      P_shaft_W: P_shaft,
      P_motor_W: P_motor,
      serviceFactor,
    },
    materials: {
      wheelMaterial,
      tipSpeedLimit_m_s: u2_limit,
      tipSpeedOK,
    },
    acoustics: {
      Lw_dBA: Lw,
    },
    curve,
  };
}

// expose to global scope for the browser app (no module bundler required)
window.FanDesign = {
  PHYS,
  inletDensity,
  densityCorrection,
  sizeFan,
  cordierDelta,
  slipFactor,
  bladeNumber,
  recommendBladeType,
  defaultBeta2,
  recommendWheelMaterial,
  TIP_SPEED_LIMIT,
  BLADE_TYPE_LABEL,
};
