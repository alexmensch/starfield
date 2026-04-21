interface Fetcher {
  fetch(request: Request): Promise<Response>;
}

interface Env {
  ASSETS: Fetcher;
}

const PREFIX = '/starfield';

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // /starfield → /starfield/ so relative URLs in the HTML (e.g. ./foo.js)
    // resolve against the app directory rather than the origin root.
    if (url.pathname === PREFIX) {
      return Response.redirect(`${url.origin}${PREFIX}/`, 301);
    }

    // Everything under /starfield/ is served out of the assets bundle, which
    // was built with Vite base=/starfield/ so the app's own asset references
    // already include the prefix — strip it here before handing off.
    if (url.pathname.startsWith(`${PREFIX}/`)) {
      url.pathname = url.pathname.slice(PREFIX.length);
      return env.ASSETS.fetch(new Request(url.toString(), request));
    }

    return new Response('Not found', { status: 404 });
  },
};
