# AnimeDekho Nuvio Provider

Converted from the supplied AnimeDekhoProvider.cs3 behaviour into a Promise-based Nuvio local scraper. This maintenance release corrects anime media-type routing, avoids selecting a different TV episode as a fallback, removes the bundled TMDB key, and collects results from all discovered server slots.

## Files
- `manifest.json` — provider repository manifest
- `providers/anime-dekho.js` — provider script

## Install
Host the folder contents on a static HTTPS host with these paths preserved, then add the hosted `manifest.json` URL in Nuvio's Plugins/Local Scrapers section supported by your build. If testing a single provider, load `providers/anime-dekho.js` in the provider tester.

## Important compatibility notes
- This uses the Nuvio provider contract `getStreams(tmdbId, mediaType, season, episode)` and Promise chains (no async/await).
- It uses the `cheerio-without-node-native` module expected by the Nuvio local-scraper runtime.
- TMDB access uses the key injected by current Nuvio runtimes (`__get_tmdb_api_key`). A compatible runtime is required; the provider no longer ships a TMDB key in its source.
- For `anime`, it checks the TMDB TV record first and falls back to the movie record. TV results are returned only when the requested season and episode can be matched exactly.
- Direct links, server-selector iframes, and all `trdekho` and `trembed` slots are collected and URL-deduplicated. Server-slot requests use limited concurrency to avoid a large simultaneous request burst.
- Cloudstream's `loadExtractor()` registry has no direct equivalent in Nuvio. This port handles direct media URLs and a limited set of common iframe hosts; unrecognised hosts may return no playable stream.
- AnimeDekho site markup, domain, TMDB API access, and embedded host behaviour can change. Mocked logic tests do not establish current-site availability or playback; validate in Nuvio's Plugin Tester before treating it as production-ready.
