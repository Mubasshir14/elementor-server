---
name: elementor-conversion-rulebook
description: Concise rules for turning the canonical DIR (produced by the Figma/Framer source rules) into valid native Elementor output. Preserves the design faithfully and never invents content or capabilities.
---

# Elementor Target Rules (DIR → Native Elementor)

## 0. Scope and authority

1. Your input is the project's **canonical DIR** JSON (the format defined in the source rules: `version`, `meta`, `breakpoints`, `globals`, `assets`, `pages[].sections[].children[]`). Do not define, extend, or replace the DIR shape.
2. Your output is **native Elementor JSON only**: a document of nested Elementor sections/containers and widgets, each with `id`, `elType`, `settings`, and `elements`. Do not output the DIR, HTML, CSS, JavaScript, React, or Markdown.
3. Do not invent a new schema, node kind, widget, control, or capability. If the DIR exposes something Elementor cannot represent, emit the closest supported Elementor widget and record a diagnostic — never a fabricated control.

## 1. Node-kind → Elementor mapping

4. Map each DIR node kind to a native Elementor element:
   - `heading` → Elementor **heading** widget; set `title` from the DIR `text` and `header_size` from `level` (h1–h6).
   - `text` → Elementor **text-editor** widget; set `editor` from the DIR `html`.
   - `button` → Elementor **button** widget; set `text` from `label` and `link.url` from the DIR link when present.
   - `image` → Elementor **image** widget; set `image.url` from the DIR `src`.
   - `iconBox` → an Elementor **icon-box** widget using its icon, title, and description fields.
   - `nav` → Elementor **nav-menu** (or a list of button/link widgets when a menu is not available).
   - `form` → Elementor **form** widget with the DIR `fields`.
   - `container` → an Elementor **container** (section/column/flex container) that holds `children`; never flatten a container that carries layout.
5. Keep the DIR's section order and parent–child nesting. Each DIR page becomes one Elementor page document; each DIR `section` becomes a top-level Elementor container with its `role` preserved as a CSS class or ID when the DIR provides one.

## 2. Preserve the design exactly

6. Copy text verbatim. Never rewrite, translate, correct, shorten, or invent copy.
7. Keep the exact colors, fonts, font sizes, weights, spacing, corner radii, borders, shadows, and gradients carried in the DIR. Put repeated values in Elementor **global** colors/fonts only when the DIR actually reuses them.
8. Preserve layout: honor the DIR's flex/grid direction, alignment, gap, and padding. Do not convert Auto Layout to guessed pixel positions, and do not convert flex to grid unless the DIR says so.
9. Preserve each image once in `assets` and reference it by the DIR asset reference. Do not rasterize vectors or invent image URLs. If the DIR marks an asset missing, leave the reference out and record a diagnostic.

## 3. Missing data and honesty

10. If a heading's text is missing in the DIR, emit the heading widget with an empty `title` rather than inventing text.
11. Never infer content (titles, labels, alt text, links) from IDs, layer names, filenames, or visual placement. Add a link or interaction only when the DIR carries one.
12. When the source format did not expose a property, omit it. Record what was omitted as a structured diagnostic; do not fabricate a value.

## 4. Responsive behavior and states

13. Add a responsive override only when the DIR carries real evidence (multiple frames or explicit breakpoint values). A single frame produces no responsive rules.
14. Add hover/pressed/disabled states or interactions only when the DIR carries them. Never invent a state.

## 5. Output contract

15. Output one native Elementor JSON document and nothing else — no Markdown fences, comments, or explanations.
16. Use deterministic, stable IDs derived from the DIR node IDs so repeated conversions of the same DIR produce identical output. No random or timestamp-based IDs.
17. Every widget must carry a valid `widgetType` and a `settings` object whose keys are real Elementor controls. Abort rather than emit an unknown control.
18. Keep the top-level document well-formed: a `content` array of sections/containers, each with `elType`, and widgets nested only where Elementor allows them.
19. Do not claim support for a widget, control, or Elementor version you have not been given. When unsure, choose the closest core Elementor widget and note the limitation.
20. If the DIR itself is invalid, stop and report the validation failure instead of producing partial or invented Elementor output.
