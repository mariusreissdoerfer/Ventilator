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
    const { f, fnew, wall, nx, ny, ux_in, uy_in, tau } = s;
    const invtau = 1 / tau;

    // Collision in place on f.  Skip wall cells.
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

  function render(canvas, s) {
    const { wall, nx, ny } = s;
    const fields = computeFields(s);
    const W2 = canvas.width;
    const H2 = canvas.height;
    const ctx = canvas.getContext('2d');

    // Periodic top/bottom = infinite cascade.  We compute one passage
    // but render TILES copies stacked, then *crop* the visible portion
    // to PITCH_VISIBLE pitches so the central blade is dominant while
    // the neighbours stay just visible at the top and bottom edges.
    const TILES = 3;
    const PITCH_VISIBLE = 1.5;
    const srcYStart = ny * (TILES / 2 - PITCH_VISIBLE / 2);   // = 0.75 ny
    const srcH      = ny * PITCH_VISIBLE;                      // = 1.5  ny

    // ---- Field image at offscreen grid resolution -----------------
    const off = document.createElement('canvas');
    off.width = nx; off.height = ny * TILES;
    const offCtx = off.getContext('2d');
    const img = offCtx.createImageData(nx, ny * TILES);
    for (let t = 0; t < TILES; t++) {
      for (let c = 0; c < nx * ny; c++) {
        const j = (c / nx) | 0;
        const i = c - j * nx;
        const targetJ = t * ny + j;
        const idx = (targetJ * nx + i) * 4;
        if (wall[c]) {
          img.data[idx] = 40; img.data[idx+1] = 40; img.data[idx+2] = 40;
        } else {
          const tv = fields.maxMag > 1e-9 ? fields.mag[c] / fields.maxMag : 0;
          const [r, g, b] = jetColor(tv);
          img.data[idx] = r; img.data[idx+1] = g; img.data[idx+2] = b;
        }
        img.data[idx+3] = 255;
      }
    }
    offCtx.putImageData(img, 0, 0);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(off, 0, srcYStart, nx, srcH, 0, 0, W2, H2);

    // Mapping helpers from field coords (in the 3-tile space) to canvas
    const xScale = W2 / nx;
    const yScale = H2 / srcH;
    const xToCanvas = (i) => i * xScale;
    const yToCanvas = (yField) => (yField - srcYStart) * yScale;

    // ---- Reverse-flow overlay (Stroemungsabriss / Rezirkulation) ---
    // Any fluid cell with u_x < 0 indicates back-flow; paint these red.
    let nReverse = 0, nFluid = 0;
    ctx.fillStyle = 'rgba(220, 20, 20, 0.55)';
    for (let c = 0; c < nx * ny; c++) {
      if (wall[c]) continue;
      nFluid++;
      if (fields.ux[c] < 0) {
        nReverse++;
        const jLocal = (c / nx) | 0;
        const iLocal = c - jLocal * nx;
        for (let t = 0; t < TILES; t++) {
          const yC = yToCanvas(t * ny + jLocal);
          if (yC > -yScale && yC < H2) {
            ctx.fillRect(xToCanvas(iLocal), yC, xScale + 0.6, yScale + 0.6);
          }
        }
      }
    }
    lastStats = {
      reversePct: nFluid > 0 ? 100 * nReverse / nFluid : 0,
      nReverse, nFluid,
    };

    // ---- Streamlines (LIC-like) ------------------------------------
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
      for (let t = 0; t < TILES; t++) {
        ctx.beginPath();
        let prev = null;
        for (const p of pts) {
          const dx = xToCanvas(p.x);
          const dy = yToCanvas(t * ny + p.y);
          if (prev && Math.abs(p.y - prev.y) > ny / 2) {
            ctx.moveTo(dx, dy);
          } else if (prev) {
            ctx.lineTo(dx, dy);
          } else {
            ctx.moveTo(dx, dy);
          }
          prev = p;
        }
        ctx.stroke();
      }
    }

    // ---- Pitch divider lines ---------------------------------------
    ctx.save();
    ctx.strokeStyle = 'rgba(255,255,255,0.35)';
    ctx.setLineDash([4, 4]);
    ctx.lineWidth = 1;
    for (let t = 1; t < TILES; t++) {
      const yLine = yToCanvas(t * ny);
      if (yLine > 0 && yLine < H2) {
        ctx.beginPath();
        ctx.moveTo(0, yLine);
        ctx.lineTo(W2 - 40, yLine);
        ctx.stroke();
      }
    }
    ctx.restore();

    // ---- Labels ----------------------------------------------------
    ctx.fillStyle = '#fff';
    ctx.font = '11px ui-monospace, monospace';
    ctx.textAlign = 'left';
    // Central blade label sits inside the middle tile, near its top
    ctx.fillText('Schaufel n-1 (Nachbar)', 8, 14);
    ctx.fillText('Schaufel n',             8, yToCanvas(ny) + 14);
    ctx.fillText('Schaufel n+1 (Nachbar)', 8, yToCanvas(2 * ny) + 14);

    // Separation legend (small red square + label) if any reverse flow
    if (nReverse > 0) {
      ctx.fillStyle = 'rgba(220,20,20,0.8)';
      ctx.fillRect(W2 - 180, H2 - 22, 14, 14);
      ctx.fillStyle = '#fff';
      ctx.fillText('Rueckstroemung (u<0)', W2 - 162, H2 - 11);
    }

    // ---- Colour bar (right side) -----------------------------------
    const cbW = 14, cbH = H2 * 0.7;
    const cbX = W2 - 26, cbY = H2 * 0.15;
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
    ctx.fillStyle = '#fff';
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
    const state = { f, fnew, wall, nx, ny, ux_in, uy_in, tau };

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
        render(canvas, state);
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
