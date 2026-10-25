# topic-feeds

Public topic feeds of link cards, built from RSS. The same for everyone, free to read from any app.
Personalising (which topics, hiding what you've seen) is left to the app, on the user's device.

- Index: `https://sybenx.github.io/topic-feeds/index.json`
- A topic: `https://sybenx.github.io/topic-feeds/topics/<id>.json`

Topics: `ai`, `nostr`, `games`, `bitcoin`, `software`, `privacy`, `gadgets`, `selfhosting`, `food`, `art`, `photos`, `news`.
The sources for each are in [sources.json](sources.json).

Rebuilt every 30 minutes by a GitHub Actions workflow and served by GitHub Pages
(`Access-Control-Allow-Origin: *`, `Cache-Control: max-age=600`). No server, no Cloudflare.

## Shape (version 1)

The shape is stable: fields may be added, never renamed or removed, without bumping `version`.

`index.json`

```json
{
  "version": 1,
  "generated_at": 1792945147,
  "generated": "2026-10-25T16:19:07Z",
  "site": "https://sybenx.github.io/topic-feeds",
  "topics": [
    {
      "id": "games",
      "name": "Games and game making",
      "url": "https://sybenx.github.io/topic-feeds/topics/games.json",
      "count": 29,
      "newest_at": 1792940000,
      "sources": [{ "id": "rps", "name": "Rock Paper Shotgun", "home": "https://www.rockpapershotgun.com", "ok": true }]
    }
  ]
}
```

`topics/<id>.json`

```json
{
  "version": 1,
  "generated_at": 1792945147,
  "topic": { "id": "news", "name": "General news" },
  "window_hours": 72,
  "items": [
    {
      "id": "27919d7b33d1d845",
      "url": "https://www.bbc.co.uk/news/articles/c6jdmj1ej715o",
      "title": "Early reports suggest record high turnout in Serbia elections",
      "summary": "Serbia is heading to the polls as a student movement attempts to oust …",
      "image": "https://ichef.bbci.co.uk/ace/standard/240/cpsprodpb/….jpg",
      "source": { "id": "bbc-world", "name": "BBC News", "home": "https://www.bbc.com/news/world" },
      "published_at": 1792944315,
      "published": "2026-10-25T16:05:15Z",
      "first_seen": 1792945147,
      "discussion": null,
      "discussions": [],
      "topic": "news"
    }
  ]
}
```

| field | meaning |
|---|---|
| `id` | first 16 hex chars of sha256 of the canonical URL (https, no `www.`, no tracking params or fragment). Stable: use it to remember what a user has seen. |
| `url` | link to the original article (tracking parameters removed) |
| `title` | plain text, at most 200 chars |
| `summary` | plain text, at most 280 chars, or `null`. Only ever a short teaser, never the article text. |
| `image` | https image URL (feed media, enclosure, or the page's `og:image`), or `null` |
| `source` | where it came from; `home` is the source's front page |
| `published_at` / `published` | publish time, unix seconds / ISO 8601 (UTC). Future dates are clamped. |
| `first_seen` | unix seconds when this pool first saw the item |
| `discussion` | the first discussion page's URL (same as `discussions[0].url`), or `null`. Kept for older readers. |
| `discussions` | where this article is being discussed, oldest first; always present, `[]` when none. Each is `{ "url", "site", "comments"? }`: `site` is e.g. `"Hacker News"`, `"Lobsters"`, `"Stacker News"`, `"r/selfhosted"`; `comments` is the comment count when the feed gives one (Hacker News does; Lobsters, Stacker News and Reddit feeds don't) and is left out otherwise. Collected across all topics, so a Verge article that's also on Hacker News carries the Hacker News link. |
| `topic` | topic id |

Items are newest first.

Example `discussions`:

```json
[
  { "url": "https://stacker.news/items/1601314", "site": "Stacker News" },
  { "url": "https://news.ycombinator.com/item?id=50229587", "site": "Hacker News", "comments": 374 }
]
```

## What's in a feed

- Last 72 hours; slow sources (weekly newsletters, release notes) keep items up to 8 days so the topic isn't empty. `window_hours` is the longest window in that topic.
- Deduplicated within a topic by canonical URL and by near-identical title (≥80% of words shared). The same link can appear in two topics.
- Aggregator items (Hacker News, Lobsters, Stacker News, Reddit) point `url` at the article itself and the thread goes in `discussions`. If the same article also comes from its own site in that topic, that site's card is kept and the aggregators' threads are added to it. Reddit image, video and gallery posts keep the thread as `url`.
- Caps, so a busy source can't flood a topic: by default 6 items per source per day, 20 per topic per day, 60 per topic in total. General news: 2 per source, 5 per day, 15 in total. Overrides are in `sources.json`.
- Within a cap, earlier-seen items win and stay; an item never drops out before its window ends unless the topic total is full.
- Hacker News only includes stories with 300+ points.

`state.json` (the pool, HTTP cache headers, image cache) and `report.json` (per-source fetch status) are published too; they're for the builder and debugging, not part of the stable shape.

## Later: Nostr

Each card maps to a NIP-B0 web bookmark (kind `39701`), signed by a dedicated bridge key:

| card | event |
|---|---|
| `url` minus `https://` | `d` tag |
| `title` | `title` tag |
| `summary` | `content` |
| `published_at` | `published_at` tag |
| `topic` | `t` tag |
| `image` | `image` tag |
| `source.name` | `source` tag (or a `p` tag if the source has a Nostr key) |

Not built yet.

## Run locally

```
npm ci
STATE_FILE=state.json OUT_DIR=out node build.mjs   # STATE_FILE is optional; without it the live state.json is used
```

To add a source, add it to `sources.json` under a topic: `id`, `name`, `home`, `feed`, and optionally
`windowHours`, `perSourcePerDay`, `everyHours` (fetch at most every N hours, for rate-limited feeds).
