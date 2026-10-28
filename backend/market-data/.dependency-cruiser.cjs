const thirdParty = ['npm', 'npm-dev', 'npm-optional', 'npm-peer'];
const allowedInCore = 'node_modules/decimal\\.js';

module.exports = {
  forbidden: [
    {
      name: 'application-does-not-know-infra',
      severity: 'error',
      from: { path: '^src/application' },
      to: { path: '^src/infra' },
    },
    {
      name: 'application-depends-only-on-ports',
      severity: 'error',
      from: { path: '^src/application' },
      to: { dependencyTypes: thirdParty, pathNot: allowedInCore },
    },
    {
      name: 'service-stays-in-its-folder',
      severity: 'error',
      from: {},
      to: { path: '^\\.\\./' },
    },
    {
      name: 'no-circular-dependencies',
      severity: 'error',
      from: {},
      to: { circular: true },
    },
    {
      name: 'no-unresolvable-imports',
      severity: 'error',
      from: {},
      to: { couldNotResolve: true },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'tsconfig.json' },
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'types', 'default'],
      extensions: ['.ts', '.js'],
    },
  },
};
