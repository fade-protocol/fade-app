// Runs only for requests that match no built file (wrangler.jsonc: assets are
// served first, not_found_handling "none"). It keeps the single-page fallback
// for app routes and answers a real 404 for anything that looks like a file.
//
// Why: with a blanket SPA fallback, a hashed chunk that no longer exists (a tab
// opened before a deploy) came back as index.html with a 200, the browser
// refused it as a module script, and that HTML could be cached under the .js
// URL. A 404 lets the client notice and reload (src/lib/staleDeploy.ts).

interface Env {
  ASSETS: { fetch(request: Request): Promise<Response> };
}

/** A last path segment with an extension: "/assets/engine-x1y2.js", "/logo.svg". */
const FILE_LIKE = /\.[a-z0-9]+$/i;

function notFound(): Response {
  return new Response("Not found", {
    status: 404,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/assets/") || FILE_LIKE.test(url.pathname)) return notFound();
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("Method not allowed", { status: 405, headers: { allow: "GET, HEAD" } });
    }
    // The vault page once lived at /pool: links shared then still reach it (the
    // browser keeps the #tab across the redirect).
    if (url.pathname === "/pool" || url.pathname === "/pool/")
      return Response.redirect(new URL(`/vault${url.search}`, url).toString(), 301);
    // An app route: serve the shell, the client router takes it from there. A draw's link,
    // /w/<ticket> (a share card's QR code), is one: an address never has an extension.
    return env.ASSETS.fetch(new Request(new URL("/", url), request));
  },
};
