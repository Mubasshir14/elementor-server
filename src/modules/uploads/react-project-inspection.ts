import * as yauzl from "yauzl";
import { HttpError } from "../../middleware/errors.js";
import { inspectZip } from "./archive-inspection.js";

const MAX_PACKAGE_JSON_BYTES = 1024 * 1024;

export type DetectedFramework = "react" | "nextjs";

type PackageManifest = {
  dependencies?: Record<string, unknown>;
  devDependencies?: Record<string, unknown>;
  peerDependencies?: Record<string, unknown>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasDependency(manifest: PackageManifest, name: string): boolean {
  return [manifest.dependencies, manifest.devDependencies, manifest.peerDependencies]
    .some((dependencies) => isRecord(dependencies) && typeof dependencies[name] === "string");
}

function isSourceFile(path: string): boolean {
  return /\.(?:[cm]?[jt]sx?)$/i.test(path) &&
    !/(?:^|\/)(?:node_modules|\.next|dist|build)\//.test(path);
}

function classifyProject(
  manifestPath: string,
  manifest: PackageManifest,
  allPaths: string[],
): DetectedFramework {
  const projectRoot = manifestPath === "package.json" ? "" : manifestPath.slice(0, -"package.json".length);
  const projectPaths = allPaths
    .filter((path) => path.startsWith(projectRoot))
    .map((path) => path.slice(projectRoot.length));
  const hasNextRouting = projectPaths.some((path) =>
    /^(?:src\/)?(?:app|pages)\/.+\.(?:[cm]?[jt]sx?)$/i.test(path),
  );
  const hasReactSource = projectPaths.some((path) =>
    /^(?:src\/)?(?:app|pages|components|routes)\/.+\.(?:[cm]?[jt]sx?)$/i.test(path) ||
    /^(?:src\/)?(?:App|app|index|main)\.(?:[cm]?[jt]sx?)$/i.test(path),
  );

  if (hasDependency(manifest, "next") && hasNextRouting) {
    return "nextjs";
  }
  if (hasDependency(manifest, "react") && hasReactSource) {
    return "react";
  }
  throw new HttpError(
    400,
    "UNRECOGNIZED_REACT_PROJECT",
    "The ZIP must contain a package.json with React or Next.js dependencies and matching application source files.",
  );
}

export async function inspectReactProjectZip(buffer: Buffer): Promise<{
  detectedFramework: DetectedFramework;
  packageRoot: string;
  sourceFileCount: number;
}> {
  await inspectZip(buffer);

  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buffer, { lazyEntries: true, decodeStrings: true }, (openError, archive) => {
      if (openError || !archive) {
        reject(new HttpError(400, "INVALID_PROJECT_ARCHIVE", "The project ZIP could not be opened."));
        return;
      }

      const paths: string[] = [];
      let manifestPath: string | undefined;
      let manifest: PackageManifest | undefined;
      let settled = false;

      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        archive.close();
        reject(error);
      };
      archive.on("error", (error) => fail(new HttpError(
        400,
        "INVALID_PROJECT_ARCHIVE",
        "The project ZIP could not be read safely.",
      )));
      archive.on("end", () => {
        if (settled) return;
        settled = true;
        const manifestCandidates = paths.filter((path) =>
          path === "package.json" || /^[^/]+\/package\.json$/i.test(path),
        );
        if (manifestCandidates.length !== 1 || !manifestPath || !manifest) {
          reject(new HttpError(
            400,
            "UNRECOGNIZED_REACT_PROJECT",
            "The ZIP must contain one root package.json, optionally inside one project folder.",
          ));
          return;
        }
        try {
          const detectedFramework = classifyProject(manifestPath, manifest, paths);
          resolve({
            detectedFramework,
            packageRoot: manifestPath === "package.json" ? "" : manifestPath.slice(0, -"package.json".length),
            sourceFileCount: paths.filter(isSourceFile).length,
          });
        } catch (error) {
          reject(error);
        }
      });
      archive.on("entry", (entry) => {
        paths.push(entry.fileName.replaceAll("\\", "/"));
        if (entry.fileName === "package.json" || /^[^/]+\/package\.json$/i.test(entry.fileName)) {
          if (entry.uncompressedSize > MAX_PACKAGE_JSON_BYTES) {
            fail(new HttpError(400, "INVALID_PROJECT_MANIFEST", "The project package.json exceeds the inspection limit."));
            return;
          }
          archive.openReadStream(entry, (streamError, stream) => {
            if (streamError || !stream) {
              fail(new HttpError(400, "INVALID_PROJECT_MANIFEST", "The project package.json could not be read."));
              return;
            }
            const chunks: Buffer[] = [];
            let bytes = 0;
            stream.on("data", (chunk: Buffer) => {
              bytes += chunk.length;
              if (bytes > MAX_PACKAGE_JSON_BYTES) {
                stream.destroy(new Error("Manifest exceeds inspection limit"));
                return;
              }
              chunks.push(chunk);
            });
            stream.on("error", () => fail(new HttpError(
              400,
              "INVALID_PROJECT_MANIFEST",
              "The project package.json is malformed or unreadable.",
            )));
            stream.on("end", () => {
              if (settled) return;
              try {
                const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
                if (!isRecord(parsed)) {
                  throw new Error("package.json must contain an object");
                }
                if (manifestPath) {
                  fail(new HttpError(
                    400,
                    "AMBIGUOUS_PROJECT_ARCHIVE",
                    "The ZIP contains multiple possible project roots; upload one project at a time.",
                  ));
                  return;
                }
                manifestPath = entry.fileName.replaceAll("\\", "/");
                manifest = parsed;
                archive.readEntry();
              } catch {
                fail(new HttpError(400, "INVALID_PROJECT_MANIFEST", "The project package.json is not valid JSON."));
              }
            });
          });
          return;
        }
        archive.readEntry();
      });
      archive.readEntry();
    });
  });
}
