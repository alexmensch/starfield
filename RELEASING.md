# Releasing

Stellata uses [Semantic Versioning](https://semver.org/). Each tagged
release is its own changelog — the GitHub release page collects the
PR titles auto-generated from the diff since the previous tag, and
each PR's body has the detail. There is no separate `CHANGELOG.md`
and no CI release workflow; the steps below are run manually from a
clean working tree on `main`.

## Version policy

- **Major** — incompatible changes to the URL state format, the
  binary catalogue layout, the Worker route, or anything else that
  breaks bookmarks / saved links.
- **Minor** — new user-visible features (rendering modes, overlays,
  data sources), backward-compatible.
- **Patch** — bug fixes, copy tweaks, dependency bumps with no
  user-visible behaviour change.

Bump `package.json` on every PR so the version on `main` is always
the *next* release. Cutting a release is then just tagging — no
version bump dance required at release time.

The `version-guard` workflow (`.github/workflows/version-guard.yml`)
runs on every PR and asserts:

1. `package.json#version` is strictly greater (per semver) than the
   base branch's version.
2. The new version is not already a published git tag.

Concurrent PRs can't silently both claim the same bump: whichever
merges second fails the guard until rebased and re-bumped. Pure
metadata PRs (e.g. `bd` issue-sync, no shipped code) can attach the
`skip-version-bump` label to opt out — use sparingly.

## Cutting a release

1. **Make sure `main` is clean and green.**
   ```sh
   git status
   npm run typecheck
   npm test
   ```

2. **Tag the current `main` with the version already in `package.json`.**
   ```sh
   VERSION=$(node -p "require('./package.json').version")
   git tag -a "v$VERSION" -m "v$VERSION"
   ```

3. **Push the tag.**
   ```sh
   git push origin "v$VERSION"
   ```

4. **Create the GitHub release with auto-generated notes.**
   ```sh
   gh release create "v$VERSION" \
     --title "v$VERSION" \
     --generate-notes
   ```

5. **Deploy.**
   ```sh
   npm run deploy
   ```

## After the release

- Verify `https://stellata.xyz` serves the new version (visible at
  the bottom-right of the About modal).
- Bump `package.json` on the next PR to the version that release will
  carry.
