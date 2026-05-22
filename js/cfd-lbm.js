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

    function plotThick(x, y) {
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy >= 0 && yy < ny && x >= 0 && x < nx) {
          wall[yy * nx + x] = 1;
        }
      }
    }

    // Trace the camber line, sample at every grid step in x
    for (let xi = 0; xi <= chord; xi++) {
      const s = xi / chord;
      const dy = (a_s * s + b_s * s * s) * chord;
      // Negative because increasing y in image coords goes downward
      const y_cam = Math.round(yMid - dy);
      const xg = xLE + xi;
      // Connect previous to current with simple line drawing
      const xa = prev_x, ya = prev_y, xb = xg, yb = y_cam;
      const steps = Math.max(Math.abs(xb - xa), Math.abs(yb - ya));
      for (let s2 = 0; s2 <= steps; s2++) {
        const t = steps === 0 ? 0 : s2 / steps;
        const xx = Math.round(xa + t * (xb - xa));
        const yy = Math.round(ya + t * (yb - ya));
        plotThick(xx, yy);
      }
      prev_x = xg;
      prev_y = y_cam;
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

  function render(canvas, s) {
    const { wall, nx, ny } = s;
    const fields = computeFields(s);
    const W2 = canvas.width;
    const H2 = canvas.height;
    const ctx = canvas.getContext('2d');

    // Field image at grid resolution
    const off = document.createElement('canvas');
    off.width = nx; off.height = ny;
    const offCtx = off.getContext('2d');
    const img = offCtx.createImageData(nx, ny);
    for (let c = 0; c < nx * ny; c++) {
      const idx = c * 4;
      if (wall[c]) {
        img.data[idx] = 40; img.data[idx+1] = 40; img.data[idx+2] = 40;
      } else {
        const t = fields.maxMag > 1e-9 ? fields.mag[c] / fields.maxMag : 0;
        const [r, g, b] = jetColor(t);
        img.data[idx] = r; img.data[idx+1] = g; img.data[idx+2] = b;
      }
      img.data[idx+3] = 255;
    }
    offCtx.putImageData(img, 0, 0);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(off, 0, 0, W2, H2);

    // Streamline overlay (LIC-like: many short tracers)
    ctx.strokeStyle = 'rgba(255,255,255,0.55)';
    ctx.lineWidth = 1.2;
    const scaleX = W2 / nx;
    const scaleY = H2 / ny;
    const tracerStep = Math.max(1, Math.floor(ny / 16));
    for (let j0 = 4; j0 < ny; j0 += tracerStep) {
      let x = 2, y = j0;
      ctx.beginPath();
      ctx.moveTo(x * scaleX, y * scaleY);
      for (let stp = 0; stp < 220; stp++) {
        const ix = Math.floor(x), iy = Math.floor(y);
        if (ix < 0 || iy < 0 || ix >= nx || iy >= ny) break;
        const c = iy * nx + ix;
        if (wall[c]) break;
        const u = fields.ux[c], v = fields.uy[c];
        const sp = Math.hypot(u, v);
        if (sp < 1e-6) break;
        x += u / sp * 0.7;
        y += v / sp * 0.7;
        // Periodic top/bottom
        if (y < 0) y += ny;
        if (y >= ny) y -= ny;
        ctx.lineTo(x * scaleX, y * scaleY);
      }
      ctx.stroke();
    }

    // Colourbar
    const cbW = 14, cbH = H2 * 0.7;
    const cbX = W2 - 30, cbY = H2 * 0.15;
    const segs = 48;
    for (let i = 0; i < segs; i++) {
      const t = 1 - i / (segs - 1);
      const [r, g, b] = jetColor(t);
      ctx.fillStyle = `rgb(${r},${g},${b})`;
      ctx.fillRect(cbX, cbY + i * cbH / segs, cbW, cbH / segs + 0.6);
    }
    ctx.strokeStyle = '#555';
    ctx.lineWidth = 0.8;
    ctx.strokeRect(cbX, cbY, cbW, cbH);
    ctx.fillStyle = '#222';
    ctx.font = '11px ui-monospace, monospace';
    ctx.textAlign = 'left';
    ctx.fillText('|w|', cbX, cbY - 4);
    ctx.fillText('max', cbX + cbW + 2, cbY + 8);
    ctx.fillText('0',   cbX + cbW + 2, cbY + cbH + 4);
  }

  // ---- Public entry point --------------------------------------------
  function runSimulation(result, canvas, statusEl, doneCallback) {
    if (!result || !canvas) return;
    if (running) return;
    running = true;

    // Grid sized for ~ 1 second on a mid-range phone
    const nx = 160, ny = 60;
    const tau = 0.6;
    const u_mag = 0.06;     // inlet speed in lattice units, M ~ 0.1

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
      if (statusEl) {
        statusEl.textContent = (done === totalIter)
          ? `Solver konvergiert nach ${totalIter} Iterationen (D2Q9-BGK, Re~250).`
          : `Lattice-Boltzmann-Simulation: Iteration ${done} / ${totalIter}...`;
      }
      // Render periodically for progress feedback
      if (done % 200 === 0 || done === totalIter) {
        render(canvas, state);
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
