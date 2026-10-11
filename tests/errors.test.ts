import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { errorHandler, HttpError } from "../src/middleware/errors.js";
import { z } from "zod";

describe("API errors", () => {
  const app = express();
  app.use(express.json());
  app.post("/validate", (req, _res, next) => {
    try {
      z.object({ name: z.string().min(1) }).strict().parse(req.body);
      next(new HttpError(409, "CONFLICT", "Request conflicts"));
    } catch (error) {
      next(error);
    }
  });
  app.use(errorHandler);

  it("returns a bounded validation error without exposing internals", async () => {
    const response = await request(app).post("/validate").send({ name: "", ignored: true });
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("VALIDATION_ERROR");
    expect(JSON.stringify(response.body)).not.toContain("stack");
  });

  it("preserves safe application error codes", async () => {
    const response = await request(app).post("/validate").send({ name: "ok" });
    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe("CONFLICT");
  });
});
