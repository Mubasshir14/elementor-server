import { storage } from './src/infrastructure/storage/local.js';

async function checkReferencedComponents() {
  const snapshotKey = 'imports/cmv6ajfqg0000c4rf052ggsk0/react-next-23e8e257-e2a3-4c01-b9d4-fa64830bf85d.json';
  const snapshotBytes = await storage.readFile(snapshotKey);
  const snapshot = JSON.parse(snapshotBytes.toString('utf8'));

  const referenced = new Set<string>();
  for (const r of snapshot.routes) {
    for (const c of r.importedComponents ?? []) referenced.add(c.toLowerCase());
    for (const s of r.sections ?? []) {
      for (const c of s.childComponents ?? []) referenced.add(c.toLowerCase());
    }
  }

  console.log('Referenced names:', Array.from(referenced));
  console.log('All component names:', snapshot.components.map((c: any) => c.name));

  const filtered = snapshot.components.filter((c: any) => {
    const name = c.name.toLowerCase().replace(/[-_]/g, '');
    return Array.from(referenced).some(r => {
      const ref = r.replace(/[-_]/g, '');
      return ref.includes(name) || name.includes(ref);
    });
  });

  console.log('Filtered component names count:', filtered.length, 'out of', snapshot.components.length);
  console.log('Filtered names:', filtered.map((c: any) => c.name));
}

checkReferencedComponents()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });

