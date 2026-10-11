import { describe, expect, it } from "vitest";
import { inspectReactProjectZip } from "../src/modules/uploads/react-project-inspection.js";

type ZipFile = { name: string; contents: string };

function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function makeZip(files: ZipFile[]): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let localOffset = 0;

  for (const file of files) {
    const name = Buffer.from(file.name);
    const data = Buffer.from(file.contents);
    const checksum = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    localParts.push(local, name, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(localOffset, 42);
    centralParts.push(central, name);
    localOffset += local.length + name.length + data.length;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(localOffset, 16);
  return Buffer.concat([...localParts, centralDirectory, end]);
}

describe("React and Next.js project ZIP inspection", () => {
  it("recognizes a root-layout React application without executing it", async () => {
    const result = await inspectReactProjectZip(makeZip([
      { name: "package.json", contents: JSON.stringify({ dependencies: { react: "^18.0.0" } }) },
      { name: "src/App.tsx", contents: "export default function App() { return null; }" },
      { name: "src/main.tsx", contents: "import React from 'react';" },
    ]));

    expect(result).toMatchObject({ detectedFramework: "react", packageRoot: "", sourceFileCount: 2 });
  });

  it("recognizes Next.js applications in a single project folder", async () => {
    const result = await inspectReactProjectZip(makeZip([
      { name: "website/package.json", contents: JSON.stringify({ dependencies: { next: "^14.0.0" } }) },
      { name: "website/app/page.tsx", contents: "export default function Page() { return null; }" },
    ]));

    expect(result).toMatchObject({ detectedFramework: "nextjs", packageRoot: "website/", sourceFileCount: 1 });
  });

  it("rejects ZIPs that are not verifiable React or Next.js projects", async () => {
    await expect(inspectReactProjectZip(makeZip([
      { name: "package.json", contents: JSON.stringify({ dependencies: { react: "^18.0.0" } }) },
      { name: "README.md", contents: "Not an application source tree" },
    ]))).rejects.toMatchObject({ code: "UNRECOGNIZED_REACT_PROJECT", status: 400 });
  });

  it("rejects ambiguous project roots", async () => {
    await expect(inspectReactProjectZip(makeZip([
      { name: "first/package.json", contents: JSON.stringify({ dependencies: { react: "^18.0.0" } }) },
      { name: "second/package.json", contents: JSON.stringify({ dependencies: { react: "^18.0.0" } }) },
    ]))).rejects.toMatchObject({ code: "AMBIGUOUS_PROJECT_ARCHIVE", status: 400 });
  });

  it("rejects malformed package manifests", async () => {
    await expect(inspectReactProjectZip(makeZip([
      { name: "package.json", contents: "{" },
    ]))).rejects.toMatchObject({ code: "INVALID_PROJECT_MANIFEST", status: 400 });
  });
});
