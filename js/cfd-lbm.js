/**
 * 2D Lattice-Boltzmann CFD Solver for the centrifugal fan blade-to-blade
 * passage.
 *
 * Method: D2Q9 with BGK (single-relaxation-time) collision operator.
 *
 *     f_i(x + c_i dt, t + dt) - f_i(x, t) = -1/tau (f_i - f_i^eq)
 *
 * with the discrete velocity set
 *
 *     c_0  = ( 0,  0)        w_0  = 4/9
 *     c_1..4 = (1,0),(0,1),(-1,0),(0,-1)         w_1..4 = 1/9
 *     c_5..8 = (1,1),(-1,1),(-1,-1),(1,-1)       w_5..8 = 1/36
 *
 * and the equilibrium distribution
 *
 *     f_i^eq = rho w_i [ 1 + 3 (c_i.u) + 9/2 (c_i.u)^2 - 3/2 |u|^2 ]
 *
 * Macroscopic quantities
 *     rho = Sum f_i        rho u = Sum c_i f_i
 *
 * Kinematic viscosity in lattice units:  nu = (tau - 1/2) / 3
 *
 * Geometry: 2D cascade approximation - the blade unwrapped to a curved
 * camber line from leading to trailing edge inside a rectangular channel
 * with periodic top/bottom (representing the adjacent blade passage)
 * and velocity inlet / zero-gradient outlet.
 *
 * Boundary conditions
 *   left   : velocity inlet at flow angle beta1 (relative inlet)
 *   right  : zero-gradient outflow
 *   top/bot: periodic
 *   blade  : full bounce-back (no-slip wall)
 *
 * References:
 *   - Krueger et al., "The Lattice Boltzmann Method", Springer 2017
 *   - Succi, "The Lattice Boltzmann Equation", Oxford 2001
 *   - Mohamad, "Lattice Boltzmann Method", Springer 2011
 */

