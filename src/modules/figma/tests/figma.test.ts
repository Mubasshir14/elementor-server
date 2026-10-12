import { describe, expect, it } from "vitest";
import { buildFigTree, detectNativeFigmaFile, inspectFigmaFileJson } from "../figma.parser.js";
import type { FigNativeDiagnostic } from "../figma.types.js";

describe("Figma module parser, variants, constraints, and Auto Layout sizing", () => {
  it("reconstructs component sets, variant properties, constraints, and Auto Layout wrap/sizing from native nodeChanges", () => {
    const diagnostics: FigNativeDiagnostic[] = [];
    const message = {
      nodeChanges: [
        {
          guid: { sessionID: 1, localID: 0 },
          type: "DOCUMENT",
          name: "Document",
        },
        {
          guid: { sessionID: 1, localID: 1 },
          parentIndex: { guid: { sessionID: 1, localID: 0 }, position: "!" },
          type: "CANVAS",
          name: "Design System",
        },
        {
          guid: { sessionID: 1, localID: 2 },
          parentIndex: { guid: { sessionID: 1, localID: 1 }, position: "!" },
          type: "COMPONENT_SET",
          name: "Button",
          stackMode: "HORIZONTAL",
          stackWrap: "WRAP",
          layoutSizingHorizontal: "HUG",
          layoutSizingVertical: "HUG",
          itemSpacing: 16,
          paddingLeft: 12,
          paddingRight: 12,
          paddingTop: 8,
          paddingBottom: 8,
        },
        {
          guid: { sessionID: 1, localID: 3 },
          parentIndex: { guid: { sessionID: 1, localID: 2 }, position: "!" },
          type: "COMPONENT",
          name: "Variant=Primary, Size=Large",
          horizontalConstraint: "STRETCH",
          verticalConstraint: "CENTER",
          size: { x: 180, y: 48 },
          fillPaints: [{ type: "SOLID", color: { r: 0.145, g: 0.388, b: 0.921, a: 1 } }],
        },
      ],
    };

    const tree = buildFigTree(message, diagnostics);
    expect(tree.pages).toHaveLength(1);
    expect(tree.componentCount).toBe(2);

    const compSet = tree.pages[0]!.children[0]!;
    expect(compSet.isComponentSet).toBe(true);
    expect(compSet.layout?.mode).toBe("HORIZONTAL");
    expect(compSet.layout?.wrap).toBe(true);
    expect(compSet.layout?.sizingHorizontal).toBe("HUG");

    const variant = compSet.children[0]!;
    expect(variant.variantProperties).toEqual({
      Variant: "Primary",
      Size: "Large",
    });
    expect(variant.constraints).toEqual({
      horizontal: "STRETCH",
      vertical: "CENTER",
    });
  });

  it("detects native .fig Kiwi headers and rejects non-Figma JSON", () => {
    expect(detectNativeFigmaFile(Buffer.from("fig-kiwi\x01\x00\x00\x00"))).toBe("fig");
    expect(() => inspectFigmaFileJson(Buffer.from('{"hello":"world"}'))).toThrow(
      /missing the Figma file name/,
    );
  });
});

