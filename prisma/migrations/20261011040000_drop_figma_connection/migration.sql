-- DropTable
-- Remove the FigmaConnection table introduced solely for the OAuth
-- account-connected import workflow. Figma intake now uses direct file upload,
-- so no OAuth tokens, scopes, or account links are stored.
DROP TABLE "FigmaConnection";
