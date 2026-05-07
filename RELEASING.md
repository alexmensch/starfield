# Releasing

Stellata uses [Semantic Versioning](https://semver.org/). Each tagged
release is its own changelog — the GitHub release page is populated
from a `## Release notes` section in the merging PR's body. There is
no separate `CHANGELOG.md`.

Releases are cut automatically by `.github/workflows/deploy.yml`:
every push to `main` whose `package.json#version` differs from the
previous commit triggers a build, a `wrangler deploy`, a `v<version>`
tag, and a GitHub release. PRs that bump the version therefore
release on merge; the work below is mostly about getting the bump
*and the release notes section* right on the PR.

## Release notes per PR

The PR template (`.github/pull_request_template.md`) carries a
`## Release notes` block. Fill it with user-facing prose for the
version this PR ships — sub-headings for *Summary*, *New features*,
*Bugfixes*, and *Changes* (drop ones that don't apply).

The `release-notes-guard` workflow
(`.github/workflows/release-notes-guard.yml`) fails any PR whose
body lacks a non-empty `## Release notes` section (HTML comments are
stripped before the check, so the empty template doesn't pass).
Pure metadata PRs that attach `skip-version-bump` are exempt — they
don't ship a release.

When the deploy workflow runs, it parses the squash-commit subject
for the merged PR number, fetches the body via `gh pr view --json
body`, extracts the `## Release notes` section, and passes it to
`gh release create --notes-file`. If the section can't be found
(non-squash merge, body fetch fails) it falls back to GitHub's
`--generate-notes`.

## Version policy

- **Major** — incompatible changes to the URL state format, the
  binary catalogue layout, the Worker route, or anything else that
  breaks bookmarks / saved links.
- **Minor** — new user-visible features (rendering modes, overlays,
  data sources), backward-compatible.
- **Patch** — bug fixes, copy tweaks, dependency bumps with no
  user-visible behaviour change.

Bump `package.json` on every PR so the version on `main` is always
the *next* release. Cutting a release is then just merging — the
deploy workflow handles tag, GitHub release, and Cloudflare deploy.

The `version-guard` workflow (`.github/workflows/version-guard.yml`)
runs on every PR and asserts:

1. `package.json#version` is strictly greater (per semver) than the
   base branch's version.
2. The new version is not already a published git tag.

Concurrent PRs can't silently both claim the same bump: whichever
merges second fails the guard until rebased and re-bumped. Pure
metadata PRs (e.g. `bd` issue-sync, no shipped code, CI workflow
edits) can attach the `skip-version-bump` label to opt out — use
sparingly. PRs without a bump don't redeploy.

## What the deploy workflow does

On every push to `main`, `deploy.yml`:

1. Compares `HEAD:package.json#version` against `HEAD~1:package.json#version`.
   No change → exits silently.
2. Checks out with LFS, sets up Node 20 + Python 3, runs `npm ci`
   and `npm run build` (catalog + clouds + dust-sync + client).
3. Deploys to Cloudflare via `cloudflare/wrangler-action@v3`.
4. Tags `v<version>` and pushes the tag.
5. Extracts the `## Release notes` section from the merging PR's
   body and creates the GitHub release with `--notes-file`. Falls
   back to `--generate-notes` if the section is missing.

Required repository secrets:

- `CLOUDFLARE_API_TOKEN` — token scoped to: Account → Workers
  Scripts:Edit; Zone → Workers Routes:Edit + DNS:Edit (on the
  `stellata.xyz` zone, so wrangler can manage the proxied apex
  record from `wrangler.toml`'s `custom_domain = true`).
- `CLOUDFLARE_ACCOUNT_ID` — the Cloudflare account hosting the
  Worker.

## After a release

- Verify `https://stellata.xyz` serves the new version (visible at
  the bottom-right of the About modal).
- Bump `package.json` on the next PR to the version that release
  will carry.

## Manual release (fallback)

If the workflow needs to be bypassed (e.g. infrastructure outage):

```sh
VERSION=$(node -p "require('./package.json').version")
git tag -a "v$VERSION" -m "v$VERSION"
git push origin "v$VERSION"
# Use --notes-file with the PR's release-notes section, or
# --generate-notes as a quick fallback.
gh release create "v$VERSION" --title "v$VERSION" --generate-notes
npm run deploy
```
