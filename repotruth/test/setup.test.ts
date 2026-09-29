import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { classifyLicenseText } from '../src/parsers/license.js';
import { auditFiles, byRule } from './helpers.js';

const MIT = 'MIT License\n\nPermission is hereby granted, free of charge, to any person obtaining a copy...\n';
const PROPRIETARY = 'PROPRIETARY LICENSE\nALL RIGHTS RESERVED\nNo use, copying, or distribution is permitted.\n';
const README_NPM = '# x\n\n```bash\ngit clone https://example.com/x.git\ncd x\nnpm install\nnpm test\n```\n';

describe('setup.readme-manifest-missing', () => {
  it('flags npm commands when no package.json exists anywhere', async () => {
    const r = await auditFiles({ 'README.md': README_NPM });
    const [f, ...rest] = byRule(r, 'setup.readme-manifest-missing');
    assert.equal(rest.length, 0);
    assert.equal(f!.confidence, 'high');
    assert.equal(f!.status, 'finding');
    assert.equal(f!.location.line, 6);
  });

  it('handles trailing shell comments on setup lines', async () => {
    const r = await auditFiles({ 'README.md': '```bash\nnpm install   # deps\n# or: yarn install\n```\n' });
    assert.equal(byRule(r, 'setup.readme-manifest-missing')[0]!.evidence, 'npm install');
  });

  it('does not flag when package.json is present', async () => {
    const r = await auditFiles({ 'README.md': README_NPM, 'package.json': '{"name":"x"}' });
    assert.deepEqual(byRule(r, 'setup.readme-manifest-missing'), []);
  });

  it('follows cd into an existing subdirectory', async () => {
    const r = await auditFiles({ 'README.md': '```sh\ncd web && npm ci\n```\n', 'web/package.json': '{}' });
    assert.deepEqual(byRule(r, 'setup.readme-manifest-missing'), []);
  });

  it('lowers confidence when a manifest exists only in a subdirectory', async () => {
    const r = await auditFiles({ 'README.md': README_NPM, 'tools/package.json': '{}' });
    const [f] = byRule(r, 'setup.readme-manifest-missing');
    assert.equal(f!.status, 'needs-review');
    assert.equal(f!.confidence, 'medium');
  });

  it('ignores global installs, npx, and non-shell code blocks', async () => {
    const r = await auditFiles({
      'README.md': '```bash\nnpm install -g foo\nnpx create-thing\n```\n\n```js\n// npm install\n```\n',
    });
    assert.deepEqual(byRule(r, 'setup.readme-manifest-missing'), []);
  });
});

describe('setup.license-conflict', () => {
  it('flags README MIT vs proprietary LICENSE as needs-review', async () => {
    const r = await auditFiles({ 'README.md': '# x\n\n## License\n\nThis project is licensed under the MIT License.\n', LICENSE: PROPRIETARY });
    const [f] = byRule(r, 'setup.license-conflict');
    assert.ok(f);
    assert.equal(f.status, 'needs-review');
    assert.equal(f.location.line, 5);
  });

  it('accepts agreeing licenses', async () => {
    const r = await auditFiles({ 'README.md': '## License\nMIT\n', LICENSE: MIT });
    assert.deepEqual(byRule(r, 'setup.license-conflict'), []);
  });

  it('does not guess when LICENSE text is unrecognized', async () => {
    const r = await auditFiles({ 'README.md': '## License\nMIT\n', LICENSE: 'Some custom terms.\n' });
    assert.deepEqual(byRule(r, 'setup.license-conflict'), []);
    assert.ok(r.coverage.notEvaluated.some((e) => e.area === 'setup: license'));
  });

  it('checks package.json license against the sibling LICENSE', async () => {
    const r = await auditFiles({ 'package.json': '{"license":"MIT"}', LICENSE: PROPRIETARY });
    assert.equal(byRule(r, 'setup.license-conflict').length, 1);
  });

  it('classifies common license texts', () => {
    assert.equal(classifyLicenseText(MIT), 'MIT');
    assert.equal(classifyLicenseText(PROPRIETARY), 'Proprietary');
    assert.equal(classifyLicenseText('Apache License\nVersion 2.0, January 2004'), 'Apache-2.0');
    assert.equal(classifyLicenseText('Copyright 2020. All rights reserved.'), 'unknown');
  });
});

describe('declared language and links', () => {
  it('flags a declared language with no source files, not one that exists', async () => {
    const bad = await auditFiles({ 'README.md': 'Developed in **Rust**.\n', 'main.py': 'x=1\n' });
    assert.equal(byRule(bad, 'setup.declared-language-missing').length, 1);
    const ok = await auditFiles({ 'README.md': 'Written in TypeScript.\n', 'a.ts': 'export {};\n' });
    assert.deepEqual(byRule(ok, 'setup.declared-language-missing'), []);
  });

  it('flags missing relative links but not URLs, anchors, existing files, or links leaving the repo', async () => {
    const r = await auditFiles({
      'README.md': '[a](docs/guide.md) [b](https://x.dev) [c](#top) [d](MISSING.md) [e](../../security/advisories/new)\n',
      'docs/guide.md': '# g\n',
    });
    const f = byRule(r, 'docs.broken-relative-link');
    assert.equal(f.length, 1);
    assert.equal(f[0]!.evidence, 'MISSING.md');
  });
});
