// Pure helpers for the build-catalog count assertion (stellata-9mm.183).
//
// `BuildCounts` is a flat record of every headline number `build-catalog.ts`
// logs at the end of a successful build. The committed
// `build-catalog-expected.json` carries the last known-good snapshot, and
// `compareBuildCounts` produces a structured diff for the build script to
// pretty-print on mismatch. Refresh the expected file deliberately with
// `UPDATE_BUILD_COUNTS=1 npm run build:catalog`.

export interface BuildCounts {
  /** Records written to catalog.bin after filtering and sort. */
  recordCount: number;
  /** `inferBinaries` companion assignments. */
  binaryPairs: number;
  /** Pairs where both stars chose each other (sets FLAG_BINARY_PRIMARY). */
  binaryMutualPairs: number;
  /** Entries in the GCVS main table at source. */
  gcvsEntries: number;
  /** GCVS cross-reference Hipparcos lookups. */
  gcvsHipXrefs: number;
  /** GCVS cross-reference Henry Draper lookups. */
  gcvsHdXrefs: number;
  /** Variables matched into the catalog after cross-reference resolution. */
  gcvsMatched: number;
  /** Total CCDM systems in the source TSV. */
  ccdmGroups: number;
  /** CCDM systems resolved against catalog records. */
  ccdmResolved: number;
  /** New FLAG_BINARY_PRIMARY bits set by the CCDM pass (excludes ones
   *  already set by `inferBinaries`). */
  ccdmFlagged: number;
  /** Total entries in the Bailer-Jones DR3 distance TSV (parsed map size). */
  bjEntries: number;
  /** AT-HYG rows the Bailer-Jones override is allowed to fire on:
   *  Gaia DR3 source_id present AND dist_src ∈ {G_R3, G_R2} (the Gaia
   *  inverse-parallax population the posterior is the principled
   *  replacement for). HIP / GJ / N / OTHER rows are excluded — their
   *  underlying distance isn't a Gaia inverse and B-J would silently
   *  move them to the prior's distant tail at low parallax S/N. */
  bjEligible: number;
  /** bjEligible rows whose source_id was also in the B-J catalogue —
   *  the count actually overridden. Coverage = bjOverridden / bjEligible. */
  bjOverridden: number;
  /** AT-HYG rows whose (ra, dec) falls inside the LMC sky cone — the
   *  population the LMC kinematic PM gate is evaluated against. */
  lmcCandidates: number;
  /** Rows that ALSO pass the LMC bulk-PM gate; their dist/x/y/z/absmag
   *  were snapped to Pietrzyński 2019's eclipsing-binary distance. */
  lmcOverridden: number;
  /** Stars with a proper name written into the name table. */
  nameTableEntries: number;
  /** Stars with both nonzero amplitude and period after quantisation —
   *  drives the shader's "is variable" sentinel. */
  variableCount: number;
  /** Entries in search-index.json (stars with at least one searchable
   *  identifier). */
  searchEntries: number;
  /** Record index of Sol after sort. -1 if Sol is not found in source. */
  solIndex: number;
  /** Total stick-figure polylines across all constellations. */
  figureCount: number;
  /** Constellations that carry at least one stick-figure polyline. */
  figureConstellations: number;
}

export type CountDiff =
  | { key: keyof BuildCounts; status: 'match'; value: number }
  | {
      key: keyof BuildCounts;
      status: 'mismatch';
      expected: number;
      actual: number;
    };

/** Compare actual counts against an expected manifest and emit a per-key
 *  diff. Pure — no I/O. The caller decides whether mismatches are fatal. */
export function compareBuildCounts(
  expected: BuildCounts,
  actual: BuildCounts,
): CountDiff[] {
  const keys = Object.keys(actual) as (keyof BuildCounts)[];
  return keys.map((key) => {
    const a = actual[key];
    const e = expected[key];
    if (a === e) return { key, status: 'match' as const, value: a };
    return { key, status: 'mismatch' as const, expected: e, actual: a };
  });
}

/** Pretty-printer for the diff. Used by the build script and any future
 *  CLI consumer. Lines are sorted with mismatches first so a fatal exit
 *  doesn't scroll the actionable rows off-screen. */
export function formatCountDiff(diff: CountDiff[]): string {
  const mismatches = diff.filter((d) => d.status === 'mismatch');
  const lines: string[] = [];
  if (mismatches.length === 0) {
    lines.push(`build-counts: all ${diff.length} counts match`);
  } else {
    lines.push(
      `build-counts: ${mismatches.length} of ${diff.length} counts differ`,
    );
    for (const m of mismatches) {
      if (m.status !== 'mismatch') continue;
      const delta = m.actual - m.expected;
      const sign = delta > 0 ? '+' : '';
      lines.push(
        `  ${m.key.padEnd(22)} expected ${m.expected}, got ${m.actual} (${sign}${delta})`,
      );
    }
  }
  return lines.join('\n');
}
