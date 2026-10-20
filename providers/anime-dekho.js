/* AnimeDekho -> Nuvio local scraper
 * Ported from the supplied AnimeDekhoProvider.cs3 behaviour and the publicly
 * available provider implementation. Promise-only for QuickJS/Hermes runtimes.
 */
var cheerio = require("cheerio-without-node-native");
var BASE_URL = "https://animedekho.app";
var UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
var BASE_HEADERS = {
  "User-Agent": UA,
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  "Referer": BASE_URL + "/"
};

function getTmdbApiKey() {
  try {
    return typeof __get_tmdb_api_key === "function"
      ? String(__get_tmdb_api_key() || "").trim()
      : "";
  } catch (_) {
    return "";
  }
}
function isHttpUrl(url) {
  try {
    var parsed = new URL(String(url || ""));
    return (parsed.protocol === "http:" || parsed.protocol === "https:")
      && !!parsed.hostname && !parsed.username && !parsed.password;
  } catch (_) {
    return false;
  }
}
function getText(url, headers) {
  if (!isHttpUrl(url)) return Promise.reject(new Error("Blocked non-HTTP URL"));
  return fetch(url, { headers: Object.assign({}, BASE_HEADERS, headers || {}) }).then(function (r) {
    if (!r.ok && r.status >= 400) throw new Error("HTTP " + r.status + " for " + url);
    return r.text();
  });
}
function getJson(url) {
  return fetch(url, { headers: { "User-Agent": UA, "Accept": "application/json" } }).then(function (r) {
    if (!r.ok && r.status >= 400) throw new Error("HTTP " + r.status + " for " + url);
    return r.json();
  });
}
function absUrl(url, base) {
  try { return new URL(url, base || BASE_URL).toString(); }
  catch (_) {
    if (!url) return "";
    if (/^https?:\/\//i.test(url)) return url;
    return (base || BASE_URL).replace(/\/$/, "") + "/" + url.replace(/^\//, "");
  }
}
function norm(s) {
  return String(s || "").toLowerCase().replace(/&amp;/g, "&").replace(/\[[^\]]*\]|\([^)]*\)/g, " ")
    .replace(/[^a-z0-9]+/g, " ").trim().replace(/\s+/g, " ");
}
function titleScore(a, b) {
  var x = norm(a), y = norm(b);
  if (!x || !y) return 0;
  if (x === y) return 100;
  if (x.indexOf(y) >= 0 || y.indexOf(x) >= 0) return 80;
  var xa = x.split(" "), ya = y.split(" "), hits = 0;
  xa.forEach(function (w) { if (w.length > 1 && ya.indexOf(w) >= 0) hits++; });
  return Math.round(60 * hits / Math.max(xa.length, ya.length));
}
function getTitle(details) {
  return details && (details.title || details.name || details.original_title || details.original_name) || "";
}
function getTmdbDetails(tmdbId, mediaType, apiKey) {
  var requested = String(mediaType || "movie").toLowerCase();
  var preferredType = (requested === "tv" || requested === "series" || requested === "show") ? "tv" : "movie";
  var types = requested === "anime" ? ["tv", "movie"] : [preferredType];
  function tryType(index) {
    if (index >= types.length) return Promise.reject(new Error("TMDB title not found"));
    var type = types[index];
    var url = "https://api.themoviedb.org/3/" + type + "/" + encodeURIComponent(tmdbId)
      + "?api_key=" + encodeURIComponent(apiKey);
    return getJson(url).then(function (details) {
      if (!getTitle(details)) throw new Error("TMDB response has no title");
      return { details: details, type: type };
    }).catch(function () {
      if (index + 1 < types.length) return tryType(index + 1);
      throw new Error("TMDB title lookup failed");
    });
  }
  return tryType(0);
}
function extractTerm(html) {
  var $ = cheerio.load(html);
  var bodyClass = $("body").attr("class") || "";
  var m = bodyClass.match(/(?:term|postid)-(\d+)/i);
  return m ? m[1] : null;
}
function extractDirectStreams(html, pageUrl, label) {
  var out = [];
  var seen = {};
  function add(url, quality, headers) {
    url = absUrl(String(url || "").replace(/&amp;/g, "&"), pageUrl);
    if (!/^https?:\/\//i.test(url) || seen[url]) return;
    if (!/\.(?:m3u8|mp4|mkv|avi|webm|mpd)(?:[?#]|$)|\/api\/file\//i.test(url)) return;
    seen[url] = true;
    out.push({ name: "AnimeDekho" + (label ? " - " + label : ""), title: quality || "Auto", url: url,
      quality: quality || "Unknown", size: "Unknown", headers: Object.assign({ "User-Agent": UA, "Referer": pageUrl }, headers || {}), provider: "anime-dekho" });
  }
  var $ = cheerio.load(html);
  $("video source[src], source[src]").each(function () { add($(this).attr("src"), "Auto"); });
  $("a[href]").each(function () { var h = $(this).attr("href"); if (h && /\.(?:m3u8|mp4|mkv|avi)(?:[?#]|$)/i.test(h)) add(h, "Auto"); });
  // Scan player configs as well as ordinary <source> tags. NeoCDN embeds
  // commonly keep the media URL in JS/JSON config instead of the DOM.
  var re = /["']((?:https?:)?\\?\/\\?\/[^"'\s<>]+?\.(?:m3u8|mp4|mkv|webm|mpd)(?:[?#][^"'\s<>]*)?)["']/ig, m;
  while ((m = re.exec(html)) !== null) add(m[1].replace(/\\\//g, "/"), "Auto");
  // Also handle JSON-style `file`, `src`, `source`, `hls` and `url` properties,
  // including relative/protocol-relative URLs used by some NeoCDN mirrors.
  var cfg = /(?:file|src|source|hls|url|playlist)\s*[:=]\s*["']([^"']+(?:\.m3u8|\.mp4|\.mkv|\.webm|\.mpd)(?:[?#][^"']*)?)["']/ig;
  while ((m = cfg.exec(html)) !== null) add(m[1].replace(/\\\//g, "/"), "Auto");
  return out;
}
function unpackJs(packed) {
  if (!packed) return "";
  var match = packed.match(/eval\s*\(\s*function\s*\(\s*p\s*,\s*a\s*,\s*c\s*,\s*k\s*,\s*e\s*,\s*d\s*\)[\s\S]*?\}\s*\(\s*(['"])([\s\S]*?)\1\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*(['"])([\s\S]*?)\6\.split\(['"]\|['"]\)/);
  if (!match) return packed;
  var p = match[2], radix = parseInt(match[3], 10), count = parseInt(match[4], 10), words = match[7].split("|");
  function enc(n, r) { return (n < r ? "" : enc(Math.floor(n / r), r)) + (n % r > 35 ? String.fromCharCode(n % r + 29) : (n % r).toString(36)); }
  while (count--) { if (words[count]) p = p.replace(new RegExp("\\b" + enc(count, radix) + "\\b", "g"), words[count]); }
  return p;
}
function hostName(url) {
  var m = String(url || "").match(/^https?:\/\/([^/]+)/i);
  return m ? m[1] : "Server";
}
function extractHostStreams(html, url) {
  var low = String(url || "").toLowerCase(), body = unpackJs(html) || html;
  var streams = extractDirectStreams(body, url, hostName(url)), seen = {};
  streams.forEach(function (stream) { seen[stream.url] = true; });
  function add(rawUrl) {
    var mediaUrl = absUrl(String(rawUrl || "").replace(/\\\//g, "/"), url);
    if (!isHttpUrl(mediaUrl) || seen[mediaUrl]) return;
    seen[mediaUrl] = true;
    streams.push({ name: "AnimeDekho - " + hostName(url), title: "Auto", url: mediaUrl, quality: "Unknown", size: "Unknown",
      headers: { "User-Agent": UA, "Referer": url }, provider: "anime-dekho" });
  }
  var patterns = [];
  if (/neocdn|neo-cdn|neo_cdn/i.test(low)) {
    patterns.push(/(?:file|src|source|hls|url|playlist)\s*[:=]\s*["']((?:https?:)?\\?\/\\?\/[^"']+?\.(?:m3u8|mp4)(?:[?#][^"']*)?)["']/ig);
    patterns.push(/["']((?:https?:)?\\?\/\\?\/[^"']+?\.(?:m3u8|mp4)(?:[?#][^"']*)?)["']/ig);
  } else if (low.indexOf("vidmoly") >= 0) {
    patterns.push(/file\s*:\s*["']([^"']+\.m3u8[^"']*)["']/ig);
  } else if (/filemoon|abyssplayer|rubystm|streamhide|cloudy\.upns|gdmirrorbot|emturbovid/.test(low)) {
    patterns.push(/sources\s*:\s*\[\s*\{\s*file\s*:\s*["']([^"']+\.m3u8[^"']*)["']/ig);
    patterns.push(/file\s*:\s*["']([^"']+\.m3u8[^"']*)["']/ig);
  } else if (/voe\.sx|voe\.network/.test(low)) {
    patterns.push(/hls['"]?\s*:\s*['"]([^'"]+\.m3u8[^'"]*)['"]/ig);
  }
  patterns.forEach(function (pattern) {
    var match;
    while ((match = pattern.exec(body)) !== null) add(match[1]);
  });
  return streams;
}
function resolveIframe(url, pageUrl, depth) {
  depth = Number(depth || 0);
  if (!url || depth > 3) return Promise.resolve([]);
  url = absUrl(url, pageUrl);
  if (!isHttpUrl(url)) return Promise.resolve([]);
  if (/\.(?:m3u8|mp4|mkv|avi)(?:[?#]|$)/i.test(url)) {
    return Promise.resolve([{ name: "AnimeDekho", title: "Auto", url: url, quality: "Unknown", size: "Unknown",
      headers: { "User-Agent": UA, "Referer": pageUrl || BASE_URL + "/" }, provider: "anime-dekho" }]);
  }
  return getText(url, { "Referer": pageUrl || BASE_URL + "/" }).then(function (html) {
    var streams = extractHostStreams(html, url), $ = cheerio.load(html), nestedUrls = [];
    $("iframe[src]").each(function () {
      var nested = absUrl($(this).attr("src"), url);
      if (isHttpUrl(nested) && nested !== url && nestedUrls.indexOf(nested) < 0) nestedUrls.push(nested);
    });
    if (/neocdn|neo-cdn|neo_cdn/i.test(url)) {
      $("a[href*='embed'], a[href*='player']").each(function () {
        var embed = absUrl($(this).attr("href"), url);
        if (isHttpUrl(embed) && embed !== url && nestedUrls.indexOf(embed) < 0) nestedUrls.push(embed);
      });
    }
    return mapLimit(nestedUrls, 3, function (nested) {
      return resolveIframe(nested, url, depth + 1);
    }).then(function (batches) {
      batches.forEach(function (batch) { (batch || []).forEach(function (stream) { streams.push(stream); }); });
      return streams;
    });
  }).catch(function () {
    return [];
  });
}
function findItem(searchHtml, title) {
  var $ = cheerio.load(searchHtml), candidates = [];
  $("ul[data-results] li article, article").each(function () {
    var el = $(this), href = el.find("a.lnk-blk").first().attr("href") || el.find("a[href]").first().attr("href");
    var name = el.find("header h2, h2.entry-title, h2").first().text().trim();
    if (href) candidates.push({ url: absUrl(href), title: name, score: titleScore(name, title) });
  });
  candidates.sort(function (a, b) { return b.score - a.score; });
  return candidates.length && candidates[0].score >= 45 ? candidates[0] : null;
}
function parseEpisodeLabel(label) {
  var text = String(label || "");
  var match = text.match(/\b(?:s|season)\s*(\d+)\s*(?:[-._ ]*)?(?:e|ep|episode)\s*(\d+)\b/i);
  if (match) return { season: parseInt(match[1], 10), episode: parseInt(match[2], 10) };
  match = text.match(/\b(\d{1,2})\s*x\s*(\d{1,3})\b/i);
  if (match) return { season: parseInt(match[1], 10), episode: parseInt(match[2], 10) };
  match = text.match(/\b(?:s|season)\s*(\d+)\b/i);
  return match ? { season: parseInt(match[1], 10), episode: null } : { season: null, episode: null };
}
function findEpisodeUrl(seriesHtml, season, episode) {
  var $ = cheerio.load(seriesHtml), items = [];
  $("ul.seasons-lst li").each(function () {
    var el = $(this), href = el.find("a[href]").first().attr("href");
    var span = el.find("h3.title span").text() || el.find("h3.title").text();
    var parsed = parseEpisodeLabel(span);
    items.push({ url: href ? absUrl(href) : "", season: parsed.season, episode: parsed.episode });
  });
  var wantedSeason = Number(season || 1), wantedEpisode = Number(episode || 1);
  var exact = items.find(function (x) { return x.url && x.season === wantedSeason && x.episode === wantedEpisode; });
  return exact ? exact.url : "";
}
function mapLimit(items, concurrency, worker) {
  var output = new Array(items.length), nextIndex = 0;
  var workerCount = Math.min(items.length, Math.max(1, Number(concurrency) || 1));
  function runNext() {
    if (nextIndex >= items.length) return Promise.resolve();
    var index = nextIndex++;
    return Promise.resolve().then(function () {
      return worker(items[index], index);
    }).then(function (result) {
      output[index] = result;
    }, function () {
      output[index] = [];
    }).then(runNext);
  }
  var workers = [];
  for (var i = 0; i < workerCount; i++) workers.push(runNext());
  return Promise.all(workers).then(function () { return output; });
}
function resolveEmbedDocument(html, pageUrl, label) {
  var streams = extractDirectStreams(html, pageUrl, label), $ = cheerio.load(html), iframeUrls = [];
  $("iframe[src]").each(function () {
    var iframe = absUrl($(this).attr("src"), pageUrl);
    if (isHttpUrl(iframe) && iframe !== pageUrl && iframeUrls.indexOf(iframe) < 0) iframeUrls.push(iframe);
  });
  return mapLimit(iframeUrls, 2, function (iframe) {
    return resolveIframe(iframe, pageUrl, 0);
  }).then(function (batches) {
    batches.forEach(function (batch) { (batch || []).forEach(function (stream) { streams.push(stream); }); });
    return streams;
  });
}
function findTermServerStreams(term, mediaType, pageUrl) {
  var tasks = [], ids = [];
  for (var i = 0; i <= 10; i++) ids.push(i);
  ["trdekho", "trembed"].forEach(function (parameter) {
    ids.forEach(function (id) { tasks.push({ parameter: parameter, id: id }); });
  });
  var contentType = mediaType === "movie" ? 1 : 2;
  return mapLimit(tasks, 4, function (task) {
    var iframePage = BASE_URL + "/?" + task.parameter + "=" + task.id
      + "&trid=" + encodeURIComponent(term) + "&trtype=" + contentType;
    return getText(iframePage, { "Referer": pageUrl }).then(function (frameHtml) {
      return resolveEmbedDocument(frameHtml, iframePage, task.parameter + "-" + task.id);
    }).catch(function () { return []; });
  }).then(function (batches) {
    var streams = [];
    batches.forEach(function (batch) { (batch || []).forEach(function (stream) { streams.push(stream); }); });
    return streams;
  });
}
function normalizeStreams(streams, pageUrl) {
  var seen = {};
  return streams.filter(function (stream) {
    if (!stream || !isHttpUrl(stream.url)) return false;
    var key = stream.url;
    if (seen[key]) return false;
    seen[key] = true;
    if (!stream.provider) stream.provider = "anime-dekho";
    if (!stream.name) stream.name = "AnimeDekho";
    if (!stream.title) stream.title = "Auto";
    if (!stream.quality) stream.quality = "Unknown";
    if (!stream.headers) stream.headers = { "User-Agent": UA, "Referer": pageUrl };
    return true;
  });
}
function fetchPageStreams(pageUrl, mediaType) {
  var cookieHeaders = { "Cookie": "toronites_server=vidstream", "Referer": BASE_URL + "/" };
  return getText(pageUrl, cookieHeaders).then(function (html) {
    var term = extractTerm(html);
    var streams = extractDirectStreams(html, pageUrl, "Direct");
    var $ = cheerio.load(html), iframeUrls = [];
    $("iframe.serversel[src]").each(function () {
      var src = $(this).attr("src");
      if (src) iframeUrls.push({ url: absUrl(src, pageUrl) });
    });
    return mapLimit(iframeUrls, 3, function (item) {
      if (!isHttpUrl(item.url)) return [];
      return getText(item.url, { "Referer": pageUrl }).then(function (innerHtml) {
        return resolveEmbedDocument(innerHtml, item.url, "VidStream");
      }).catch(function () { return []; });
    }).then(function (batches) {
      batches.forEach(function (batch) { (batch || []).forEach(function (stream) { streams.push(stream); }); });
      if (!term) return normalizeStreams(streams, pageUrl);
      // Collect every direct, selected-iframe, current, and legacy server result.
      // All server slots are queried, but concurrency stays bounded.
      return findTermServerStreams(term, mediaType, pageUrl).then(function (serverStreams) {
        serverStreams.forEach(function (stream) { streams.push(stream); });
        return normalizeStreams(streams, pageUrl);
      });
    });
  });
}
function getStreams(tmdbId, mediaType, season, episode) {
  var apiKey = getTmdbApiKey();
  if (!apiKey) {
    if (typeof console !== "undefined" && console.error) console.error("[AnimeDekho] Nuvio TMDB API key is unavailable");
    return Promise.resolve([]);
  }
  if (!/^\d+$/.test(String(tmdbId || ""))) return Promise.resolve([]);
  return getTmdbDetails(tmdbId, mediaType, apiKey).then(function (result) {
    var details = result.details, type = result.type, title = getTitle(details);
    if (!title) return [];
    var searchUrl = BASE_URL + "/?s=" + encodeURIComponent(title);
    return getText(searchUrl).then(function (searchHtml) {
      var item = findItem(searchHtml, title);
      if (!item) return [];
      return getText(item.url).then(function (detailHtml) {
        var pageUrl = item.url;
        if (type === "tv") {
          var episodeUrl = findEpisodeUrl(detailHtml, season, episode);
          // Never return a season/series-level stream for a specific episode:
          // that can silently play the wrong episode.
          if (!episodeUrl) return [];
          pageUrl = episodeUrl;
        }
        return fetchPageStreams(pageUrl, type).then(function (streams) {
          return streams.map(function (s) {
            if (!s.title || s.title === "Auto") s.title = type === "tv" ? "S" + (season || 1) + "E" + (episode || 1) + " - " + (s.name || "AnimeDekho") : title;
            return s;
          });
        });
      });
    });
  }).catch(function (e) {
    if (typeof console !== "undefined" && console.error) console.error("[AnimeDekho]", String(e));
    return [];
  });
}
if (typeof module !== "undefined" && module.exports) module.exports = { getStreams: getStreams };
else if (typeof globalThis !== "undefined") globalThis.getStreams = getStreams;
