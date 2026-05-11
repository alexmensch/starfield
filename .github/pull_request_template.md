<!--
PR title goes in the title field above. Keep it short (under 70 chars);
detail lives below.
-->

## Summary

<!-- 1–3 bullets describing what this PR does. -->

## Test plan

<!-- Bulleted checklist of what you ran / what should be smoke-tested. -->

- [ ] `npm run typecheck`
- [ ] `npm test`
- [ ] Manual smoke in browser
- [ ] If you touched `scripts/build-catalog.ts` / `scripts/catalog-pure.ts`: `rm -f public/catalog.bin && npm run build:catalog` — the count assertion against `scripts/build-catalog-expected.json` either passes (no change to the manifest) or fails with a diff. Drift the manifest deliberately with `UPDATE_BUILD_COUNTS=1 npm run build:catalog`.

## Release notes

<!--
This section is consolidated into the GitHub release for the version
this PR ships. The `release-notes-guard` workflow fails the PR if
this section is empty (after stripping HTML comments).

Write user-facing prose, not implementation detail. Suggested
shape — drop sub-sections that don't apply, add ones that do:

  ### Summary
  1–2 sentences capturing the headline change.

  ### New features
  - …

  ### Bugfixes
  - …

  ### Changes
  Modifications to existing behaviour.
  - …

Markdown — bullets, links, code spans all render on the release
page.

For metadata-only PRs (no version bump, attach the
`skip-version-bump` label) you can leave this section empty.
-->
