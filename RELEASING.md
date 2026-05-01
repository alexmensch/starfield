# Releasing

Stellata uses [Semantic Versioning](https://semver.org/) and tracks
every release in [`CHANGELOG.md`](./CHANGELOG.md). Releases are cut
manually with `npm version` + `gh release create`. There is no CI
release workflow; the steps below are run from a clean working tree on
`main`.

## Version policy

- **Major** — incompatible changes to the URL state format, the
  binary catalogue layout, the Worker route, or anything else that
  breaks bookmarks / saved links.
- **Minor** — new user-visible features (rendering modes, overlays,
  data sources), backward-compatible.
- **Patch** — bug fixes, copy tweaks, dependency bumps with no
  user-visible behaviour change.

## Cutting a release

1. **Make sure `main` is clean and green.**
   ```sh
   git status
   npm run typecheck
   ```

2. **Update `CHANGELOG.md`** — add a new section at the top following
   the format of the previous release. Include the date.

3. **Bump the version.** This edits `package.json` and creates an
   annotated `vX.Y.Z` git tag.
   ```sh
   npm version <patch|minor|major>
   ```

4. **Push commits and the new tag.**
   ```sh
   git push origin main --follow-tags
   ```

5. **Create the GitHub release** from the tag, sourcing notes from the
   matching `CHANGELOG.md` section.
   ```sh
   VERSION=$(node -p "require('./package.json').version")
   gh release create "v$VERSION" \
     --title "v$VERSION" \
     --notes-file CHANGELOG.md \
     --draft
   ```
   Trim the changelog body in the GitHub UI to just the new
   release's section, then publish.

6. **Deploy.**
   ```sh
   npm run deploy
   ```

## After the release

- Verify `https://alxm.me/stellata/` serves the new version
  (visible at the bottom-right of the About modal).
- Add a placeholder `## [Unreleased]` section to `CHANGELOG.md` to
  collect the next set of changes.
