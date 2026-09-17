module.exports = {
  forbidden: [
    { name: 'no-circular', severity: 'error', from: {}, to: { circular: true } },
    {
      name: 'domain-is-pure',
      severity: 'error',
      from: { path: '(^|/)packages/domain/' },
      to: {
        path: '(^|/)(apps/|packages/(application|infrastructure|resume-renderer|ui|config)/)',
      },
    },
    {
      name: 'application-uses-ports',
      severity: 'error',
      from: { path: '(^|/)packages/application/' },
      to: { path: '(^|/)(apps/|packages/(infrastructure|resume-renderer|ui)/)' },
    },
    {
      name: 'renderer-no-services',
      severity: 'error',
      from: { path: '(^|/)packages/resume-renderer/' },
      to: { path: '(^|/)(apps/|packages/(application|infrastructure)/)' },
    },
    {
      name: 'packages-no-apps',
      severity: 'error',
      from: { path: '(^|/)packages/' },
      to: { path: '(^|/)apps/' },
    },
    {
      name: 'client-no-server',
      severity: 'error',
      from: { path: '(^|/)apps/web/src/client/' },
      to: {
        path: '(^|/)(apps/web/src/server/|packages/(application|infrastructure)/|packages/config/src/server\\.ts$)',
      },
    },
    {
      name: 'no-private-package-imports',
      severity: 'error',
      from: { path: '(^|/)apps/' },
      to: { path: '(^|/)packages/[^/]+/src/(?!index\\.ts$).+' },
    },
  ],
  options: {
    tsConfig: { fileName: 'tsconfig.base.json' },
    doNotFollow: { path: 'node_modules' },
    exclude: '(^|/)node_modules/|(^|/)\.next/',
  },
};
