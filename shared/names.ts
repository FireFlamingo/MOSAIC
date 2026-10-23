import type { ArtifactRequest, ArtifactType } from './types';

export function normalizeName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

export function packageBaseName(name: string): string {
  return name.replace(/@v?\d+(?:\.\d+){0,2}(?:[-+][a-z0-9.-]+)?$/i, '');
}

/** Same artifact, any content: exact name and source. Used only to notice that a trusted artifact changed. */
export const trustIdentityOf = (request: Pick<ArtifactRequest, 'type' | 'name' | 'source'>) =>
  `${request.type}|${request.name.trim().toLowerCase()}|${request.source?.trim().toLowerCase() ?? ''}`;

/** Deliberately broad: ignores version suffixes, case and punctuation so a block covers variants. */
export const blockKeyOf = (type: ArtifactType, name: string) =>
  `${type}|${normalizeName(type === 'package' ? packageBaseName(name) : name)}`;
