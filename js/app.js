/**
 * UI controller for the radial-fan design app. Talks to:
 *   FanDesign        (window.FanDesign)
 *   CEMENT_PRESETS   (window.CEMENT_PRESETS)
 *   MATERIALS        (window.MATERIALS)
 *   WEAR_PROTECTION  (window.WEAR_PROTECTION)
 *   recommendWearProtection
 */

const $ = (id) => document.getElementById(id);

// ---------- preset handling ----------
function fillPresetSelect() {
  const sel = $('preset');
  CEMENT_PRESETS.forEach((p) => {
    const opt = document.createElement('option');
    opt.value = p.id;
    opt.textContent = p.name;
    sel.appendChild(opt);
  });
  sel.value = 'kiln-id';
  applyPreset('kiln-id');
}

function applyPreset(id) {
  const p = CEMENT_PRESETS.find((x) => x.id === id);
  if (!p) return;
  $('preset-desc').textContent = p.description;
  $('Q').value = p.Q_m3h;
  $('dp').value = p.dp_total_Pa;
  $('T').value = p.tempC;
  $('p').value = p.pressurePa;
  $('dust').value = p.dustLoading;
  $('n').value = p.n_rpm;
  $('bladeType').value = p.bladeType;
  if ($('arrangement')) $('arrangement').value = p.arrangement || 'SISW';
}

// ---------- formatting helpers ----------
const fmt = (v, digits = 2) =>
  (Math.abs(v) >= 1000 ? v.toFixed(0) : v.toFixed(digits))
    .replace(/\B(?=(\d{3})+(?!\d))/g, " ");
const fmtMm = (m) => fmt(m * 1000, 0) + ' mm';
const fmtKw = (w) => fmt(w / 1000, 1) + ' kW';

// ---------- run ----------
function runCalc() {
  const inp = {
    Q_m3h: +$('Q').value,
    dp_total_Pa: +$('dp').value,
    tempC: +$('T').value,
    pressurePa: +$('p').value,
    dustLoading: +$('dust').value,
    n_rpm: +$('n').value,
    bladeType: $('bladeType').value,
    slipModel: $('slipModel').value,
    arrangement: $('arrangement') ? $('arrangement').value : 'SISW',
  };
  let res;
  try {
    res = FanDesign.sizeFan(inp);
  } catch (e) {
    $('summary').innerHTML = `<div class="kpi bad"><div class="label">Fehler</div><div class="value">${e.message}</div></div>`;
    return;
  }
  // run detailed-design analysis (loss model + strength + rotor + volute)
  const det = DetailedDesign.detailedAnalysis(res, res.materials.wheelMaterial);
  // The calculated efficiency from the loss model overrides the empirical
  // guess so the summary, power and curve all use a single consistent value.
  res.aerodynamics.eta_total = det.losses.eta.total;
  res.power.P_shaft_W = det.losses.P_shaft_W;
  res.power.P_motor_W = det.losses.P_motor_W;

  // run engineering-grade verification (multi-DOF rotor FEM, sigma(r),
  // off-design map). Not 3D-CFD/FEM but the classical equivalents.
  const ver = CFD_FEM.verification(res, det);

  renderSummary(res);
  renderGeometry(res);
  renderVelocityTriangle(res);
  renderCurve(res);
  renderLosses(res, det.losses);
  renderStrength(res, det.strength);
  renderRotor(res, det.rotorDyn);
  renderVolute(res, det.volute);
  renderRotorFEM(res, ver.rotorFEM);
  renderDiskProfile(res, ver.diskProfile, det.strength);
  renderOffDesign(res, ver.offDesign);
  renderFlowField(res);
  renderStressField(ver.diskProfile);
  if (window.ThreeModel) window.ThreeModel.update(res);
  renderMaterials(res);
  renderNotes(res, det, ver);
}

// ---------- summary KPIs ----------
function renderSummary(r) {
  const el = $('summary');
  const tip = r.materials.tipSpeedOK ? 'good' : 'bad';
  el.innerHTML = `
    <div class="kpi"><div class="label">Spez. Drehzahl &sigma;</div>
      <div class="value">${fmt(r.state.sigma, 3)}</div></div>
    <div class="kpi"><div class="label">Spez. Durchmesser &delta;</div>
      <div class="value">${fmt(r.state.delta, 2)}</div></div>
    <div class="kpi"><div class="label">Laufrad-Aussen &empty;D2</div>
      <div class="value">${fmtMm(r.geometry.D2_m)}</div></div>
    <div class="kpi ${tip}"><div class="label">Umfangsgeschwindigkeit u2</div>
      <div class="value">${fmt(r.aerodynamics.u2_m_s, 1)}<span class="unit">m/s</span></div></div>
    <div class="kpi"><div class="label">Schaufelzahl Z</div>
      <div class="value">${r.geometry.Z}</div></div>
    <div class="kpi"><div class="label">Wirkungsgrad &eta;</div>
      <div class="value">${fmt(r.aerodynamics.eta_total * 100, 1)}<span class="unit">%</span></div></div>
    <div class="kpi"><div class="label">Hydraulische Leistung</div>
      <div class="value">${fmtKw(r.power.P_hydraulic_W)}</div></div>
    <div class="kpi"><div class="label">Wellenleistung</div>
      <div class="value">${fmtKw(r.power.P_shaft_W)}</div></div>
    <div class="kpi"><div class="label">Empf. Motor</div>
      <div class="value">${fmtKw(r.power.P_motor_W)}</div></div>
    <div class="kpi"><div class="label">Schallleistung Lw</div>
      <div class="value">${fmt(r.acoustics.Lw_dBA, 0)}<span class="unit">dB(A)</span></div></div>
  `;
}

// ---------- geometry table + sketch ----------
function renderGeometry(r) {
  const isDIDW = r.geometry.arrangement === 'DIDW';
  const arrLabel = isDIDW ? 'Doppelflutig (DIDW)' : 'Einflutig (SISW)';
  const b2Label = isDIDW ? 'Schaufelbreite b2 (pro Saugseite)' : 'Schaufelaustrittsbreite b2';
  const zLabel = isDIDW ? 'Schaufelzahl Z (pro Seite / gesamt)' : 'Schaufelzahl Z';
  const zVal = isDIDW ? `${r.geometry.Z} / ${r.geometry.Z_total}` : `${r.geometry.Z}`;
  const axialRow = isDIDW
    ? `<tr><th>Axiale Laufradbreite (gesamt)</th><td>${fmtMm(r.geometry.axialExtent_m)}</td></tr>`
    : '';
  $('geom-table').innerHTML = `
    <table class="data">
      <tr><th>Bauart</th><td>${arrLabel}</td></tr>
      <tr><th>Schaufelform</th><td>${r.aerodynamics.bladeTypeLabel}</td></tr>
      <tr><th>Aussendurchmesser D2</th><td>${fmtMm(r.geometry.D2_m)}</td></tr>
      <tr><th>Saugaugen-&empty; D1</th><td>${fmtMm(r.geometry.D1_m)}</td></tr>
      <tr><th>${b2Label}</th><td>${fmtMm(r.geometry.b2_m)}</td></tr>
      ${axialRow}
      <tr><th>Eintrittswinkel &beta;1</th><td>${fmt(r.geometry.beta1_calc_deg, 1)}&deg;</td></tr>
      <tr><th>Austrittswinkel &beta;2</th><td>${fmt(r.geometry.beta2_deg, 1)}&deg;</td></tr>
      <tr><th>${zLabel}</th><td>${zVal}</td></tr>
      <tr><th>Druckziffer &psi;</th><td>${fmt(r.aerodynamics.psi, 2)}</td></tr>
      <tr><th>Lieferziffer &phi;</th><td>${fmt(r.aerodynamics.phi, 3)}</td></tr>
      <tr><th>Slip-Faktor</th><td>${fmt(r.aerodynamics.slipFactor, 3)}</td></tr>
      <tr><th>Gasdichte am Eintritt</th><td>${fmt(r.state.rho_kg_m3, 3)} kg/m&sup3;</td></tr>
    </table>
  `;
  drawImpeller(r);
}

function drawImpeller(r) {
  const svg = $('geom-svg');
  // viewBox -180..180 -> 360 wide. Map D2 -> 280 px (radius 140)
  const R2 = 140;
  const R1 = R2 * (r.geometry.D1_m / r.geometry.D2_m);
  const Z = r.geometry.Z;
  const beta2 = r.geometry.beta2_deg;
  const beta1 = Math.max(15, Math.min(60, r.geometry.beta1_calc_deg));

  // Build a logarithmic-spiral-ish blade: radius from R1 to R2
  // with local angle = beta2 at outside, beta1 at inside.
  // Simple parametric: r(t) = R1 + t*(R2-R1), theta(t) = -tan-equivalent
  function bladePath(angleOffsetDeg) {
    let d = '';
    const N = 24;
    let theta = 0;
    let prev_r = R1;
    for (let i = 0; i <= N; i++) {
      const t = i / N;
      const radius = R1 + t * (R2 - R1);
      // local blade angle interpolates beta1 -> beta2
      const beta = (beta1 + (beta2 - beta1) * t) * Math.PI / 180;
      const dr = radius - prev_r;
      // d(theta) = dr / (r * tan(beta))   (geometric construction of a vane)
      if (i > 0 && Math.tan(beta) > 1e-3) {
        theta += dr / (prev_r * Math.tan(beta));
      }
      prev_r = radius;
      const a = (angleOffsetDeg * Math.PI / 180) - theta;
      const x = radius * Math.cos(a);
      const y = radius * Math.sin(a);
      d += (i === 0 ? 'M' : 'L') + x.toFixed(2) + ',' + y.toFixed(2);
    }
    return d;
  }

  let blades = '';
  for (let i = 0; i < Z; i++) {
    blades += `<path class="svg-blade" d="${bladePath((360 / Z) * i)}"/>`;
  }
  // Forward-curved fans turn the blade the other way
  if (r.aerodynamics.bladeType === 'forward-curved') {
    blades = `<g transform="scale(1,-1)">${blades}</g>`;
  }
  svg.innerHTML = `
    <circle class="svg-impeller-fill" cx="0" cy="0" r="${R2}" />
    <circle class="svg-impeller" cx="0" cy="0" r="${R2}" />
    <circle class="svg-impeller" cx="0" cy="0" r="${R1}" />
    ${blades}
    <circle cx="0" cy="0" r="6" fill="#333"/>
    <text class="svg-label" x="${R2 + 4}" y="-4">D2 = ${fmtMm(r.geometry.D2_m)}</text>
    <text class="svg-label" x="${R1 + 4}" y="${R1 + 14}">D1</text>
    <text class="svg-label" x="${-R2}" y="${R2 + 16}">Z = ${Z} Schaufeln, &beta;2 = ${fmt(beta2, 0)}&deg;</text>
  `;
}

// ---------- velocity triangle ----------
function renderVelocityTriangle(r) {
  // Map u2 m/s -> 250 px (longest vector)
  const a = r.aerodynamics;
  const SCALE = 250 / Math.max(a.u2_m_s, a.c2_m_s);
  const ox = 20, oy = 150;

  const u2x = a.u2_m_s * SCALE;
  const cu2x = a.cu2_m_s * SCALE;
  const cm2y = a.cm2_m_s * SCALE;

  // u2: tangential (point base at origin, tip to the right)
  // c2: starts at origin, ends at (cu2, -cm2)
  // w2: starts at origin, ends at (cu2 - u2, -cm2) -> goes left & up
  const cTipX = ox + cu2x;
  const cTipY = oy - cm2y;
  const uTipX = ox + u2x;
  const uTipY = oy;

  function arrow(x1, y1, x2, y2, cls) {
    const len = Math.hypot(x2 - x1, y2 - y1);
    if (len < 1) return '';
    const ux = (x2 - x1) / len, uy = (y2 - y1) / len;
    const hx = x2 - 8 * ux, hy = y2 - 8 * uy;
    const px = -uy * 4, py = ux * 4;
    return `
      <line class="svg-vector ${cls}" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"/>
      <polygon class="svg-vector ${cls}" fill="currentColor" points="${x2},${y2} ${hx + px},${hy + py} ${hx - px},${hy - py}" stroke="none"/>
    `;
  }

  $('vt-svg').innerHTML = `
    <line class="svg-axis" x1="${ox}" y1="${oy}" x2="${ox + 280}" y2="${oy}"/>
    <line class="svg-axis" x1="${ox}" y1="${oy}" x2="${ox}" y2="${oy - 140}"/>
    ${arrow(ox, oy, uTipX, uTipY, 'u')}
    ${arrow(ox, oy, cTipX, cTipY, 'c')}
    ${arrow(uTipX, uTipY, cTipX, cTipY, 'w')}
    <text class="svg-label" x="${ox + u2x / 2}" y="${oy + 14}">u2 = ${fmt(a.u2_m_s, 1)} m/s</text>
    <text class="svg-label" x="${cTipX + 6}" y="${cTipY - 4}">c2 = ${fmt(a.c2_m_s, 1)} m/s</text>
    <text class="svg-label" x="${(uTipX + cTipX) / 2 + 6}" y="${(uTipY + cTipY) / 2}">w2 = ${fmt(a.w2_m_s, 1)} m/s</text>
  `;
  $('vt-table').innerHTML = `
    <table class="data">
      <tr><th>Umfangsgeschw. u2</th><td>${fmt(a.u2_m_s, 1)} m/s</td></tr>
      <tr><th>Meridiankomp. cm2</th><td>${fmt(a.cm2_m_s, 1)} m/s</td></tr>
      <tr><th>Drallkomp. cu2 (mit Slip)</th><td>${fmt(a.cu2_m_s, 1)} m/s</td></tr>
      <tr><th>Absolutgeschw. c2</th><td>${fmt(a.c2_m_s, 1)} m/s</td></tr>
      <tr><th>Relativgeschw. w2</th><td>${fmt(a.w2_m_s, 1)} m/s</td></tr>
      <tr><th>Slip-Faktor (${$('slipModel').value})</th><td>${fmt(a.slipFactor, 3)}</td></tr>
    </table>
  `;
}

// ---------- characteristic curve ----------
function renderCurve(r) {
  const W = 600, H = 320;
  const padL = 60, padR = 50, padT = 20, padB = 40;
  const xmin = 0;
  const xmax = Math.max(...r.curve.map((p) => p.Q_m3h)) * 1.05;
  const ymax = Math.max(...r.curve.map((p) => p.dp_Pa)) * 1.05;
  const pmax = Math.max(...r.curve.map((p) => p.P_W)) * 1.10;
  const X = (q) => padL + (q - xmin) / (xmax - xmin) * (W - padL - padR);
  const Y = (p) => H - padB - p / ymax * (H - padT - padB);
  const Yp = (pw) => H - padB - pw / pmax * (H - padT - padB);

  let pathDp = '', pathP = '';
  r.curve.forEach((pt, i) => {
    pathDp += (i ? 'L' : 'M') + X(pt.Q_m3h).toFixed(1) + ',' + Y(pt.dp_Pa).toFixed(1);
    pathP  += (i ? 'L' : 'M') + X(pt.Q_m3h).toFixed(1) + ',' + Yp(pt.P_W).toFixed(1);
  });

  // y-axis ticks (dp)
  let ticks = '';
  for (let i = 0; i <= 5; i++) {
    const y = padT + i * (H - padT - padB) / 5;
    const v = ymax * (1 - i / 5);
    ticks += `<line class="svg-grid" x1="${padL}" y1="${y}" x2="${W - padR}" y2="${y}"/>`;
    ticks += `<text class="svg-label" x="${padL - 6}" y="${y + 3}" text-anchor="end">${fmt(v, 0)}</text>`;
    const vp = pmax * (1 - i / 5);
    ticks += `<text class="svg-label" x="${W - padR + 6}" y="${y + 3}">${fmt(vp / 1000, 0)}</text>`;
  }
  // x-axis ticks
  for (let i = 0; i <= 5; i++) {
    const x = padL + i * (W - padL - padR) / 5;
    const v = xmax * i / 5;
    ticks += `<line class="svg-grid" x1="${x}" y1="${padT}" x2="${x}" y2="${H - padB}"/>`;
    ticks += `<text class="svg-label" x="${x}" y="${H - padB + 14}" text-anchor="middle">${fmt(v, 0)}</text>`;
  }

  // Operating point
  const Qd = r.inputs.Q_m3h;
  const dpd = r.inputs.dp_total_Pa;
  const opMarker = `<circle cx="${X(Qd)}" cy="${Y(dpd)}" r="5" fill="#c75b12" />
                    <text class="svg-label" x="${X(Qd) + 8}" y="${Y(dpd) - 8}">Auslegungspunkt</text>`;

  $('curve-svg').innerHTML = `
    ${ticks}
    <line class="svg-axis" x1="${padL}" y1="${padT}" x2="${padL}" y2="${H - padB}"/>
    <line class="svg-axis" x1="${padL}" y1="${H - padB}" x2="${W - padR}" y2="${H - padB}"/>
    <line class="svg-axis" x1="${W - padR}" y1="${padT}" x2="${W - padR}" y2="${H - padB}"/>
    <path class="svg-curve" d="${pathDp}"/>
    <path class="svg-curve-2" d="${pathP}"/>
    ${opMarker}
    <text class="svg-label" x="${padL - 40}" y="${padT + 6}">&Delta;p [Pa]</text>
    <text class="svg-label" x="${W - padR + 8}" y="${padT + 6}">P [kW]</text>
    <text class="svg-label" x="${(W) / 2}" y="${H - 6}" text-anchor="middle">Q [m&sup3;/h]</text>
  `;
}

