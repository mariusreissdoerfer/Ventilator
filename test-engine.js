// quick smoke test for fan-design.js
// run: node test-engine.js
global.window = {};
require('./js/fan-design.js');
const { sizeFan } = global.window.FanDesign;

function runCase(label, inp) {
  const r = sizeFan(inp);
  console.log('\n=== ' + label + ' ===');
  console.log(`Q=${inp.Q_m3h} m3/h  dp=${inp.dp_total_Pa} Pa  T=${inp.tempC} C  n=${inp.n_rpm} 1/min`);
  console.log(`rho=${r.state.rho_kg_m3.toFixed(3)} kg/m3   sigma=${r.state.sigma.toFixed(3)}  delta=${r.state.delta.toFixed(2)}`);
  console.log(`Blade: ${r.aerodynamics.bladeType}  psi=${r.aerodynamics.psi}`);
  console.log(`u2=${r.aerodynamics.u2_m_s.toFixed(1)} m/s   D2=${(r.geometry.D2_m*1000).toFixed(0)} mm   b2=${(r.geometry.b2_m*1000).toFixed(0)} mm`);
  console.log(`Z=${r.geometry.Z}  beta1_calc=${r.geometry.beta1_calc_deg.toFixed(1)}  beta2=${r.geometry.beta2_deg}`);
  console.log(`Slip=${r.aerodynamics.slipFactor.toFixed(3)}  cu2=${r.aerodynamics.cu2_m_s.toFixed(1)}  cm2=${r.aerodynamics.cm2_m_s.toFixed(1)}`);
  console.log(`P_hyd=${(r.power.P_hydraulic_W/1000).toFixed(1)} kW   P_shaft=${(r.power.P_shaft_W/1000).toFixed(1)} kW   P_motor=${(r.power.P_motor_W/1000).toFixed(1)} kW`);
  console.log(`Material: ${r.materials.wheelMaterial}  u2_lim=${r.materials.tipSpeedLimit_m_s} m/s   OK=${r.materials.tipSpeedOK}`);
  return r;
}

// Kiln ID fan, classic cement plant case
runCase('Kiln ID fan', {
  Q_m3h: 850000, dp_total_Pa: 8500, tempC: 340, pressurePa: 99000,
  dustLoading: 80, n_rpm: 990, bladeType: 'backward-curved', slipModel: 'wiesner',
});

// Cooler cooling fan (clean cold air, high pressure)
runCase('Cooler cooling fan', {
  Q_m3h: 110000, dp_total_Pa: 7000, tempC: 35, pressurePa: 99000,
  dustLoading: 0, n_rpm: 1490, bladeType: 'backward-curved-airfoil', slipModel: 'wiesner',
});

// Bag filter fan (large, low pressure, post-filter)
runCase('Bag filter fan', {
  Q_m3h: 900000, dp_total_Pa: 3500, tempC: 180, pressurePa: 99000,
  dustLoading: 0.05, n_rpm: 990, bladeType: 'backward-curved-airfoil', slipModel: 'wiesner',
});

// Auto blade selection
runCase('Auto-pick blade', {
  Q_m3h: 100000, dp_total_Pa: 5000, tempC: 20, pressurePa: 101325,
  dustLoading: 0, n_rpm: 1485, bladeType: 'auto', slipModel: 'wiesner',
});
