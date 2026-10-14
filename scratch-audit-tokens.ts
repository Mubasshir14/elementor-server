import { storage } from './src/infrastructure/storage/local.js';
import { loadConversionRules } from './src/modules/rules/rule-loader.js';
import { buildConversionMessages } from './src/infrastructure/ai/provider.js';

async function auditTokens() {
  const snapshotKey = 'imports/cmv6ajfqg0000c4rf052ggsk0/react-next-23e8e257-e2a3-4c01-b9d4-fa64830bf85d.json';
  const snapshotBytes = await storage.readFile(snapshotKey);
  const snapshot = JSON.parse(snapshotBytes.toString('utf8'));

  const rules = loadConversionRules('react-next-zip');

  const DIR_TASK = [
    "Interpret the design in the UNTRUSTED-DESIGN block using the source analysis",
    "rules above, then output the canonical DIR JSON for the target described in",
    "the target rules above. Return ONE DIR JSON object and nothing else: no",
    "markdown fences, no comments, no explanations.",
  ].join(" ");

  const rawDesignPayload = JSON.stringify(snapshot);

  const messages = buildConversionMessages({
    rules,
    designPayload: rawDesignPayload,
    task: DIR_TASK,
  });

  const systemContent = messages[0].content;
  const userContent = messages[1].content;

  console.log('=== PROMPT COMPONENT SIZES ===');
  console.log('System instructions characters:', systemContent.length);
  console.log('User prompt characters:', userContent.length);
  console.log('Total characters:', systemContent.length + userContent.length);
  console.log('Design payload raw characters:', rawDesignPayload.length);

  console.log('\n=== SNAPSHOT ROOT KEYS & CHAR SIZES ===');
  for (const [key, val] of Object.entries(snapshot)) {
    const jsonStr = JSON.stringify(val);
    console.log(` - ${key}: ${jsonStr.length} chars (${typeof val === 'object' && val !== null ? (Array.isArray(val) ? val.length + ' items' : Object.keys(val).length + ' keys') : val})`);
  }

  if (snapshot.components) {
    console.log('\n=== COMPONENTS DETAIL ===');
    for (const [compName, compVal] of Object.entries(snapshot.components as Record<string, any>)) {
      console.log(`   * ${compName}: ${JSON.stringify(compVal).length} chars`);
    }
  }

  if (snapshot.routes) {
    console.log('\n=== ROUTES DETAIL ===');
    console.log('Routes count:', Array.isArray(snapshot.routes) ? snapshot.routes.length : Object.keys(snapshot.routes).length);
    console.log('Routes JSON chars:', JSON.stringify(snapshot.routes).length);
  }
}

auditTokens()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });

