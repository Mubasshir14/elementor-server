import { storage } from './src/infrastructure/storage/local.js';

async function breakdownComponents() {
  const snapshotKey = 'imports/cmv6ajfqg0000c4rf052ggsk0/react-next-23e8e257-e2a3-4c01-b9d4-fa64830bf85d.json';
  const snapshotBytes = await storage.readFile(snapshotKey);
  const snapshot = JSON.parse(snapshotBytes.toString('utf8'));

  for (const c of snapshot.components) {
    const headingsLen = JSON.stringify(c.headings ?? []).length;
    const parasLen = JSON.stringify(c.paragraphs ?? []).length;
    const buttonsLen = JSON.stringify(c.buttons ?? []).length;
    const navLen = JSON.stringify(c.navItems ?? []).length;
    const imagesLen = JSON.stringify(c.images ?? []).length;
    const formsLen = JSON.stringify(c.forms ?? []).length;
    const classNameLen = (c.className ?? '').length;

    console.log(`${c.name}: total=${JSON.stringify(c).length} (h=${headingsLen}, p=${parasLen}, b=${buttonsLen}, nav=${navLen}, img=${imagesLen}, f=${formsLen}, cls=${classNameLen})`);
  }
}

breakdownComponents()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });

