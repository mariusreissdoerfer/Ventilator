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
  };
  let res;
  try {
    res = FanDesign.sizeFan(inp);
  } catch (e) {
    $('summary').innerHTML = `<div class="kpi bad"><div class="label">Fehler</div><div class="value">${e.message}</div></div>`;
    return;
  }
  renderSummary(res);
  renderGeometry(res);
  renderVelocityTriangle(res);
  renderCurve(res);
  renderMaterials(res);
  renderNotes(res);
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
  $('geom-table').innerHTML = `
    <table class="data">
      <tr><th>Schaufelform</th><td>${r.aerodynamics.bladeTypeLabel}</td></tr>
      <tr><th>Aussendurchmesser D2</th><td>${fmtMm(r.geometry.D2_m)}</td></tr>
      <tr><th>Saugaugen-&empty; D1</th><td>${fmtMm(r.geometry.D1_m)}</td></tr>
      <tr><th>Schaufelaustrittsbreite b2</th><td>${fmtMm(r.geometry.b2_m)}</td></tr>
      <tr><th>Eintrittswinkel &beta;1</th><td>${fmt(r.geometry.beta1_calc_deg, 1)}&deg;</td></tr>
      <tr><th>Austrittswinkel &beta;2</th><td>${fmt(r.geometry.beta2_deg, 1)}&deg;</td></tr>
      <tr><th>Schaufelzahl Z</th><td>${r.geometry.Z}</td></tr>
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
function renderNotes(r) {
  const preset = CEMENT_PRESETS.find((p) => p.id === $('preset').value);
  const ul = $('notes');
  ul.innerHTML = '';
  const notes = [...(preset?.notes ?? [])];

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
  ['Q', 'dp', 'T', 'p', 'dust', 'n', 'bladeType', 'slipModel'].forEach((id) => {
    const el = $(id);
    if (!el) return;
    el.addEventListener('input', scheduleCalc);
    el.addEventListener('change', scheduleCalc);
  });

  setupTabs();

  // initial calculation
  runCalc();
});
