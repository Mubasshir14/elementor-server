import { storage } from './src/infrastructure/storage/local.js';

async function checkStyles() {
  const snapshotKey = 'imports/cmv6ajfqg0000c4rf052ggsk0/react-next-23e8e257-e2a3-4c01-b9d4-fa64830bf85d.json';
  const snapshotBytes = await storage.readFile(snapshotKey);
  const snapshot = JSON.parse(snapshotBytes.toString('utf8'));

  console.log('colors count:', snapshot.styles?.colors?.length);
  console.log('fonts count:', snapshot.styles?.fonts?.length);
  console.log('customProperties keys count:', Object.keys(snapshot.styles?.customProperties ?? {}).length);
  console.log('customProperties sample:', Object.keys(snapshot.styles?.customProperties ?? {}).slice(0, 20));
  console.log('assets count:', snapshot.assets?.length);
}

checkStyles()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });

