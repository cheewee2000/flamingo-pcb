# eink-cell board — design spec (2026-07-17)

Handheld cellular e-ink device board, designed through Flamingo (dogfood #2).
User approved 2026-07-17: overall design, engine slot feature, TP4056 charger,
JST-SH LRA hookup.

## Concept

- **Board:** 66 × 116 mm, 2-layer (jlcpcb-2l), rounded corners (r3), portrait,
  y-up, origin at board center. GND pours both sides.
- **Display:** GDEQ0426FT82 (4.26" 800×480, SSD1677) — glass 105.33 × 62.37 mm,
  adhesive-mounted **centered on the back** (not a placed component). Its
  24 mm FPC tails exit the glass bottom edge, pass through **milled slots**
  below the glass (see FT-variant section for verified geometry), and mate
  flip-lock FPC connectors on the front. Dual-contact connector (XUNPU
  FPC-05FB-24PH20, C2856831) removes the contact-face risk of the fold.
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

- Three tail slots at y=3.5 (bottom-left origin; superseded detail in the
  FT-variant section).
- FPC connectors above slots, entry toward slot.
- EPD boost cluster around connector.
- Walter vertical, left-of-center; header rows 20 mm apart.
- USB-C on the right edge (frontlight tail owns the old bottom-right spot);
  TP4056 + load share + battery JST bottom-left.
- Buttons: (±33, y≈25 & 45) edges. Piezo + DRV2605L + LRA JST top region.
- 4× M2 mounting holes (drill 2.2, pad 4.0), corners inset ~4 mm.
- Silk: version "v0.1", button labels, USB/VIN warning.

## Microphone (added mid-build at user request)

ICS-43434 I2S MEMS mic (C5656610), bottom-port → 0.5 mm NPTH acoustic hole
through the board at the port, placed in the strip above the display glass
(port at y≈111.8 > glass edge 110.7). Datasheet DS-000069: VDD 1.65–3.63 V,
0.1 µF bypass close-in; LR→GND = left mono; 100 kΩ pulldown on SD.
Wiring: WS→IO18 (H1.7), SCK→IO17 (H1.8), SD→IO16 (H1.9).

## Build-time verified facts (agents, 2026-07-17)

- TP4056 (TopPower REV 2.3): 1 TEMP→GND, 2 PROG (1.2 k → 1 A), 3 GND, 4 VCC,
  5 BAT, 6 STDBY, 7 CHRG (open-drain, low while charging), 8 CE→VCC; EP→GND.
- SI2301 & Si1308EDL: pad 1=G, 2=S, 3=D. SS34 & MBR0530WS: pad 1=K, 2=A.
- LEDs: C2286 pad1=A; C72043 pad2=A (they differ).
- Buttons: switch closes pads 1↔2; pads 3/4 are a shorted frame anchor (→GND).
  Note: wiring-verify read the family datasheet as top-actuated; user specified
  this part as side-press and the footprint silk shows an edge tab — kept as
  side-press per user intent, worth a physical check on first articles.
- DRV2605L DGS: 1 REG (1 µF req'd), 2 SCL, 3 SDA, 4 IN/TRIG→GND, 5 EN,
  6 VDD/NC→VDD, 7 OUT+, 8 GND, 9 OUT−, 10 VDD (1 µF + 0.1 µF).
- Display FPC: pin 1 on the LEFT in front view tail-down (GDEQ0426T82-FT01C
  drawing, 2025-12-22). After the fold through the slot, pin 1 lands on the
  board's +x side; J4 (FPC-05FB-24PH20, cable entry over its contact row) is
  rotated 180° to face the slot ⇒ **display pin k ↔ J4 pad 25−k**.
- Boost reference circuit (GDEQ0426T82 §8.2, vector-verified): D_pos SW→PREVGH;
  fly cap SW↔F; D F→GND (cathode GND); D PREVGL→F (anode PREVGL); VGH ties to
  PREVGH (no own cap); VSL has its own 4.7 µF; VGL ties to PREVGL + 4.7 µF.

## FT variant: three tails (frontlight | EPD | touch)

GDEQ0426**FT**82 = FT01C variant. Tails on the bottom edge (front view,
left→right): frontlight 6P | EPD 24P | touch 6P, 0.5 mm pitch, all
bottom-contact, pin 1 left in front view.

**Corrected 2026-07-17 from the FT01C drawing** (vector-measured +
dimension-verified; PDF cached at `boards/eink-cell/datasheets/`):

- All three tails are **24.0 mm** long (glass edge → contact tip). The
  earlier "12.5 mm tail" was a misread — 12.50 is the EPD *contact-section
  width* (24 pins × 0.5 mm).
- Flanking tails: outer stalk edge **10.00 mm from each glass side edge**,
  tail width 3.50 ⇒ contact centerlines 11.75 mm in from the glass edges =
  **±19.44 mm from panel center** (not ±9.6). Board x (glass edges at
  1.815/64.185, front-view-left ↔ board +x): touch **13.57**, frontlight
  **52.44**. Note: the drawing's front-view *sketch* draws the touch tail
  ~1.2 mm further inboard than its own 10.00 dim; dims trusted, slots sized
  generously to absorb this.
- EPD tail: 24.85 from glass left edge to contact-section left edge ⇒
  contact centerline 31.10 from glass left = board x **33.09**. Its
  bending/wide section is ~23.7 mm wide (board x ≈ 22.6–46.35) and passes
  through the slot.
- Touch tail carries a ~10.1 × ~4.8 mm **device area** (FT6336U + steel
  reinforcement) 10.9–20 mm down the tail — it must pass through the slot
  and lands flat on the front over the charger area (low parts only there).
- ⇒ **One merged milled slot** (user preference): 44 × 2 mm, plus a
  copper/via keepout band over it. All components moved out of the three
  tail landing zones on the front.
- **Connector orientation (XUNPU datasheet-verified, cached):** FPC-05FB
  is a REAR-flip connector — cable enters on the EAR-pad side, solder-tail
  row is the back. So J4/J5/J6 are **rot 0** (ears/mouth south toward the
  slot) and the mapping is **display pin k ↔ pad k** (NOT 25−k / 7−k;
  the fold mirror is absorbed by the connector's own pad order). Verified:
  J5's map lands exactly on the FT6336U CTP table; J4's NC pads = display
  NC pins.
- **USB-C**: user placed J1 top-left (17.75, y_top) plug out the top edge;
  C1/R3/R4 satellites nearby below it.
- **2026-07-17 v2: board grew to 66 × 126.5** (all content shifted +10.5 in y)
  to host a GNSS antenna strip below the slot.

- **Touch (J5, FPC-05FB-6PH20 rot 180 at (13.57,20)):** FT6336U — pin k ↔ pad
  7−k. Shares I2C with DRV2605L (0x38 vs 0x5A). INT→IO7 (H1.11). RST = RC
  (internal 3 kΩ pullup to VDDA + 4.7 µF C19 → ~14 ms; no free GPIO left).
  IOVCC/VDD on 3V3 (power-gated). I2C ≤400 kHz.
- **Frontlight (J6 rot 180 at (52.44,20)):** two channels, each 5 white LEDs in
  series, VF ≤ 15 V, IF ≤ 15 mA. 2× SGM3732 (C116578) boost: pins 1 SW, 2 GND,
  3 FB (200 mV), 4 CTRL (PWM 2–60 kHz), 5 VOUT (OVP 38 V), 6 VIN. RSET = 15 Ω
  (C203326) → 13.3 mA. L = 10 µH CY54 (C2929431); D = SS34 (open-LED OVP 38 V
  ⇒ ≥40 V diode + **50 V** output cap CL21B105KBFNNNE C28323; MBR0530 (30 V)
  is NOT safe here). Warm PWM→IO1 (H2.14), cool PWM→IO15 (H1.10).
  Mapping pin k ↔ pad 7−k: W−=pad6, W+=pad5, C−=pad2, C+=pad1.

## Microphone / mid-build additions

Mic: ICS-43434 (below). Flamingo gained: silk lines (display outline + tails
drawn on B.Silk), pad/net label layers, Lock & Route button, right-click pan,
command-aware footprint region parsing (courtyard arc bug). GPIO budget is now
FULL: only strap IO0 remains unassigned.

## Process

1. Slot feature (TDD, subagent) → rebuild, restart server.
2. Verify TP4056 pinout from datasheet (subagent).
3. Build board via MCP tools (parts_get everything first), net classes
   (power: 0.5 mm track; default signal 0.25).
4. Autoroute → run_drc → export_fab (no waiver) → screenshots → commit.

## GNSS antenna (added 2026-07-17, v2 board 66×126.5)

Ignion NN02-224 RUN mXTEND (C5702652) tuned for GNSS per Ignion AN
"GPS/Glonass/Beidou" + UM + DS (all cached in `boards/eink-cell/datasheets/`):

- Bottom antenna strip: copper/via keepout y 0–9.5 both layers (eval board
  clearance is 6.5 × 60; ours is taller because the user wants the antenna
  ≥3 mm off the board edge). GND zones start at y 9.5.
- ANT1 at (7.6, 4.5) rot 180 — body y 3–6, long axis parallel to the edge,
  corner placement per eval board. Pad 1 = feed (per DS footprint fig), at
  (13.217, 4.5); pad 2 is mechanical-only, left floating per DS.
- Feed: 2.0 mm-wide stub (DS "D" dim) north through a keepout gap
  (x 12.0–14.4), necking to 0.6 mm into the matching network.
- Matching (AN Fig 2): series 9.1 nH LQW18AN9N1G80 (L4, C2049208) then
  shunt 3.9 nH LQW15AN3N9B80 (L5, C1329507) to GND; nets ANT / GNSS_RF.
- GNSS_RF terminates at u.FL J7 (HRS U.FL-R-SMT-1(10), C88373) — jumper to
  the Walter module's GNSS u.FL. Note: Ignion recommends final matching
  verification on the assembled device (their free Oxion/support service).
- Bottom M2 holes now at (3.5/62.5, 13.5) — moved up out of the RF strip.
