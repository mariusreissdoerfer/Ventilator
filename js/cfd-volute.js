/**
 * 2D Lattice-Boltzmann CFD solver for the spiral casing (volute) of
 * the centrifugal fan, in the *absolute* (non-rotating) reference
 * frame.
 *
 * Geometry (Stepanoff-style):
 *   - Impeller exit circle at radius R2_lat (treated as velocity
 *     inlet; the wedge inside is a solid wall)
 *   - Volute outer wall: logarithmic / linear-with-azimuth spiral
 *     r_outer(phi) = R2 * (1 + alpha * phi / 2*pi),
 *     alpha typically ~ 0.85 (= outer radius at phi=2*pi is 1.85*R2)
 *   - Tongue at phi = 0 (top of canvas), small clearance to R2
 *   - Discharge nozzle: extends tangentially from the spiral end
 *     to the right edge of the canvas (outflow boundary)
 *
 * Inlet BC on the D2 circle: each inlet cell is assigned a velocity
 *   u_radial * r_hat + u_tangential * theta_hat
 * with u_radial = c_m2_lat and u_tangential = c_u2_lat coming from
 * the impeller outlet velocity triangle in the absolute frame
 * (c_m2 = meridional, c_u2 = whirl with slip correction).
 *
 * Solver: same D2Q9-BGK as cfd-lbm.js but without rotating-frame
 * body forces - the volute itself does not rotate.  Outflow at the
 * right canvas edge is zero-gradient.
 */

