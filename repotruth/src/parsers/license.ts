// License family detection. Classification uses well-known verbatim phrases
// only; anything else is `unknown` and is never reported as a conflict.

export type LicenseFamily =
  | 'MIT' | 'Apache-2.0' | 'GPL' | 'LGPL' | 'AGPL' | 'BSD' | 'MPL-2.0' | 'Unlicense' | 'ISC' | 'Proprietary';

/** Classifies the text of a LICENSE file. */
export function classifyLicenseText(text: string): LicenseFamily | 'unknown' {
  const t = text.replace(/\s+/g, ' ');
  if (/GNU AFFERO GENERAL PUBLIC LICENSE/i.test(t)) return 'AGPL';
  if (/GNU LESSER GENERAL PUBLIC LICENSE/i.test(t)) return 'LGPL';
  if (/GNU GENERAL PUBLIC LICENSE/i.test(t)) return 'GPL';
  if (/Apache License,? Version 2\.0/i.test(t)) return 'Apache-2.0';
  if (/Mozilla Public License,? (Version |v\.? ?)?2\.0/i.test(t)) return 'MPL-2.0';
  if (/free and unencumbered software released into the public domain/i.test(t)) return 'Unlicense';
  if (/Permission is hereby granted, free of charge/i.test(t)) return 'MIT';
  if (/Permission to use, copy, modify, and\/or distribute this software for any purpose/i.test(t)) return 'ISC';
  if (/Redistribution and use in source and binary forms/i.test(t)) return 'BSD';
  if (/all rights reserved/i.test(t) && /(proprietary|not permitted|confidential|no use, copying|unauthori[sz]ed)/i.test(t)) {
    return 'Proprietary';
  }
  return 'unknown';
}

const MENTIONS: [RegExp, LicenseFamily][] = [
  [/\bAGPL/i, 'AGPL'],
  [/\bLGPL/i, 'LGPL'],
  [/\b(?<![AL])GPL(?:-?v?[23])?\b|GNU General Public/i, 'GPL'],
  [/\bApache(?:[- ]License)?[- ]?(?:2(?:\.0)?)?\b/i, 'Apache-2.0'],
  [/\bMPL\b|Mozilla Public/i, 'MPL-2.0'],
  [/\bUnlicense\b/i, 'Unlicense'],
  [/\bMIT\b/, 'MIT'],
  [/\bISC\b/, 'ISC'],
  [/\bBSD\b/, 'BSD'],
  [/\bproprietary\b|\ball rights reserved\b|\bUNLICENSED\b/i, 'Proprietary'],
];

/** License families named on README lines that talk about licensing. */
export function licenseMentions(lines: { text: string; line: number }[]): { family: LicenseFamily; line: number; text: string }[] {
  const out: { family: LicenseFamily; line: number; text: string }[] = [];
  let inLicenseSection = false;
  for (const { text, line } of lines) {
    const heading = /^\s{0,3}#{1,6}\s+(.*)$/.exec(text);
    if (heading) inLicenseSection = /licen[cs]/i.test(heading[1] ?? '');
    if (heading || !(inLicenseSection || /licen[cs]ed?\b/i.test(text))) continue;
    for (const [re, family] of MENTIONS) {
      if (re.test(text) && !out.some((o) => o.family === family)) out.push({ family, line, text });
    }
  }
  return out;
}

/** Maps an SPDX-ish identifier (package.json `license`) to a family. */
export function familyFromSpdx(id: string): LicenseFamily | 'unknown' {
  const s = id.trim();
  if (/^UNLICENSED$/i.test(s)) return 'Proprietary';
  if (/^MIT$/i.test(s)) return 'MIT';
  if (/^Apache-2\.0$/i.test(s)) return 'Apache-2.0';
  if (/^AGPL/i.test(s)) return 'AGPL';
  if (/^LGPL/i.test(s)) return 'LGPL';
  if (/^GPL/i.test(s)) return 'GPL';
  if (/^BSD/i.test(s)) return 'BSD';
  if (/^MPL-2\.0$/i.test(s)) return 'MPL-2.0';
  if (/^Unlicense$/i.test(s)) return 'Unlicense';
  if (/^ISC$/i.test(s)) return 'ISC';
  return 'unknown';
}
