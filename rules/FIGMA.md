# Figma → DIR Conversion Skill

## 1. Purpose

This skill converts a Figma design into the project's **existing DIR JSON**. It does not define a new format, a new envelope or new node kinds. Its job is to tell you how to read Figma and express what you see in the DIR that already exists.

The pipeline is: **Figma + skills → DIR → TypeScript emitters.** You only produce the DIR. Do not write React, Next.js, Elementor, HTML or CSS implementation. A separate target skill may be stacked in the same prompt; code maps the DIR to that target later.

The design is provided to you as a parsed Figma document recovered locally from an uploaded native `.fig` file (or a REST API file JSON export). It contains pages, frames, groups, text, fills, strokes, corner radii, typography, Auto Layout, and component/instance references that the file actually exposed. Read only what is present; when a property is absent, follow the omission and diagnostics conventions instead of inventing values.

Core attitude: rebuild the design as it is in Figma. Preserve, do not improve. Never invent text, colors, fonts, spacing, assets, breakpoints, interactions or states.

---

## 2. DIR Shape (reference only, shown once)

Return **one DIR JSON object and nothing else** (no markdown fences, no comments, no explanations):

```
{
  "version": ...,
  "meta": { ... },
  "breakpoints": { ... },
  "globals": { ... },
  "assets": [ ... ],
  "pages": [
    { "sections": [ { "role": "<header|hero|features|footer|...>", "children": [ <node> ] } ] }
  ]
}
```

Allowed node kinds (use only kinds the DIR already defines):

| Kind | Use for | Key fields |
|---|---|---|
| `container` | layout groups, wrappers, rows, columns, grids | flex/grid settings, `children` |
| `heading` | titles and headlines | `text`, `level` |
| `text` | body copy, captions, labels, paragraphs | `html` |
| `button` | visible calls-to-action | label, link |
| `image` | photos and pictures | `src` |
| `iconBox` | icon + title + description blocks | icon, title, description |
| `nav` | visible menus | items |
| `form` | visible forms | fields |

Use the exact field names and value shapes from the project's DIR schema for size, spacing, color, typography and layout. If a field you want does not exist in the DIR, do not make it up: use the closest supported option.

---

## 3. Golden Rules

1. Output DIR only, one JSON object.
2. Use only existing DIR kinds and fields. Never invent `card`, `repeater`, `shape`, `vector`, `instance` or any new kind, and never add a parallel registry (components, styles, diagnostics).
3. Copy Figma text exactly. Do not rewrite, translate, correct, shorten or invent copy.
4. Keep exact visible colors, fonts, font sizes and spacing numbers from Figma.
5. Prefer Auto Layout (flex/grid) over guessed x/y positions.
6. Do not invent responsive rules, hover/disabled states, interactions, tokens or breakpoints.
7. Do not redesign, simplify or "improve" the file.
8. No framework or CSS code in the output.

---

## 4. Page Structure

1. **Sections.** Put every major page region in `pages[].sections[]` and give it a `role` (header, hero, features, footer, and so on) based on what the region visibly is. Use the Figma layer name as a hint, but trust the visible content.
2. **One page per page.** Each Figma page or top-level screen frame becomes one entry in `pages`. Do not merge different screens into one page.
3. **Section order.** Keep sections in the same top-to-bottom order as in Figma.
4. **Full-width bands.** If a section has a full-width background and its content sits in a narrower wrapper, keep both: the section carries the background, and an inner `container` carries the content width and layout. Do not add or remove wrappers to "clean up" the structure.
5. **Nested groups.** Put nested layout groups (a row of items, a column of text, a card body) in a `container` with flex or grid. Keep the same nesting depth as Figma where it affects layout.
6. **Groups without layout meaning.** A Figma group that has no fill, stroke, effect or layout role of its own may be merged into its parent. Never flatten a group that carries its own background, border, shadow, opacity or spacing.
7. **Hidden layers.** Do not output layers that are hidden in Figma unless the DIR has a field for visibility and the layer is needed (for example, part of a variant).

---

## 5. Element Mapping

