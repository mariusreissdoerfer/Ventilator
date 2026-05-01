/**
 * Material recommendations, mechanical properties and wear-protection
 * data for radial fans in cement plants.
 *
 * Based on:
 *   - DIN EN 10025-2 (S235, S355) - Re-eL data sheets
 *   - DIN EN 10028-2 (16Mo3 warmfest, hot-strength curves)
 *   - DIN EN 10088-3 (1.4571)
 *   - SSAB Hardox technical handbook
 *   - Special Metals Inconel 625 datasheet
 *   - VDI 3822 Bl. 5 (Erosion) and AD 2000 Merkblatt W 13
 *   - VDZ Merkblatt M-VT 4 "Verschleissschutz an Ventilatoren"
 *   - FKM-Richtlinie (rechnerischer Festigkeitsnachweis)
 *
 * Mechanical fields (all SI):
 *   density   kg/m^3
 *   E_modulus N/m^2  (Young's modulus at 20 degC)
 *   poisson   -
 *   alpha     1/K    (mean thermal expansion 20..400 degC)
 *   Rp02      N/mm^2 at room temperature (proof strength 0.2 %)
 *   reductionPerC slope of yield reduction per K above 20 degC,
 *                 in units of N/mm^2 per K (linear approximation
 *                 valid up to tempMax)
 */
const MATERIALS = {
  S235JR: {
    label: 'S235JR (DIN EN 10025-2)',
    use: 'Standard-Baustahl. Gehaeuse, Tragstrukturen, kaltes Reingas.',
    tempMax: 200,
    notes: 'Guenstig, gut schweissbar; nicht abriebfest.',
    density: 7850, E_modulus: 2.10e11, poisson: 0.30, alpha: 12e-6,
    Rp02: 235, reductionPerC: 0.16,
  },
  S355J2: {
    label: 'S355J2 (DIN EN 10025-2)',
    use: 'Hoeher belastete Schaufelraeder fuer kaltes/warmes Reingas.',
    tempMax: 250,
    notes: 'Hoehere Streckgrenze, Standard fuer Mittel-/Hochdruck-Profilraeder.',
    density: 7850, E_modulus: 2.10e11, poisson: 0.30, alpha: 12e-6,
    Rp02: 355, reductionPerC: 0.20,
  },
  '16Mo3': {
    label: '16Mo3 (DIN EN 10028-2, warmfest)',
    use: 'Heissgas-Schaufelraeder, Kiln-ID-Fan, Vorwaermer-Fan.',
    tempMax: 450,
    notes: 'Kriech- und zunderbestaendig. Ueblicher Werkstoff fuer Heissgas-Laeufer in Zementwerken.',
    density: 7850, E_modulus: 2.05e11, poisson: 0.30, alpha: 12e-6,
    Rp02: 280, reductionPerC: 0.18,
  },
  Hardox450: {
    label: 'Hardox 450 (SSAB)',
    use: 'Schaufelraeder mit hoher Verschleissbeanspruchung, Rohgas, Rohmuehle.',
    tempMax: 250,
    notes: 'Haerte ~ 450 HBW, Streckgrenze ~ 1250 N/mm2, sehr gute Abriebfestigkeit.',
    density: 7850, E_modulus: 2.10e11, poisson: 0.30, alpha: 12e-6,
    Rp02: 1250, reductionPerC: 1.0,
  },
  Hardox500: {
    label: 'Hardox 500 (SSAB)',
    use: 'Verschleissauflagen, Schaufelpanzerung, Spiralgehaeuse-Liner.',
    tempMax: 250,
    notes: 'Haerte ~ 500 HBW, hervorragend abriebfest, schweissbar mit Vorwaermung.',
    density: 7850, E_modulus: 2.10e11, poisson: 0.30, alpha: 12e-6,
    Rp02: 1400, reductionPerC: 1.1,
  },
  '1.4571': {
    label: '1.4571 / 316Ti (austenitisch)',
    use: 'Korrosive feuchte Gase, SO2/SO3-fuehrende Abgase nach Konditionierturm.',
    tempMax: 600,
    notes: 'Korrosionsbestaendig, deutlich teurer als ferritischer Stahl.',
    density: 8000, E_modulus: 2.00e11, poisson: 0.30, alpha: 16.5e-6,
    Rp02: 220, reductionPerC: 0.12,
  },
  Inconel625: {
    label: 'Inconel 625 (NiCr22Mo9Nb)',
    use: 'Spezialfaelle > 400 degC und korrosiv. Selten im Zementwerk.',
    tempMax: 900,
    notes: 'Sehr hochwertig; nur bei extremen Bedingungen wirtschaftlich.',
    density: 8440, E_modulus: 2.05e11, poisson: 0.31, alpha: 12.8e-6,
    Rp02: 460, reductionPerC: 0.20,
  },
};

/**
 * Approximate yield strength at operating temperature.
 * Linear derating from room-T data; saturates at 50 % of room value.
 */
function yieldAtTemperature(matKey, tempC) {
  const m = MATERIALS[matKey];
  if (!m) return 235;
  const dT = Math.max(0, (tempC ?? 20) - 20);
  const Rp = m.Rp02 - m.reductionPerC * dT;
  return Math.max(0.5 * m.Rp02, Rp);
}

/**
 * Wear-protection options for impeller and casing.
 */
const WEAR_PROTECTION = [
  {
    id: 'none',
    label: 'Keiner (Reingas)',
    appliesTo: 'Reingas-Reinluftventilatoren, Filter-Saugfans',
    typicalLifetime: '> 10 Jahre',
  },
  {
    id: 'wear-plates',
    label: 'Aufgeschweisste Verschleissbleche (Hardox 450/500)',
    appliesTo: 'Rohmuehle, Klinkerkuehler-Vent, Zementmuehle',
    typicalLifetime: '2 - 4 Jahre Schaufelpanzerung, 3 - 6 Jahre Gehaeuse',
  },
  {
    id: 'cr-carbide',
    label: 'Chrom-Karbid-Auftragsschweissung (CCO)',
    appliesTo: 'Hochabrasive Heissgase, Kiln-ID-Fan',
    typicalLifetime: '4 - 8 Jahre auf Schaufelfront',
  },
  {
    id: 'ceramic',
    label: 'Keramikkacheln (Al2O3 90+%)',
    appliesTo: 'Sehr feiner abrasiver Staub, Spiralzunge',
    typicalLifetime: '> 8 Jahre, jedoch stossempfindlich',
  },
  {
    id: 'tungsten-carbide',
    label: 'Wolframkarbid-Spritzschicht (HVOF)',
    appliesTo: 'Profilschaufeln, hochwertige Loesungen',
    typicalLifetime: '5 - 10 Jahre',
  },
];

/**
 * Choose a wear-protection scheme from operating conditions.
 */
function recommendWearProtection({ dustLoading, tempC, bladeType }) {
  if (!dustLoading || dustLoading < 1) return WEAR_PROTECTION[0];
  if (tempC > 300 && dustLoading > 30) return WEAR_PROTECTION[2];   // CCO
  if (dustLoading > 50) return WEAR_PROTECTION[1];                  // Hardox plates
  if (bladeType === 'backward-curved-airfoil') return WEAR_PROTECTION[4]; // HVOF
  return WEAR_PROTECTION[1];
}

window.MATERIALS = MATERIALS;
window.WEAR_PROTECTION = WEAR_PROTECTION;
window.recommendWearProtection = recommendWearProtection;
window.yieldAtTemperature = yieldAtTemperature;
