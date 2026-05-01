/**
 * 3D-Visualisierung des Ventilators auf Basis von three.js (UMD).
 *
 * Geometrie wird prozedural aus den Auslegungs-Parametern erzeugt:
 *
 *   - Tragscheibe (back disk)        Cylinder R = D2/2, Hoehe = 0.012 D2
 *   - Deckscheibe (front shroud)     Ringscheibe mit Saugauge D1
 *   - Schaufeln                      Z gewundene Streifen, Logarithmische
 *                                    Spirale mit beta(r) interpoliert
 *   - Nabe und Welle                 Zentrische Zylinder
 *
 * Beleuchtung: Ambient + Schluessel- + Fuelllicht.
 * Bedienung:  Pinch zum Zoomen, ein Finger drehen, zwei Finger
 *             panen (OrbitControls).
 *
 * Dies ist eine geometrische Visualisierung der Auslegung -- keine
 * 3D-CFD/FEM-Loesung.
 */

(function () {
  let three = null;

  function init(container) {
    if (three) return three;
    if (!window.THREE) {
      console.warn('three.js not loaded');
      return null;
    }

    const w = Math.max(1, container.clientWidth);
    const h = Math.max(1, container.clientHeight || 400);

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0xeff1f4);

    const camera = new THREE.PerspectiveCamera(45, w / h, 0.05, 200);

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(w, h, false);
    renderer.outputEncoding = THREE.sRGBEncoding || 3001;
    container.appendChild(renderer.domElement);

    // Touch + mouse drag uses orbit controls
    const controls = new THREE.OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.rotateSpeed = 0.7;

    // Lights
    scene.add(new THREE.AmbientLight(0xffffff, 0.55));
    const key = new THREE.DirectionalLight(0xffffff, 0.85);
    key.position.set(5, 10, 7);
    scene.add(key);
    const fill = new THREE.DirectionalLight(0xc4d2e8, 0.3);
    fill.position.set(-6, 4, -4);
    scene.add(fill);

    // Subtle ground plane for depth
    const ground = new THREE.Mesh(
      new THREE.CircleGeometry(50, 48),
      new THREE.MeshStandardMaterial({ color: 0xdadee5, roughness: 0.9 }),
    );
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -2;
    scene.add(ground);

    // ResizeObserver keeps the canvas in sync with the parent card
    const ro = new ResizeObserver(() => {
      const ww = container.clientWidth;
      const hh = container.clientHeight;
      if (ww > 0 && hh > 0) {
        camera.aspect = ww / hh;
        camera.updateProjectionMatrix();
        renderer.setSize(ww, hh, false);
      }
    });
    ro.observe(container);

    let prev = performance.now();
    function loop(now) {
      requestAnimationFrame(loop);
      controls.update();
      renderer.render(scene, camera);
      prev = now;
    }
    requestAnimationFrame(loop);

    three = { scene, camera, renderer, controls, group: null };
    return three;
  }

  function disposeGroup(g) {
    g.traverse((node) => {
      if (node.geometry) node.geometry.dispose();
      if (node.material) {
        if (Array.isArray(node.material)) node.material.forEach((m) => m.dispose());
        else node.material.dispose();
      }
    });
  }

  // ---- geometry builders --------------------------------------------------

  function spiralPoints(R_i, R_o, beta1Deg, beta2Deg, N, sign) {
    const pts = [];
    let theta = 0, prev_r = R_i;
    for (let i = 0; i <= N; i++) {
      const s = i / N;
      const radius = R_i + s * (R_o - R_i);
      const beta = (beta1Deg + (beta2Deg - beta1Deg) * s) * Math.PI / 180;
      const dr = radius - prev_r;
      if (i > 0 && Math.tan(beta) > 1e-3) {
        theta += dr / (prev_r * Math.tan(beta));
      }
      prev_r = radius;
      pts.push({ r: radius, theta: sign * theta });
    }
    return pts;
  }

  // A blade as an extruded ribbon with finite thickness.
  function buildBlade(R_i, R_o, beta1, beta2, b2, angularOffset, isForward, t_blade, mat) {
    const sign = isForward ? -1 : 1;
    const N = 32;
    const pts = spiralPoints(R_i, R_o, beta1, beta2, N, sign);

    // Build two offset spirals for blade thickness (outward normal in
    // the (x,z) plane).  For each spiral point, the local tangent
    // direction is along d/ds (r cos t, r sin t); the normal is
    // perpendicular.
    function offsetPoint(p, dist) {
      // tangent in 3D plane (xz)
      const x = p.r * Math.cos(p.theta + angularOffset);
      const z = p.r * Math.sin(p.theta + angularOffset);
      // normal direction approximately radial outward through angle
      // but rotated by 90° = (cos(θ+a + 90), sin(θ+a + 90))
      const nx = -Math.sin(p.theta + angularOffset);
      const nz =  Math.cos(p.theta + angularOffset);
      return { x: x + nx * dist, z: z + nz * dist };
    }

    const positions = [];
    const indices = [];

    // 4 vertex rings: front-low, front-high, back-low, back-high
    // (front = pressure side, back = suction side, in the local sense)
    function addRing(yVal, dist) {
      pts.forEach((p) => {
        const op = offsetPoint(p, dist);
        positions.push(op.x, yVal, op.z);
      });
    }

    const half = t_blade / 2;
    addRing(0,  +half); // 0: bottom front
    addRing(b2, +half); // 1: top    front
    addRing(0,  -half); // 2: bottom back
    addRing(b2, -half); // 3: top    back

    const stride = pts.length;
    function quad(a, b, c, d) {
      indices.push(a, b, c);
      indices.push(a, c, d);
    }
    // Front face (between 0 and 1)
    for (let i = 0; i < stride - 1; i++) {
      quad(0*stride + i, 0*stride + i + 1, 1*stride + i + 1, 1*stride + i);
    }
    // Back face (between 2 and 3) - reversed winding
    for (let i = 0; i < stride - 1; i++) {
      quad(2*stride + i, 3*stride + i, 3*stride + i + 1, 2*stride + i + 1);
    }
    // Top edge (between 1 and 3)
    for (let i = 0; i < stride - 1; i++) {
      quad(1*stride + i, 1*stride + i + 1, 3*stride + i + 1, 3*stride + i);
    }
    // Bottom edge (between 0 and 2)
    for (let i = 0; i < stride - 1; i++) {
      quad(0*stride + i, 2*stride + i, 2*stride + i + 1, 0*stride + i + 1);
    }
    // Inner cap (i=0, leading edge)
    indices.push(0, 1*stride, 3*stride);
    indices.push(0, 3*stride, 2*stride);
    // Outer cap (i = stride-1, trailing edge)
    const e = stride - 1;
    indices.push(0*stride + e, 2*stride + e, 3*stride + e);
    indices.push(0*stride + e, 3*stride + e, 1*stride + e);

    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geom.setIndex(indices);
    geom.computeVertexNormals();
    return new THREE.Mesh(geom, mat);
  }

  function buildImpellerGroup(r) {
    const group = new THREE.Group();

    const D2 = r.geometry.D2_m;
    const D1 = r.geometry.D1_m;
    const b2 = r.geometry.b2_m;
    const Z  = r.geometry.Z;
    const beta1 = Math.max(15, Math.min(60, r.geometry.beta1_calc_deg));
    const beta2 = r.geometry.beta2_deg;
    const isForward = r.aerodynamics.bladeType === 'forward-curved';

    const R_o = D2 / 2, R_i = D1 / 2;
    const t_disk   = 0.012 * D2;
    const t_shroud = 0.012 * D2;
    const t_blade  = 0.005 * D2;

    const steel = new THREE.MeshStandardMaterial({
      color: 0x6c7785, metalness: 0.7, roughness: 0.5,
    });
    const bladeMat = new THREE.MeshStandardMaterial({
      color: 0xc25d00, metalness: 0.4, roughness: 0.55,
    });
    const shaftMat = new THREE.MeshStandardMaterial({
      color: 0x404654, metalness: 0.85, roughness: 0.35,
    });
    const hubMat = new THREE.MeshStandardMaterial({
      color: 0x55606e, metalness: 0.6, roughness: 0.5,
    });

    // Tragscheibe (back disk)
    const back = new THREE.Mesh(
      new THREE.CylinderGeometry(R_o, R_o, t_disk, 96),
      steel,
    );
    back.position.y = -t_disk / 2;
    group.add(back);

    // Deckscheibe (front shroud, with eye hole)
    const shroudShape = new THREE.Shape();
    shroudShape.absarc(0, 0, R_o, 0, Math.PI * 2, false);
    const eyeHole = new THREE.Path();
    eyeHole.absarc(0, 0, R_i, 0, Math.PI * 2, true);
    shroudShape.holes.push(eyeHole);
    const shroudGeom = new THREE.ExtrudeGeometry(shroudShape, {
      depth: t_shroud, bevelEnabled: false,
    });
    shroudGeom.rotateX(-Math.PI / 2);
    const shroud = new THREE.Mesh(shroudGeom, steel);
    shroud.position.y = b2;
    group.add(shroud);

    // Blades
    for (let bi = 0; bi < Z; bi++) {
      const offset = (2 * Math.PI / Z) * bi;
      const blade = buildBlade(R_i, R_o, beta1, beta2, b2, offset, isForward, t_blade, bladeMat);
      group.add(blade);
    }

    // Nabe (hub)
    const hubR = Math.max(R_i * 0.35, 0.04);
    const hub = new THREE.Mesh(
      new THREE.CylinderGeometry(hubR, hubR, b2 + t_disk + t_shroud, 32),
      hubMat,
    );
    hub.position.y = b2 / 2;
    group.add(hub);

    // Welle (shaft)
    const shaftR = Math.max(0.07 * D2 / 2, 0.04);
    const shaftL = 1.2 * D2;
    const shaft = new THREE.Mesh(
      new THREE.CylinderGeometry(shaftR, shaftR, shaftL, 32),
      shaftMat,
    );
    shaft.position.y = -shaftL / 2 - t_disk;
    group.add(shaft);

    return group;
  }

  // ---- public update entrypoint ------------------------------------------

  function update(r) {
    const container = document.getElementById('three-container');
    if (!container) return;
    const t = init(container);
    if (!t) return;

    if (t.group) {
      t.scene.remove(t.group);
      disposeGroup(t.group);
    }
    const group = buildImpellerGroup(r);
    t.scene.add(group);
    t.group = group;

    // Camera position scaled to fan size
    const D2 = r.geometry.D2_m;
    t.camera.position.set(D2 * 1.4, D2 * 0.85, D2 * 1.4);
    t.controls.target.set(0, r.geometry.b2_m / 2, 0);
    t.controls.update();

    // Move ground below the rotor
    const ground = t.scene.children.find((c) => c.geometry && c.geometry.type === 'CircleGeometry');
    if (ground) ground.position.y = -D2 * 0.9;
  }

  window.ThreeModel = { update };
})();