8. **Titles → `heading`.** Map every title or headline to `heading`, not generic `text`. Set `level` from the visual hierarchy: the main page title is level 1, section titles level 2, card/sub titles level 3 and below. Do not use a level just to get a size.
9. **Body copy → `text`.** Map paragraphs, captions, labels and short descriptions to `text` and put the content in `html`.
10. **Mixed formatting in one paragraph.** If one text layer has bold words, different colors or links inside it, keep it as **one** `text` node and express the differences inside `html`. Do not split it into several nodes.
11. **Line breaks and lists.** Keep line breaks as they are. Keep bulleted or numbered lists as a list inside the same `html`, not as separate text nodes.
12. **CTAs → `button`.** Every visible call-to-action is a `button`. Keep its label text exactly, its fill, border, radius, padding and text style, and its link if Figma defines one. A layer is a button only if it clearly looks and reads like one or has a prototype click action. Do not turn plain text or a look-alike frame into a button.
13. **Photos → `image`.** Map photos and pictures to `image` with `src` pointing to the asset. Keep crop, fit and aspect ratio as Figma shows them.
14. **Icon + title + description → `iconBox`.** Use `iconBox` when a small icon, a title and a short description sit together as one block. If the pieces do not fit that pattern, use a `container` with its own children instead.
15. **Menus → `nav`.** Map a visible header, footer or sidebar menu to `nav`, with its items in the same order and with the same labels.
16. **Forms → `form`.** Map visible forms to `form`: inputs, labels, placeholders, submit button. Keep the visible placeholder and label text exactly. Do not add fields that are not in the design.
17. **Pure decoration.** Decorative vectors, blobs, lines or patterns with no clear DIR kind use the closest supported option (for example `image`, `icon` or `html`). Do not invent a kind. Keep decoration only if it is visible in the design.
18. **Dividers and spacers.** Express lines and empty spacing with the DIR's existing means (a border on a container, gap or padding). Do not create fake empty nodes only to push things apart if gap or padding can do it.

---

## 6. Layout

19. **Auto Layout → flex.** When a Figma frame has Auto Layout, map it to flex: horizontal → row, vertical → column. Keep gap, padding, main-axis alignment (start, center, end, space-between) and cross-axis alignment exactly as Figma has them.
20. **Grid.** Map Figma grid layouts, or wrapped Auto Layout with equal columns, to grid when the DIR supports it. Keep the column count and gaps from the source. Do not guess a column count from how the screenshot looks.
21. **Wrapping.** If Auto Layout wrapping is on, keep wrapping on. Do not freeze wrapped items into fixed positions.
22. **Padding and gap.** Use one value when all sides are equal and separate values only when they differ. Never collapse different top/right/bottom/left values into one number.
23. **Sizing.** Keep each element's sizing mode: fixed size stays fixed, "hug content" stays content-sized, "fill container" stays fill. Do not convert fill or hug into pixel widths. Keep min and max sizes only when Figma defines them.
24. **Absolute children.** If a child is absolute-positioned inside an Auto Layout frame (a badge, an overlay), keep it out of the normal flow and keep its position, using the DIR's existing positioning fields if they exist. Do not move it into the flow to simplify.
25. **Frames without Auto Layout.** If a frame has no Auto Layout, use the DIR's existing positioning shape and the child positions from Figma. Do not invent a flex layout the designer did not make.
26. **Clipping and overflow.** Keep clipping when a container clips its content (for example a rounded image frame).
27. **Stacking.** Keep children in the same order as Figma. Do not reverse or reorder them.

---

## 7. Visual Styling

28. **Colors.** Keep the exact colors from Figma. Do not invent a new palette, round colors to nearby ones or replace custom colors with generic ones. Use the DIR's field shape for colors (usually hex strings). Keep transparency when the design has it.
29. **Repeated colors and fonts → `globals`.** When the same color or font is used in many places, define it once in DIR `globals` and reuse it, as the DIR schema allows. If the file has named Figma styles or variables, use their names as the global names. Do not invent token names.
30. **Gradients.** Keep gradients as gradients, with the same direction and the same color stops. Never replace a gradient with a single color. Use the DIR's gradient shape if it has one; if it has none, use the closest supported option and do not drop the gradient silently.
31. **Backgrounds.** A container's background is its own fill. Do not add an extra rectangle child just to show a background. A page-level background belongs in the page or document level fields of the DIR, not on a frame.
32. **Background images and overlays.** Keep a background image as the background of its container and keep a color or gradient overlay on top of it as a separate layer or fill, as the DIR allows. Do not merge image and overlay into one flattened image.
33. **Borders.** Keep border width, color and style. Keep per-side borders when sides differ.
34. **Corner radius.** Keep radius as one value when all corners are equal and per-corner values when they differ.
35. **Shadows and blurs.** Keep every shadow with its offset, blur, spread and color, in the same order. Keep layer blur and background blur. Never remove a shadow that changes the look.
36. **Opacity.** Keep layer opacity as layer opacity and fill opacity as fill opacity. Do not multiply or merge them. Hidden is not the same as transparent.

