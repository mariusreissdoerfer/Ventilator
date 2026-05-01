# Radialventilator-Auslegung fuer die Zementindustrie

Web-App zur aerodynamischen und mechanischen Vor-Auslegung einstufiger
Radialventilatoren fuer die typischen Prozessventilatoren einer
Zementanlage.

## Bedienung

`index.html` direkt im Browser oeffnen - kein Build, keine Abhaengigkeiten.

```
xdg-open index.html        # Linux
open index.html            # macOS
start index.html           # Windows
```

Oder einen lokalen Webserver starten:

```
python3 -m http.server 8000
# dann http://localhost:8000 oeffnen
```

## Funktionen

* **Anwendungs-Presets**: typische Betriebspunkte fuer Kiln-ID, Rohmuehlen-,
  Vorwaermer-, Kuehler-, Kohlemuehlen-, Filter- und Zementmuehlen-Ventilator.
* **Aerodynamische Auslegung**: Cordier-Diagramm, Druck- und Lieferziffer,
  Slip-Faktor (Wiesner / Stodola), Pfleiderer-Schaufelzahl,
  Geschwindigkeitsdreieck am Schaufelaustritt.
* **Geometrie**: D2, D1, b2, beta1/beta2, Schaufelzahl, Skizze des Laufrads.
* **Kennlinie**: Druck- und Leistungskurve relativ zum Auslegungspunkt.
* **Werkstoffwahl**: Stahl-Empfehlung in Abhaengigkeit von Temperatur,
  Staubbeladung und Umfangsgeschwindigkeit.
* **Verschleissschutz**: Wahl zwischen Hardox-Auflagen, Cr-Carbid,
  Keramik oder HVOF-Wolframkarbid je nach Beanspruchung.
* **Festigkeitspruefung**: Vergleich der berechneten Umfangsgeschwindigkeit
  mit den werkstoffspezifischen Grenzen aus Herstellerkatalogen.

## Berechnungs-Grundlagen

Die Auslegung folgt der klassischen Stroemungsmaschinen-Theorie:

| Groesse | Definition |
| --- | --- |
| Spez. Drehzahl `sigma` | `omega * sqrt(Q) / (2 Y)^(3/4)` |
| Spez. Durchmesser `delta` | `D2 * (2 Y)^(1/4) / sqrt(Q)` |
| Druckziffer `psi` | `2 dp / (rho u2^2)` |
| Lieferziffer `phi` | `Q / (pi/4 D2^2 u2)` |
| Euler-Druck | `dp_th = rho u2 cu2` (drallfreier Eintritt) |
| Slip nach Wiesner | `1 - sqrt(sin beta2) / Z^0.7` |
| Slip nach Stodola | `1 - pi sin(beta2) / Z` |
| Schaufelzahl Pfleiderer | `Z ~ 6.5 (D2+D1)/(D2-D1) sin((beta1+beta2)/2)` |

Wichtige Quellen:
* Bommes / Fricke / Grundmann, *Ventilatoren*, Vulkan-Verlag
* Eck B., *Ventilatoren*, Springer
* Bohl / Elmendorf, *Stroemungsmaschinen 2*, Vogel
* Cordier O., *Aehnlichkeitsbedingungen fuer Stroemungsmaschinen*, BWK 1953
* Wiesner F.J., *A Review of Slip Factors for Centrifugal Impellers*,
  ASME J. Eng. Power, 1967
* ISO 5801, *Industrial fans - Performance testing*
* VDZ-Merkblatt M-VT 4, *Verschleissschutz an Ventilatoren*
* Duda, *Cement Data Book*, Bauverlag
* Labahn / Kohlhaas, *Cement Engineers' Handbook*, Bauverlag
* SSAB Hardox technical handbook

## Projektstruktur

```
index.html           # UI
css/styles.css       # Layout
js/fan-design.js     # Berechnungs-Engine (SI-Einheiten)
js/presets.js        # Typische Betriebspunkte Zementwerk
js/materials.js      # Werkstoffe und Verschleissschutz
js/app.js            # UI-Controller, Diagramme (SVG)
test-engine.js       # Smoke-Test der Engine fuer Node
```

Engine-Tests laufen unter Node:

```
node test-engine.js
```

## Hinweis

Die Anwendung liefert eine **Vor-Auslegung**. Eine ausgefuehrte
Stroemungs- und Festigkeitsrechnung (CFD / FEM) sowie die geltenden
Normen (DIN EN ISO 5801, DIN EN 14986 (ATEX), DIN EN 13463-1, AD 2000,
EN 13445, VDI 2056) sind im Auftragsfall verbindlich.
