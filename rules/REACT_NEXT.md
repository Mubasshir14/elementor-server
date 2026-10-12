# React / Next.js → DIR Conversion Skill

## 1. Purpose

This skill converts a bounded React or Next.js source-project analysis snapshot into the project's **existing DIR JSON**. It does not define a new format, a new envelope, or new node kinds. Its job is to tell you how to read the inspected React/Next.js project snapshot and express what is actually present in the canonical DIR that already exists.

The pipeline is: **React/Next.js Snapshot + skills → DIR → TypeScript emitters.** You only produce the DIR. Do not write React, Next.js, Elementor, HTML, or CSS implementation code. A separate target skill (`ELEMENTOR_SKILL.md`) is stacked in the same prompt; code maps the DIR to that target later.

The design is provided to you as a bounded source-analysis JSON snapshot recovered locally from an uploaded React or Next.js ZIP archive without executing user code. It contains detected framework metadata (`react` or `nextjs`), router conventions (`app-router`, `pages-router`, or `react-spa`), routes/pages, component hierarchies, JSX element trees, extracted static copy, headings, buttons/links, forms, navigation structures, assets, and CSS/Tailwind style tokens that the archive actually exposed. Read only what is present; when a property is absent, omit it or record a diagnostic instead of inventing values.

Core attitude: rebuild the visible UI structure and styling as it exists in the React/Next.js source snapshot. Preserve, do not improve. Never invent text, colors, fonts, spacing, assets, breakpoints, interactions, or states.

---

## 2. DIR Shape (reference only, shown once)

Return **one DIR JSON object and nothing else** (no markdown fences, no comments, no explanations):

```
{
  "version": "1.0",
  "meta": {
    "sourceType": "react-next-zip",
    "sourceRef": "<upload-id-or-archive-ref>",
    "title": "<project-or-page-title>",
    "extractedAt": "<ISO-8601>"
  },
  "breakpoints": { ... },
  "globals": { ... },
  "assets": [ ... ],
  "pages": [
    { "id": "...", "name": "...", "path": "/", "sections": [ { "id": "...", "name": "...", "role": "<header|hero|features|footer|...>", "children": [ <node> ] } ] }
  ],
  "diagnostics": [ ... ]
}
```

Allowed node kinds (use only kinds the DIR already defines):

| Kind | Use for | Key fields |
|---|---|---|
| `container` | layout wrappers, `<section>`, `<div>`, `<main>`, `<header>`, `<footer>`, `<article>`, rows, columns, grids | flex/grid settings, `children` |
| `heading` | `<h1>`–`<h6>` and heading components | `text`, `level` |
| `text` | `<p>`, `<span>`, body copy, captions, labels, rich text | `html` |
| `button` | `<button>`, CTA `<Link>` / `<a>` elements styled as buttons | `label`, `href`, `variant` |
| `image` | `<img>`, Next.js `<Image>`, SVG/picture references | `src`, `alt` |
| `iconBox` | icon + title + description feature blocks | `icon`, `title`, `description` |
| `nav` | `<nav>` menus, header/footer navigation lists | `items` (`label`, `href`) |
| `form` | `<form>` blocks with visible `<input>`, `<textarea>`, `<select>`, submit button | `fields`, `submitLabel`, `action` |

Use the exact field names and value shapes from the project's DIR schema for size, spacing, color, typography, and layout.

---

## 3. Golden Rules

1. Output DIR only, one JSON object.
2. Use only existing DIR kinds and fields. Never invent custom component kinds (`card`, `modal`, `carousel`, `tabs`, `accordion`).
3. Copy static JSX text literals exactly. Do not rewrite, translate, summarize, or invent marketing copy.
4. When JSX contains dynamic expressions (e.g., `{user.name}` or `{items.map(...)}`), use the static fallback/default value if present in the snapshot, or preserve the literal placeholder label exposed by the snapshot and record an `info` or `warning` diagnostic when dynamic runtime data cannot be statically resolved.
5. Map CSS / Tailwind layout classes (`flex`, `flex-col`, `grid`, `grid-cols-*`, `gap-*`, `p-*`, `items-*`, `justify-*`) and inline styles directly to DIR layout and style fields when explicit values are known.
6. Do not invent responsive rules, hover states, colors, fonts, or tokens that are not evidenced in the project's CSS, Tailwind config, or component classes.
7. Do not execute or emit JavaScript/TypeScript code in the output.