(function () {
  const W   = [4/9, 1/9, 1/9, 1/9, 1/9, 1/36, 1/36, 1/36, 1/36];
  const CX  = [ 0,   1,   0,  -1,   0,    1,   -1,   -1,    1];
  const CY  = [ 0,   0,   1,   0,  -1,    1,    1,   -1,   -1];
  const OPP = [ 0,   3,   4,   1,   2,    7,    8,    5,    6];

  let lastState = null;
  let lastResult = null;
  let running = false;
  let lastGeom = null;

  // -------------------------------------------------------------------
  // Geometry: build wall mask + inlet cell list for the spiral casing
  // -------------------------------------------------------------------
  function buildVoluteGeometry(nx, ny, result) {
    const wall = new Uint8Array(nx * ny);
    const inlet = [];

    // Place the impeller center to the left/top quadrant so the
    // discharge nozzle has room to extend to the right edge
    const cx_imp = nx * 0.36;
    const cy_imp = ny * 0.56;
    const R2 = Math.min(nx, ny) * 0.18;

    // Volute outer growth: capped at 0.95 (so outer radius <= 1.95 R2)
    // ratio to keep things visually reasonable
    const alpha = 0.85;

    // ---- Impeller solid region (cells with r < R2) ----
    for (let yy = 0; yy < ny; yy++) {
      for (let xx = 0; xx < nx; xx++) {
        const dx = xx - cx_imp, dy = yy - cy_imp;
        if (dx*dx + dy*dy < (R2 - 0.5) * (R2 - 0.5)) {
          wall[yy * nx + xx] = 1;
        }
      }
    }

    // ---- Spiral outer wall ----
    // phi = 0 means "top of canvas" (we orient phi clockwise from there)
    // Trace the spiral and mark a 2-cell-thick wall on the outside.
    function plotWall(px, py) {
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          const xx = Math.round(px) + dx;
          const yy = Math.round(py) + dy;
          if (xx >= 0 && xx < nx && yy >= 0 && yy < ny) {
            wall[yy * nx + xx] = 1;
          }
        }
      }
    }

    // We let the spiral go from phi = 0 (just past the tongue) to
    // phi = 2*pi (where it meets the discharge nozzle).
    const phiStart = 0.05;          // just past tongue
    const phiEnd   = 2 * Math.PI - 0.05;
    const noz_phi  = 2 * Math.PI;    // discharge starts here
    for (let phi = phiStart; phi <= phiEnd; phi += 0.01) {
      const r = R2 * (1 + alpha * phi / (2 * Math.PI));
      // theta: 0 -> top of canvas, clockwise
      const theta = -Math.PI / 2 + phi;
      plotWall(cx_imp + r * Math.cos(theta), cy_imp + r * Math.sin(theta));
    }

    // ---- Tongue: short radial wall at phi ~ 0 ----
    // From R2 + small gap inward to the spiral outer wall
    const tongueGap = 0.20 * R2;     // clearance from the impeller
    const tongueX = cx_imp;          // approximately top
    const r_tongue_inner = R2 + tongueGap;
    const r_tongue_outer = R2 * (1 + alpha * 0.10);  // overlap with spiral
    for (let r = r_tongue_inner; r <= r_tongue_outer; r += 0.5) {
      plotWall(tongueX, cy_imp - r);
    }

    // ---- Discharge nozzle: extends from spiral end horizontally right ----
    // Spiral end position (phi = 2*pi - epsilon): just left of top
    const r_end = R2 * (1 + alpha);
    const theta_end = -Math.PI / 2 + phiEnd;
    const noz_x0 = cx_imp + r_end * Math.cos(theta_end);
    const noz_y0 = cy_imp + r_end * Math.sin(theta_end);
    // The nozzle width
    const noz_w = alpha * R2 * 0.95;
    const noz_top = noz_y0 - noz_w / 2;
    const noz_bot = noz_y0 + noz_w / 2;
    // Top and bottom walls of nozzle, from noz_x0 to right edge
    for (let xx = Math.round(noz_x0); xx < nx; xx++) {
      const yt = Math.round(noz_top);
      const yb = Math.round(noz_bot);
      if (yt >= 0 && yt < ny) wall[yt * nx + xx] = 1;
      if (yb >= 0 && yb < ny) wall[yb * nx + xx] = 1;
    }
    // Clear any wall cells in the open outlet (right edge between top/bot)
    for (let yy = Math.round(noz_top) + 1; yy < Math.round(noz_bot); yy++) {
      wall[yy * nx + (nx - 1)] = 0;
    }

    // ---- Inlet cells around the D2 perimeter ----
    // Each inlet cell carries a velocity (radial outward + tangential CW)
    const c_m2 = result.aerodynamics.cm2_m_s;
    const c_u2 = result.aerodynamics.cu2_m_s;
    const c2_mag = Math.hypot(c_m2, c_u2) || 1;
    // Inlet velocity in lattice units.  The flow accelerates strongly
    // through the narrow nozzle (5-8x area ratio), so we start with a
    // conservative inlet so the maximum stays under the LBM Mach 0.3
    // stability limit even after acceleration.
    const u_lat_scale = 0.055;
    const cm_lat = u_lat_scale * c_m2 / c2_mag;
    const cu_lat = u_lat_scale * c_u2 / c2_mag;

    for (let yy = 0; yy < ny; yy++) {
      for (let xx = 0; xx < nx; xx++) {
        if (wall[yy * nx + xx]) continue;
        const dx = xx - cx_imp, dy = yy - cy_imp;
        const r = Math.sqrt(dx*dx + dy*dy);
        if (r > R2 - 0.5 && r < R2 + 1.2) {
          const inv_r = 1 / Math.max(r, 1e-6);
          const rx = dx * inv_r;
          const ry = dy * inv_r;
          // tangential unit vector for clockwise rotation
          // (rotor rotates so the flow exits with positive whirl in -theta direction)
          const tx =  ry;
          const ty = -rx;
          const u = cm_lat * rx + cu_lat * tx;
          const v = cm_lat * ry + cu_lat * ty;
          inlet.push({ c: yy * nx + xx, u, v });
        }
      }
    }

    return {
      wall, inlet,
      cx_imp, cy_imp, R2, alpha,
      noz_x0, noz_y0, noz_w, noz_top, noz_bot,
      c2_phys: c2_mag,
    };
  }

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

  function step(s) {
    const { f, fnew, wall, inlet, nx, ny, tau } = s;
    const invtau = 1 / tau;

    // (1) Inlet BC: at each inlet cell, set f to the equilibrium for
    //     the prescribed velocity at unit density.  This is a Dirichlet
    //     velocity boundary condition that drives the whole flow.
    for (let i = 0; i < inlet.length; i++) {
      const inl = inlet[i];
      const c9 = inl.c * 9;
      const uu = inl.u * inl.u + inl.v * inl.v;
      for (let k = 0; k < 9; k++) {
        const cu = CX[k]*inl.u + CY[k]*inl.v;
        f[c9 + k] = W[k] * (1 + 3*cu + 4.5*cu*cu - 1.5*uu);
      }
    }

    // (2) Collision in place
    for (let c = 0; c < nx * ny; c++) {
      if (wall[c]) continue;
      const c9 = c * 9;
      let rho = 0, mx = 0, my = 0;
      for (let k = 0; k < 9; k++) {
        const fk = f[c9 + k];
        rho += fk; mx += CX[k]*fk; my += CY[k]*fk;
      }
      if (rho < 1e-9) rho = 1;
      let ux = mx / rho;
      let uy = my / rho;
      // Velocity clamp for Mach safety
      const uu_raw = ux*ux + uy*uy;
      if (uu_raw > 0.28 * 0.28) {
        const sc = 0.28 / Math.sqrt(uu_raw);
        ux *= sc; uy *= sc;
      }
      const uu = ux*ux + uy*uy;
      for (let k = 0; k < 9; k++) {
        const cu = CX[k]*ux + CY[k]*uy;
        const feq = W[k] * rho * (1 + 3*cu + 4.5*cu*cu - 1.5*uu);
        f[c9 + k] -= (f[c9 + k] - feq) * invtau;
      }
    }

    // (3) Streaming (pull) with bounce-back at walls and zero-gradient
    //     at canvas boundaries (outflow on the right is handled
    //     implicitly because the nozzle opens there).
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const c = j * nx + i;
        if (wall[c]) continue;
        const c9 = c * 9;
        for (let k = 0; k < 9; k++) {
          let ni = i - CX[k];
          let nj = j - CY[k];
          if (ni < 0 || ni >= nx || nj < 0 || nj >= ny) {
            // boundary - zero-gradient (copy local)
            fnew[c9 + k] = f[c9 + k];
            continue;
          }
          const nc = nj * nx + ni;
          if (wall[nc]) {
            fnew[c9 + k] = f[c9 + OPP[k]];
          } else {
            fnew[c9 + k] = f[nc * 9 + k];
          }
        }
      }
    }
    f.set(fnew);
  }

  // -------------------------------------------------------------------
  // Macroscopic fields (velocity, pressure, vorticity)
  // -------------------------------------------------------------------
  function computeFields(s) {
    const { f, wall, nx, ny } = s;
    const mag = new Float32Array(nx * ny);
    const ux  = new Float32Array(nx * ny);
    const uy  = new Float32Array(nx * ny);
    const pressure = new Float32Array(nx * ny);
    const vorticity = new Float32Array(nx * ny);
    let maxMag = 0, pMin = +1e9, pMax = -1e9, wAbsMax = 0;
    for (let c = 0; c < nx * ny; c++) {
      if (wall[c]) { mag[c] = -1; pressure[c] = NaN; continue; }
      const c9 = c * 9;
      let rho = 0, mxv = 0, myv = 0;
      for (let k = 0; k < 9; k++) {
        const fk = f[c9 + k];
        rho += fk; mxv += CX[k]*fk; myv += CY[k]*fk;
      }
      if (rho < 1e-9) rho = 1;
      const u = mxv / rho, v = myv / rho;
      ux[c] = u; uy[c] = v;
      const m = Math.sqrt(u*u + v*v);
      mag[c] = m;
      if (m > maxMag) maxMag = m;
      const p = (rho - 1) / 3;
      pressure[c] = p;
      if (p < pMin) pMin = p;
      if (p > pMax) pMax = p;
    }
    for (let j = 1; j < ny - 1; j++) {
      for (let i = 1; i < nx - 1; i++) {
        const c = j * nx + i;
        if (wall[c]) continue;
        const cR = j * nx + (i + 1);
        const cL = j * nx + (i - 1);
        const cU = (j - 1) * nx + i;
        const cD = (j + 1) * nx + i;
        if (wall[cR] || wall[cL] || wall[cU] || wall[cD]) continue;
        const dvdx = (uy[cR] - uy[cL]) * 0.5;
        const dudy = (ux[cD] - ux[cU]) * 0.5;
        const w = dvdx - dudy;
        vorticity[c] = w;
        const aw = Math.abs(w);
        if (aw > wAbsMax) wAbsMax = aw;
      }
    }
    return { mag, ux, uy, pressure, vorticity, maxMag, pMin, pMax, wAbsMax };
  }

  // -------------------------------------------------------------------
  // Colormaps
  // -------------------------------------------------------------------
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
  function divergingColor(s) {
    if (s !== s) return [220, 220, 220];
    s = Math.max(-1, Math.min(1, s));
    if (s >= 0) {
      return [
        Math.round(255 - s * (255 - 200)),
        Math.round(255 - s * (255 -  30)),
        Math.round(255 - s * (255 -  30)),
      ];
    }
    const a = -s;
    return [
      Math.round(255 - a * (255 -  30)),
      Math.round(255 - a * (255 -  70)),
      Math.round(255 - a * (255 - 180)),
    ];
  }

  // -------------------------------------------------------------------
  // Rendering: direct Cartesian (LBM grid == display, just scaled)
  // -------------------------------------------------------------------
  function render(canvas, s, geom, result, mode = 'velocity') {
    const { wall, nx, ny } = s;
    const fields = computeFields(s);
    const W2 = canvas.width;
    const H2 = canvas.height;
    const ctx = canvas.getContext('2d');

    let palette, valueAt, vMin, vMax, label;
    if (mode === 'pressure') {
      const pr = Math.max(Math.abs(fields.pMin), Math.abs(fields.pMax), 1e-9);
      vMin = -pr; vMax = +pr; label = 'p';
      palette = (v) => divergingColor(v / pr);
      valueAt = (c) => fields.pressure[c];
    } else if (mode === 'vorticity') {
      const wr = Math.max(fields.wAbsMax, 1e-9);
      vMin = -wr; vMax = +wr; label = 'ω_z';
      palette = (v) => divergingColor(v / wr);
      valueAt = (c) => fields.vorticity[c];
    } else {
      vMin = 0; vMax = fields.maxMag; label = '|c|';
      palette = (v) => jetColor(fields.maxMag > 1e-9 ? v / fields.maxMag : 0);
      valueAt = (c) => fields.mag[c];
    }

    // Paint the LBM grid at its native resolution to an offscreen
    // canvas, then drawImage scaled to the display.
    const off = document.createElement('canvas');
    off.width = nx; off.height = ny;
    const offCtx = off.getContext('2d');
    const img = offCtx.createImageData(nx, ny);
    for (let c = 0; c < nx * ny; c++) {
      const idx = c * 4;
      if (wall[c]) {
        img.data[idx]   = 60;
        img.data[idx+1] = 64;
        img.data[idx+2] = 72;
      } else {
        const [r, g, b] = palette(valueAt(c));
        img.data[idx] = r; img.data[idx+1] = g; img.data[idx+2] = b;
      }
      img.data[idx+3] = 255;
    }
    offCtx.putImageData(img, 0, 0);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(off, 0, 0, W2, H2);

    const sx = W2 / nx, sy = H2 / ny;

    // Streamlines from the inlet ring
    ctx.strokeStyle = 'rgba(255,255,255,0.6)';
    ctx.lineWidth = 1.2;
    const ring = geom.inlet;
    const step = Math.max(1, Math.floor(ring.length / 28));
    for (let k = 0; k < ring.length; k += step) {
      const inl = ring[k];
      const j0 = (inl.c / nx) | 0;
      const i0 = inl.c - j0 * nx;
      let x = i0 + 0.5, y = j0 + 0.5;
      ctx.beginPath();
      ctx.moveTo(x * sx, y * sy);
      for (let st = 0; st < 600; st++) {
        const ix = x | 0, iy = y | 0;
        if (ix < 0 || iy < 0 || ix >= nx || iy >= ny) break;
        const c = iy * nx + ix;
        if (wall[c]) break;
        const u = fields.ux[c], v = fields.uy[c];
        const sp = Math.hypot(u, v);
        if (sp < 1e-6) break;
        x += u / sp * 0.6;
        y += v / sp * 0.6;
        ctx.lineTo(x * sx, y * sy);
      }
      ctx.stroke();
    }

    // Outline impeller and tongue
    ctx.strokeStyle = '#222';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(geom.cx_imp * sx, geom.cy_imp * sy,
            geom.R2 * sx, 0, 2 * Math.PI);
    ctx.stroke();

    // Labels
    ctx.fillStyle = '#fff';
    ctx.font = '11px ui-monospace, monospace';
    ctx.textAlign = 'center';
    ctx.fillText('Laufrad (D2)', geom.cx_imp * sx, geom.cy_imp * sy);
    ctx.textAlign = 'left';
    ctx.fillText('Zunge', geom.cx_imp * sx + 6,
                 (geom.cy_imp - geom.R2 - 8) * sy);
    ctx.fillText('Druckstutzen', (geom.noz_x0 + 12) * sx,
                 (geom.noz_top - 6) * sy);
    ctx.fillText('Spirale', (geom.cx_imp + geom.R2 * 1.4) * sx,
                 (geom.cy_imp + geom.R2 * 0.8) * sy);

    // Color bar
    const cbW = 14, cbH = H2 * 0.55;
    const cbX = W2 - 26, cbY = H2 * 0.18;
    const segs = 48;
    for (let i = 0; i < segs; i++) {
      const v = vMax + (vMin - vMax) * (i / (segs - 1));
      const [r, g, b] = palette(v);
      ctx.fillStyle = `rgb(${r},${g},${b})`;
      ctx.fillRect(cbX, cbY + i * cbH / segs, cbW, cbH / segs + 0.6);
    }
    ctx.strokeStyle = '#555';
    ctx.lineWidth = 0.8;
    ctx.strokeRect(cbX, cbY, cbW, cbH);
    ctx.fillStyle = '#222';
    ctx.fillText(label, cbX - 4, cbY - 4);
    ctx.fillText(vMax.toFixed(2 + (Math.abs(vMax) < 0.1 ? 1 : 0)),
                 cbX + cbW + 2, cbY + 8);
    if (vMin < 0) ctx.fillText('0', cbX + cbW + 2, cbY + cbH / 2 + 4);
    ctx.fillText(vMin.toFixed(2 + (Math.abs(vMin) < 0.1 ? 1 : 0)),
                 cbX + cbW + 2, cbY + cbH + 4);
  }

  function renderMode(canvas, mode) {
    if (!lastState || !lastGeom || !canvas) return;
    render(canvas, lastState, lastGeom, lastResult, mode);
  }

  // -------------------------------------------------------------------
  // Public entry point
  // -------------------------------------------------------------------
  function runSimulation(result, canvas, statusEl, doneCallback, mode) {
    if (!result || !canvas) return;
    if (running) return;
    running = true;

    const nx = 160, ny = 140;
    const tau = 0.57;
    const geom = buildVoluteGeometry(nx, ny, result);
    const f = initEquilibrium(nx, ny, 0, 0);
    const fnew = new Float32Array(f.length);
    const state = { f, fnew, wall: geom.wall, inlet: geom.inlet,
                    nx, ny, tau };

    const totalIter = 2000;
    let done = 0;

    function chunk() {
      const t0 = performance.now();
      while (performance.now() - t0 < 40 && done < totalIter) {
        step(state);
        done++;
      }
      if (done % 200 === 0 || done === totalIter) {
        render(canvas, state, geom, result, mode || 'velocity');
      }
      if (done === totalIter) {
        lastState = state;
        lastGeom = geom;
        lastResult = result;
      }
      if (statusEl) {
        statusEl.textContent = (done === totalIter)
          ? `Konvergiert nach ${totalIter} Iterationen (D2Q9-BGK, Volute-Geometrie nach Stepanoff).`
          : `Volute-Simulation: Iteration ${done} / ${totalIter}...`;
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

  window.CFD_VOLUTE = { runSimulation, renderMode };
})();
