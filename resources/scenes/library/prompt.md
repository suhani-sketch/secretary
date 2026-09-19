# Library — master illustration prompt

The prompt below is the exact brief approved on 2026-09-19 for generating the
master Library composition. Iteration notes below.

---

Portrait 3:5, 1200 × 2000 px. Editorial hand-painted interior illustration.
Cozy private library / study, a quiet intelligent inhabitant's room. Painterly,
matte, watercolor-and-ink character. Sophisticated, refined, not cartoon,
not photorealistic, not glossy 3D, not children's-book, not fantasy concept art.

Back wall dominated by floor-to-ceiling walnut bookshelves, filled with muted-
spine books at varying heights and densities. Deep greens, oxblood, cream,
occasional brass-gilt accents. Textural only — no readable titles.

Mid-right: a large muted olive-green leather wingback reading chair as the primary
focal point. Tall back, substantial seat, worn rounded armrests, believable leather
texture, angled slightly toward viewer. Seat sized to comfortably hold a small
inhabitant later.

Beside the chair: brass floor lamp with cream fabric shade, casting a distinct
warm amber pool of light.

Just left of the chair: a small round dark-walnut side table with 2–3 stacked
books and one ceramic mug with subtle steam.

Left side / foreground: substantial wooden reading desk, large enough to be a real
workspace, secondary anchor. On the desk: a brass table lamp with cream lampshade,
an open book, a small sheaf of loose pages, a simple pen or quill. Desk positioned
so a small inhabitant could later sit BEHIND it with head visible above the surface.

Back center: a dark walnut rolling library ladder with subtle brass fittings,
leaning naturally against the bookshelves.

Far left: narrow, tall walnut-framed window. Exterior view is soft cloudy daylight
and vague hints of tree canopy — painterly, indistinct, never competing with
the interior.

Floor: warm walnut parquet or wide-plank floorboards, with strong but believable
forced perspective receding toward the back shelves. A substantial muted olive-
and-rust rug underneath the reading chair area, subtle geometric worn pattern.

Lighting: two warm amber lamp pools (one chair, one desk). Rest of the room falls
into warm cocoa shadow. Narrow window contributes cool soft daylight from left.
Contrast between cool window light and warm lamps is important. Atmospheric but
readable — never dark.

Palette: paper cream `#E9DBC1`, walnut `#4A3226`, muted olive `#6B7053`, muted
brass `#B08B4C`, deep cocoa `#2D1F1A`, warm lamp halo `#D6A768`. Muted throughout.
No pink, no purple, no neon, no cold gray, no pure black.

Compositional hierarchy: eye travels chair → warm lamp → side table → bookshelves
→ desk → window. Asymmetric. Chair not centered.

Restraint: no plants, no paintings, no wall decorations, no clocks, no candles,
no decorative clutter, no random objects, no UI elements. Only the furniture
and objects listed.

Material quality: walnut aged, leather worn, brass matte and aged, rug woven-
textured, walls subtly plaster/paper textured, everything physical and tactile.

No people, no animals, no creature, no mascot, no text, no logos.

---

## Generator-specific parameters

**Midjourney v6/v7 append:**

```
--ar 3:5 --style raw --stylize 200 --no text, logos, letters, people, animals, mascot, hands
```

**FLUX Pro (Replicate / fal):**

```
aspect_ratio: "3:5"
output_format: "png"
safety_tolerance: 2
```

**DALL-E 3 / GPT Image:**

Request "portrait 1024×1792." Embed style reinforcement in the prompt:
"portrait aspect, editorial hand-painted illustration, matte finish."

**Ideogram v2:**

Aspect `3:5`. Style `illustration` (not `realistic`). Magic Prompt: **off**.

---

## Iteration checklist

When a generation comes back, verify against these criteria before saving:

- [ ] Portrait 3:5 aspect
- [ ] Wingback chair mid-right, sized realistically
- [ ] Reading desk left-foreground, substantial
- [ ] Bookshelves floor-to-ceiling on back wall
- [ ] Warm amber pool on chair
- [ ] Warm amber pool on desk
- [ ] Cool window light from left
- [ ] Palette matches (no pink, no bright green, no gray)
- [ ] No text or logos anywhere
- [ ] No creatures, people, or mascots
- [ ] No visual clutter (no plants, no paintings, no decorative extras)
- [ ] Painterly, not cartoon, not photorealistic
- [ ] Chair seat and desk seat area readable — enough for a small creature to sit

If any criterion misses, re-prompt with the specific miss ("cluttered" → add
"editorial restraint, only major anchors visible"; "cartoon" → add "matte
painterly, no cel shading, no bold outlines").
