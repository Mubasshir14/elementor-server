import dotenv from 'dotenv';
import path from 'path';
import { storage } from './src/infrastructure/storage/local.js';
import { loadConversionRules } from './src/modules/rules/rule-loader.js';
import { buildConversionMessages } from './src/infrastructure/ai/provider.js';
import { projectReactSnapshotForAi } from './scratch-test-projection.js';

dotenv.config({ path: path.resolve('.env') });

async function checkGroqTokens() {
  const apiKey = process.env.AI_API_KEY;
  const model = 'openai/gpt-oss-120b';

  const snapshotKey = 'imports/cmv6ajfqg0000c4rf052ggsk0/react-next-23e8e257-e2a3-4c01-b9d4-fa64830bf85d.json';
  const snapshotBytes = await storage.readFile(snapshotKey);
  const rawSnapshot = JSON.parse(snapshotBytes.toString('utf8'));

  const projected = projectReactSnapshotForAi(rawSnapshot);
  const rules = loadConversionRules('react-next-zip');
  const DIR_TASK = [
    "Interpret the design in the UNTRUSTED-DESIGN block using the source analysis",
    "rules above, then output the canonical DIR JSON for the target described in",
    "the target rules above. Return ONE DIR JSON object and nothing else: no",
    "markdown fences, no comments, no explanations.",
  ].join(" ");

  const messagesProjected = buildConversionMessages({
    rules,
    designPayload: JSON.stringify(projected),
    task: DIR_TASK,
  });

  console.log('TESTING_GROQ_REQUEST with max_tokens: 10 ...');
  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: messagesProjected,
      temperature: 0,
      max_tokens: 10,
    }),
    signal: AbortSignal.timeout(15000),
  });

  console.log('HTTP_STATUS:', res.status);
  const text = await res.text();
  console.log('RESPONSE:', text.slice(0, 500));
}

checkGroqTokens()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });

