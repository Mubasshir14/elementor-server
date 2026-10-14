import dotenv from "dotenv";
dotenv.config({ path: "server/.env" });
import jwt from "jsonwebtoken";
import { prisma } from "./infrastructure/database/prisma.js";

async function main() {
  const convId = "cmv6fytwj0000o0rfwsegucfw";
  const convJob = await prisma.conversionJob.findUnique({
    where: { id: convId },
    include: { project: { include: { members: true } } },
  });
  if (!convJob) throw new Error("Conversion job not found in DB");
  const ownerMember = convJob.project.members[0];
  if (!ownerMember) throw new Error("No member found for project");
  const targetUserId = ownerMember.userId;

  let session = await prisma.session.findFirst({
    where: {
      userId: targetUserId,
      revokedAt: null,
      expiresAt: { gt: new Date() },
    },
  });
  if (!session) {
    session = await prisma.session.create({
      data: {
        userId: targetUserId,
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      },
    });
  }

  const secret = process.env.JWT_SECRET || "secret";
  const token = jwt.sign(
    { sub: targetUserId, sid: session.id },
    secret,
    { algorithm: "HS256", issuer: "design-to-elementor-api", expiresIn: "24h" }
  );

  console.log("Retrying conversion job:", convId);
  const retryRes = await fetch(`http://localhost:4000/api/v1/conversions/${convId}/retry`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(10000),
  });
  console.log("Retry response status:", retryRes.status);
  const retryData = await retryRes.json();
  console.log("Retry response body:", retryData);

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});

