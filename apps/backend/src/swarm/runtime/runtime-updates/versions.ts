/** `x.y.z` with an optional `v` prefix and suffix; prerelease ordering is not needed for CLI releases. */
export function parseVersion(value: string): [number, number, number] | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(value.trim());
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

/** Exactly `x.y.z`; required wherever a version becomes part of a path. */
export function isPlainVersion(value: string): boolean {
  return /^\d+\.\d+\.\d+$/.test(value);
}

export function compareVersions(a: string, b: string): number {
  const [left, right] = [parseVersion(a), parseVersion(b)];
  if (!left || !right) return 0;
  for (let index = 0; index < 3; index++) {
    if (left[index] !== right[index]) return left[index]! - right[index]!;
  }
  return 0;
}