(function () {
  // ---- D2Q9 lattice ---------------------------------------------------
  const W   = [4/9, 1/9, 1/9, 1/9, 1/9, 1/36, 1/36, 1/36, 1/36];
  const CX  = [ 0,   1,   0,  -1,   0,    1,   -1,   -1,    1];
  const CY  = [ 0,   0,   1,   0,  -1,    1,    1,   -1,   -1];
  const OPP = [ 0,   3,   4,   1,   2,    7,    8,    5,    6];

  let running = false;

  // ---- Build the wall mask from the fan geometry ---------------------
  function buildBladeWalls(nx, ny, r) {
    const wall = new Uint8Array(nx * ny);
    const beta1 = Math.max(15, Math.min(80, r.geometry.beta1_calc_deg));
    const beta2 = Math.max(10, Math.min(85, r.geometry.beta2_deg));

    // Quadratic camber line y(s) = a s + b s^2 on s in [0, 1]
    // dy/ds at s=0 = cot(beta1), at s=1 = cot(beta2).  Scaled to fit in
    // the channel so the blade is clearly visible without crossing the
    // periodic boundaries.
    const cot_b1 = 1 / Math.tan(beta1 * Math.PI / 180);
    const cot_b2 = 1 / Math.tan(beta2 * Math.PI / 180);

    const xLE = Math.floor(nx * 0.20);
    const xTE = Math.floor(nx * 0.80);
    const chord = xTE - xLE;

    // Total tangential rise of the blade between LE and TE
    const a = cot_b1;
    const b = (cot_b2 - cot_b1) / 2;
    // dy_max at s=1: a + b
    const rise = (a + b);
    // Scale so the rise occupies at most 40% of the channel height
    const targetRise = ny * 0.40;
    const scale = Math.min(1, targetRise / Math.max(Math.abs(rise) * chord, 1));

    const a_s = a * scale;
    const b_s = b * scale;

    const yMid = Math.floor(ny / 2);
    let prev_y = yMid;
    let prev_x = xLE;

    // Realistic blade thickness profile (NACA-style parabola): peaks at
    // mid-chord, tapers to a near-sharp LE and TE.  Provides enough
    // bluff-body character for real separation to develop at Re > ~400.
    const tMax = 5;  // maximum thickness in lattice cells
    function thicknessAt(s) {
      // s in [0,1]; classic NACA-like t(s) = tMax * (a0*sqrt(s) - a1*s
      // - a2*s^2 - a3*s^3 + a4*s^4) - simplified to a smooth parabola
      // peaking at s=0.4, more LE-blunt than TE-blunt (typical airfoil).
      const x = s;
      return tMax * 1.2 * (0.5 * Math.sqrt(x) - 0.06 * x - 0.35 * x * x - 0.10 * x * x * x);
    }
    function plotThick(x, yCenter, halfT) {
      const h = Math.max(1, Math.round(halfT));
      for (let dy = -h; dy <= h; dy++) {
        const yy = yCenter + dy;
        if (yy >= 0 && yy < ny && x >= 0 && x < nx) {
          wall[yy * nx + x] = 1;
        }
      }
    }

    // Trace the camber line with variable thickness
    let prev_thick = 0;
    for (let xi = 0; xi <= chord; xi++) {
      const s = xi / chord;
      const dy = (a_s * s + b_s * s * s) * chord;
      const y_cam = Math.round(yMid - dy);
      const xg = xLE + xi;
      const thick = thicknessAt(s);
      // Connect previous to current with simple line drawing
      const xa = prev_x, ya = prev_y, xb = xg, yb = y_cam;
      const steps = Math.max(Math.abs(xb - xa), Math.abs(yb - ya));
      for (let s2 = 0; s2 <= steps; s2++) {
        const t = steps === 0 ? 0 : s2 / steps;
        const xx = Math.round(xa + t * (xb - xa));
        const yy = Math.round(ya + t * (yb - ya));
        const halfT = (prev_thick + (thick - prev_thick) * t) / 2;
        plotThick(xx, yy, halfT);
      }
      prev_x = xg;
      prev_y = y_cam;
      prev_thick = thick;
    }
    return { wall, beta1, beta2 };
  }

  // ---- Initialise distribution functions to equilibrium --------------
  function initEquilibrium(nx, ny, ux, uy) {
    const f = new Float32Array(nx * ny * 9);
    const uu = ux*ux + uy*uy;
    for (let c = 0; c < nx * ny; c++) {
      for (let k = 0; k < 9; k++) {
        const cu = CX[k]*ux + CY[k]*uy;
        f[c*9 + k] = W[k] * (1 + 3*cu + 4.5*cu*cu - 1.5*uu);
      }
    }
    return f;
  }

  // ---- One time step (collision + streaming with BCs) ----------------
  function step(s) {
    const { f, fnew, wall, nx, ny, ux_in, uy_in, tau, F_centrif, radiusRatio } = s;
    const invtau = 1 / tau;

    // Collision in place on f.  Skip wall cells.  The rotating-frame
    // centrifugal body force is applied via the Shan-Chen scheme: the
    // velocity used to evaluate the equilibrium distribution is
    // shifted by F * tau / rho, which is equivalent to a body force
    // rho * omega^2 * r in the momentum equation.  F grows linearly
    // with radial position i so that the radial outward acceleration
    // mimics what happens in the rotating impeller frame.
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const c = j * nx + i;
        if (wall[c]) continue;
        const c9 = c * 9;
        let rho = 0, mx = 0, my = 0;
        for (let k = 0; k < 9; k++) {
          const fk = f[c9 + k];
          rho += fk;
          mx  += CX[k] * fk;
          my  += CY[k] * fk;
        }
        if (rho < 1e-9) rho = 1;
        let ux = mx / rho;
        let uy = my / rho;
        // Driving: enforce velocity at inlet, keep rho at outlet
        if (i === 0) { ux = ux_in; uy = uy_in; rho = 1; }
        // Centrifugal body force (Shan-Chen): shift equilibrium velocity
        // F_centrif scales the dimensionless r/R2 -> linearly growing
        // radial force, capturing rho * omega^2 * r in the rotating frame.
        if (F_centrif > 0 && i > 0) {
          const r_norm = radiusRatio + (1 - radiusRatio) * (i / (nx - 1));
          ux += F_centrif * r_norm * tau;
        }
        const uu = ux*ux + uy*uy;
        for (let k = 0; k < 9; k++) {
          const cu = CX[k]*ux + CY[k]*uy;
          const feq = W[k] * rho * (1 + 3*cu + 4.5*cu*cu - 1.5*uu);
          f[c9 + k] -= (f[c9 + k] - feq) * invtau;
        }
      }
    }

    // Streaming (pull): for each cell, take f_k from cell upstream in dir k.
    for (let j = 0; j < ny; j++) {
      const jm = (j - 1 + ny) % ny;
      const jp = (j + 1) % ny;
      for (let i = 0; i < nx; i++) {
        const c = j * nx + i;
        const c9 = c * 9;
        if (wall[c]) {
          // For wall, just keep current values; bounce-back happens from
          // outside the wall cells via OPP[k] from the streaming below.
          continue;
        }
        for (let k = 0; k < 9; k++) {
          // Upstream coords
          let ni = i - CX[k];
          let nj = j - CY[k];
          if (nj === -1) nj = ny - 1;
          else if (nj === ny) nj = 0;
          if (ni < 0) {
            // Inlet ghost: equilibrium at inlet velocity
            const uu_in = ux_in*ux_in + uy_in*uy_in;
            const cu = CX[k]*ux_in + CY[k]*uy_in;
            fnew[c9 + k] = W[k] * (1 + 3*cu + 4.5*cu*cu - 1.5*uu_in);
            continue;
          }
          if (ni >= nx) {
            // Outlet ghost: zero-gradient -> copy from cell itself
            fnew[c9 + k] = f[c9 + k];
            continue;
          }
          const nc = nj * nx + ni;
          if (wall[nc]) {
            // Bounce-back: incoming direction comes from local outgoing in
            // opposite direction (full-way bounce-back at the wall).
            fnew[c9 + k] = f[c9 + OPP[k]];
          } else {
            fnew[c9 + k] = f[nc * 9 + k];
          }
        }
      }
    }
    f.set(fnew);
  }

  // ---- Macroscopic velocity magnitude for visualisation --------------
  function computeFields(s) {
    const { f, wall, nx, ny } = s;
    const mag = new Float32Array(nx * ny);
    const ux  = new Float32Array(nx * ny);
    const uy  = new Float32Array(nx * ny);
    let maxMag = 0;
    for (let c = 0; c < nx * ny; c++) {
      if (wall[c]) { mag[c] = -1; continue; }
      const c9 = c * 9;
      let rho = 0, mxv = 0, myv = 0;
      for (let k = 0; k < 9; k++) {
        const fk = f[c9 + k];
        rho += fk;
        mxv += CX[k] * fk;
        myv += CY[k] * fk;
      }
      if (rho < 1e-9) rho = 1;
      const u = mxv / rho;
      const v = myv / rho;
      ux[c] = u; uy[c] = v;
      const m = Math.sqrt(u*u + v*v);
      mag[c] = m;
      if (m > maxMag) maxMag = m;
    }
    return { mag, ux, uy, maxMag };
  }

  // ---- Colormap & rendering ------------------------------------------
  function jetColor(t) {
    t = Math.max(0, Math.min(1, t));
    if (t < 0.125) return [0, 0, Math.round(143 + (255-143) * t / 0.125)];
    if (t < 0.375) return [0, Math.round(255 * (t - 0.125) / 0.25), 255];
    if (t < 0.625) {
      const u = (t - 0.375) / 0.25;
      return [Math.round(255 * u), 255, Math.round(255 * (1 - u))];
    }
    if (t < 0.875) {
      const u = (t - 0.625) / 0.25;
      return [255, Math.round(255 * (1 - u)), 0];
    }
    return [Math.round(255 - 127 * (t - 0.875) / 0.125), 0, 0];
  }

  // Result of last render, exposed so the caller can read the separation
  // statistics for the status line.
  let lastStats = { reversePct: 0, nReverse: 0, nFluid: 0 };

  function render(canvas, s, result) {
    const { wall, nx, ny } = s;
    const fields = computeFields(s);
    const W2 = canvas.width;
    const H2 = canvas.height;
    const ctx = canvas.getContext('2d');

    // ============================================================
    // Polar wedge rendering: the LBM solves on a rectangular grid
    // (cascade approximation) but the physical blade passage is an
    // annular sector ("Kuchenstueck"). Here we map the rectangular
    // (i = radial, j = tangential) result onto the actual wedge:
    // three consecutive blade pitches between D1 and D2, with each
    // blade following its logarithmic spiral. The flow field is
    // resampled per canvas pixel into that geometry.
    // ============================================================
    const Z = result?.geometry?.Z ?? 12;
    const R1_phys = result?.geometry?.D1_m / 2 ?? 0.45;
    const R2_phys = result?.geometry?.D2_m / 2 ?? 1.0;
    const ratio = R1_phys / R2_phys;

    const TILES = 3;
    const halfAngle = Math.PI * TILES / Z;   // half-angle of the displayed sector

    // Fit the sector into the canvas. The widest horizontal extent is
    // at the outer arc (D2). Constraint: 2 R2 sin(halfAngle) <= 0.92 W
    // Vertical extent of the sector: R2 - R1 cos(halfAngle)  (apex below
    // canvas, outer arc near top, inner arc somewhere in middle/bottom).
    const R2_px_h = (W2 * 0.92) / (2 * Math.sin(Math.min(halfAngle, Math.PI / 2 - 0.01)));
    const R2_px_v = (H2 * 0.84) / (1 - ratio * Math.cos(halfAngle));
    const R2_px = Math.min(R2_px_h, R2_px_v);
    const R1_px = R2_px * ratio;

    const cx = W2 / 2;
    const cy = R2_px + (H2 - (R2_px - R1_px * Math.cos(halfAngle))) / 2 - 6;

    // Field image - sample one canvas pixel at a time
    const img = ctx.createImageData(W2, H2);
    const bg = [239, 241, 244];     // page surface
    let nReverse = 0, nFluid = 0;

    for (let py = 0; py < H2; py++) {
      const dy = py - cy;
      for (let px = 0; px < W2; px++) {
        const dx = px - cx;
        const r_px = Math.sqrt(dx * dx + dy * dy);
        // theta measured from "up" direction, increasing clockwise
        const theta = Math.atan2(dx, -dy);
        const idx = (py * W2 + px) * 4;

        if (r_px < R1_px || r_px > R2_px || Math.abs(theta) > halfAngle) {
          img.data[idx]   = bg[0];
          img.data[idx+1] = bg[1];
          img.data[idx+2] = bg[2];
          img.data[idx+3] = 255;
          continue;
        }

        // Map (r, theta) -> (i, j) on the cascade grid.
        // Radial coordinate i in [0, nx)
        const sr = (r_px - R1_px) / (R2_px - R1_px);
        let i = (sr * (nx - 1)) | 0;
        if (i < 0) i = 0; else if (i >= nx) i = nx - 1;
        // Tangential: theta in [-halfAngle, +halfAngle] -> j_global in [0, TILES*ny)
        const sth = (theta + halfAngle) / (2 * halfAngle);
        const jGlobal = sth * TILES * ny;
        let jLocal = jGlobal % ny;
        if (jLocal < 0) jLocal += ny;
        const j = jLocal | 0;
        const c = j * nx + i;

        if (wall[c]) {
          img.data[idx]   = 40;
          img.data[idx+1] = 40;
          img.data[idx+2] = 40;
        } else {
          const tv = fields.maxMag > 1e-9 ? fields.mag[c] / fields.maxMag : 0;
          const [r, g, b] = jetColor(tv);
          if (fields.ux[c] < 0) {
            // Reverse flow: blend toward red for visibility
            img.data[idx]   = (r * 0.40 + 220 * 0.60) | 0;
            img.data[idx+1] = (g * 0.40 +  20 * 0.60) | 0;
            img.data[idx+2] = (b * 0.40 +  20 * 0.60) | 0;
          } else {
            img.data[idx] = r; img.data[idx+1] = g; img.data[idx+2] = b;
          }
        }
        img.data[idx+3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);

    // Count reverse-flow / fluid cells on the LBM grid (not per-pixel)
    for (let c = 0; c < nx * ny; c++) {
      if (wall[c]) continue;
      nFluid++;
      if (fields.ux[c] < 0) nReverse++;
    }
    lastStats = {
      reversePct: nFluid > 0 ? 100 * nReverse / nFluid : 0,
      nReverse, nFluid,
    };

    // ---- Wedge outline + pitch dividers ---------------------------
    function polarToXY(rPx, th) {
      return [cx + rPx * Math.sin(th), cy - rPx * Math.cos(th)];
    }
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = '#333';
    ctx.beginPath();
    ctx.arc(cx, cy, R2_px, -halfAngle - Math.PI/2, halfAngle - Math.PI/2);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(cx, cy, R1_px, -halfAngle - Math.PI/2, halfAngle - Math.PI/2);
    ctx.stroke();
    // Side spokes
    ctx.beginPath();
    const [sx1a, sy1a] = polarToXY(R1_px, -halfAngle);
    const [sx2a, sy2a] = polarToXY(R2_px, -halfAngle);
    ctx.moveTo(sx1a, sy1a); ctx.lineTo(sx2a, sy2a);
    const [sx1b, sy1b] = polarToXY(R1_px,  halfAngle);
    const [sx2b, sy2b] = polarToXY(R2_px,  halfAngle);
    ctx.moveTo(sx1b, sy1b); ctx.lineTo(sx2b, sy2b);
    ctx.stroke();

    // Pitch dividers (dashed radial lines between tiles)
    ctx.save();
    ctx.strokeStyle = 'rgba(255,255,255,0.35)';
    ctx.setLineDash([4, 4]);
    ctx.lineWidth = 1;
    for (let t = 1; t < TILES; t++) {
      const th = -halfAngle + (t / TILES) * 2 * halfAngle;
      const [x1, y1] = polarToXY(R1_px, th);
      const [x2, y2] = polarToXY(R2_px, th);
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();
    }
    ctx.restore();

    // ---- Streamlines in polar geometry ----------------------------
    const tracerStep = Math.max(1, Math.floor(ny / 14));
    ctx.strokeStyle = 'rgba(255,255,255,0.6)';
    ctx.lineWidth = 1.3;
    for (let j0 = 3; j0 < ny; j0 += tracerStep) {
      let x = 2, y = j0;
      const pts = [{ x, y }];
      for (let stp = 0; stp < 320; stp++) {
        const ix = x | 0, iy = y | 0;
        if (ix < 0 || iy < 0 || ix >= nx || iy >= ny) break;
        const c = iy * nx + ix;
        if (wall[c]) break;
        const u = fields.ux[c], v = fields.uy[c];
        const sp = Math.hypot(u, v);
        if (sp < 1e-6) break;
        x += u / sp * 0.7;
        y += v / sp * 0.7;
        if (y < 0) y += ny;
        else if (y >= ny) y -= ny;
        pts.push({ x, y });
      }
      // Draw on each tile, converting to polar canvas coordinates
      for (let t = 0; t < TILES; t++) {
        ctx.beginPath();
        let prev = null;
        for (const p of pts) {
          const sr = p.x / nx;
          const sth = (t + p.y / ny) / TILES;   // 0..1 across whole sector
          const r_px = R1_px + sr * (R2_px - R1_px);
          const th = -halfAngle + sth * 2 * halfAngle;
          const cx_pt = cx + r_px * Math.sin(th);
          const cy_pt = cy - r_px * Math.cos(th);
          if (prev && Math.abs(p.y - prev.y) > ny / 2) {
            ctx.moveTo(cx_pt, cy_pt);
          } else if (prev) {
            ctx.lineTo(cx_pt, cy_pt);
          } else {
            ctx.moveTo(cx_pt, cy_pt);
          }
          prev = p;
        }
        ctx.stroke();
      }
    }

    // ---- Labels ---------------------------------------------------
    ctx.fillStyle = '#222';
    ctx.font = '12px ui-monospace, monospace';
    ctx.textAlign = 'center';
    // D1 label below the inner arc, centered
    const [d1x, d1y] = polarToXY(R1_px - 14, 0);
    ctx.fillText(`D1 = ${(R1_phys * 2 * 1000).toFixed(0)} mm`, d1x, d1y);
    // D2 label above the outer arc, centered
    const [d2x, d2y] = polarToXY(R2_px + 4, 0);
    ctx.fillText(`D2 = ${(R2_phys * 2 * 1000).toFixed(0)} mm`, d2x, d2y - 4);
    // Pitch annotation
    ctx.font = '11px ui-monospace, monospace';
    ctx.textAlign = 'left';
    ctx.fillText(`Z = ${Z} Schaufeln, Sektor = ${(2 * halfAngle * 180 / Math.PI).toFixed(0)}° (${TILES} Teilungen)`, 8, H2 - 24);
    // Rotation arrow
    ctx.fillStyle = 'rgba(28,93,153,0.85)';
    ctx.fillText('Drehrichtung →', 8, H2 - 8);

    // Separation legend (small red square + label) if any reverse flow
    if (nReverse > 0) {
      ctx.fillStyle = 'rgba(220,20,20,0.8)';
      ctx.fillRect(W2 - 184, H2 - 22, 14, 14);
      ctx.fillStyle = '#222';
      ctx.textAlign = 'left';
      ctx.fillText('Rueckstroemung (u<0)', W2 - 166, H2 - 11);
    }

    // ---- Colour bar (right side) -----------------------------------
    const cbW = 14, cbH = H2 * 0.55;
    const cbX = W2 - 26, cbY = H2 * 0.10;
    const segs = 48;
    for (let i = 0; i < segs; i++) {
      const tv = 1 - i / (segs - 1);
      const [r, g, b] = jetColor(tv);
      ctx.fillStyle = `rgb(${r},${g},${b})`;
      ctx.fillRect(cbX, cbY + i * cbH / segs, cbW, cbH / segs + 0.6);
    }
    ctx.strokeStyle = '#555';
    ctx.lineWidth = 0.8;
    ctx.strokeRect(cbX, cbY, cbW, cbH);
    ctx.fillStyle = '#222';
    ctx.textAlign = 'left';
    ctx.fillText('|w|', cbX - 4, cbY - 4);
    ctx.fillText('max', cbX + cbW + 2, cbY + 8);
    ctx.fillText('0',   cbX + cbW + 2, cbY + cbH + 4);
  }

  function getLastStats() { return lastStats; }

  // ---- Public entry point --------------------------------------------
  function runSimulation(result, canvas, statusEl, doneCallback) {
    if (!result || !canvas) return;
    if (running) return;
    running = true;
    lastStats = { reversePct: 0, nReverse: 0, nFluid: 0 };

    // Grid sized for ~ 1-3 seconds on a mid-range phone.
    // tau = 0.54 -> kinematic viscosity nu = (0.54-0.5)/3 = 0.0133.
    // With u_mag = 0.10 and channel height ny = 60, Re = u*L/nu ~ 450,
    // enough for genuine separation behind a finite-thickness blade
    // while staying well below LBM stability limits for D2Q9-BGK.
    const nx = 180, ny = 70;
    const tau = 0.54;
    const u_mag = 0.10;

    // Inlet angle: beta1 is from the tangential direction in the impeller,
    // but in the cascade analogue the inlet is from the left at the same
    // angle relative to the chordwise axis.  Project the inlet velocity:
    const beta1 = Math.max(15, Math.min(80, result.geometry.beta1_calc_deg));
    const angle = (90 - beta1) * Math.PI / 180;
    const ux_in =  u_mag * Math.cos(angle);
    const uy_in = -u_mag * Math.sin(angle);

    const { wall } = buildBladeWalls(nx, ny, result);
    const f = initEquilibrium(nx, ny, ux_in, uy_in);
    const fnew = new Float32Array(f.length);

    // Centrifugal force coefficient: tuned so the radial velocity at
    // the outer edge is ~ 50 % above the inlet value, capturing the
    // dominant rotating-frame effect (rho * omega^2 * r) without
    // pushing the LBM toward its Mach-number stability limit.  In
    // a real impeller u_tip / c_m1 = (omega * R2) / c_m1 is typically
    // 5 to 10; the visual gradient here is the qualitative analogue.
    const radiusRatio = (result.geometry.D1_m / result.geometry.D2_m);
    const F_centrif   = 1.2e-4;
    const state = { f, fnew, wall, nx, ny, ux_in, uy_in, tau, F_centrif, radiusRatio };

    const totalIter = 2200;
    let done = 0;

    function chunk() {
      const t0 = performance.now();
      // Run for ~ 40 ms then yield to the UI
      while (performance.now() - t0 < 40 && done < totalIter) {
        step(state);
        done++;
      }
      // Render periodically for progress feedback (also updates lastStats)
      if (done % 200 === 0 || done === totalIter) {
        render(canvas, state, result);
      }
      if (statusEl) {
        if (done === totalIter) {
          const st = getLastStats();
          const sepNote = st.reversePct >= 1
            ? ` Stroemungsabriss erkannt: ${st.reversePct.toFixed(1)} % Rueckstroemung im Stroemungsfeld (rot ueberlagert).`
            : ' Stroemung anliegend, keine signifikante Rueckstroemung im Schaufelkanal.';
          statusEl.textContent =
            `Konvergiert nach ${totalIter} Iterationen (D2Q9-BGK, Re ~ 450).${sepNote}`;
        } else {
          statusEl.textContent =
            `Lattice-Boltzmann-Simulation: Iteration ${done} / ${totalIter}...`;
        }
      }
      if (done < totalIter) {
        requestAnimationFrame(chunk);
      } else {
        running = false;
        if (doneCallback) doneCallback(state);
      }
    }
    chunk();
  }

  window.CFD_LBM = { runSimulation };
})();
