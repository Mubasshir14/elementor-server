import { storage } from './src/infrastructure/storage/local.js';

async function checkRoutes() {
  const snapshotKey = 'imports/cmv6ajfqg0000c4rf052ggsk0/react-next-23e8e257-e2a3-4c01-b9d4-fa64830bf85d.json';
  const snapshotBytes = await storage.readFile(snapshotKey);
  const snapshot = JSON.parse(snapshotBytes.toString('utf8'));

  console.log('Routes sample:', JSON.stringify(snapshot.routes, null, 2));
}

checkRoutes()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });

