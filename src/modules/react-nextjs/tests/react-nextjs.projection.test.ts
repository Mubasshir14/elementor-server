import { describe, expect, it } from "vitest";
import { projectReactSnapshotForAi } from "../react-nextjs.projection.js";
import type { ReactNextProjectSnapshot } from "../react-nextjs.types.js";

describe("React/Next.js Snapshot AI Projection & Token Optimization", () => {
  const sampleSnapshot: ReactNextProjectSnapshot = {
    schemaVersion: "1.0",
    source: "react-next-zip",
    detectedFramework: "nextjs",
    routerConvention: "nextjs-app-router",
    packageRoot: "my-app/",
    packageInfo: {
      name: "acme-sparkle",
      version: "1.0.0",
      dependencies: [
        "react",
        "react-dom",
        "next",
        "tailwindcss",
        "lucide-react",
        "framer-motion",
        "clsx",
        "tailwind-merge",
        "lodash",
        "axios",
        "zod",
      ],
      devDependencies: ["typescript", "eslint", "prettier", "@types/node", "@types/react"],
      stylingSolutions: ["tailwind"],
    },
    stats: {
      sourceFileCount: 25,
      inspectedFileCount: 20,
      routeCount: 1,
      componentCount: 3,
      styleFileCount: 2,
      assetCount: 1,
      omittedFileCount: 0,
    },
    routes: [
      {
        id: "route-1",
        path: "/",
        name: "Home",
        sourceFile: "src/app/page.tsx",
        importedComponents: ["HeroSection", "UnusedHelper"],
        sections: [
          {
            id: "sec-hero",
            name: "Hero",
            role: "hero",
            tagName: "section",
            className: "w-full py-12 md:py-24 lg:py-32 xl:py-48 bg-gradient-to-b from-white to-gray-50",
            layoutHint: { mode: "flex", direction: "column", gapPx: 24 },
            headings: [
              {
                level: 1,
                text: "Holiday Magic Delivered",
                className: "text-3xl font-bold tracking-tighter sm:text-4xl md:text-5xl lg:text-6xl/none",
              },
            ],
            paragraphs: [
              "Create unforgettable moments with our handcrafted seasonal decor collection.",
            ],
            buttons: [
              {
                label: "Shop Now",
                href: "/shop",
                variant: "primary",
                className:
                  "inline-flex h-9 items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground shadow hover:bg-primary/90",
              },
            ],
            navItems: [],
            images: [{ src: "/hero.jpg", alt: "Holiday Tree", className: "w-full rounded-lg" }],
            forms: [],
            childComponents: ["HeroSection"],
          },
        ],
      },
    ],
    components: [
      {
        name: "HeroSection",
        sourceFile: "src/components/HeroSection.tsx",
        headings: [{ level: 2, text: "Sub-banner text" }],
        paragraphs: ["More info here"],
        buttons: [{ label: "Learn More", href: "/about" }],
        navItems: [],
        images: [],
        forms: [],
      },
      {
        name: "UnreferencedWidget",
        sourceFile: "src/components/UnreferencedWidget.tsx",
        headings: [{ level: 3, text: "Should be omitted because it's not referenced" }],
        paragraphs: ["Omitted paragraph"],
        buttons: [],
        navItems: [],
        images: [],
        forms: [],
      },
    ],
    styles: {
      colors: [
        { name: "primary", value: "#ff0000", source: "tailwind.config.js" },
        { name: "secondary", value: "#00ff00", source: "tailwind.config.js" },
      ],
      fonts: [{ name: "sans", family: "Inter", source: "globals.css" }],
      customProperties: { "--primary": "#ff0000" },
      tailwindConfigured: true,
      styleFiles: ["src/app/globals.css"],
    },
    assets: [{ id: "asset-1", path: "/hero.jpg", kind: "image" }],
    diagnostics: [
      {
        code: "ZIP_INSPECTION_DEBUG",
        message: "Internal unpacker debug entry that should never be sent to Groq AI",
        severity: "info",
      },
      {
        code: "ANOTHER_DEBUG",
        message: "Another verbose diagnostics message taking up prompt tokens",
        severity: "warning",
      },
    ],
  };

  it("projects the snapshot deterministically, omitting bloat while preserving all essential design context", () => {
    const projected = projectReactSnapshotForAi(sampleSnapshot);

    // 1. Diagnostics and raw dependencies must be omitted
    expect((projected as any).diagnostics).toBeUndefined();
    expect((projected as any).packageInfo).toBeUndefined();
    expect((projected as any).stats).toBeUndefined();

    // 2. Core framework & package info preserved
    expect(projected.detectedFramework).toBe("nextjs");
    expect(projected.routerConvention).toBe("nextjs-app-router");
    expect(projected.packageName).toBe("acme-sparkle");

    // 3. Route hierarchy & section content preserved
    expect(projected.routes).toHaveLength(1);
    const sec = projected.routes[0]!.sections[0]!;
    expect(sec.id).toBe("sec-hero");
    expect(sec.role).toBe("hero");
    expect(sec.layoutHint).toEqual({ mode: "flex", direction: "column", gapPx: 24 });
    expect(sec.headings).toEqual([{ level: 1, text: "Holiday Magic Delivered" }]);
    expect(sec.paragraphs).toEqual([
      "Create unforgettable moments with our handcrafted seasonal decor collection.",
    ]);
    expect(sec.buttons).toEqual([{ label: "Shop Now", href: "/shop", variant: "primary" }]);
    expect(sec.images).toEqual([{ src: "/hero.jpg", alt: "Holiday Tree" }]);

    // 4. Bulky CSS classes are stripped from element nodes
    expect((sec.headings![0] as any).className).toBeUndefined();
    expect((sec.buttons![0] as any).className).toBeUndefined();
    expect((sec.images![0] as any).className).toBeUndefined();

    // 5. Empty arrays are omitted
    expect((sec as any).navItems).toBeUndefined();
    expect((sec as any).forms).toBeUndefined();

    // 6. Only referenced components are included
    expect(projected.components).toHaveLength(1);
    expect(projected.components![0]!.name).toBe("HeroSection");
    expect(projected.components![0]!.headings).toEqual([{ level: 2, text: "Sub-banner text" }]);

    // 7. Styles and assets preserved
    expect(projected.styles?.colors).toHaveLength(2);
    expect(projected.styles?.fonts).toHaveLength(1);
    expect(projected.styles?.customProperties).toEqual({ "--primary": "#ff0000" });
    expect(projected.assets).toEqual([{ path: "/hero.jpg", kind: "image" }]);

    // 8. Token / size reduction ratio verification
    const originalJson = JSON.stringify(sampleSnapshot);
    const projectedJson = JSON.stringify(projected);
    expect(projectedJson.length).toBeLessThan(originalJson.length * 0.6); // at least 40% reduction
  });
});

