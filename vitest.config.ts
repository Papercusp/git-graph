import { defineVitestConfig } from '@papercusp/test-config';

// git-graph ships React components; render-level tests (CommitDetail.test.tsx)
// need the automatic JSX runtime so test-file JSX doesn't require an explicit
// `import React`. The shared unit config leaves esbuild on the classic
// runtime, so opt in here.
export default {
  ...defineVitestConfig({ layer: 'unit' }),
  esbuild: { jsx: 'automatic' as const },
};
