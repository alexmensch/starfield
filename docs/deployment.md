# Deployment

Cloudflare assets-only deploy: the site is served directly from `./dist`
via the `[assets]` binding in `wrangler.toml`. There is no Worker — the
prefix-stripping entry that lived at `src/worker.ts` was dropped when
the project moved from `alxm.me/stellata/` to the root of `stellata.xyz`.

## Wrangler config

`wrangler.toml` declares only the project name, the routes for the
apex of `stellata.xyz`, and the assets directory. `routes` must appear
**before** `[assets]` in the TOML — TOML sections claim every line
after them until the next section header, so a top-level array after a
`[section]` would be parsed as part of that section.

`compatibility_date` is pinned to `2026-04-22`. Bump deliberately when
new runtime features are needed; `wrangler deploy` will log when it's
overriding whatever the dashboard has.
