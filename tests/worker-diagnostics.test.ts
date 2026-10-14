import { describe, expect, it } from "vitest";
import { computePersistedDiagnostics } from "../src/worker.js";

// Regression: a "missing validated source import" diagnostic must NEVER be
// persisted alongside a SUCCEEDED conversion (the inconsistent state reported in
// the UI). The invariant lives in computePersistedDiagnostics, which the worker
// uses for every stage/report diagnostics write.
describe("worker diagnostics honesty", () => {
  const missingSource = {
    code: "SOURCE_ANALYSIS_RULES_MISSING",
    severity: "error",
    message:
      "Conversion stopped because this job has no validated source import; the Markdown-driven pipeline requires a ready source snapshot for the recorded source type.",
    stage: "source_ir_validation",
  };

  it("persists only a neutral completion marker on SUCCEEDED (never the missing-source diagnostic)", () => {
    const { diagnostics, success } = computePersistedDiagnostics("SUCCEEDED", null, missingSource);
    expect(success).toBe(true);
    expect(diagnostics).toEqual([{ code: "UPSTREAM_STAGE_COMPLETED" }]);
    // The missing-source message must not appear anywhere in the persisted diagnostics.
    expect(JSON.stringify(diagnostics)).not.toContain("SOURCE_ANALYSIS_RULES_MISSING");
    expect(JSON.stringify(diagnostics)).not.toContain("no validated source import");
  });

  it("persists the pipeline's real diagnostics on BLOCKED and does not report success", () => {
    const blocked = [{ code: "DIR_INVALID", message: "pages[0]: missing sections", stage: "source_ir_validation" }];
    const { diagnostics, success } = computePersistedDiagnostics("BLOCKED", blocked, missingSource);
    expect(success).toBe(false);
    expect(diagnostics).toEqual(blocked);
  });

  it("persists the missing-source diagnostic only when the pipeline never ran (null result), as a failure", () => {
    const { diagnostics, success } = computePersistedDiagnostics(null, null, missingSource);
    expect(success).toBe(false);
    expect(diagnostics).toEqual([missingSource]);
  });

  it("never marks success while emitting a missing-source diagnostic", () => {
    for (const status of ["SUCCEEDED", "BLOCKED", null] as const) {
      const { diagnostics, success } = computePersistedDiagnostics(status, null, missingSource);
      const hasMissingSource = JSON.stringify(diagnostics).includes("SOURCE_ANALYSIS_RULES_MISSING");
      if (hasMissingSource) {
        expect(success).toBe(false);
      }
    }
  });
});
