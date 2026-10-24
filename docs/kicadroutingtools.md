# KiCadRoutingTools autoroute backend

`autoroute` can use [KiCadRoutingTools](https://github.com/drandyhaas/KiCadRoutingTools)
(a Rust-accelerated A* router) instead of Freerouting. It is **opt-in**:
Freerouting stays the default, and nothing changes unless you select it.

## Setup (once)

```bash
git clone https://github.com/drandyhaas/KiCadRoutingTools
cd KiCadRoutingTools
python3 -m venv .venv && .venv/bin/pip install numpy scipy shapely
.venv/bin/python build_router.py     # downloads the prebuilt router binary
```

Then point Flamingo at the checkout, either with environment variables

```bash
export FLAMINGO_KRT_DIR=/path/to/KiCadRoutingTools
export FLAMINGO_ROUTER=krt            # make it the default (optional)
```

or, for launches that do not see your shell (the Mac app), a settings file,
`~/.flamingo/config.json`:

```json
{ "krtDir": "/path/to/KiCadRoutingTools", "router": "krt" }
```

Environment variables win over the file. `FLAMINGO_KRT_PYTHON` overrides the
interpreter (default: `<krtDir>/.venv/bin/python`, then `python3`).

## Using it

- MCP: `autoroute` takes `router: "freerouting" | "krt"`; the HTTP `/api/route`
  body takes the same field. Omitted, it follows `FLAMINGO_ROUTER` / the config
  file, then Freerouting.
- Java is not needed for this backend.

## How it works

The board is written as a KiCad 10 `.kicad_pcb` (`exportKiCadPcb` in
`@flamingo/fab`; pad positions come from the same `padWorld` the DRC uses),
routed by `route.py`, and the new tracks/vias are read back
(`importKiCadRoutes`). Everything after that -- widen, zone stitching, undo --
is the existing shared pipeline.

Two things are worth knowing:

1. **Pours are not handed to the router.** Plane connectivity in Flamingo is
   decided by its own zone fill, so plane nets are routed as real copper and the
   pours are left to Flamingo.
2. **Boards with a fine-pitch part are routed in stages.** With, say, a
   0.35 mm-pitch QFN, routing every net in one run starves the part's escapes
   even though the same nets route fine in small groups. The plan is: signal
   nets in batches of 8 ordered by the fine-pitch part's pin number, then small
   supply nets, then each big rail alone on its own inner layer, then one retry
   pass for nets that still had unconnected pads. The routing grid is chosen
   from the finest pad pitch. Boards without a fine-pitch part are routed in a
   single run.

After import, any track end that touches (but is not inside) a same-net pad is
extended to the pad centre: the router counts overlapping copper as connected,
Flamingo's connectivity requires the end point inside the pad.

## Limitations

- One track width / clearance / via size per router run (tightest class of the
  run's nets); per-net clearances are passed through.
- Arc tracks in the router's output are rejected (it produces none today).
- Keepouts are not exported yet.

`FLAMINGO_KRT_DEBUG=1` logs each stage's arguments and the router's per-stage
failures.
