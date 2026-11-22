/**
 * Layer rules for Harbor City (see PLAN.md §2).
 * LAYERS is ordered bottom → top. A module may import only from layers strictly below it.
 * Entries that are arrays are sibling tiers: siblings may not import each other.
 */
const LAYERS = [
  'core',
  'ecs',
  ['physics', 'rendering', 'audio', 'save'],
  'world',
  'characters',
  'vehicles',
  'combat',
  'ai',
  'police',
  'missions',
  'ui',
  'debug',
  'game',
];

const flat = (entry) => (Array.isArray(entry) ? entry : [entry]);
const group = (names) => `^src/(${names.join('|')})/`;

const layerRules = LAYERS.flatMap((entry, index) => {
  const forbidden = LAYERS.slice(index + 1).flatMap(flat);
  return flat(entry).map((name) => {
    const siblings = flat(entry).filter((other) => other !== name);
    const targets = [...forbidden, ...siblings];
    return {
      name: `layer-${name}`,
      comment: `${name} may only import from lower layers (PLAN.md §2).`,
      severity: 'error',
      from: { path: `^src/${name}/` },
      to: { path: targets.length > 0 ? group(targets) : '^$' },
    };
  });
});

module.exports = {
  forbidden: [
    {
      name: 'no-circular',
      severity: 'error',
      comment: 'Circular imports are forbidden.',
      from: {},
      to: { circular: true },
    },
    ...layerRules,
    {
      name: 'content-is-data',
      comment: 'src/content holds pure data: it may only import types from domains.',
      severity: 'error',
      from: { path: '^src/content/', pathNot: '\\.test\\.ts$' },
      to: { path: '^src/(?!content/)', dependencyTypesNot: ['type-only'] },
    },
    {
      name: 'content-consumers',
      comment: 'Only the composition root (and tests) read content; domains receive it by injection.',
      severity: 'error',
      from: { path: '^src/', pathNot: ['^src/(content|game)/', '\\.test\\.ts$', '^src/main\\.ts$'] },
      to: { path: '^src/content/' },
    },
    {
      name: 'main-is-entry',
      comment: 'Nothing imports the entry point.',
      severity: 'error',
      from: {},
      to: { path: '^src/main\\.ts$' },
    },
    {
      name: 'no-test-tooling-in-src',
      comment: 'Game code must not import e2e or scripts.',
      severity: 'error',
      from: { path: '^src/' },
      to: { path: '^(e2e|scripts)/' },
    },
    {
      name: 'not-to-unresolvable',
      severity: 'error',
      from: {},
      to: { couldNotResolve: true },
    },
    {
      name: 'no-non-package-json',
      severity: 'error',
      from: {},
      to: { dependencyTypes: ['npm-no-pkg', 'npm-unknown'] },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'tsconfig.json' },
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default', 'types'],
    },
  },
};
