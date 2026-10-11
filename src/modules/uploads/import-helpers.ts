import { z } from "zod";

// Shared import helpers. The Figma remote-API request helper and the
// Figma-connection cleanup helper were removed along with the OAuth workflow:
// Figma files are now uploaded and parsed locally with no external API calls.
export const framerImportBodySchema = z.object({ siteUrl: z.string().trim().min(1).max(2_048) }).strict();