// ---------- losses ----------
function renderLosses(r, L) {
  const eta = L.eta;
  $('losses-summary').innerHTML = `
    <div class="kpi"><div class="label">&eta;<sub>hyd</sub></div>
      <div class="value">${fmt(eta.hyd * 100, 1)}<span class="unit">%</span></div></div>
    <div class="kpi"><div class="label">&eta;<sub>Radseite</sub></div>
      <div class="value">${fmt(eta.disk * 100, 1)}<span class="unit">%</span></div></div>
    <div class="kpi"><div class="label">&eta;<sub>Spalt</sub></div>
      <div class="value">${fmt(eta.leak * 100, 2)}<span class="unit">%</span></div></div>
    <div class="kpi"><div class="label">&eta;<sub>mech</sub></div>
      <div class="value">${fmt(eta.mech * 100, 1)}<span class="unit">%</span></div></div>
    <div class="kpi good"><div class="label">&eta;<sub>total</sub></div>
      <div class="value">${fmt(eta.total * 100, 1)}<span class="unit">%</span></div></div>
    <div class="kpi"><div class="label">de-Haller w2/w1</div>
      <div class="value">${fmt(L.deHaller, 2)}</div></div>
  `;

  // stacked horizontal bar of psi components
  const total_psi = L.psi.psi_th + L.psi.skin + L.psi.diff + L.psi.inc + L.psi.volute;
  const segs = [
    { v: L.psi.psi_th,  c: '#1c5d99', label: 'ψ Nutz' },
    { v: L.psi.skin,    c: '#c75b12', label: 'Reibung' },
    { v: L.psi.diff,    c: '#e08530', label: 'Diffusion' },
    { v: L.psi.inc,     c: '#a07050', label: 'Inzidenz' },
    { v: L.psi.volute,  c: '#7a8b3a', label: 'Volute' },
  ];
  const W = 580, H = 36;
  let x = 10;
  let bars = '', legend = '';
  segs.forEach((s, i) => {
    const w = (W - 20) * s.v / total_psi;
    bars += `<rect x="${x}" y="20" width="${w}" height="${H}" fill="${s.c}" />
             <text class="svg-label" x="${x + w/2}" y="${20 + H/2 + 4}" text-anchor="middle" fill="#fff">${fmt(s.v / total_psi * 100, 0)}%</text>`;
    x += w;
    legend += `<g transform="translate(${10 + i*120}, 80)">
                 <rect width="14" height="14" fill="${s.c}" />
                 <text class="svg-label" x="20" y="11">${s.label}</text>
               </g>`;
  });
  $('losses-svg').innerHTML = `
    <text class="svg-label" x="10" y="14">Druckziffer-Bilanz &psi;<sub>th</sub> + &Sigma;&psi;<sub>Verlust</sub> = ${fmt(total_psi,2)}</text>
    ${bars}
    ${legend}
  `;

  $('losses-table').innerHTML = `
    <table class="data">
      <tr><th>Re (Schaufelkanal)</th><td>${fmt(L.Re_channel/1000, 0)} &times; 10&sup3;</td></tr>
      <tr><th>Reibungsbeiwert c<sub>f</sub></th><td>${fmt(L.cf, 4)}</td></tr>
      <tr><th>de-Haller-Kriterium w2/w1</th><td>${fmt(L.deHaller, 3)} ${L.deHaller >= 0.72 ? '(OK)' : '(grenzwertig, &lt; 0.72)'}</td></tr>
      <tr><th>Spaltweite (Saugauge)</th><td>${fmt(L.parasitic.gap_m * 1000, 1)} mm</td></tr>
      <tr><th>Spaltverlust-Volumenstrom</th><td>${fmt(L.parasitic.Q_leakage_m3s * 3600, 0)} m&sup3;/h</td></tr>
      <tr><th>Radseitenreibung-Leistung</th><td>${fmtKw(L.parasitic.P_diskFriction_W)}</td></tr>
      <tr><th>Wellenleistung (mit Verlustmodell)</th><td>${fmtKw(L.P_shaft_W)}</td></tr>
    </table>
  `;
}

// ---------- strength ----------
function renderStrength(r, S) {
  if (!S) return;
  const cls = S.pass ? 'good' : 'bad';
  const txt = S.pass ? 'BESTANDEN' : 'NICHT BESTANDEN';
  $('strength-summary').innerHTML = `
    <div class="kpi ${cls}"><div class="label">Sicherheits-Faktor SF</div>
      <div class="value">${fmt(S.safetyFactor, 2)}</div></div>
    <div class="kpi"><div class="label">Erforderlich SF<sub>min</sub></div>
      <div class="value">${fmt(S.requiredSF, 2)}</div></div>
    <div class="kpi"><div class="label">&sigma;<sub>max</sub></div>
      <div class="value">${fmt(S.sigma_max_MPa, 0)}<span class="unit">N/mm&sup2;</span></div></div>
    <div class="kpi"><div class="label">R<sub>p0.2</sub>(T)</div>
      <div class="value">${fmt(S.Rp02_T_MPa, 0)}<span class="unit">N/mm&sup2;</span></div></div>
    <div class="kpi ${cls}"><div class="label">Nachweis</div>
      <div class="value">${txt}</div></div>
  `;
  $('strength-table').innerHTML = `
    <table class="data">
      <tr><th>Aussenradius R<sub>o</sub></th><td>${fmt(S.R_o_m * 1000, 0)} mm</td></tr>
      <tr><th>Innenradius (Bohrung) R<sub>i</sub></th><td>${fmt(S.R_i_m * 1000, 0)} mm</td></tr>
      <tr><th>Tangentialspannung &sigma;<sub>&theta;,max</sub></th><td>${fmt(S.sigma_theta_max_MPa, 0)} N/mm&sup2;</td></tr>
      <tr><th>Radialspannung &sigma;<sub>r,max</sub></th><td>${fmt(S.sigma_radial_peak_MPa, 0)} N/mm&sup2;</td></tr>
      <tr><th>Schaufel-Fliehkraftspannung</th><td>${fmt(S.sigma_blade_MPa, 0)} N/mm&sup2;</td></tr>
      <tr><th>Thermische Spannung (&Delta;T = 30 K)</th><td>${fmt(S.sigma_thermal_MPa, 0)} N/mm&sup2;</td></tr>
      <tr><th>Vergleichsspannung &sigma;<sub>v</sub></th><td>${fmt(S.sigma_max_MPa, 0)} N/mm&sup2;</td></tr>
      <tr><th>Streckgrenze bei T</th><td>${fmt(S.Rp02_T_MPa, 0)} N/mm&sup2;</td></tr>
    </table>
  `;
}

