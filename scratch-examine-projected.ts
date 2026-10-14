import { storage } from './src/infrastructure/storage/local.js';
import { projectReactSnapshotForAi } from './scratch-test-projection.js';

async function examineProjected() {
  const snapshotKey = 'imports/cmv6ajfqg0000c4rf052ggsk0/react-next-23e8e257-e2a3-4c01-b9d4-fa64830bf85d.json';
  const snapshotBytes = await storage.readFile(snapshotKey);
  const rawSnapshot = JSON.parse(snapshotBytes.toString('utf8'));

  const projected = projectReactSnapshotForAi(rawSnapshot);

  console.log('--- Routes (length: ' + JSON.stringify(projected.routes).length + ') ---');
  console.log(JSON.stringify(projected.routes, null, 2).slice(0, 500));

  console.log('--- Components (length: ' + JSON.stringify(projected.components).length + ') ---');
  for (const c of projected.components) {
    console.log(`Component ${c.name}: ${JSON.stringify(c).length} chars`);
  }

  console.log('--- Styles (length: ' + JSON.stringify(projected.styles).length + ') ---');
  console.log('Styles chars:', JSON.stringify(projected.styles ?? {}).length);

  console.log('--- Assets (length: ' + JSON.stringify(projected.assets).length + ') ---');
  console.log('Assets chars:', JSON.stringify(projected.assets ?? {}).length);
}

examineProjected()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });

