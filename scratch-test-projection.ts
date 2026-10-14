import { storage } from './src/infrastructure/storage/local.js';
import { loadConversionRules } from './src/modules/rules/rule-loader.js';
import { buildConversionMessages } from './src/infrastructure/ai/provider.js';
import type { ReactNextProjectSnapshot } from './src/modules/react-nextjs/react-nextjs.types.js';

export function projectReactSnapshotForAi(snapshot: ReactNextProjectSnapshot) {
  // 1. Compact routes: strip sourceFile, empty arrays, verbose button/heading classes
  const routes = (snapshot.routes ?? []).map(r => ({
    id: r.id,
    path: r.path,
    name: r.name,
    sections: (r.sections ?? []).map(s => {
      const section: Record<string, any> = {
        id: s.id,
        name: s.name,
        role: s.role,
      };
      if (s.tagName && s.tagName !== 'div') section.tagName = s.tagName;
      if (s.className) section.className = s.className;
      if (s.layoutHint) section.layoutHint = s.layoutHint;
      if (s.headings?.length) {
        section.headings = s.headings.map(h => ({ level: h.level, text: h.text }));
      }
      if (s.paragraphs?.length) section.paragraphs = s.paragraphs;
      if (s.buttons?.length) {
        section.buttons = s.buttons.map(b => ({
          label: b.label,
          ...(b.href ? { href: b.href } : {}),
          ...(b.variant ? { variant: b.variant } : {}),
        }));
      }
      if (s.navItems?.length) section.navItems = s.navItems;
      if (s.images?.length) {
        section.images = s.images.map(img => ({ src: img.src, ...(img.alt ? { alt: img.alt } : {}) }));
      }
      if (s.forms?.length) section.forms = s.forms;
      if (s.childComponents?.length) section.childComponents = s.childComponents;
      return section;
    }),
    ...(r.importedComponents?.length ? { importedComponents: r.importedComponents } : {}),
  }));

  // 2. Compact components: omit sourceFile, empty arrays, verbose button/heading classes
  const components = (snapshot.components ?? []).map(c => {
    const comp: Record<string, any> = {
      name: c.name,
    };
    if (c.roleHint) comp.roleHint = c.roleHint;
    if (c.className) comp.className = c.className;
    if (c.headings?.length) {
      comp.headings = c.headings.map(h => ({ level: h.level, text: h.text }));
    }
    if (c.paragraphs?.length) comp.paragraphs = c.paragraphs;
    if (c.buttons?.length) {
      comp.buttons = c.buttons.map(b => ({
        label: b.label,
        ...(b.href ? { href: b.href } : {}),
        ...(b.variant ? { variant: b.variant } : {}),
      }));
    }
    if (c.navItems?.length) comp.navItems = c.navItems;
    if (c.images?.length) {
      comp.images = c.images.map(img => ({ src: img.src, ...(img.alt ? { alt: img.alt } : {}) }));
    }
    if (c.forms?.length) comp.forms = c.forms;
    return comp;
  });

  // 3. Compact styles: essential design tokens only
  const styles: Record<string, any> = {};
  if (snapshot.styles?.customProperties && Object.keys(snapshot.styles.customProperties).length > 0) {
    const themeProps: Record<string, string> = {};
    for (const [k, v] of Object.entries(snapshot.styles.customProperties)) {
      if (k.startsWith('--color') || k.startsWith('--radius') || k.startsWith('--primary') || k.startsWith('--background')) {
        themeProps[k] = v;
      }
    }
    if (Object.keys(themeProps).length > 0) {
      styles.customProperties = themeProps;
    }
  }

  // 4. Compact assets: only path & kind
  const assets = (snapshot.assets ?? []).slice(0, 15).map(a => ({ path: a.path, kind: a.kind }));

  return {
    source: snapshot.source,
    detectedFramework: snapshot.detectedFramework,
    routerConvention: snapshot.routerConvention,
    projectName: snapshot.packageInfo?.name ?? 'project',
    routes,
    components,
    ...(Object.keys(styles).length > 0 ? { styles } : {}),
    ...(assets.length > 0 ? { assets } : {}),
  };
}

async function testProjection() {
  const snapshotKey = 'imports/cmv6ajfqg0000c4rf052ggsk0/react-next-23e8e257-e2a3-4c01-b9d4-fa64830bf85d.json';
  const snapshotBytes = await storage.readFile(snapshotKey);
  const rawSnapshot = JSON.parse(snapshotBytes.toString('utf8'));

  const projected = projectReactSnapshotForAi(rawSnapshot);
  const projectedJson = JSON.stringify(projected);
  const rawJson = JSON.stringify(rawSnapshot);

  console.log('RAW_SNAPSHOT_CHARS:', rawJson.length);
  console.log('PROJECTED_SNAPSHOT_CHARS:', projectedJson.length);
  console.log('REDUCTION_PERCENTAGE:', Math.round((1 - projectedJson.length / rawJson.length) * 100) + '%');

  const rules = loadConversionRules('react-next-zip');
  const DIR_TASK = [
    "Interpret the design in the UNTRUSTED-DESIGN block using the source analysis",
    "rules above, then output the canonical DIR JSON for the target described in",
    "the target rules above. Return ONE DIR JSON object and nothing else: no",
    "markdown fences, no comments, no explanations.",
  ].join(" ");

  const messagesProjected = buildConversionMessages({ rules, designPayload: projectedJson, task: DIR_TASK });
  const totalProjectedChars = messagesProjected[0].content.length + messagesProjected[1].content.length;

  console.log('TOTAL_PROMPT_PROJECTED_CHARS:', totalProjectedChars);
}

if (process.argv[1]?.includes('scratch-test-projection')) {
  testProjection()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}