// ---------- rotor dynamics ----------
function renderRotor(r, R) {
  if (!R) return;
  const cls = R.pass ? 'good' : (R.ratio > 1.15 ? 'warn' : 'bad');
  $('rotor-summary').innerHTML = `
    <div class="kpi"><div class="label">Betriebsdrehzahl</div>
      <div class="value">${fmt(R.n_op_rpm, 0)}<span class="unit">1/min</span></div></div>
    <div class="kpi"><div class="label">n<sub>krit</sub> (1. biegekrit.)</div>
      <div class="value">${fmt(R.n_crit_rpm, 0)}<span class="unit">1/min</span></div></div>
    <div class="kpi ${cls}"><div class="label">n<sub>op</sub>/n<sub>krit</sub></div>
      <div class="value">${fmt(R.ratio, 2)}</div></div>
    <div class="kpi ${cls}"><div class="label">Lavalbereich</div>
      <div class="value" style="font-size:13px">${R.regime}</div></div>
  `;
  $('rotor-table').innerHTML = `
    <table class="data">
      <tr><th>Wellenmoment T</th><td>${fmt(r.power.P_shaft_W / r.state.omega_rad_s, 0)} Nm</td></tr>
      <tr><th>Wellendurchmesser d (gerundet)</th><td>${fmt(R.d_shaft_m * 1000, 0)} mm</td></tr>
      <tr><th>Lagerabstand L</th><td>${fmt(R.L_span_m * 1000, 0)} mm</td></tr>
      <tr><th>Laufrad-Masse</th><td>${fmt(R.impellerMass_kg, 0)} kg</td></tr>
      <tr><th>Wellensteifigkeit k</th><td>${fmt(R.shaftStiffness_N_m / 1e6, 1)} MN/m</td></tr>
    </table>
  `;
}

// ---------- volute ----------
function renderVolute(r, V) {
  if (!V) return;
  // Table
  let rows = '';
  V.sections.forEach((s) => {
    rows += `<tr>
      <td>${s.phi_deg}&deg;</td>
      <td>${fmt(s.A_m2, 3)} m&sup2;</td>
      <td>${fmt((s.r_outer_m - r.geometry.D2_m / 2) * 1000, 0)} mm</td>
      <td>${fmt(s.r_outer_m * 1000, 0)} mm</td>
    </tr>`;
  });
  $('volute-table').innerHTML = `
    <table class="data">
      <tr><th>Mittl. Geschw. c<sub>3</sub></th><td>${fmt(V.c_volute_m_s, 1)} m/s</td></tr>
      <tr><th>Volutenbreite b<sub>v</sub></th><td>${fmt(V.width_b_v_m * 1000, 0)} mm</td></tr>
      <tr><th>Zungenabstand</th><td>${fmt(V.tongueClearance_m * 1000, 0)} mm</td></tr>
    </table>
    <table class="data" style="margin-top:8px">
      <tr><th>&phi;</th><th>A(&phi;)</th><th>&Delta;r</th><th>r<sub>aussen</sub></th></tr>
      ${rows}
    </table>
  `;
  // SVG: spiral with 8 radial markers
  const R2 = 80;  // base scale
  const maxR = R2 + (V.sections[V.sections.length - 1].r_outer_m - r.geometry.D2_m / 2) /
                    (r.geometry.D2_m / 2) * R2;
  const scale = 130 / maxR;
  let spiral = '', markers = '';
  // build interpolated spiral path (every 5 deg, linear in A)
  let d = '';
  for (let phi = 0; phi <= 360; phi += 5) {
    const A_phi = (phi / 360) * r.inputs.Q / V.c_volute_m_s;
    const r_outer = (r.geometry.D2_m / 2 + A_phi / V.width_b_v_m);
    const radius = (r.geometry.D2_m / 2 + (r_outer - r.geometry.D2_m / 2)) * (R2 * 2 / r.geometry.D2_m);
    // simpler: scale to fit
    const rad = R2 + (r_outer - r.geometry.D2_m / 2) * (R2 / (r.geometry.D2_m / 2));
    const a = (phi - 90) * Math.PI / 180;
    const x = rad * Math.cos(a);
    const y = rad * Math.sin(a);
    d += (phi === 0 ? 'M' : 'L') + x.toFixed(1) + ',' + y.toFixed(1);
  }
  V.sections.forEach((s) => {
    const rad = R2 + (s.r_outer_m - r.geometry.D2_m / 2) * (R2 / (r.geometry.D2_m / 2));
    const a = (s.phi_deg - 90) * Math.PI / 180;
    const x = rad * Math.cos(a);
    const y = rad * Math.sin(a);
    markers += `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="3" fill="#c75b12" />
                <text class="svg-label" x="${(x*1.08).toFixed(1)}" y="${(y*1.08+3).toFixed(1)}" text-anchor="middle">${s.phi_deg}&deg;</text>`;
  });
  $('volute-svg').innerHTML = `
    <circle class="svg-impeller-fill" cx="0" cy="0" r="${R2}" />
    <circle class="svg-impeller" cx="0" cy="0" r="${R2}" />
    <path d="${d}" stroke="#1c5d99" stroke-width="2" fill="rgba(28,93,153,.06)"/>
    ${markers}
    <circle cx="0" cy="0" r="4" fill="#333"/>
    <text class="svg-label" x="${R2 + 4}" y="-${R2 - 4}">D2</text>
  `;
}

// ====================================================================
// VERIFICATION RENDERERS (multi-DOF rotor FEM / sigma(r) / off-design)
// ====================================================================

// ---------- generic SVG axis helper ----------
function svgAxes({ W, H, padL, padR, padT, padB, xMax, yMax, xLabel, yLabel, xTicks = 5, yTicks = 5, y2Max, y2Label }) {
  let s = '';
  for (let i = 0; i <= yTicks; i++) {
    const y = padT + i * (H - padT - padB) / yTicks;
    const v = yMax * (1 - i / yTicks);
    s += `<line class="svg-grid" x1="${padL}" y1="${y}" x2="${W - padR}" y2="${y}"/>`;
    s += `<text class="svg-label" x="${padL - 6}" y="${y + 3}" text-anchor="end">${fmt(v, 0)}</text>`;
    if (y2Max !== undefined) {
      const v2 = y2Max * (1 - i / yTicks);
      s += `<text class="svg-label" x="${W - padR + 6}" y="${y + 3}">${fmt(v2, 0)}</text>`;
    }
  }
  for (let i = 0; i <= xTicks; i++) {
    const x = padL + i * (W - padL - padR) / xTicks;
    const v = xMax * i / xTicks;
    s += `<line class="svg-grid" x1="${x}" y1="${padT}" x2="${x}" y2="${H - padB}"/>`;
    s += `<text class="svg-label" x="${x}" y="${H - padB + 14}" text-anchor="middle">${fmt(v, 0)}</text>`;
  }
  s += `<line class="svg-axis" x1="${padL}" y1="${padT}" x2="${padL}" y2="${H - padB}"/>`;
  s += `<line class="svg-axis" x1="${padL}" y1="${H - padB}" x2="${W - padR}" y2="${H - padB}"/>`;
  if (y2Max !== undefined) {
    s += `<line class="svg-axis" x1="${W - padR}" y1="${padT}" x2="${W - padR}" y2="${H - padB}"/>`;
    s += `<text class="svg-label" x="${W - padR + 8}" y="${padT - 4}">${y2Label}</text>`;
  }
  s += `<text class="svg-label" x="${padL - 40}" y="${padT - 4}">${yLabel}</text>`;
  s += `<text class="svg-label" x="${W / 2}" y="${H - 4}" text-anchor="middle">${xLabel}</text>`;
  return s;
}

// ---------- rotor FEM (Campbell) ----------
function renderRotorFEM(r, F) {
  if (!F) return;
  const rows = F.criticals.map((c, i) => {
    const margin = F.margins[i];
    const cls = margin.pass ? 'good' : 'bad';
    return `<div class="kpi ${cls}">
      <div class="label">${i + 1}. krit. Drehzahl</div>
      <div class="value">${fmt(c.n_crit_rpm, 0)}<span class="unit">1/min</span></div>
    </div>`;
  }).join('');
  const op_cls = F.pass ? 'good' : 'bad';
  $('rotorfem-summary').innerHTML = `
    <div class="kpi"><div class="label">Betriebsdrehzahl</div>
      <div class="value">${fmt(F.n_op, 0)}<span class="unit">1/min</span></div></div>
    ${rows}
    <div class="kpi ${op_cls}"><div class="label">Sicherheitsabstand &ge; 15 %</div>
      <div class="value">${F.pass ? 'EINGEHALTEN' : 'VERLETZT'}</div></div>
  `;

  // Campbell diagram: x = rotor speed [rpm], y = frequency [Hz]
  // Plot: 1x line (synchronous), 2x, blade-pass; horizontal lines for n_crit
  const W = 600, H = 320, padL = 60, padR = 30, padT = 20, padB = 40;
  const n_max = Math.max(F.n_op * 1.5, ...F.criticals.map(c => c.n_crit_rpm)) * 1.1;
  const f_max = Math.max(...F.criticals.map(c => c.f_Hz)) * 1.2;
  let svg = svgAxes({ W, H, padL, padR, padT, padB, xMax: n_max, yMax: f_max,
                      xLabel: 'n [1/min]', yLabel: 'f [Hz]' });

  // 1x and 2x synchronous lines
  const X = (n) => padL + (n / n_max) * (W - padL - padR);
  const Y = (f) => H - padB - (f / f_max) * (H - padT - padB);
  const f1 = (n) => n / 60;
  const f2 = (n) => 2 * n / 60;
  const Z = r.geometry.Z;
  const fz = (n) => Z * n / 60;

  svg += `<path class="svg-curve" d="M${X(0)},${Y(f1(0))} L${X(n_max)},${Y(f1(n_max))}"/>`;
  svg += `<text class="svg-label" x="${W - padR - 30}" y="${Y(f1(n_max)) - 4}">1x</text>`;
  svg += `<path stroke="#7a8b3a" stroke-width="1.5" fill="none" stroke-dasharray="3 3" d="M${X(0)},${Y(f2(0))} L${X(n_max)},${Y(Math.min(f_max, f2(n_max)))}"/>`;
  svg += `<text class="svg-label" x="${W - padR - 30}" y="${Y(Math.min(f_max, f2(n_max))) - 4}">2x</text>`;
  if (Z * f1(n_max) <= f_max) {
    svg += `<path stroke="#a0500a" stroke-width="1.5" fill="none" stroke-dasharray="2 4" d="M${X(0)},${Y(0)} L${X(n_max)},${Y(fz(n_max))}"/>`;
    svg += `<text class="svg-label" x="${W - padR - 30}" y="${Y(fz(n_max)) + 12}">Z·1x (Schaufelpass)</text>`;
  }

  // Critical-speed horizontals
  F.criticals.forEach((c, i) => {
    svg += `<line stroke="#b3261e" stroke-width="1.5" stroke-dasharray="6 3" x1="${padL}" y1="${Y(c.f_Hz)}" x2="${W - padR}" y2="${Y(c.f_Hz)}"/>`;
    svg += `<text class="svg-label" x="${padL + 6}" y="${Y(c.f_Hz) - 4}">f<sub>${i + 1}</sub> = ${fmt(c.f_Hz, 1)} Hz</text>`;
  });

  // Operating speed and ±15% band
  svg += `<rect x="${X(F.n_op * 0.85)}" y="${padT}" width="${X(F.n_op * 1.15) - X(F.n_op * 0.85)}" height="${H - padT - padB}" fill="rgba(28,93,153,.06)"/>`;
  svg += `<line stroke="#1c5d99" stroke-width="2" x1="${X(F.n_op)}" y1="${padT}" x2="${X(F.n_op)}" y2="${H - padB}"/>`;
  svg += `<text class="svg-label" x="${X(F.n_op) + 4}" y="${padT + 12}">n<sub>op</sub></text>`;
  $('campbell-svg').innerHTML = svg;

  // Mode-shape sketch: shaft length normalized to W, draw first mode
  const W2 = 600, H2 = 200;
  const shaft = `<line stroke="#888" stroke-width="2" x1="20" y1="${H2 / 2}" x2="${W2 - 20}" y2="${H2 / 2}"/>`;
  // Draw stations as triangles
  const stationMarks = F.rotor.stations.map((st) => {
    const x = 20 + (st.x / F.rotor.totalLength) * (W2 - 40);
    if (st.k > 0) {
      return `<polygon points="${x - 6},${H2 / 2 + 14} ${x + 6},${H2 / 2 + 14} ${x},${H2 / 2 + 4}" fill="#555"/>`;
    }
    if (st.m > 0) {
      return `<rect x="${x - 8}" y="${H2 / 2 - 12}" width="16" height="24" fill="#1c5d99"/>`;
    }
    return '';
  }).join('');
  // Mode shapes
  const colors = ['#c75b12', '#7a8b3a', '#1c5d99'];
  let modes = '';
  F.modeShapes.forEach((shape, idx) => {
    if (idx > 2) return;
    let d = '';
    shape.forEach((pt, i) => {
      const x = 20 + (pt.x / F.rotor.totalLength) * (W2 - 40);
      const y = H2 / 2 - pt.y * 60;
      d += (i ? 'L' : 'M') + x.toFixed(1) + ',' + y.toFixed(1);
    });
    modes += `<path stroke="${colors[idx]}" stroke-width="2" fill="none" d="${d}"/>`;
    modes += `<text class="svg-label" x="${W2 - 100}" y="${20 + idx * 14}" fill="${colors[idx]}">Mode ${idx + 1}: ${fmt(F.criticals[idx].n_crit_rpm, 0)} 1/min</text>`;
  });
  $('modeshape-svg').innerHTML = `${shaft}${stationMarks}${modes}`;

  $('modeshape-table').innerHTML = `
    <table class="data">
      <tr><th>Wellenlaenge</th><td>${fmt(F.rotor.totalLength * 1000, 0)} mm</td></tr>
      <tr><th>EI (Welle)</th><td>${fmt(F.rotor.EI / 1e6, 1)} kN m&sup2;</td></tr>
      <tr><th>Stationen (Lager / Massen)</th><td>${F.rotor.stations.length}</td></tr>
    </table>
  `;
}

// ---------- disk stress profile sigma(r) ----------
function renderDiskProfile(r, D, S1D) {
  if (!D) return;
  // KPIs
  const peak = D.peak;
  const SF = D.Rp02_T_MPa / peak.sigma_v_MPa;
  const cls = SF >= 1.5 ? 'good' : 'bad';
  $('diskprofile-summary').innerHTML = `
    <div class="kpi"><div class="label">&sigma;<sub>v</sub> Maximum</div>
      <div class="value">${fmt(peak.sigma_v_MPa, 0)}<span class="unit">N/mm&sup2;</span></div></div>
    <div class="kpi"><div class="label">Position r/R<sub>o</sub></div>
      <div class="value">${fmt(peak.r_m / D.R_o_m, 2)}</div></div>
    <div class="kpi"><div class="label">R<sub>p0.2</sub>(T)</div>
      <div class="value">${fmt(D.Rp02_T_MPa, 0)}<span class="unit">N/mm&sup2;</span></div></div>
    <div class="kpi ${cls}"><div class="label">SF (Verifikation)</div>
      <div class="value">${fmt(SF, 2)}</div></div>
  `;

  // Plot sigma_r, sigma_t, sigma_v vs. r/R_o
  const W = 600, H = 280, padL = 60, padR = 100, padT = 20, padB = 40;
  const ymax = Math.max(...D.points.map(p => Math.max(p.sigma_r_MPa, p.sigma_t_MPa, p.sigma_v_MPa))) * 1.1;
  let svg = svgAxes({ W, H, padL, padR, padT, padB, xMax: 1.0, yMax: ymax,
                      xLabel: '(r-R_i)/(R_o-R_i)', yLabel: 'σ [N/mm²]' });
  const X = (q) => padL + q * (W - padL - padR);
  const Y = (s) => H - padB - (s / ymax) * (H - padT - padB);

  function path(values, color, dash) {
    let d = '';
    D.points.forEach((p, i) => {
      d += (i ? 'L' : 'M') + X(p.r_norm).toFixed(1) + ',' + Y(values[i]).toFixed(1);
    });
    return `<path stroke="${color}" stroke-width="2" fill="none" ${dash ? 'stroke-dasharray="' + dash + '"' : ''} d="${d}"/>`;
  }
  svg += path(D.points.map(p => p.sigma_r_MPa), '#c75b12', '4 3');
  svg += path(D.points.map(p => p.sigma_t_MPa), '#1c5d99');
  svg += path(D.points.map(p => p.sigma_v_MPa), '#2e7d32');

  // Yield line
  const yY = Y(D.Rp02_T_MPa);
  if (yY > padT && yY < H - padB) {
    svg += `<line stroke="#b3261e" stroke-width="1.5" stroke-dasharray="6 3" x1="${padL}" y1="${yY}" x2="${W - padR}" y2="${yY}"/>
            <text class="svg-label" x="${W - padR - 80}" y="${yY - 4}" fill="#b3261e">R<sub>p0.2</sub>(T)</text>`;
  }
  // Allowable (Rp/SF)
  const allow = D.Rp02_T_MPa / 1.5;
  const yA = Y(allow);
  if (yA > padT && yA < H - padB) {
    svg += `<line stroke="#c25d00" stroke-width="1" stroke-dasharray="2 3" x1="${padL}" y1="${yA}" x2="${W - padR}" y2="${yA}"/>
            <text class="svg-label" x="${W - padR - 80}" y="${yA - 4}" fill="#c25d00">zul. (SF=1.5)</text>`;
  }
  // Legend
  svg += `<g transform="translate(${W - padR + 4}, ${padT + 20})">
            <line x1="0" y1="0" x2="20" y2="0" stroke="#1c5d99" stroke-width="2"/>
            <text class="svg-label" x="24" y="3">σ<tspan>θ</tspan></text>
            <line x1="0" y1="16" x2="20" y2="16" stroke="#c75b12" stroke-width="2" stroke-dasharray="4 3"/>
            <text class="svg-label" x="24" y="19">σ<tspan>r</tspan></text>
            <line x1="0" y1="32" x2="20" y2="32" stroke="#2e7d32" stroke-width="2"/>
            <text class="svg-label" x="24" y="35">σ<tspan>v</tspan> (Mises)</text>
          </g>`;
  $('diskprofile-svg').innerHTML = svg;
}

// ---------- off-design map ----------
function renderOffDesign(r, M) {
  if (!M) return;
  const cls = M.pass ? 'good' : 'warn';
  const surge = M.points[M.surgeIdx];
  const bep = M.points[M.bepIdx];
  $('offdesign-summary').innerHTML = `
    <div class="kpi ${cls}"><div class="label">Stall-Marge</div>
      <div class="value">${fmt(M.stallMargin_pct, 0)}<span class="unit">%</span></div></div>
    <div class="kpi"><div class="label">Surge bei Q</div>
      <div class="value">${fmt(surge.Q_m3h, 0)}<span class="unit">m&sup3;/h</span></div></div>
    <div class="kpi"><div class="label">BEP bei Q</div>
      <div class="value">${fmt(bep.Q_m3h, 0)}<span class="unit">m&sup3;/h</span></div></div>
    <div class="kpi"><div class="label">&eta;<sub>BEP</sub></div>
      <div class="value">${fmt(bep.eta * 100, 1)}<span class="unit">%</span></div></div>
  `;

  const W = 600, H = 360, padL = 60, padR = 60, padT = 20, padB = 40;
  const xMax = Math.max(...M.points.map(p => p.Q_m3h)) * 1.05;
  const yMaxDp = Math.max(...M.points.map(p => p.dp_Pa)) * 1.10;
  const yMaxEta = 1.0;
  let svg = svgAxes({ W, H, padL, padR, padT, padB, xMax, yMax: yMaxDp,
                      y2Max: 100, y2Label: 'η [%]',
                      xLabel: 'Q [m³/h]', yLabel: 'Δp [Pa]' });
  const X = (q) => padL + (q / xMax) * (W - padL - padR);
  const Yd = (d) => H - padB - (d / yMaxDp) * (H - padT - padB);
  const Ye = (e) => H - padB - e * (H - padT - padB);

  // Surge zone shading
  svg += `<rect x="${padL}" y="${padT}" width="${X(surge.Q_m3h) - padL}" height="${H - padT - padB}" fill="rgba(179,38,30,.08)"/>`;
  svg += `<text class="svg-label" x="${(padL + X(surge.Q_m3h)) / 2}" y="${padT + 14}" text-anchor="middle" fill="#b3261e">Surge-Zone</text>`;

  // dp curve
  let pathDp = '';
  M.points.forEach((p, i) => { pathDp += (i ? 'L' : 'M') + X(p.Q_m3h).toFixed(1) + ',' + Yd(p.dp_Pa).toFixed(1); });
  svg += `<path class="svg-curve" d="${pathDp}"/>`;

  // eta curve
  let pathEta = '';
  M.points.forEach((p, i) => { pathEta += (i ? 'L' : 'M') + X(p.Q_m3h).toFixed(1) + ',' + Ye(p.eta).toFixed(1); });
  svg += `<path stroke="#7a8b3a" stroke-width="2" fill="none" stroke-dasharray="4 3" d="${pathEta}"/>`;

  // Markers: Design point, BEP, Surge
  const Qd = r.inputs.Q_m3h;
  const dpd = r.inputs.dp_total_Pa;
  svg += `<circle cx="${X(Qd)}" cy="${Yd(dpd)}" r="6" fill="#c75b12"/>
          <text class="svg-label" x="${X(Qd) + 8}" y="${Yd(dpd) - 8}" fill="#c75b12">Auslegung</text>`;
  svg += `<circle cx="${X(bep.Q_m3h)}" cy="${Ye(bep.eta)}" r="5" fill="#7a8b3a"/>
          <text class="svg-label" x="${X(bep.Q_m3h) - 6}" y="${Ye(bep.eta) - 8}" fill="#7a8b3a" text-anchor="end">BEP</text>`;
  svg += `<line stroke="#b3261e" stroke-width="2" stroke-dasharray="3 3" x1="${X(surge.Q_m3h)}" y1="${padT}" x2="${X(surge.Q_m3h)}" y2="${H - padB}"/>
          <text class="svg-label" x="${X(surge.Q_m3h) + 6}" y="${H - padB - 6}" fill="#b3261e">Surge</text>`;

  $('offdesign-svg').innerHTML = svg;
}

// ====================================================================
// 2D FIELD VISUALISATIONS (jet colormap, derived from 1D physics)
// ====================================================================

// Standard "jet" colormap used in most engineering FEM/CFD post-processors.
const JET_STOPS = [
  [0.000,   0,   0, 143],
  [0.125,   0,   0, 255],
  [0.375,   0, 255, 255],
  [0.625, 255, 255,   0],
  [0.875, 255,   0,   0],
  [1.000, 128,   0,   0],
];

function jetColor(t) {
  t = Math.max(0, Math.min(1, t));
  for (let i = 0; i < JET_STOPS.length - 1; i++) {
    if (t <= JET_STOPS[i + 1][0]) {
      const lo = JET_STOPS[i], hi = JET_STOPS[i + 1];
      const f = (t - lo[0]) / (hi[0] - lo[0]);
      const r = Math.round(lo[1] + f * (hi[1] - lo[1]));
      const g = Math.round(lo[2] + f * (hi[2] - lo[2]));
      const b = Math.round(lo[3] + f * (hi[3] - lo[3]));
      return `rgb(${r},${g},${b})`;
    }
  }
  return 'rgb(128,0,0)';
}

// Build a vertical colorbar as N stacked rectangles instead of a
// linearGradient.  More robust across browsers (iOS Safari occasionally
// drops linearGradient stops set via innerHTML, especially when their
// offsets are not strictly increasing) and looks identical.
function buildColorbar(x, y, w, h, segments = 48) {
  let s = '';
  const segH = h / segments + 0.6;   // tiny overlap to avoid hairlines
  for (let i = 0; i < segments; i++) {
    const t = 1 - i / (segments - 1);  // top = high (1), bottom = low (0)
    s += `<rect x="${x}" y="${(y + i * h / segments).toFixed(2)}" width="${w}" height="${segH.toFixed(2)}" fill="${jetColor(t)}" stroke="none"/>`;
  }
  s += `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="none" stroke="#555" stroke-width="0.8"/>`;
  return s;
}

// ---------- 2D blade-to-blade flow field ----------
function renderFlowField(r) {
  const a = r.aerodynamics;
  const g = r.geometry;
  const Z = g.Z;
  const beta1 = Math.max(15, Math.min(60, g.beta1_calc_deg));
  const beta2 = g.beta2_deg;
  const R2 = 150;
  const R1 = R2 * (g.D1_m / g.D2_m);
  const passageDeg = 360 / Z;

  // Velocity range: w_min..w_max
  const w1 = Math.hypot(a.cm1_m_s, a.u1_m_s);
  const w2 = a.w2_m_s;
  const w_lo = Math.min(w1, w2);
  const w_hi = Math.max(w1, w2);
  const span = Math.max(1, w_hi - w_lo);

  // Build a logarithmic-spiral path on the impeller plane with
  // angular offset offsetDeg. Returns the SVG d attribute and an array
  // of sample points {x, y, t} along the path.
  function spiralPath(offsetDeg, N) {
    let theta = 0, prev_r = R1;
    const samples = [];
    for (let i = 0; i <= N; i++) {
      const t = i / N;
      const radius = R1 + t * (R2 - R1);
      const beta = (beta1 + (beta2 - beta1) * t) * Math.PI / 180;
      const dr = radius - prev_r;
      if (i > 0 && Math.tan(beta) > 1e-3) {
        theta += dr / (prev_r * Math.tan(beta));
      }
      prev_r = radius;
      const a_rad = (offsetDeg * Math.PI / 180) - theta;
      samples.push({ x: radius * Math.cos(a_rad), y: radius * Math.sin(a_rad), t, radius });
    }
    return samples;
  }

  // Two adjacent blade outlines (drawn in dark grey on top of streamlines)
  const blade0 = spiralPath(0, 32);
  const bladeP = spiralPath(passageDeg, 32);
  const bladePath = (smp) => smp.map((p, i) => (i ? 'L' : 'M') + p.x.toFixed(1) + ',' + p.y.toFixed(1)).join('');

  // Streamlines between the two blades, color-coded by w(r) along the path
  let stream = '';
  const numStream = 6;
  for (let s = 1; s <= numStream; s++) {
    const off = (s / (numStream + 1)) * passageDeg;
    const samples = spiralPath(off, 36);
    for (let i = 0; i < samples.length - 1; i++) {
      // local relative velocity, linear interpolation between stations
      const w_local = w1 + samples[i].t * (w2 - w1);
      const tColor = (w_local - w_lo) / span;
      const col = jetColor(tColor);
      stream += `<line x1="${samples[i].x.toFixed(1)}" y1="${samples[i].y.toFixed(1)}" x2="${samples[i+1].x.toFixed(1)}" y2="${samples[i+1].y.toFixed(1)}" stroke="${col}" stroke-width="2.5" stroke-linecap="round"/>`;
    }
    // Arrow head at outlet (radius = R2)
    const last = samples[samples.length - 1];
    const prev = samples[samples.length - 2];
    const dx = last.x - prev.x, dy = last.y - prev.y;
    const len = Math.hypot(dx, dy) || 1;
    const ux = dx / len, uy = dy / len;
    const px = -uy * 5, py = ux * 5;
    const tipColor = jetColor((w2 - w_lo) / span);
    stream += `<polygon points="${last.x.toFixed(1)},${last.y.toFixed(1)} ${(last.x - 8*ux + px).toFixed(1)},${(last.y - 8*uy + py).toFixed(1)} ${(last.x - 8*ux - px).toFixed(1)},${(last.y - 8*uy - py).toFixed(1)}" fill="${tipColor}"/>`;
  }

  // Outline circles for D1 and D2 (visual reference)
  const refs = `
    <circle cx="0" cy="0" r="${R2}" fill="none" stroke="#888" stroke-width="1" stroke-dasharray="3 3"/>
    <circle cx="0" cy="0" r="${R1}" fill="none" stroke="#888" stroke-width="1" stroke-dasharray="3 3"/>
    <circle cx="0" cy="0" r="3" fill="#333"/>
  `;

  // Inflow arrows in the eye (cm1 direction = radial outward at the eye)
  let inflow = '';
  for (let phi = 0; phi <= passageDeg; phi += passageDeg / 6) {
    const phiR = phi * Math.PI / 180 - Math.PI / 2;
    const x1 = (R1 - 20) * Math.cos(phiR), y1 = (R1 - 20) * Math.sin(phiR);
    const x2 = (R1 - 4) * Math.cos(phiR), y2 = (R1 - 4) * Math.sin(phiR);
    inflow += `<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" stroke="${jetColor((w1 - w_lo) / span)}" stroke-width="1.5"/>`;
  }

  const cbX = R2 + 30, cbY = -100, cbW = 16, cbH = 200;
  $('flowfield-svg').innerHTML = `
    ${refs}
    ${inflow}
    ${stream}
    <path d="${bladePath(blade0)}" stroke="#222" stroke-width="3" fill="none"/>
    <path d="${bladePath(bladeP)}" stroke="#222" stroke-width="3" fill="none"/>
    <text class="svg-label" x="0" y="-${R2 + 16}" text-anchor="middle">Schaufelkanal (Blade-to-Blade)</text>
    <text class="svg-label" x="0" y="${R2 + 22}" text-anchor="middle">w&#x2081;=${fmt(w1, 0)} m/s &rarr; w&#x2082;=${fmt(w2, 0)} m/s</text>

    ${buildColorbar(cbX, cbY, cbW, cbH)}
    <text class="svg-label" x="${cbX + cbW + 4}" y="${cbY + 4}">${fmt(w_hi, 0)}</text>
    <text class="svg-label" x="${cbX + cbW + 4}" y="${cbY + cbH/2 + 4}">${fmt(0.5*(w_lo+w_hi), 0)}</text>
    <text class="svg-label" x="${cbX + cbW + 4}" y="${cbY + cbH + 4}">${fmt(w_lo, 0)}</text>
    <text class="svg-label" x="${cbX + cbW + 4}" y="${cbY + cbH + 20}">m/s</text>
  `;
}

// ---------- 2D rotational stress field ----------
function renderStressField(D) {
  if (!D) return;
  const R_o = 145;
  const R_i = R_o * (D.R_i_m / D.R_o_m);
  const s_max = Math.max(...D.points.map(p => p.sigma_v_MPa));
  const s_min = Math.min(...D.points.map(p => p.sigma_v_MPa));
  const span = Math.max(1, s_max - s_min);

  // radialGradient stops at user-space coordinates
  let stops = `<stop offset="0" stop-color="${jetColor((D.points[0].sigma_v_MPa - s_min) / span)}"/>`;
  D.points.forEach((p) => {
    const off = (R_i + (R_o - R_i) * p.r_norm) / R_o;
    stops += `<stop offset="${off.toFixed(3)}" stop-color="${jetColor((p.sigma_v_MPa - s_min) / span)}"/>`;
  });

  // Bohrungs-Maske + zwei kleine Markierungen am Ort des Maximums
  const peak_r_px = R_i + (R_o - R_i) * D.peak.r_norm;

  const cbX = R_o + 30, cbY = -100, cbW = 16, cbH = 200;
  $('stressfield-svg').innerHTML = `
    <defs>
      <radialGradient id="stressGrad" cx="0" cy="0" r="${R_o}" gradientUnits="userSpaceOnUse">
        ${stops}
      </radialGradient>
    </defs>

    <circle cx="0" cy="0" r="${R_o}" fill="url(#stressGrad)" stroke="#222" stroke-width="1.5"/>
    <circle cx="0" cy="0" r="${R_i}" fill="#fff" stroke="#222" stroke-width="1.5"/>
    <circle cx="0" cy="0" r="${peak_r_px}" fill="none" stroke="#fff" stroke-width="1" stroke-dasharray="2 3"/>

    <text class="svg-label" x="0" y="-${R_o + 8}" text-anchor="middle">Laufrad-Querschnitt (rotationssymmetrisch)</text>
    <text class="svg-label" x="0" y="${R_o + 18}" text-anchor="middle">D2=${fmt(D.R_o_m * 2 * 1000, 0)} mm, D_bohr=${fmt(D.R_i_m * 2 * 1000, 0)} mm</text>
    <text class="svg-label" x="0" y="${R_o + 34}" text-anchor="middle">&sigma;<sub>v,max</sub> = ${fmt(s_max, 0)} N/mm&sup2; bei r/R<sub>o</sub> = ${fmt(D.peak.r_m / D.R_o_m, 2)}</text>

    ${buildColorbar(cbX, cbY, cbW, cbH)}
    <text class="svg-label" x="${cbX + cbW + 4}" y="${cbY + 4}">${fmt(s_max, 0)}</text>
    <text class="svg-label" x="${cbX + cbW + 4}" y="${cbY + cbH/2 + 4}">${fmt(0.5*(s_min+s_max), 0)}</text>
    <text class="svg-label" x="${cbX + cbW + 4}" y="${cbY + cbH + 4}">${fmt(s_min, 0)}</text>
    <text class="svg-label" x="${cbX + cbW + 4}" y="${cbY + cbH + 20}">N/mm&sup2;</text>
  `;
}

