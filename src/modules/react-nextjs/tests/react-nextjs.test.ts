import * as fflate from "fflate";
import { afterEach, describe, expect, it, vi } from "vitest";
import { analyzeReactNextProjectZip, inspectReactProjectZip } from "../react-nextjs.service.js";
import { inspectZip } from "../react-nextjs.validator.js";
import { runConversionPipeline } from "../../conversions/conversion-pipeline.js";
import { storage } from "../../storage/storage.service.js";
import { resetRuleCacheForTests } from "../../rules/rule-loader.js";
import { buildStoredZip } from "./zip-fixtures.js";
import { Readable } from "node:stream";

function createZipBuffer(files: Record<string, string | Uint8Array>): Buffer {
  const entries: Record<string, Uint8Array> = {};
  for (const [path, content] of Object.entries(files)) {
    entries[path] = typeof content === "string" ? Buffer.from(content, "utf8") : content;
  }
  return Buffer.from(fflate.zipSync(entries, { level: 6 }));
}

afterEach(() => {
  vi.unstubAllGlobals();
  resetRuleCacheForTests();
});

describe("React / Next.js ZIP inspection, bounded static analysis, and conversion pipeline", () => {
  it("analyzes a Next.js App Router project ZIP and extracts routes, components, layout, tokens, and copy without executing code", async () => {
    const zip = createZipBuffer({
      "my-next-app/package.json": JSON.stringify({
        name: "acme-marketing-site",
        version: "1.2.0",
        dependencies: {
          next: "14.2.5",
          react: "18.3.1",
          "react-dom": "18.3.1",
        },
        devDependencies: {
          tailwindcss: "3.4.1",
        },
      }),
      "my-next-app/tailwind.config.ts": `
        export default {
          theme: {
            extend: {
              colors: { brand: "#2563eb", accent: "#0f172a" }
            }
          }
        };
      `,
      "my-next-app/src/app/globals.css": `
        :root {
          --primary: #2563eb;
          --surface: #f8fafc;
        }
        body {
          font-family: "Inter", sans-serif;
        }
      `,
      "my-next-app/src/app/layout.tsx": `
        export default function RootLayout({ children }) {
          return (
            <html>
              <body>
                <header id="site-header" className="flex items-center justify-between px-6 py-4">
                  <nav>
                    <a href="/">Home</a>
                    <a href="/pricing">Pricing</a>
                  </nav>
                </header>
                {children}
                <footer id="site-footer" className="py-8">
                  <p>Copyright 2026 Acme Corp</p>
                </footer>
              </body>
            </html>
          );
        }
      `,
      "my-next-app/src/components/HeroBanner.tsx": `
        export function HeroBanner() {
          return (
            <div className="flex flex-col gap-6">
              <h1>Ship Elementor Pages Faster</h1>
              <p>Convert React and Next.js layouts into native Elementor containers.</p>
              <a href="/pricing" className="btn bg-brand-600 px-4 py-2 rounded">Start Free Trial</a>
            </div>
          );
        }
      `,
      "my-next-app/src/app/page.tsx": `
        import { HeroBanner } from "../components/HeroBanner";
        export default function HomePage() {
          return (
            <main>
              <section id="hero" className="grid grid-cols-2 gap-8">
                <HeroBanner />
                <img src="/images/dashboard-preview.png" alt="Dashboard preview" />
              </section>
            </main>
          );
        }
      `,
      "my-next-app/src/app/pricing/page.tsx": `
        export default function PricingPage() {
          return (
            <section id="pricing" className="grid grid-cols-3 gap-6">
              <h1>Simple Pricing</h1>
              <p>Choose the plan that fits your agency.</p>
              <button className="bg-blue-600">Contact Sales</button>
            </section>
          );
        }
      `,
      "my-next-app/public/images/dashboard-preview.png": new Uint8Array([137, 80, 78, 71]),
      "my-next-app/node_modules/evil-pkg/index.js": "throw new Error('must never be inspected or executed');",
    });

    const { inspection, snapshot } = await analyzeReactNextProjectZip(zip);

    expect(inspection.detectedFramework).toBe("nextjs");
    expect(inspection.routerConvention).toBe("nextjs-app-router");
    expect(inspection.packageName).toBe("acme-marketing-site");
    expect(inspection.routeCount).toBe(2);
    expect(inspection.componentCount).toBeGreaterThanOrEqual(1);
    expect(inspection.assetCount).toBe(1);

    expect(snapshot.routes.map((r) => r.path).sort()).toEqual(["/", "/pricing"]);
    const homeRoute = snapshot.routes.find((r) => r.path === "/")!;
    expect(homeRoute.sections.some((s) => s.role === "header")).toBe(true);
    expect(homeRoute.sections.some((s) => s.role === "footer")).toBe(true);
    expect(
      homeRoute.sections.some((s) =>
        s.headings.some((h) => h.text === "Ship Elementor Pages Faster"),
      ),
    ).toBe(true);

    expect(snapshot.styles.tailwindConfigured).toBe(true);
    expect(snapshot.styles.customProperties["--primary"]).toBe("#2563eb");
    expect(snapshot.styles.fonts[0]?.family).toBe("Inter");
  });

  it("analyzes a React SPA project ZIP with forms and state diagnostics", async () => {
    const zip = createZipBuffer({
      "package.json": JSON.stringify({
        name: "react-contact-portal",
        dependencies: {
          react: "^18.2.0",
          "react-dom": "^18.2.0",
        },
      }),
      "src/App.tsx": `
        import { useState } from "react";
        export function App() {
          const [submitted, setSubmitted] = useState(false);
          return (
            <section id="contact" className="flex flex-col gap-4">
              <h1>Get in Touch</h1>
              <p>Send us a message and our team will respond within 24 hours.</p>
              <form action="/api/contact">
                <input name="email" type="email" placeholder="you@example.com" required />
                <textarea name="message" placeholder="How can we help?" required />
                <button type="submit">Send Message</button>
              </form>
            </section>
          );
        }
      `,
    });

    const { inspection, snapshot } = await analyzeReactNextProjectZip(zip);
    expect(inspection.detectedFramework).toBe("react");
    expect(snapshot.routerConvention).toBe("react-spa");
    expect(snapshot.routes).toHaveLength(1);
    expect(snapshot.routes[0]?.sections[0]?.forms).toHaveLength(1);
    expect(snapshot.routes[0]?.sections[0]?.forms[0]?.fields).toHaveLength(2);
    expect(snapshot.routes[0]?.sections[0]?.forms[0]?.submitLabel).toBe("Send Message");
    expect(snapshot.diagnostics.some((d) => d.code === "DYNAMIC_CLIENT_STATE_DETECTED")).toBe(true);
  });

  it("enforces configurable ZIP entry and uncompressed size safety limits", async () => {
    const zip = createZipBuffer({
      "package.json": JSON.stringify({ name: "test", dependencies: { react: "18.0.0" } }),
      "src/App.tsx": "export default function App() { return <h1>Hello</h1>; }",
      "src/Extra.tsx": "export const x = 1;",
    });

    await expect(inspectZip(zip, { maxEntries: 2 })).rejects.toMatchObject({ code: "ZIP_ENTRY_COUNT_EXCEEDED" });
    await expect(inspectZip(zip, { maxEntryBytes: 10 })).rejects.toMatchObject({ code: "ZIP_ENTRY_SIZE_EXCEEDED" });
    await expect(inspectReactProjectZip(zip)).resolves.toMatchObject({
      detectedFramework: "react",
    });
  });

  it("accepts a turbopack cache entry above the per-entry limit and keeps it out of analysis output", async () => {
    // Mirrors the reported intake-archive.zip failure: a 75,614,418-byte
    // `.next/dev/cache` entry against the 64 MiB per-entry limit. The declared
    // header sizes model the metadata; the stored payload stays tiny so the
    // test would fail if anything tried to read or decompress the entry.
    const zip = buildStoredZip([
      {
        name: "intake-archive/package.json",
        data: JSON.stringify({ name: "next-app", dependencies: { next: "14.2.5", react: "18.3.1" } }),
      },
      {
        name: "intake-archive/src/app/page.tsx",
        data: "export default function Page() { return <h1>Hello</h1>; }",
      },
      {
        name: "intake-archive/.next/dev/cache/turbopack/acba4a6b/00005344.sst",
        data: Buffer.from("x"),
        declaredUncompressed: 75_614_418,
        declaredCompressed: 75_614_418,
      },
    ]);

    const { inspection, snapshot } = await analyzeReactNextProjectZip(zip);
    expect(inspection.detectedFramework).toBe("nextjs");
    expect(inspection.packageRoot).toBe("intake-archive/");
    // The generated entry never enters routes, components, assets, or any text
    // buffer that feeds DIR generation and conversion input.
    expect(JSON.stringify(snapshot)).not.toContain("turbopack");
    expect(JSON.stringify(snapshot)).not.toContain("00005344.sst");
    expect(JSON.stringify(snapshot)).not.toContain(".next/dev/cache");
    // The non-blocking informational summary names what was skipped.
    expect(
      snapshot.diagnostics.some(
        (d) => d.code === "GENERATED_FILES_EXCLUDED" && /excluded from source inspection/i.test(d.message),
      ),
    ).toBe(true);
    // The real source file is still fully analyzed.
    expect(snapshot.routes.some((route) => route.sourceFile === "src/app/page.tsx")).toBe(true);
  });

  it("runs the full React/Next.js ZIP snapshot through REACT_NEXT.md + ELEMENTOR_SKILL.md conversion pipeline", async () => {
    process.env.AI_PROVIDER = "groq";
    process.env.AI_API_KEY = "test-key";
    process.env.AI_MODEL = "test-model";

    const zip = createZipBuffer({
      "package.json": JSON.stringify({
        name: "next-landing",
        dependencies: { next: "14.2.0", react: "18.2.0" },
      }),
      "app/page.tsx": `
        export default function Page() {
          return (
            <section id="hero">
              <h1>Modern Cloud Storage</h1>
              <p>Private B2 object storage for all conversion artifacts.</p>
              <button>Get Started</button>
            </section>
          );
        }
      `,
    });

    const { snapshot } = await analyzeReactNextProjectZip(zip);
    const snapshotKey = `imports/test-react-conv/snapshot-${Date.now()}.json`;
    const serialized = Buffer.from(JSON.stringify(snapshot), "utf8");
    await storage.putObject(snapshotKey, Readable.from(serialized), serialized.length);

    const validDirResponse = {
      version: 1,
      meta: { sourceType: "react-next-zip", title: "next-landing" },
      breakpoints: {},
      globals: {},
      assets: [],
      pages: [
        {
          sections: [
            {
              role: "hero",
              children: [
                { kind: "heading", text: "Modern Cloud Storage", level: 1 },
                { kind: "text", html: "<p>Private B2 object storage for all conversion artifacts.</p>" },
                { kind: "button", label: "Get Started" },
              ],
            },
          ],
        },
      ],
    };

    const validElementorResponse = {
      type: "page",
      version: "0.4",
      title: "next-landing",
      page_settings: {},
      content: [
        {
          id: "hero_container_1",
          elType: "container",
          isInner: false,
          settings: { flex_direction: "column", content_width: "boxed" },
          elements: [
            {
              id: "heading_1",
              elType: "widget",
              widgetType: "heading",
              settings: { title: "Modern Cloud Storage", header_size: "h1" },
              elements: [],
            },
            {
              id: "text_1",
              elType: "widget",
              widgetType: "text-editor",
              settings: { editor: "<p>Private R2 object storage for all conversion artifacts.</p>" },
              elements: [],
            },
            {
              id: "btn_1",
              elType: "widget",
              widgetType: "button",
              settings: { text: "Get Started" },
              elements: [],
            },
          ],
        },
      ],
    };

    let callIndex = 0;
    const fetchMock = vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
      callIndex += 1;
      const body = JSON.parse(String(init.body));
      if (callIndex === 1) {
        expect(body.messages[0].content).toContain("React / Next.js → DIR Conversion Skill");
        expect(body.messages[1].content).toContain("Modern Cloud Storage");
        return {
          ok: true,
          json: async () => ({ choices: [{ message: { content: JSON.stringify(validDirResponse) } }] }),
        };
      }
      return {
        ok: true,
        json: async () => ({ choices: [{ message: { content: JSON.stringify(validElementorResponse) } }] }),
      };
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await runConversionPipeline(
      { sourceType: "react-next-zip", snapshotKey },
      snapshotKey,
      { projectId: "proj-1", conversionId: "conv-1", sourceType: "react-next-zip" },
    );

    expect(result.status).toBe("SUCCEEDED");
    if (result.status === "SUCCEEDED") {
      expect(result.elementorOutput.content).toHaveLength(1);
      expect(result.elementorOutput.content[0]?.id).toBe("hero_container_1");
      expect(result.elementorOutput.content[0]?.elements).toHaveLength(3);
    }

    await storage.deleteObject(snapshotKey);
  });
});
