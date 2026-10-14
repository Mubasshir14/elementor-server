import { storage } from './src/infrastructure/storage/local.js';

async function checkComponents() {
  const snapshotKey = 'imports/cmv6ajfqg0000c4rf052ggsk0/react-next-23e8e257-e2a3-4c01-b9d4-fa64830bf85d.json';
  const snapshotBytes = await storage.readFile(snapshotKey);
  const snapshot = JSON.parse(snapshotBytes.toString('utf8'));

  console.log('Component 0 keys:', Object.keys(snapshot.components[0]));
  console.log('Component 0 sample:', JSON.stringify(snapshot.components[0], null, 2).slice(0, 1000));
}

checkComponents()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });

