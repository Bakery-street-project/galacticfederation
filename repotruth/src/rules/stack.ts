// Ecosystem evidence shared by rules: which toolchains does the repository
// actually contain, judged from source extensions and manifests only.

import type { RepoIndex } from '../discovery.js';
import { languageOf } from '../text.js';

export type Ecosystem = 'python' | 'node' | 'go' | 'rust' | 'java';

const MANIFESTS: Record<Ecosystem, RegExp> = {
  python: /(^|\/)(requirements[^/]*\.txt|pyproject\.toml|setup\.py|setup\.cfg|Pipfile|tox\.ini|poetry\.lock)$/,
  node: /(^|\/)package\.json$/,
  go: /(^|\/)go\.mod$/,
  rust: /(^|\/)Cargo\.toml$/,
  java: /(^|\/)(pom\.xml|build\.gradle(\.kts)?|settings\.gradle(\.kts)?)$/,
};

const LANGS: Record<Ecosystem, string[]> = {
  python: ['python'],
  node: ['javascript', 'typescript'],
  go: ['go'],
  rust: ['rust'],
  java: ['java', 'kotlin'],
};

export interface EcosystemEvidence {
  manifests: string[];
  sources: number;
}

export function ecosystemEvidence(index: RepoIndex, eco: Ecosystem): EcosystemEvidence {
  const manifests: string[] = [];
  let sources = 0;
  for (const p of index.files.keys()) {
    if (MANIFESTS[eco].test(p)) manifests.push(p);
    const lang = languageOf(p);
    if (lang && LANGS[eco].includes(lang)) sources++;
  }
  return { manifests, sources };
}

export function hasEcosystem(index: RepoIndex, eco: Ecosystem): boolean {
  const e = ecosystemEvidence(index, eco);
  return e.manifests.length > 0 || e.sources > 0;
}