---

## 4. Page & Route Structure

1. **Routes → `pages[]`.** Each discovered page route in the snapshot (e.g. `app/page.tsx` → `/`, `app/about/page.tsx` → `/about`, `pages/index.tsx` → `/`, or top-level SPA views in `src/App.tsx`) becomes a page entry in `pages[]` with its `path` and `name`.
2. **Shared Layouts.** When a Next.js `layout.tsx` or React shell wraps page content with a persistent `<Header>` / `<Navbar>` and `<Footer>`, include those shared sections in the page's `sections[]` in top-to-bottom visual order (`header` first, page content sections in the middle, `footer` last).
3. **Sections.** Map top-level semantic landmarks (`<header>`, `<nav>`, `<main>` children, `<section>`, `<footer>`) and top-level page component blocks (`<Hero />`, `<Features />`, `<Pricing />`, `<CTA />`, `<Footer />`) to `pages[].sections[]` with an appropriate `role` (`header`, `hero`, `features`, `content`, `testimonials`, `pricing`, `faq`, `cta`, `footer`, `custom`).
4. **Component Composition.** When a page renders an imported component whose analyzed structure is included in the snapshot, inline its visible structure as a `container` (or specific section/node) at the call site, passing static props where available in the snapshot.

---

## 5. Element Mapping

1. **Headings (`<h1>`–`<h6>`) → `heading`.** Map `<h1>` through `<h6>` to `kind: "heading"` with `level` `1` through `6` and exact `text`.
2. **Paragraphs & Inline Copy (`<p>`, `<span>`, `<blockquote>`, `<ul>`/`<ol>`) → `text`.** Map body text to `kind: "text"` with `html` (e.g. `"<p>Body copy</p>"`).
3. **Buttons & CTAs (`<button>`, `<a className="btn...">`, `<Link>`) → `button`.** Map visible action buttons and CTA links to `kind: "button"` with `label` and `href` (when an `href` string literal is present).
4. **Navigation (`<nav>`) → `nav`.** Map navigation bars and link groups to `kind: "nav"` with `items: [{ label, href }]` in source order.
5. **Images (`<img>`, `<Image>`) → `image`.** Map images to `kind: "image"` with `src` pointing to the asset path/URL and `alt` text when present in JSX, and register each referenced asset in top-level `assets[]`.
6. **Forms (`<form>`) → `form`.** Map `<form>` elements and their `<input>`, `<select>`, `<textarea>` children to `kind: "form"`, mapping input `name`, `type` (`text`, `email`, `tel`, `textarea`, `select`, `checkbox`, `password`), `label`, `placeholder`, and `required` attributes, plus the submit button text in `submitLabel`.
7. **Feature Cards (`iconBox` vs `container`).** When a component or JSX block consists of an icon/image + title + short description, map it to `iconBox` if it fits cleanly, or a `container` with `heading`/`text`/`image` children.

---

## 6. Styling, Tailwind & CSS Tokens

1. **Globals (`globals.colors`, `globals.typography`, `globals.spacing`).** Populate `globals` from CSS custom properties (`:root` variables in `globals.css`/`index.css`) and `tailwind.config.*` theme extensions present in the snapshot.
2. **Layout (`layout`).**
   - `flex` / `inline-flex` → `mode: "flex"`, `direction: "row"` (or `"column"` for `flex-col`).
   - `grid` → `mode: "grid"`, setting `columns` when `grid-cols-<n>` is explicit.
   - Preserve explicit gap, padding, and alignment (`justify-*`, `items-*`) when resolved in the snapshot.
3. **Responsive Overrides (`responsive`).** Only emit `tablet` or `mobile` overrides when explicit responsive prefixes (such as Tailwind `md:`, `sm:`, `lg:` or CSS `@media` rules) are present in the snapshot.

---

## 7. Diagnostics & Unsupported Runtime Features

- When the React/Next.js project relies on client-side state hooks (`useState`, `useEffect`), dynamic API fetching, third-party interactive widgets, or unresolvable dynamic routes, do not guess their runtime state. Emit a clear entry in `diagnostics[]` (`severity: "info"` or `"warning"`, `code`, `message`, `sourcePath`) and represent the static initial UI shell faithfully.
- Output only the single valid DIR JSON object.
