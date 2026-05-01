/**
 * Material recommendations and wear-protection guide for radial fans in
 * cement plants.
 *
 * Based on:
 *   - SSAB Hardox technical handbook
 *   - VDI 3822 Bl. 5 (Erosion) and DIN EN 10025-2 (structural steels)
 *   - VDZ Merkblatt M-VT 4 "Verschleissschutz an Ventilatoren"
 *   - Manufacturer references Venti Oelde / Reitz / Howden
 */

const MATERIALS = {
  S235JR: {
    label: 'S235JR (DIN EN 10025-2)',
    use: 'Standard-Baustahl. Gehaeuse, Tragstrukturen, kaltes Reingas.',
    tempMax: 200,
    notes: 'Guenstig, gut schweissbar; nicht abriebfest.',
  },
  S355J2: {
    label: 'S355J2 (DIN EN 10025-2)',
    use: 'Hoeher belastete Schaufelraeder fuer kaltes/warmes Reingas.',
    tempMax: 250,
    notes: 'Hoehere Streckgrenze, Standard fuer Mittel-/Hochdruck-Profilraeder.',
  },
  '16Mo3': {
    label: '16Mo3 (DIN EN 10028-2, warmfest)',
    use: 'Heissgas-Schaufelraeder, Kiln-ID-Fan, Vorwaermer-Fan.',
    tempMax: 450,
    notes: 'Kriech- und zunderbestaendig. Ueblicher Werkstoff fuer Heissgas-Laeufer in Zementwerken.',
  },
  Hardox450: {
    label: 'Hardox 450 (SSAB)',
    use: 'Schaufelraeder mit hoher Verschleissbeanspruchung, Rohgas, Rohmuehle.',
    tempMax: 250,
    notes: 'Haerte ~ 450 HBW, Streckgrenze ~ 1250 N/mm2, sehr gute Abriebfestigkeit.',
  },
  Hardox500: {
    label: 'Hardox 500 (SSAB)',
    use: 'Verschleissauflagen, Schaufelpanzerung, Spiralgehaeuse-Liner.',
    tempMax: 250,
    notes: 'Haerte ~ 500 HBW, hervorragend abriebfest, schweissbar mit Vorwaermung.',
  },
  '1.4571': {
    label: '1.4571 / 316Ti (austenitisch)',
    use: 'Korrosive feuchte Gase, SO2/SO3-fuehrende Abgase nach Konditionierturm.',
    tempMax: 600,
    notes: 'Korrosionsbestaendig, deutlich teurer als ferritischer Stahl.',
  },
  Inconel625: {
    label: 'Inconel 625 (NiCr22Mo9Nb)',
    use: 'Spezialfaelle > 400 degC und korrosiv. Selten im Zementwerk.',
    tempMax: 900,
    notes: 'Sehr hochwertig; nur bei extremen Bedingungen wirtschaftlich.',
  },
};

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