---

## 8. Typography

37. **Font identity.** Keep font family, weight (as a number when the DIR uses numbers) and italic exactly as Figma has them. Never replace a font with a similar one.
38. **Size and spacing.** Keep font size, line height, letter spacing and paragraph spacing exactly. Keep percentage values as percentages and pixel values as pixels. Do not round font sizes (14.5 stays 14.5).
39. **Alignment and case.** Keep text alignment (left, center, right, justify), text case (uppercase, lowercase, capitalize) and decoration (underline, strikethrough). Case is style, so the stored text keeps its original characters.
40. **Text color.** Keep text color exactly, including gradient text fills when the DIR can express them.
41. **Text box behavior.** Keep fixed-width wrapping text, auto-width text and truncation (max lines, ellipsis) as Figma defines them.
42. **Repeated text styles.** If many text layers use the same style, put that font/size/weight combination in `globals` and reuse it.

---

## 9. Components, Repeats and Reuse

43. **Components used many times.** If Figma has a component used many times, repeat its visible structure the same way each time (same container, same child order, same kinds). The content (text, image) of each copy comes from that instance.
44. **Repeated cards.** For card grids and lists, use one flex or grid container and repeat the same child pattern inside it. Do not invent `cards` or `repeater` kinds.
45. **Instance differences.** If one instance has different text, a different image or a hidden part, reflect only that difference in that copy. Do not change the other copies.
46. **Look-alikes.** Frames that only look similar but are not the same component stay as normal separate containers. Do not merge them.
47. **Variants.** Use a variant's visible content only for the variant that is actually placed in the design. Do not output every variant of a component set.
48. **Detached components.** Treat a detached instance as a normal container.

---

## 10. Assets

49. **Images.** Put each image once in `assets` and reference it by the asset reference from nodes. The same image used many times is one asset.
50. **Vectors and icons.** Reference icons and vector artwork as assets. Do not rasterize a vector and do not redraw it.
51. **Missing assets.** If an image cannot be exported or read, keep the node and its size and leave the asset reference out rather than making up an image or URL.
52. **Alt text.** Add alt text only if Figma or the project provides it. Do not generate descriptions from what the image looks like.

---

## 11. Responsive Behavior

53. **Evidence only.** Create responsive overrides only when Figma gives real evidence: multiple frames of the same screen at different widths, or responsive variants. A single frame produces no responsive rules.
54. **Breakpoints.** Use the project's breakpoint names from the DIR `breakpoints`. Do not invent new breakpoint widths or copy desktop values into other breakpoints.
55. **Matching frames.** Match elements across frames by component and position first, then by layer-name path and order. If a match is unclear, skip the override rather than guessing.
56. **Only differences.** A breakpoint override lists only what actually differs from the base: layout direction, sizes, spacing, visibility, text. Do not repeat unchanged values.
57. **Fluid behavior.** Auto Layout sizing (fill, hug), wrapping and min/max sizes already express fluid behavior. Keep them; do not turn them into extra breakpoint rules.

---

## 12. Interactions and States

58. **Links and actions.** Add a link or action only when Figma prototype data or a hyperlink defines it. Never create interactions from how a layer looks.
59. **Hover, pressed, disabled.** Add these only when Figma has real variants for them. Never invent a hover color or a disabled style.

---

## 13. Things You Must Never Do

- Rewrite, translate or invent text.
- Change fonts, font sizes, weights or colors.
- Replace a gradient with a solid color.
- Convert fill or hug into fixed pixels.
- Replace Auto Layout with guessed coordinates.
- Remove shadows, borders, blurs or asymmetric spacing and radii.
- Invent buttons, cards, kinds, fields, states, interactions, breakpoints or tokens.
- Output a second schema (components registry, override paths, diagnostics, key-order or ID schemes).
- Output React, Next.js, Elementor, HTML or CSS code, or anything outside the single DIR JSON object.

---

## 14. Final Check Before Output

- The output is one valid JSON object that follows the project's DIR shape.
- Every node kind is one the DIR defines.
- Headings are `heading`, CTAs are `button`, menus are `nav`, forms are `form`, icon blocks are `iconBox` where they fit.
- Text is identical to Figma.
- Colors, fonts, sizes, spacing, radii, shadows and gradients match the source.
- Layout uses flex/grid from Auto Layout, with no guessed coordinates.
- Responsive rules, states and interactions exist only where Figma has evidence.
- Nothing in the output is invented.
