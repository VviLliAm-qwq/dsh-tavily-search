# dsh-web-tavily

**English** · [中文](README.zh.md)

A host-plane Cordis plugin for dsh: it registers the **`tavily`** search provider
on dsh's web seam (`ctx.web`), so the `web_search` tool goes to the **Tavily
Search API** (`POST https://api.tavily.com/search`).

- It does **not** replace the `web_search` tool itself: the tool, its system
  prompt and its result card are untouched — only the search backend changes.
- DeepSeek's native search (`web-search-deepseek`) stays available as a fallback
  you can switch to; set `web.searchProvider` back to `deepseek-official` (or
  delete the key) to do so.
- The key is always resolved as a **reference** (default `TAVILY_API_KEY`): the
  credentials service (`refs:` in `~/.dsh/.credentials.yaml`) first, then the
  process environment, and only then a literal `apiKey` in the configuration. The
  provider never stores a key.

## How it works

1. The provider (id `tavily`) registers on `ctx.web`; `web.searchProvider: tavily`
   makes it the default choice.
2. When `web_search` runs, the seam hands `{ query, maxResults }` to this provider.
3. The provider resolves the key (a snapshot per operation, so one search never
   mixes two configuration versions) and calls `{baseURL}/search`.
4. The response is mapped: `results[] → sources[]` (`title` / `url` /
   `content→snippet`, plus `published_date → publishedAt` when present), and a
   top-level `answer` (Tavily's AI summary) becomes the tool's optional `content`.
5. Cancellation (signal) → `WEB_ABORTED`; an HTTP failure or an unparsable body →
   `WEB_PROVIDER_ERROR`; a missing key → `WEB_PROVIDER_CREDENTIAL_MISSING` (the
   message names the configuration step).

## Defaults

| Field | Default | Meaning |
| --- | --- | --- |
| `apiKeyEnv` | `TAVILY_API_KEY` | Credential reference (environment-variable name). |
| `apiKey` | (none) | A literal key, only when you do not want a reference. |
| `baseURL` | `https://api.tavily.com` | Overridable with `TAVILY_BASE_URL`. |
| `searchDepth` | `basic` | `basic` / `advanced` (deeper, higher credit use). |
| `topic` | `general` | `general` / `news`. |
| `includeAnswer` | `true` | Ask for Tavily's AI summary (mapped to `content`). |
| `maxResults` | `10` | Fallback cap; `web_search` passes 8 per call, Tavily's ceiling is 20. |

## Install

1. Copy the package into
   `~/.dsh/profiles/dsh-tui/node_modules/dsh-web-tavily/`.
2. Append `"dsh-web-tavily"` to `dsh.profile.bundles` in
   `~/.dsh/profiles/dsh-tui/package.json`.
3. **Make tavily the default search backend.** This has to be written in the
   profile's user patch layer (the `web:` section of `settings.yaml` does not
   affect service configuration) — edit
   `~/.dsh/profiles/dsh-tui/cordis.patch.yml` and add:

   ```yaml
   - id: web
     name: '@deepseek-ai/dsh-web'
     config:
       searchProvider: tavily
       fetchProvider: http-trusted
   ```

   The `web` row belongs to the `dsh-base` layer, so **do not add a new row with
   `insert:`** — the duplicate id crashes the boot with
   `duplicate loader entry id: web`. Override the existing row by id instead, and
   note that an override **replaces the whole config**, which is why
   `fetchProvider` is restated above.
4. Restart dsh-tui (`/restart`).

## Configuration

The plugin's own section lives in `~/.dsh/settings.yaml` (it also appears in the
settings screen under “Web search Tavily”):

```yaml
dsh-web-tavily:
  apiKeyEnv: TAVILY_API_KEY
  searchDepth: basic
  topic: general
  includeAnswer: true
  maxResults: 10
```

`TAVILY_BASE_URL` overrides the API origin; the credential reference defaults to
`TAVILY_API_KEY`.

The settings screen renders this namespace as a bilingual card (**Web search
(Tavily)** / 联网搜索（Tavily）) with a description for every field, so the
reference is the one control you normally touch. The key itself never enters the
settings document.

## Where the key lives (local only — never in a repository)

Add it under `refs:` in `~/.dsh/.credentials.yaml` (that file holds machine-local
credentials; do not commit or share it):

```yaml
refs:
  TAVILY_API_KEY: 'tvly-...'
```

## Switching back to DeepSeek's native search

Set `web.searchProvider` to `deepseek-official` (or delete the key and let the
seam use the only provider available). The seam does **not** fall back
automatically: a broken Tavily configuration fails loudly rather than quietly
using DeepSeek.

## Proxy-compatible fetch (`http-trusted`)

The plugin also registers an `http-trusted` fetch provider, which works around
`web_fetch` being refused by the official `http` provider's safety preflight in
**fake-IP proxy environments** (Clash and friends resolving domains to
`198.18.0.0/15`): `WEB_BLOCKED_URL: resolves to a non-public IP address`.

- It **reuses the official `@deepseek-ai/dsh-web-fetch-http` transport** and
  relaxes exactly one check — the “resolved address must be public” preflight
  additionally allows `198.18.0.0/15`, the proxy fake-IP range. Everything else
  is unchanged: private, loopback and reserved ranges are still refused
  (`WEB_BLOCKED_URL`), IPv6 answers are still dropped, and address pinning,
  same-origin redirects, the content-type allowlist, byte/character caps and the
  no-credentials cookie rule all stay in place.
- ⚠️ **Security boundary:** SSRF protection moves from “enforced inside the host”
  to “trust the local proxy's DNS decision”, so the last word on reachability
  belongs to the proxy's routing rules. **Intended for a single-user machine with
  a trusted self-hosted proxy**; for shared or public deployments go back to the
  official `http` provider (below).
- Addresses that are special by construction (`http://192.168.x.x/` and friends)
  are still refused.

```yaml
# the web row in ~/.dsh/profiles/dsh-tui/cordis.patch.yml
config:
  searchProvider: tavily
  fetchProvider: http-trusted
```

**Rolling back to the official `http`:** set `fetchProvider` back to `http`. The
cost is that `web_fetch` is refused again in a fake-IP proxy environment, in
exchange for the complete safety preflight.

## Troubleshooting

- `duplicate loader entry id: web` on boot — the profile's `cordis.patch.yml`
  used `insert:` for a row that already exists; rewrite it as the by-id override
  shown above.
- `web_search` answers `WEB_PROVIDER_CONFIGURED_MISSING` — the plugin did not
  load: check the bundles list and the patch above.
- `web_fetch` answers `WEB_BLOCKED_URL ... non-public IP` — the proxy fake-IP
  preflight refused it: switch to `http-trusted`, or turn the proxy's fake-IP
  mode off.

## Limitations

- A missing or invalid Tavily key makes `web_search` fail
  (`WEB_PROVIDER_CREDENTIAL_MISSING` / `WEB_PROVIDER_ERROR`); the message names
  what to configure.
- `max_results` is clamped to Tavily's ceiling of 20.
- An invalid `searchDepth` / `topic` is an error, never a silent fallback to the
  default.

## Publishing

- **Repository**: <https://github.com/VviLliAm-qwq/dsh-web-tavily> (public)

## Usage

Once installed and configured, let the model call `web_search` as usual: the
`sources` list it returns (and the optional summary) now comes from Tavily.

## License

MIT — see [LICENSE](LICENSE).