// ---------- materials ----------
function renderMaterials(r) {
  const m = MATERIALS[r.materials.wheelMaterial];
  const wear = recommendWearProtection({
    dustLoading: r.inputs.dustLoading,
    tempC: r.inputs.tempC,
    bladeType: r.aerodynamics.bladeType,
  });
  const tipOK = r.materials.tipSpeedOK
    ? `<span style="color:var(--good)">u2 = ${fmt(r.aerodynamics.u2_m_s, 1)} m/s &le; Grenze ${r.materials.tipSpeedLimit_m_s} m/s</span>`
    : `<span style="color:var(--bad)">Achtung: u2 = ${fmt(r.aerodynamics.u2_m_s, 1)} m/s &gt; Grenze ${r.materials.tipSpeedLimit_m_s} m/s &mdash; Werkstoff hochstufen oder Drehzahl reduzieren!</span>`;
  $('materials').innerHTML = `
    <div class="row">
      <div>
        <strong>Empfohlener Laufrad-Werkstoff: ${m.label}</strong>
        ${m.use}<br>
        <small>Tmax: ${m.tempMax} &deg;C. ${m.notes}</small>
      </div>
    </div>
    <div class="row">
      <div>
        <strong>Verschleissschutz: ${wear.label}</strong>
        ${wear.appliesTo}<br>
        <small>Erwartete Standzeit: ${wear.typicalLifetime}</small>
      </div>
    </div>
    <div class="row">
      <div>
        <strong>Festigkeitspruefung Umfangsgeschwindigkeit</strong>
        ${tipOK}
      </div>
    </div>
  `;
}

// ---------- notes ----------
function renderNotes(r, det, ver) {
  const preset = CEMENT_PRESETS.find((p) => p.id === $('preset').value);
  const ul = $('notes');
  ul.innerHTML = '';
  const notes = [...(preset?.notes ?? [])];

  // Detailed-analysis warnings
  if (det && det.strength && !det.strength.pass) {
    notes.push(`<strong style="color:var(--bad)">Festigkeit:</strong> SF = ${det.strength.safetyFactor.toFixed(2)} &lt; 1.5 &mdash; Wandstaerken erhoehen, Drehzahl reduzieren oder hoeherfesten Werkstoff waehlen.`);
  }
  if (det && det.rotorDyn && !det.rotorDyn.pass) {
    notes.push(`<strong style="color:var(--bad)">Rotordynamik (1D):</strong> Betriebsdrehzahl liegt im kritischen Bereich (${det.rotorDyn.regime}). Lagerabstand verkuerzen oder Wellendurchmesser erhoehen.`);
  }
  if (det && det.losses && det.losses.deHaller < 0.72) {
    notes.push(`<strong style="color:var(--warn)">Aerodynamik:</strong> de-Haller-Kriterium w2/w1 = ${det.losses.deHaller.toFixed(2)} &lt; 0.72 &mdash; Gefahr der Stroemungsabloesung im Schaufelkanal. b2 erhoehen oder beta2 anpassen.`);
  }

  // Verification warnings
  if (ver && ver.rotorFEM && !ver.rotorFEM.pass) {
    const offending = ver.rotorFEM.margins
      .map((mg, i) => mg.pass ? null : `${i + 1}. (${mg.n_crit_rpm.toFixed(0)} 1/min, &Delta; = ${mg.margin_pct.toFixed(0)} %)`)
      .filter(Boolean).join(', ');
    notes.push(`<strong style="color:var(--bad)">Rotor-FEM:</strong> Mehrfreiheitsgrad-Modell zeigt zu geringen Abstand zu kritischen Drehzahlen: ${offending}. API 673 fordert &ge; 15 % Trennung.`);
  }
  if (ver && ver.offDesign && !ver.offDesign.pass) {
    notes.push(`<strong style="color:var(--warn)">Off-Design:</strong> Stall-Marge ${ver.offDesign.stallMargin_pct.toFixed(0)} % &lt; 10 % &mdash; Auslegungspunkt zu nahe am Surge. Drehzahlregelung und Mindestlast-Klappe vorsehen.`);
  }
  if (ver && ver.diskProfile && ver.diskProfile.peak) {
    const SF_disk = ver.diskProfile.Rp02_T_MPa / ver.diskProfile.peak.sigma_v_MPa;
    if (SF_disk < 1.5) {
      notes.push(`<strong style="color:var(--bad)">&sigma;(r)-Verifikation:</strong> Maximale Vergleichsspannung am Innenrand ${ver.diskProfile.peak.sigma_v_MPa.toFixed(0)} N/mm&sup2; ergibt SF = ${SF_disk.toFixed(2)}. Bohrungsbereich konstruktiv verstaerken (Verstaerkungsring, Hyperbel-Profil).`);
    }
  }

  // Add automatically generated warnings
  if (r.aerodynamics.eta_total < 0.7) {
    notes.push('Wirkungsgrad < 70 % &mdash; staubbedingte Einbussen, Profilschaufel nicht wirtschaftlich.');
  }
  if (r.state.sigma < 0.2) {
    notes.push('Sehr kleine spez. Drehzahl &mdash; Hochdruck-Anwendung. Mehrstufige Loesung pruefen.');
  }
  if (r.state.sigma > 1.0) {
    notes.push('Sehr hohe spez. Drehzahl &mdash; halbaxiale Maschine wirtschaftlicher.');
  }
  if (r.geometry.b2_m / r.geometry.D2_m < 0.05) {
    notes.push('Schmales Laufrad (b2/D2 &lt; 0.05) &mdash; reibungsdominiert, kleiner Wirkungsgrad.');
  }
  if (r.inputs.tempC > 300) {
    notes.push('Heissgasbetrieb &mdash; Wellendichtung mit Sperrluft, Lagerkuehlung vorsehen.');
  }
  if ((r.inputs.dustLoading ?? 0) > 30) {
    notes.push('Hohe Staubbeladung &mdash; Anbackungen pruefen, ggf. Klopfwerk oder Spuelluft.');
  }
  if (preset?.id === 'coal-mill') {
    notes.push('ATEX-konforme Ausfuehrung, antistatische Lackierung, Temperaturueberwachung.');
  }

  notes.forEach((n) => {
    const li = document.createElement('li');
    li.innerHTML = n;
    ul.appendChild(li);
  });
}

// ---------- live recalc with debounce ----------
let calcTimer = null;
function scheduleCalc() {
  clearTimeout(calcTimer);
  calcTimer = setTimeout(runCalc, 250);
}

// ---------- mobile tabs ----------
function setActiveTab(name) {
  document.body.dataset.active = name;
  document.querySelectorAll('.tabs .tab').forEach((b) => {
    b.setAttribute('aria-selected', b.dataset.tab === name ? 'true' : 'false');
  });
  // scroll to top of content (just below the sticky tab bar)
  window.scrollTo({ top: 0, behavior: 'auto' });
}

function setupTabs() {
  document.querySelectorAll('.tabs .tab').forEach((b) => {
    b.addEventListener('click', () => setActiveTab(b.dataset.tab));
  });
  // Default tab on first load
  document.body.dataset.active = 'inputs';

  // Calc button -> jump to results on mobile
  const back = $('backToInputs');
  if (back) back.addEventListener('click', () => setActiveTab('inputs'));
}

// ---------- bootstrap ----------
document.addEventListener('DOMContentLoaded', () => {
  fillPresetSelect();

  // Preset change -> fill values, recalc, collapse panel on small screens
  $('preset').addEventListener('change', (e) => {
    applyPreset(e.target.value);
    runCalc();
  });

  // "Ergebnis ansehen" button: recalc and on mobile jump to results tab
  $('calc').addEventListener('click', () => {
    runCalc();
    setActiveTab('results');
  });

  // Live recalc on every input change so mobile users don't have to scroll
  // back to the button after every tweak.
  ['Q', 'dp', 'T', 'p', 'dust', 'n', 'bladeType', 'slipModel', 'arrangement'].forEach((id) => {
    const el = $(id);
    if (!el) return;
    el.addEventListener('input', scheduleCalc);
    el.addEventListener('change', scheduleCalc);
  });

  setupTabs();

  // initial calculation
  runCalc();
});
