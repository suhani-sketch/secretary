# Library scene assets

This directory holds the illustrated assets and scene definition for the **Library** world.

The scene definition (`library.scene.json`) is code-owned: it declares the palette,
spot coordinates, lighting model, ambient effects, and creature-behavior weights.

The illustrated assets are produced externally (image generation or hand-drawn) and
dropped into this directory by filename. The integration code loads them by convention.

## Files expected

| File | Required | Description |
|---|---|---|
| `library.reference.png` | recommended | Full master composition. Kept for reference. Not loaded at runtime. |
| `library.background.png` | **required** | Master composition **minus the reading desk foreground**. Loaded as the room's back layer. Opaque. |
| `library.foreground.png` | **required** | Reading desk + desk lamp + desk-top objects, on transparent background. Loaded above the creature so the creature sits BEHIND the desk when at `desk-seat`. |
| `ambient/library.dust.svg` | optional | Small animated dust motes for the lamp pools. If missing, dust ambient is skipped. |
| `ambient/library.page-turn.svg` | optional | Small SVG animation played when the creature is reading in the chair. If missing, page-turn is skipped. |

## Dimensions

All PNG assets are produced at **1200 × 2000 px** (portrait 3:5). Larger is
acceptable; smaller will be scaled up. Do not change the aspect ratio.

## Palette

The scene palette is scoped to the room container via CSS variables. Values are
in `library.scene.json`. The global app palette (dusty blush world, chat, rail)
is unaffected.

- Paper cream: `#E9DBC1`
- Walnut: `#4A3226`
- Muted olive: `#6B7053`
- Muted brass: `#B08B4C`
- Deep cocoa: `#2D1F1A`
- Warm lamp: `#D6A768`

## Spot coordinates

Spots (where the creature can be) are defined as fractional coordinates (0..1)
of the master illustration in `library.scene.json`. These are the design intent;
they will be **tuned to the produced master** once we see where the illustrator
actually painted the chair seat, desk chair, ladder base, and window perch.

## Once the assets are dropped in

1. Place `library.background.png` and `library.foreground.png` here.
2. Optionally place `ambient/library.dust.svg` and `ambient/library.page-turn.svg`.
3. Reload the app in Library scene. The renderer reads this directory by
   convention; no code change needed to swap illustrations.

## Prompt used to generate the master

The master illustration is produced from the prompt approved in the design
brief. Style guardrails: painterly editorial illustration, portrait 3:5,
warm/muted palette above, no text/logos/creatures/people.
