import { ProjectRole } from "../../generated/prisma/client.js";
import { prisma } from "../../infrastructure/database/prisma.js";
import { HttpError } from "../../middleware/errors.js";

export async function requireProjectRole(
  projectId: string,
  userId: string,
  roles: ProjectRole[],
) {
  const membership = await prisma.projectMember.findUnique({
    where: { projectId_userId: { projectId, userId } },
    select: { role: true },
  });
  if (!membership) throw new HttpError(404, "PROJECT_NOT_FOUND", "Project was not found");
  if (!roles.includes(membership.role)) {
    throw new HttpError(403, "PROJECT_FORBIDDEN", "You do not have permission to change this project");
  }
  return membership;
}
