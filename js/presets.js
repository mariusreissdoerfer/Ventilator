/**
 * Typical operating points for the main process fans of a 3000..6000 t/d
 * cement plant (dry process, 5-stage preheater with calciner).
 *
 * Sources:
 *   - Duda, "Cement Data Book", 3rd ed., Bauverlag
 *   - Labahn/Kohlhaas, "Cement Engineers' Handbook", Bauverlag
 *   - VDZ Activity Report - Auswertungen Energieverbrauch Zementindustrie
 *   - Manufacturer brochures (Venti Oelde, Reitz, TLT, Howden, Pollrich)
 *   - "The 6 Main Process Fans in Cement Factory", cementequipment.org
 *
 * Values are typical means; site-specific design always overrides.
 */
const CEMENT_PRESETS = [
  {
    id: 'kiln-id',
    name: 'Kiln / Preheater ID-Ventilator (Hauptzugventilator)',
    description:
      'Foerdert die heissen, staubbeladenen Abgase aus dem Vorwaermer durch Konditionierturm und Filter. Toughest duty in the whole plant.',
    Q_m3h: 850000,
    dp_total_Pa: 8500,
    tempC: 340,
    pressurePa: 99000,
    dustLoading: 80,
    n_rpm: 990,
    bladeType: 'backward-curved',
    arrangement: 'SISW',
    notes: [
      'Heissgasbetrieb 280-380 degC, Anbackungen durch Rohmehlstaub',
      'Schaufelprofile mit Verschleissauflagen (Hardox/Cr-Carbide)',
      'Drehzahlregelung ueber Frequenzumrichter ist heute Standard',
      'Auslegung mit ca. 10 % Reserve auf Q und dp empfohlen',
    ],
  },
  {
    id: 'raw-mill',
    name: 'Rohmuehlenventilator (Raw Mill Fan)',
    description:
      'Erzeugt den Foerderstrom durch die Vertikalrohmuehle. Hoher Druckverlust ueber Sichter und Mahlbett.',
    Q_m3h: 600000,
    dp_total_Pa: 9000,
    tempC: 95,
    pressurePa: 99000,
    dustLoading: 60,
    n_rpm: 1490,
    bladeType: 'backward-curved',
    notes: [
      'Bei kombiniertem Mahltrocknungsbetrieb gleichzeitig Heizgastraeger',
      'Hohe Staubbeladung -> Verschleissschutz Pflicht',
      'Druckverhaeltnis dp/p ~ 0.09  -> noch inkompressibel auslegen',
    ],
  },
  {
    id: 'preheater-fan',
    name: 'Vorwaermer-Saugventilator',
    description:
      'Saugt durch den Wirbelschicht-Vorwaermer; arbeitet im hot raw gas.',
    Q_m3h: 950000,
    dp_total_Pa: 7500,
    tempC: 360,
    pressurePa: 99000,
    dustLoading: 90,
    n_rpm: 745,
    bladeType: 'backward-curved',
    notes: [
      'Niedrige Drehzahl wegen Festigkeit bei hoher Temperatur',
      'Wellenkuehlung mit Sperrluft empfohlen',
    ],
  },
  {
    id: 'cooler-vent',
    name: 'Klinkerkuehler Mittendruck-Entlueftung',
    description:
      'Foerdert die heisse Abluft des Rostkuehlers zur Tertiaerluftleitung oder Filter.',
    Q_m3h: 350000,
    dp_total_Pa: 2500,
    tempC: 260,
    pressurePa: 99000,
    dustLoading: 25,
    n_rpm: 1480,
    bladeType: 'backward-curved',
    notes: [
      'Mittlere Staubbeladung (groesserer Klinkerstaub, abrasiv)',
      'Dichtgehaeuse, Auswurfklappen fuer Klinkerbruchstuecke',
    ],
  },
  {
    id: 'cooler-cooling',
    name: 'Klinkerkuehler Kuehlluftgeblaese',
    description:
      'Drueckt Umgebungsluft in die Kuehlerkammern. Kaltgas, hoher Druck.',
    Q_m3h: 110000,
    dp_total_Pa: 7000,
    tempC: 35,
    pressurePa: 99000,
    dustLoading: 0,
    n_rpm: 1490,
    bladeType: 'backward-curved-airfoil',
    notes: [
      'Saubere Aussenluft -> Profilschaufel moeglich, hoher Wirkungsgrad',
      'Mehrere kleine Geblaese pro Kuehler, Drehzahlregelung pro Kammer',
    ],
  },
  {
    id: 'coal-mill',
    name: 'Kohlemuehlenventilator',
    description:
      'Foerdert Heissgas + Kohlenstaub durch Muehle und Sichter. ATEX Zone 22.',
    Q_m3h: 130000,
    dp_total_Pa: 7500,
    tempC: 80,
    pressurePa: 99000,
    dustLoading: 40,
    n_rpm: 1485,
    bladeType: 'radial-curved',
    notes: [
      'EX-Schutz gemaess ATEX-Richtlinie 2014/34/EU, Zone 22',
      'Funkenarme Lagerung, Erdung, Temperaturueberwachung',
      'Selbstreinigende Schaufelform (radial-curved) bevorzugt',
    ],
  },
  {
    id: 'bag-filter',
    name: 'Schlauchfilter Reingas-Saugventilator (RABH)',
    description:
      'Saugt durch den Hauptfilter der Ofenlinie. Gereinigtes Gas, gemaessigte Temperatur.',
    Q_m3h: 900000,
    dp_total_Pa: 3500,
    tempC: 180,
    pressurePa: 99000,
    dustLoading: 0.05,
    n_rpm: 990,
    bladeType: 'backward-curved-airfoil',
    notes: [
      'Reingas (Reststaub < 50 mg/Nm3) -> Profilschaufel ohne Verschleissschutz',
      'Toleriert Temperaturspitzen bis 220 degC bei Filterausfall',
    ],
  },
  {
    id: 'cement-mill',
    name: 'Zementmuehlenventilator',
    description:
      'Sichterluft fuer die Kugel- oder Vertikalmuehle der Zementmahlanlage.',
    Q_m3h: 280000,
    dp_total_Pa: 6500,
    tempC: 100,
    pressurePa: 99000,
    dustLoading: 35,
    n_rpm: 1485,
    bladeType: 'backward-curved',
    notes: [
      'Anbackungen durch Zementstaub auf Schaufelruecken moeglich',
      'Klopfwerk an Gehaeuse oder Hochdruck-Spuelluft an den Schaufeln',
    ],
  },
  {
    id: 'kiln-id-didw',
    name: 'Kiln ID-Ventilator (doppelflutig, 8000-10000 t/d)',
    description:
      'Doppelflutiger Hauptzugventilator fuer Grossanlagen. Beide Saugaugen ziehen aus dem Konditionierturm; Q_total wird auf zwei Laufradhaelften aufgeteilt -> kleinerer D2 oder geringerer u2 als bei einflutiger Bauart.',
    Q_m3h: 1500000,
    dp_total_Pa: 8500,
    tempC: 340,
    pressurePa: 99000,
    dustLoading: 80,
    n_rpm: 745,
    bladeType: 'backward-curved',
    arrangement: 'DIDW',
    notes: [
      'Axialschub durch Symmetrie ausgeglichen -> einfachere Lagerung',
      'Doppelte Anzahl Wellendichtungen, Sperrlufteindeckung beidseitig',
      'Spiralgehaeuse umfasst beide Halbradraeder, Eintrittskruemmer Y-foermig',
      'Bei Grossanlagen ueber 7000 t/d Standard-Bauart',
    ],
  },
  {
    id: 'bag-filter-didw',
    name: 'Schlauchfilter-Saugventilator (doppelflutig)',
    description:
      'Doppelflutige Bauart fuer sehr grosse Filterstroeme. Reingas-Bedingungen erlauben hochbeanspruchte Profilschaufelraeder mit hohem Wirkungsgrad.',
    Q_m3h: 1400000,
    dp_total_Pa: 3800,
    tempC: 180,
    pressurePa: 99000,
    dustLoading: 0.05,
    n_rpm: 745,
    bladeType: 'backward-curved-airfoil',
    arrangement: 'DIDW',
    notes: [
      'Reingas -> kein Verschleissschutz noetig',
      'Sehr grosser Volumenstrom -> doppelflutig waehlt geringere Drehzahl',
    ],
  },
  {
    id: 'custom',
    name: 'Custom (manuelle Eingabe)',
    description: 'Freie Eingabe aller Parameter. Keine Vorbelegung.',
    Q_m3h: 100000,
    dp_total_Pa: 5000,
    tempC: 20,
    pressurePa: 101325,
    dustLoading: 0,
    n_rpm: 1485,
    bladeType: 'auto',
    arrangement: 'SISW',
    notes: [],
  },
];

window.CEMENT_PRESETS = CEMENT_PRESETS;
