# eink-cell board — design spec (2026-07-17)

Handheld cellular e-ink device board, designed through Flamingo (dogfood #2).
User approved 2026-07-17: overall design, engine slot feature, TP4056 charger,
JST-SH LRA hookup.

## Concept

- **Board:** 66 × 116 mm, 2-layer (jlcpcb-2l), rounded corners (r3), portrait,
  y-up, origin at board center. GND pours both sides.
- **Display:** GDEQ0426FT82 (4.26" 800×480, SSD1677) — glass 105.33 × 62.37 mm,
  adhesive-mounted **centered on the back** (not a placed component). Its
  12.5 mm FPC tail exits the glass bottom edge, passes through a **15 × 2 mm
  milled slot** below the glass, and mates a 24-pin 0.5 mm flip-lock FPC
  connector on the front. Dual-contact connector (XUNPU FPC-05FB-24PH20,
  C2856831) removes the contact-face risk of the fold.
- **All other components on the front.**

## Engine feature: slotted mounting holes

Flamingo outlines are a single closed loop, so internal cutouts are not
expressible; excellon already emits G85 slots for slotted pad drills. Extend
`MountingHole` with optional `slotLength` (total length, > drill) and
`rotation` (deg CCW, slot long axis), plumbed through:
`add_mounting_hole` tool → ops → excellon (G85) → gerber annulus/mask
(stadium) → DRC (hole-to-hole & clearances treat slot as capsule) → zone fill
obstacle → renderer. Tests per layer of plumbing.

## Power

- 1S LiPo → JST-SH (C160388) → **VSYS** → Walter VIN (pin 28; 3.0–5.5 V,
  1.5 A peak — datasheet §3, §5.1).
- USB-C 16P (C165948), CC1/CC2 → 5.1 kΩ to GND. VBUS → TP4056 (C16581),
  PROG ≈ 1.2 kΩ → ~1 A. CHRG (open-drain, active while charging) sinks the
  red **charge LED** from VBUS. Pinout verified from TP4056 datasheet before
  wiring (subagent task).
- Load sharing: BAT+ → SI2301 P-FET (C306861) → VSYS with gate at VBUS
  (100 k pulldown); VBUS → Schottky → VSYS. System runs from USB while
  charging; battery charges undisturbed.
- Walter datasheet §5.1.1: **never power module USB-C and VIN together** —
  silkscreen warning near the module.
- Peripheral rail = Walter **3V3-OUT (pin 26, 250 mA max)**: display
  VCI/VDDIO + boost, DRV2605L. Deep sleep can power-gate all peripherals via
  pin 4 (3V3_EN strap/IO0).

## Walter mounting

Not on LCSC → two 1×14 through-hole 2.54 mm header rows, rows exactly
20.0 mm apart (datasheet Fig 4: 24.8 × 55.0 mm module, castellations at
2.54 mm pitch, 2.40 mm edge inset). Module solders on via headers or directly
on castellations. Antennas are module u.FL (LTE + GNSS) — no carrier RF.
Flashing: module USB-C (with power caveat) or UART0 via header pins 1–4.

## Display drive (GDEQ0426T82 datasheet Rev 1.0, §8.2 reference circuit)

L1 47 µH ≥500 mA; Q1 Si1308EDL; D1–D3 MBR0530; R_GDR 1 MΩ; R_RESE 2.2 Ω;
7× 4.7 µF/25 V (VSH2, neg pump, PREVGH, VSH1, VGH, VSL/VGL, 3V3 in);
3× 1 µF/25 V (VCI, VDD, VCOM). BS1 → GND (4-wire SPI). VPP NC.
FPC pinout (§5): 1 NC · 2 GDR · 3 RESE · 4 NC · 5 VSH2 · 6/7 NC · 8 BS1 ·
9 BUSY · 10 RES# · 11 D/C# · 12 CS# · 13 SCL · 14 SDA · 15 VDDIO · 16 VCI ·
17 VSS · 18 VDD · 19 VPP · 20 VSH1 · 21 VGH · 22 VSL · 23 VGL · 24 VCOM.

## Peripherals & GPIO map (Walter edge pin → ESP32-S3 IO)

| Function | Walter pin | IO |
|---|---|---|
| EPD SCK / MOSI / CS / DC / RST / BUSY | 8/9/10/11/12/13 | IO38/IO39/IO40/IO41/IO42/IO2 |
| I2C SDA / SCL (DRV2605L) | 23 / 24 | IO8 / IO9 |
| DRV2605L EN | 25 | IO10 |
| Buttons L1/L2 (left edge) | 5 / 6 | IO12 / IO11 |
| Buttons R1/R2 (right edge) | 15 / 16 | IO4 / IO5 |
| GP LED | 7 | IO13 |
| Piezo PWM | 17 | IO6 |

Buttons: 4× GT-TC018A-H0375-L1 (C963235) side-press, active-low to GND,
internal pullups, two per left/right board edge.
Haptics: DRV2605L (C527464, VSSOP-10) on I2C, LRA via second JST-SH
(C160388) — no LCSC LRA is reflowable; motor sourced off-LCSC (Vybronics).
Piezo: Murata PKLCS1212E4001-R1 (C113159, 12 mm, passive) on GPIO PWM.
LEDs: 0603, charge (red, hardware CHRG) + GP (GPIO), ~1 k series.

## Placement sketch (front, origin center)

- Slot centered x=0, y ≈ −54.3 (just below glass edge at −52.67).
- FPC connector above slot, entry toward slot.
- EPD boost cluster around connector.
- Walter vertical, left-of-center; header rows 20 mm apart.
- USB-C bottom edge right of slot; TP4056 + load share + battery JST nearby.
- Buttons: (±33, y≈25 & 45) edges. Piezo + DRV2605L + LRA JST top region.
- 4× M2 mounting holes (drill 2.2, pad 4.0), corners inset ~4 mm.
- Silk: version "v0.1", button labels, USB/VIN warning.

## Process

1. Slot feature (TDD, subagent) → rebuild, restart server.
2. Verify TP4056 pinout from datasheet (subagent).
3. Build board via MCP tools (parts_get everything first), net classes
   (power: 0.5 mm track; default signal 0.25).
4. Autoroute → run_drc → export_fab (no waiver) → screenshots → commit.
