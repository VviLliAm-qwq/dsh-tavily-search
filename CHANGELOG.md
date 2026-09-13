# Changelog

All notable changes to this project are documented in this file.

## 0.4.1 (2026-09-13)

- Documentation only, no code change. Installation now goes through `dsh plugin --profile dsh-tui add dsh-web-tavily` (the package is published) instead of copying files into `node_modules`, both READMEs gain a CI badge, and the release section records the OIDC trusted-publishing path.

## 0.4.0 (2026-09-13)

### Changed

- **Renamed again, to `dsh-web-tavily`.** The 0.3.0 name `dsh-tavily-search`
  turned out to be taken on npm as well (`ouones`, v0.1.2) — as are
  `dsh-tavily-provider`, `dsh-search-tavily`, `dsh-tavily` and
  `dsh-tavily-web-search`; `dsh-web-tavily` is the free one. The package name,
  the manifest `id`, the bundle patch's row id and module name, the Cordis name,
  the settings namespace and the log file all follow it. 0.3.0 was never
  published, so nobody has to migrate twice.
- **Settings section and log file are now `dsh-web-tavily`**: the section in
  `~/.dsh/settings.yaml` is `dsh-web-tavily:` and the lifecycle log is
  `~/.dsh-tui/dsh-web-tavily.log`.

## 0.3.0 (2026-09-13)

### Changed

- **Renamed from `dsh-web-search-tavily` to `dsh-tavily-search`.** The npm name
  `dsh-web-search-tavily` is taken by an unrelated package, so the package name,
  the manifest `id`, the bundle patch's row id and module name, and the plugin's
  Cordis name all moved to `dsh-tavily-search`. The provider id (`tavily`),
  the registered fetch provider (`http-trusted`) and every seam contract are
  unchanged, so a profile patch needs no edit.
- **The settings namespace and the log file follow the package name**: the
  section in `~/.dsh/settings.yaml` is now `dsh-tavily-search:` (rename the old
  `web-search-tavily:` key to keep your values) and the lifecycle log is now
  `~/.dsh-tui/dsh-tavily-search.log`.

### Added

- The `repository` field in `package.json` and `source.repository` in
  `dsh-plugin.json`, both pointing at the public repository.

## 0.2.0 (2026-09-13)

### Added

- **A localized settings card** (`lib/settings-card.js`). `settings.installSection`
  registers the namespace and its schema, and the host can always render a generic
  card from that — but a generic card shows raw field keys (`apiKeyEnv`,
  `searchDepth`, …) with no translation. The card registered here is a
  `tuiSettingsSections` section, the same shape every other plugin in this
  ecosystem ships, with Chinese and English descriptions for the credential
  reference, the API base URL, search depth, topic, the AI-answer switch and the
  fallback result cap. `apiKey` is deliberately left out: a literal secret in a
  settings document is the one thing this plugin tells users not to do.
- The card registration tolerates the first tick: the seam refuses with
  `requires a live Cordis activation context` while the activation is not live
  yet, so the registration retries for ~12 s and logs the refusal once. Verified
  against the headless probe: the card lands on the retry.

## 0.1.1 (2026-09-13)

### Added

- **A lifecycle log** (`lib/diag.js` → `~/.dsh-tui/dsh-web-search-tavily.log`, the
  host logger when there is one, 128 KiB cap, silent under `node --test`). The
  plugin declares `inject = ["web"]`, so on a host without that seam `apply()`
  stays parked — and with no logging at all it looked exactly like a plugin that
  was never loaded. There is now an import-time breadcrumb, an `apply started`
  line, the settings-namespace and provider-registration results, and an unload
  line.
- Both provider registrations are wrapped in a `try`/`catch` that logs, instead
  of letting a refusing seam take the boot down.

### Changed

- Documentation: the README is split into an English `README.md` and a Chinese
  `README.zh.md` with reciprocal links, the internal workspace path is gone from
  the install steps, and the published `files` list now carries `README.zh.md`
  and this changelog.
