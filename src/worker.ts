// Copyright (C) 2026 Alex Marshall
// SPDX-License-Identifier: AGPL-3.0-only

interface Fetcher {
  fetch(request: Request): Promise<Response>;
}

interface Env {
  ASSETS: Fetcher;
}

// Thin passthrough. The Worker exists so per-request analytics,
// observability logs, and tail are available — pure assets-only deploys
// lose those. With the app at the apex of stellata.xyz there is no path
// prefix to strip; just hand the request to the assets binding.
export default {
  fetch(request: Request, env: Env): Promise<Response> {
    return env.ASSETS.fetch(request);
  },
};
