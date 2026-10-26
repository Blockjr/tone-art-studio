// Static host for the Tone Art Studio web app and its downloads.
//
// The app is entirely client side: arrangement, session, mixer, devices and
// mastering all run in the browser's audio engine, and projects are stored in
// IndexedDB. There is no API to serve, so every request is an asset request.
//
// The downloadable archives are stored with a `.bin` suffix because the asset
// uploader only accepts known extensions. A request for the real filename is
// answered from the matching `.bin` asset with the right type and an
// attachment header, so the browser saves `ToneArtStudio-....zip` as-is.
const ARCHIVE = /^\/download\/([A-Za-z0-9][A-Za-z0-9._-]*\.zip)$/;

const TYPES = {
  zip: 'application/zip',
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const match = ARCHIVE.exec(url.pathname);

    if (match) {
      const assetUrl = new URL(request.url);
      assetUrl.pathname = `/download/${match[1]}.bin`;
      const asset = await env.ASSETS.fetch(new Request(assetUrl.toString(), request));
      if (asset.ok) {
        const headers = new Headers(asset.headers);
        headers.set('content-type', TYPES.zip);
        headers.set('content-disposition', `attachment; filename="${match[1]}"`);
        headers.set('cache-control', 'public, max-age=300');
        return new Response(asset.body, { status: 200, statusText: 'OK', headers });
      }
      return new Response('Not found', { status: 404, headers: { 'content-type': 'text/plain' } });
    }

    return env.ASSETS.fetch(request);
  },
};
