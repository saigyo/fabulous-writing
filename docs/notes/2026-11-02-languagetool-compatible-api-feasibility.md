# LanguageTool-compatible HTTP API — feasibility

Date: 2026-11-02. Scope: research only, no implementation. Builds on
`docs/notes/2026-08-24-languagetool-integration.md` (sidecar direction, LGPL
analysis of rule data); this note covers the opposite direction: Fabulous
Writing *as* the server that existing LanguageTool (LT) clients talk to.

Source pins used below (so claims stay checkable):
- LT core/server: `languagetool-org/languagetool` @ `2c9b51ea0746c341fd7edabfc753b1cff1f516c7` (master, 2026-11-02), called `LT@2c9b51e`.
- LT dev docs: `languagetool-org/languagetool-org.github.io` @ `f11acb745620a9cb804afb6e9ab2ea4ea7d80373`, called `LTdocs@f11acb7`.
- Swagger: https://languagetool.org/http-api/languagetool-swagger.json (fetched 2026-11-02, `info.version` 1.1.2).

## Bottom line

1. **Realistic targets**: LibreOffice (built into LibreOffice core since 7.4, so no
   extension needed), LTeX+ (VS Code, Neovim, Emacs and others via LSP), the
   Obsidian LanguageTool plugin, the VS Code "LanguageTool Linter" extension,
   TeXstudio, Emacs `langtool.el` / `flycheck-languagetool`. All send plain
   form-encoded `POST /v2/check` and read a small subset of the response.
2. **Conditional**: the official LT browser extension (Chrome/Firefox/Edge) has an
   "Other server" setting and LT says it keeps working with your own server even
   though the extension is Premium-only otherwise. Caveats: CORS header
   required, plain-HTTP trouble reported, language list is hard-coded in the
   add-on. The macOS desktop app has an "other server" option per a 2026 forum
   report, but it caps checks at 1,500 characters in that mode.
3. **Word add-in**: a "custom server" field existed in 2022–2023 (forum, LT staff
   confirm "it's supposed to work"), HTTPS only. Whether the current (2026)
   add-in still has it is **unverified**; I found no official doc either way.
4. **Cannot be pointed at a custom server (as of the sources found)**: Windows
   desktop app (no option, unanswered request 2025-04), Outlook add-in (LT staff
   "on the wishlist", still requested 2026-07), Mac Mail/Slack integration via the
   Mac app (2024: "you cannot set your own server"). Google Docs: the old add-on is
   deprecated in LT's own list; use the browser extension. Mobile keyboards:
   no evidence found either way (unverified).
5. **Minimal endpoint set**: `POST /v2/check` (form-encoded; `text`, `language`;
   optionally `data`), `GET /v2/languages`. For the LT Java client used by the
   LibreOffice *extension* also `POST /v2/configinfo` and `POST /v2/maxtextlength`
   (undocumented), or the extension silently stops using the remote server.
6. **Hard contract details**: `offset`/`length` are Java `String` indices, i.e.
   UTF-16 code units; our spans are Python code points (needs conversion, a
   converter already exists in `frontend/src/embed/offsets.ts`). Response must
   carry `Content-Type: application/json` and, for browser clients,
   `Access-Control-Allow-Origin`.
7. **Auth**: LT has only `username` + `apiKey` form fields (plus `password` and
   `tokenV2`, and a JWT `Authorization` header on Premium infra). No bearer
   scheme that clients can be configured with. Our per-user auth would have to
   map onto `username`/`apiKey` (LTeX+, LibreOffice, VS Code linter, Obsidian
   can send them) or the server runs unauthenticated on a private network.
8. **Licensing**: re-implementing the documented HTTP interface without copying
   LT code creates no LGPL obligation (LGPL 2.1 only attaches to copying,
   modifying or distributing the Library or works based on it). The Swagger
   file carries no licence text; no copying of it is needed. Do not ship LT rule
   data (already settled in the 2026-08-24 note).
9. **Trademark**: the "LanguageTool" owner is now stated as Learneo, Inc. on the
   current Terms (effective 2026-08-21), not LanguageTooler GmbH as assumed in
   the task. No trademark registry record was found. Descriptive wording such
   as "works with LanguageTool clients" is the lower-risk framing; do not name
   the product "LanguageTool-anything" (unverified legal point, not legal advice).
10. **Prior art exists** (several 2026 projects, e.g. `chethan62/grammar-server`,
    `legion-works/grammar-forge`, `juliarscat/ClariCat`) that implement
    `/v2/check` over non-LT engines, which supports the idea that the needed
    subset is small and that LT clients tolerate missing optional fields.

## 1. LanguageTool HTTP API contract (v2)

### 1.1 Documented surface

The official Swagger lists exactly five operations: `POST /check`,
`GET /languages`, `GET /words`, `POST /words/add`, `POST /words/delete`; base
path `/v2`, host `api.languagetoolplus.com`
(https://languagetool.org/http-api/languagetool-swagger.json). It states "any
parameters or outputs not part of this documentation are internal and must not be
relied on" (same file, `info.description`). The Swagger UI page is
https://languagetool.org/http-api/.

### 1.2 `POST /v2/check` request

All parameters are declared `in: formData` (swagger, same file); there is no
JSON-body variant in the spec.

| Parameter | Notes (all from swagger unless marked) |
|---|---|
| `text` | Text to check. "This or `data` is required." |
| `data` | JSON document `{"annotation":[{"text":"A "},{"markup":"<b>"},{"text":"test"},{"markup":"</b>"}]}`. Markup is ignored when finding errors; a markup item may carry `interpretAs` (e.g. `"\n\n"` for `<p>`). Entities must be expanded by the caller. |
| `language` | Required. `en-US`, `de-DE`, `fr`, or `auto`. For variant languages (en, de, pt) spell checking only activates with an explicit variant. |
| `username`, `apiKey` | "Set to get Premium API access". |
| `dicts` | Comma-separated user dictionaries (premium accounts). |
| `motherTongue` | Enables false-friend checks for some pairs. |
| `preferredVariants` | Comma-separated; only valid with `language=auto` (server rejects otherwise: `V2TextChecker.java` in LT@2c9b51e, "You specified 'preferredVariants' but you didn't specify 'language=auto'", unless `multilingual=true`). |
| `enabledRules`, `disabledRules`, `enabledCategories`, `disabledCategories` | Comma-separated ids. `level` still gates `enabledRules`. |
| `enabledOnly` | Boolean; only the listed rules/categories run. |
| `level` | `default` or `picky`. |

Server-side `data` handling (`ApiV2.handleCheckRequest`, LT@2c9b51e
`languagetool-server/src/main/java/org/languagetool/server/ApiV2.java`):
- `text` and `data` together -> `BadRequestException`; neither -> `BadRequestException`.
- `data` JSON may use `annotation` **or** `text` (not both). In `annotation`, each
  item must have exactly one of `text`/`markup`; `interpretAs` only on `markup`.
- Offsets returned for `data` input refer to the **original** string including
  markup (the annotated-text builder maps plain-text positions back; see
  `AnnotatedText.getOriginalTextPositionFor` in `languagetool-core`). Obsidian and
  LTeX+ rely on this (section 2).

**Request encoding**: the server reads POST bodies only as
`application/x-www-form-urlencoded`, regardless of the request `Content-Type`:
`getRequestQuery`/`getParameterMap` in `LanguageToolHttpHandler.java` split on
`&`/`=` and `URLDecoder.decode`; query-string parameters on a POST are merged in.
There is no JSON-body or multipart path in the official server. (Third-party
reimplementations add JSON bodies; clients do not need it.)

**Undocumented parameters the official server accepts** (names grep'd from
`TextChecker.java`/`V2TextChecker.java`, LT@2c9b51e; behaviour not verified):
`mode` (`all`/`textLevelOnly`/`allButTextLevelOnly`), `ruleValues`,
`textSessionId`, `useragent`, `noopLanguages`, `altLanguages`, `callback`
(JSONP), `c` (compact output), `allowIncompleteResults`, `enableTempOffRules`,
`enableHiddenRules`, `preferredLanguages`, `tokenV2`, `password`. The Java client
sends `mode`, `level`, `ruleValues`, `textSessionId`, `useragent` (section 2.4).

### 1.3 `POST /v2/check` response

Swagger defines the shape (same file, `responses.200`). Actual writer:
`RuleMatchesAsJsonSerializer.ruleMatchesToJson2` (LT@2c9b51e
`languagetool-core/src/main/java/org/languagetool/tools/RuleMatchesAsJsonSerializer.java`),
which emits keys in this order: `software`, `warnings`, `language`, `matches`,
optionally `hiddenMatches`, `ignoreRanges`, `sentenceRanges`,
`extendedSentenceRanges`.

```jsonc
{
  "software": {"name":"LanguageTool","version":"6.x","buildDate":"...","apiVersion":1,"premium":false,"status":""},
  "warnings": {"incompleteResults": false},          // + incompleteResultsReason when true
  "language": {"name":"English (US)","code":"en-US",
               "detectedLanguage":{"name":"...","code":"...","confidence":0.99,"source":"..."}},
  "matches": [{
    "message": "...", "shortMessage": "...",          // shortMessage optional
    "offset": 5, "length": 3,
    "replacements": [{"value":"..."}],                // may carry shortDescription/suffix/type/confidence
    "context": {"text":"...","offset":0,"length":3},
    "sentence": "...",
    "type": {"typeName":"Other"},                     // UnknownWord | Hint | Other (RuleMatch.Type)
    "rule": {"id":"...","subId":"1","description":"...","issueType":"misspelling",
             "urls":[{"value":"https://..."}],
             "category":{"id":"TYPOS","name":"Possible Typo"}},
    "ignoreForIncompleteSentence": true,
    "contextForSureMatch": 0
  }],
  "sentenceRanges": [[0,25],[26,60]]
}
```

Swagger marks as required: `software.{name,version,buildDate,apiVersion}`,
`language.{name,code,detectedLanguage}`, and per match `message`, `offset`,
`length`, `replacements`, `context.{text,offset,length}`, `sentence`,
`rule.{id,description,category}`. Swagger itself says `ignoreForIncompleteSentence`
is "not official" (a code comment in the serializer says the same; it is derived
from `rule.estimateContextForSureMatch()`).

`software.premium` is true only for Premium infrastructure; `apiVersion` is the
constant `1` (`API_VERSION = 1`).

**Offset unit**: swagger says "0-based character offset" and "length in
characters". The server computes `offset = match.getFromPos()` and
`length = getToPos() - getFromPos()` on Java `String` positions
(`RuleMatchesAsJsonSerializer.java`, lines around `writeNumberField("offset", ...)`);
there is no code-point conversion (grep for `codePoint` in the serializer and
`RuleMatch.java` finds none). Java `String` indices are UTF-16 code units, so a
character outside the BMP counts as 2. Corroboration from clients: LibreOffice
core uses the `offset` directly on `OUString` (UTF-16) in
`lingucomponent/source/spellcheck/languagetool/languagetoolimp.cxx`
(LibreOffice/core@563e5cd), and the Obsidian plugin builds annotations in JS
string units. I did not run a live test with an emoji against a real LT server;
this conclusion is from the source, not an experiment.

`context.offset`/`context.length` are likewise positions inside `context.text`.

### 1.4 Other endpoints

- `GET /v2/languages` -> array of `{name, code, longCode}` (swagger; writer
  `ApiV2.getLanguages`). The server also appends aliases such as `fr-FR -> fr`
  "because LibreOffice 7.4 needs them" (code comment, `ApiV2.java`).
- `GET /v2/words?offset&limit&username&apiKey[&dicts]` -> `{"words":[...]}`;
  `POST /v2/words/add` and `/v2/words/delete` (`word`, `username`, `apiKey`,
  optional `dict`) -> `{"added":bool}` / `{"deleted":bool}`. Swagger requires
  `username` + `apiKey` for all three; these are user-dictionary features of
  Premium accounts. `ApiV2.handleWordsRequest` goes through `DatabaseAccess`, so
  they need a DB-backed user store.
- Undocumented but implemented in `ApiV2.handleRequest` (LT@2c9b51e):
  `maxtextlength` (returns `text/plain` integer), `configinfo`
  (`language=...` -> JSON with `software`, `parameter.maxTextLength`, `rules[]`),
  `info`, `healthcheck`, plus internal `admin/refreshUser`, `users/me`.

### 1.5 Premium-only parts

Per swagger: `username`/`apiKey` ("Premium API access"), `dicts`, and the three
`/words*` operations. Premium rule sets (AI/ML rules) are filtered out of
`configinfo` for the open-source build (`ApiV2.getConfigurationInfo` filters
`Premium.get().isPremiumRule`). LT staff: "the local server doesn't provide
premium features. It's available as an on-premise server only to customers with a
larger user base (200+ users)" (https://forum.languagetool.org/t/does-a-local-server-use-premium-features-if-i-have-a-premium-account/7100,
2021).

### 1.6 Limits, content types, CORS, errors

- **Public API limits** (swagger `info.description`): 20 requests/min free (80
  Premium), 75,000 / 300,000 characters per minute, 20,000 / 60,000 characters per
  request. Same numbers for the free tier in
  https://github.com/languagetool-org/languagetool-org.github.io/blob/f11acb7/public-http-api.md.
- **Self-hosted limit**: `maxTextLength` (and `maxTextLengthAnonymous`,
  `maxTextLengthLoggedIn`, `maxTextLengthPremium`, `maxTextHardLength`) in the
  properties file; default `Integer.MAX_VALUE`, so unlimited unless configured
  (`HTTPServerConfig.java` @ LT@2c9b51e). Over-limit -> `TextTooLongException`
  -> HTTP **413** (`LanguageToolHttpHandler.java`). Length is measured as
  `aText.getPlainText().length()` (UTF-16 units again; `TextChecker.java`).
  `/v2/maxtextlength` returns `maxTextLengthAnonymous`.
- **Response Content-Type**: `application/json` for `/check`, `/languages`,
  `/info`, `/configinfo` (`V2TextChecker.JSON_CONTENT_TYPE`,
  `ApiV2.JSON_CONTENT_TYPE`); `text/plain` for `/maxtextlength`. No charset
  parameter is set; body is UTF-8. Error responses are plain text starting with
  `Error: ` and map to 400 (bad request), 403, 404, 413, 429, 500, 503
  (`LanguageToolHttpHandler.java`, `errorCode = ...` block).
- **CORS**: the official server sets exactly one header, `Access-Control-Allow-Origin`,
  via `ServerTools.setAllowOrigin`, and only when started with `--allow-origin`
  (value `*` if no argument; `HTTPServerConfig.java`). It is also set on error
  responses (`sendError`). `OPTIONS` handling exists only for the private
  `users/me` route (`Access-Control-Allow-Methods`/`-Headers`); `/v2/check` has no
  preflight handler. Consequence: clients must use "simple" cross-origin requests
  (form-urlencoded POST, no custom headers), or a reimplementation must answer
  preflights itself. LT's own doc says to omit `--allow-origin` when no browser
  add-on is used (`LTdocs@f11acb7/http-server.md`).

## 2. Clients: custom server support

### 2.1 LanguageTool browser extension (Chrome/Firefox/Edge/Opera/Safari)

- **Closed source today.** The open repo `languagetool-org/languagetool-browser-addon`
  is marked "OUTDATED" and its README says the new add-on is "completely
  rewritten and under a new license" (README @ `c3b1919`, last push 2023-03-01).
  So settings cannot be confirmed from current source; only docs, support threads
  and an old version.
- **Documented**: "visit the add-on's options by clicking the cog icon, then open
  'Experimental settings' and select 'Local server'"; Safari needs HTTPS and
  "Other server" with `https://localhost:8082/v2`; the synonym feature does not
  work against a self-hosted server (`LTdocs@f11acb7/http-server.md`).
- **Still supported in 2025/2026?** LT's own Premium-only announcement for the
  extension says: "Is LanguageTool's server still open-source? Yes. If you are a
  developer, you can still host and run your own instance of LanguageTool's
  server. The browser extension will continue to work as it currently does for
  users who use it with their own server."
  (https://languagetool.org/webextension/premium-announcement, fetched
  2026-11-02; page is undated, **date of the announcement unverified**). A 2025
  GitHub issue with LT staff participation confirms version 8.14.3 against a
  self-hosted 6.5 server, URL form `http://host:8081/v2`
  (https://github.com/languagetool-org/languagetool-browser-addon/issues/279, and
  the same issue 279 is a 8.14.3 regression for HTTP-only servers in Firefox;
  a commenter writes "We submitted an update to Firefox that should address
  this". Separately, https://github.com/languagetool-org/languagetool/issues/11232
  reports the same symptom, which the reporter resolved by moving to HTTPS).
  Current menu labels ("Other server" vs "Local server") in the 2026 UI are
  **unverified**.
- **Language list is hard-coded**: LT's maintainer, 2025-03: "I think the list of
  languages is hard-coded in the add-on"
  (https://forum.languagetool.org/t/chrome-extension-with-custom-http-server-and-languages/11057).
  So the extension will send LT language codes (en-US, de-DE, ...) regardless of
  `/v2/languages`; unsupported codes must be handled gracefully.
- **Endpoints/format** (old open-source version only, `webextension/bs/common.js`
  @ `c3b1919`): `POST <serverUrl>/check`; it sent `username` + `password`
  (not `apiKey`) for Premium. Current `text` vs `data` choice, timeouts and
  request frequency of the new extension: **unverified** (closed source).
- **Auth with custom server**: unverified for the current extension.

### 2.2 LanguageTool for Microsoft Word (Office add-in) and desktop apps

- **Closed source.** I found no repository for the current add-in. The
  third-party `jaumeortola/languagetool-msword10-addin` is a different, older,
  Windows-only add-in that LT's docs list as "old version"
  (`LTdocs@f11acb7/software-that-supports-languagetool-as-a-plug-in-or-add-on.md`).
- **Evidence the official add-in accepted a custom server**:
  - 2022-08: LT's maintainer on a self-hosted server: "It's supposed to work, and it
    works for me using http://localhost:8081/v2", then asked about `--allow-origin "*"`
    (https://forum.languagetool.org/t/self-hosted-languagetool-and-ms-word-add-in/8171).
    The thread ends with a user concluding "Word just won't issue requests that
    don't use SSL".
  - 2023-09: a user refers to "MS Word extension's custom server field"; the
    maintainer suggests "MS Word only accepts https connections"; the user
    confirms and gets it working only behind a TLS terminator
    (https://forum.languagetool.org/t/microsoft-word-extension-fails-to-connect-to-custom-server/9265).
  - Server-side code comment: JSONP `callback` is "still needed today for ... hosting
    your own on-premise LT without SSL and using it from a local MS Word (not
    Online Word) - issue #89 in the add-on repo" (`TextChecker.java` @ LT@2c9b51e).
- **Not confirmed**: whether the 2026 Word add-in still has a server field, whether
  it is gated to a plan, which endpoints it calls. The official add-in page
  (https://languagetool.org/word-add-in) only mentions a Microsoft 365
  subscription requirement and Premium; nothing on servers. **Plainly: the only
  confirmed way is "possibly yes, HTTPS required, status in 2026 unknown".**
  A trusted-certificate HTTPS endpoint (not self-signed) should be assumed.
- **macOS desktop app**: 2022 maintainer reply says not possible; 2024-02 "For Mail,
  while supported by the Mac desktop app, you cannot set your own server"
  (https://forum.languagetool.org/t/self-hosted-and-macos-mail-slack-and-safari/9842);
  2026-07 a user reports choosing "other server" in the Mac app, and a 1,500
  character cap with an "upgrade to Premium" message, with no `/v2/check` request
  sent beyond that size
  (https://forum.languagetool.org/t/character-limit-with-desktop-app-for-macos-and-option-other-server-with-self-hosted-docker/12035).
  Treat as "exists, size-capped client-side" (user report, not an official doc).
- **Windows desktop app**: thread "Desktop app custom server" has no staff answer;
  last post 2025-04-09 (https://forum.languagetool.org/t/desktop-app-custom-server/10271). No option known.
- **Outlook add-in**: "It's on the wishlist, but not on a specific roadmap yet"
  (2023-08), still asked about 2026-07
  (https://forum.languagetool.org/t/outlook-addin-selfhosting/9180).

### 2.3 Google Docs

LT's own list strikes through the Google Docs add-on and recommends "the browser
add-on instead, which also supports Google Docs"
(`LTdocs@f11acb7/software-that-supports-languagetool-as-a-plug-in-or-add-on.md`).
So Docs inherits the browser-extension answer (2.1). A staff reply in 2022 also
recommends the browser add-on with Google Docs for custom servers
(thread 8077 cited above).

### 2.4 LibreOffice / OpenOffice

Two independent integrations:

1. **LibreOffice core (7.4+)**, no extension. Source:
   `lingucomponent/source/spellcheck/languagetool/languagetoolimp.cxx` and
   `cui/source/options/optlanguagetool.cxx` in LibreOffice/core@563e5cd (MPL-2.0).
   Config: Base URL (`LanguageToolCfg::BaseURL`), Username, API key, Enable.
   Request URL is `BaseURL + "/check"`, so the user enters the `/v2` prefix
   themselves (the official LT help page also says "Starting with LibreOffice 7.4,
   LibreOffice comes with a feature to use a remote LanguageTool server":
   https://help.languagetool.org/hc/en-us/articles/39254524980119). It POSTs
   `text=...&language=<bcp47>` and, only if both are set, `&username=...&apiKey=...`
   (so credentials are sent with a custom server). CURL timeout is **10 s**
   (`CURLOPT_TIMEOUT 10L`). Response fields read: `matches[].offset`, `length`,
   `message`, `shortMessage`, `rule.category.id`, `replacements[].value`; the
   number of suggestions is capped. Uses `text`, not `data`.
2. **LanguageTool LibreOffice extension (Java)**, source
   `languagetool-org/languagetool-for-libreoffice` @ `6f9eb45` (last push
   2024-09-27, README: "not actively maintained anymore. See https://writingtool.org").
   `LORemoteLanguageTool.java`: defaults `https://api.languagetool.org` or
   `https://api.languagetoolplus.com` (premium); a custom URL when
   `Configuration.useOtherServer()` (keys `useOtherServer`, `otherServerUrl`,
   `remoteUserName`, `remoteApiKey` in `Configuration.java`, LT@2c9b51e
   `languagetool-gui-commons`). `getRemoteUsername()` returns the stored name only
   if the `isPremium` flag is on, independent of server choice. The extension
   calls `POST /v2/configinfo` and `POST /v2/maxtextlength` in its constructor
   (`RemoteLanguageTool.java`, `languagetool-http-client`); on any exception it
   sets `remoteRun = false` and `check()` returns `null`, i.e. **the remote
   server is not used at all** unless both endpoints answer. The 20,000 char
   default limit applies if `maxtextlength` fails.
   `languagetool-http-client` sends `text`, `language`, `motherTongue`,
   `enabledRules`, `disabledRules`, `enabledOnly`, `mode`, `level`, `ruleValues`,
   `textSessionId`, `username`, `apiKey`, `useragent=java-http-client`.

### 2.5 LTeX / LTeX+ (`ltex.languageToolHttpServerUri`)

- `valentjn/ltex-ls` is the original (unmaintained per its README; not re-checked);
  `ltex-plus/ltex-ls-plus` and `ltex-plus/vscode-ltex-plus` (both MPL-2.0, pushed
  2026-11-02) are the maintained fork.
- Settings in `vscode-ltex-plus/package.json` / `package.nls.json`:
  `ltex.languageToolHttpServerUri` ("Set this to the root URI of the server ...
  `http://localhost:8081` for a self-hosted server. LTeX+ automatically appends
  the API path (`/v2/check`)"), `ltex.languageToolOrg.username`,
  `ltex.languageToolOrg.apiKey` ("Only relevant if `ltex.languageToolHttpServerUri`
  is set").
- Protocol (`LanguageToolHttpInterface.kt`, ltex-ls-plus@`bcfe86a`): form-encoded
  POST to `<uri>/v2/check` with **`data`** (annotated JSON), plus `language`,
  `level=picky` (optional), `motherTongue`, `enabledRules`, `preferredVariants`
  (with `language=auto`), `username`, `apiKey`. It reads `offset`, `length`,
  `message`, `sentence`, `rule.id`, `replacements[].value` (`LanguageToolRuleMatch.kt`).
  `sentence` is read without a null check, so it must be present.
  Because LTeX+ sends `data`, `offset` must be relative to the original string
  including markup items.

### 2.6 Other clients (one line each)

- **Obsidian "LanguageTool Integration"** (`Clemens-E/obsidian-languagetool-plugin`
  @ `f181770`, AGPL-3.0): setting **Endpoint** -> "Custom URL ... Enter only the
  base URL (for example `http://localhost:8010`); the plugin adds the API path",
  Username/API Key only for the premium endpoint; autocheck delay minimum 50 ms
  for custom endpoints (README, "Settings"). Sends annotated `data` (`src/api.ts`
  builds `{text|markup}` items).
- **VS Code "LanguageTool Linter"** (`davidlday/vscode-languagetool-linter` @
  `ba008ea`, Apache-2.0): `languageToolLinter.external.url` (default
  `http://localhost:8081`), `.external.username`, `.external.apiKey` (`package.json`).
- **TeXstudio** (`texstudio-org/texstudio` @ `86c2109`): `languageToolURL` config
  member (`src/grammarcheck_config.h`); `grammarcheck.cpp` appends `v2/check` and POSTs
  `language=...&text=...`.
- **Emacs `langtool.el`** (`mhayashi1120/Emacs-langtool`): `langtool-http-server-host`,
  `-port`, `-stream-type`; requests `/v2/check`. **`flycheck-languagetool`**
  (`emacs-languagetool/flycheck-languagetool`): `flycheck-languagetool-url`
  (defcustom) and path `/v2/check`.
- **Thunderbird**: languagetool.org lists a Thunderbird add-on; a user report
  states Thunderbird works with `http://host/v2` (issue 11232 above). The add-on
  itself is closed; settings **unverified**.
- **Vim/Neovim** `vim-grammarous`, `vim-LanguageTool`: not checked in source;
  they are known as jar-based. **Unverified**. Neovim users reach servers via
  LTeX+ (LSP).
- **Joplin, Logseq, Zotero, Typora**: Logseq has `avelino/logseq-languagetool`
  (last push 2024-06) and `eliias/logseq-languagetool` (2023-01); no Joplin plugin
  found by repo search; not source-checked. **Unverified**.
- **Mobile keyboards (iOS/Android)**: no primary-source evidence found that they
  support a custom server. **Unverified**; assume no.
- **Proofline** (`PiratesIRC/Proofline`, GPL-3.0, pushed 2026-10-31): a
  Windows-wide checker whose README says "Point it at a self-hosted LanguageTool
  server" (README). Evidence that third parties fill the desktop gap, not an LT client.

## 3. Authentication

- Server (`ServerTools.getUserLimits`, LT@2c9b51e): if `username` is present then
  `apiKey` **or** `password` **or** `tokenV2` is required (`apiKey` and
  `password` together is a 400; `apiKey` without `username` is a 400). An
  `Authorization` header is read (`headers.getFirst("Authorization")`) and, if
  present, validated as a **JWT** via `UserLimits.getLimitsWithJwtToken`; this is
  the Premium add-on token path, not something to implement against.
  Basic auth is used only on the private `users/me` route. So the compatible
  convention is **form fields `username` + `apiKey`**, not bearer tokens.
- Clients that send credentials to a custom server: LibreOffice core (when both
  set), LibreOffice Java extension (only if its "premium" flag is on), LTeX+,
  VS Code linter, Obsidian (documented as premium-endpoint only, so likely not for
  custom URLs; **unverified in code**).
- Official browser extension and Word add-in with custom server: whether they send
  `username`/`apiKey`: **unverified** (closed source). The old open-source
  extension sent `username`+`password`.
- For Fabulous Writing: map `apiKey` to a personal access token (username = account
  email) and keep `/v2/*` rate-limited per key; or leave it unauthenticated and bind
  to a private network. An unauthenticated public `/v2/check` would be an open
  free proxy to the LLM budget, so rules-only (no LLM) mode would be the safe default.

## 4. Licensing and trademark

- **Core/server licence**: LGPL 2.1 or later. `COPYING.txt` begins "GNU LESSER
  GENERAL PUBLIC LICENSE Version 2.1, February 1999" (LT@2c9b51e); the README
  says "Unless otherwise noted, this software – the LanguageTool core – is
  distributed under the LGPL"; GitHub's API reports `LGPL-2.1` for the repo.
- **Spec file licence**: `languagetool-swagger.json` has no `license` or
  `termsOfService` fields (`info` object, fetched 2026-11-02). I found no copy of
  it in either `languagetool` or `languagetool-org.github.io` (tree search for
  `swagger`/`openapi` returned nothing), so which repo owns it and under what
  licence is **unverified**. The prose docs repo is CC-BY-SA-4.0 (GitHub licence
  metadata for `languagetool-org.github.io`), which is relevant only if we copy
  its text. We do not need to copy either: implementing against documented
  behaviour needs no spec file in our repo.
- **Does a clean-room reimplementation trigger LGPL?** From the licence text
  (`COPYING.txt`, LT@2c9b51e): "Activities other than copying, distribution and
  modification are not covered by this License; they are outside its scope"
  (around line 144), and "mere aggregation of another work not based on the
  Library with the Library ... does not bring the other work under the scope of
  this License" (around line 208). The obligations attach to copying,
  modifying or distributing the Library or a "work based on" it. A separate
  codebase that merely speaks the same HTTP/JSON protocol contains none of LT's
  code, so it is not a work based on the Library. The risk is entirely in
  *copying*: code, rule XML, `<example>` sentences, test fixtures, message texts.
  (An interoperability API is not copyright-protected in the EU under the CJEU's
  *SAS Institute v World Programming* line of reasoning, but I did not verify
  this against primary sources here; not legal advice.)
- **Trademark**: the current Terms (effective **2026-08-21**) say "LanguageTool is
  owned and operated by Learneo, Inc., a corporation organized under the laws of
  the State of Delaware"
  (https://languagetool.org/legal/terms). The 2023 forum announcement says
  LanguageTooler GmbH "is joining forces with Learneo" and "The Open Source
  project is not affected"
  (https://forum.languagetool.org/t/languagetool-joins-learneo/8865). The imprint
  page did not render for automated fetch. I found **no trademark registry entry**
  and no trademark note in the LT README or `LTdocs`. Owner of the mark and its
  registration scope: **unverified**. Practical guidance: the Terms mention
  customers' "trademark guidelines" only in the context of using a customer's logo;
  no public brand-usage policy was found. Use the name only descriptively
  ("compatible with the LanguageTool API / clients") and not in the product name.
- **Terms of use restrictions**: the Terms apply to "LanguageTool's websites,
  mobile applications, browser extensions, widgets, application programming
  interfaces (APIs), and related services". Relevant clauses: "you may not resell
  or make any version of the LanguageTool Services available to the public
  without obtaining our written approval. You may not use the LanguageTool
  Services to develop a product that directly competes with our offerings."
  Reading: these govern the hosted Services; whether using a *client* with a
  non-LT server is "using the Services" is a legal question I cannot answer. No
  clause explicitly forbids pointing a client at a third-party server, and LT's
  own docs and announcement permit it for the browser extension. The Learneo
  Terms of Service referenced by these Terms could not be fetched
  (`learneo.com/terms-of-service` returned 404), so any additional clauses there
  are **unverified**. The Word add-in's separate terms were not found.

## 5. Prior art: projects serving a LanguageTool-compatible API

All are non-LT engines. Endpoint implementation files:

| Project | Engine | Where `/v2/check` is implemented | Notes |
|---|---|---|---|
| `chethan62/grammar-server` (MIT) @ `f097adc` | Harper (`harper-ls`) | `internal/api/handler.go` (route table: `/v2/check`, `/v2/languages`, plus extras); `internal/api/compat_test.go` | README states offsets are UTF-16 units, accepts form-encoded, JSON and GET; deliberately omits `ignoreForIncompleteSentence`/`contextForSureMatch`. Targets LTeX, browser extensions, LibreOffice. Claims are the project's own, not independently run. |
| `legion-works/grammar-forge` (AGPL-3.0) @ `d9e5171` | Harper + GECToR | `bridge/internal/ltcompat/handler.go`, `offsets.go` | README: bridge "serves `POST /v2/check` natively" and `/v2/languages`; also an LT gRPC `RemoteRule` server (`bridge/internal/ltgrpc/server.go`). |
| `juliarscat/ClariCat` (AGPL-3.0) @ `01c5bc9` | own Catalan engine | `apps/server/server.js` (route `/v2/check` -> `toLanguageTool(result)`) | LibreOffice connected via "Servidor LanguageTool" option (README). |
| `kiriharu/lango`, `chethan62/grammar-ui` | n/a | front-ends *for* an LT-compatible API | Show demand, not servers. |

Not LT-compatible servers (checked): **Harper itself** (`Automattic/harper`; a code
search for `/v2/check` returned nothing; it is an LSP/library, and its docs merely
compare to LT); **LTeX+** is a client only. **Grammalecte** integrates the other
direction (LT's `HTTPServerConfig` has a `grammalecteServer` option) — not an LT API
server, not source-checked beyond that. **`languagetool-rust`**, **textidote**, **Vale**:
not checked; they are clients/CLIs as far as I know (**unverified**).

Takeaway: three independent projects shipped `/v2/check` with the minimal subset
(`matches[]` with `message`, `offset`, `length`, `replacements`, `rule.id`,
`rule.category`, `context`, `sentence`), and the README of the first confirms
real clients accept omitting the two "unofficial" fields.

## 6. Mapping from Fabulous Writing (brief)

Our API: `POST /api/checks` (JSON body `text`, `language`, `domain_ids`, `checkers`,
...) returns 202 with `findings` and runs the LLM asynchronously; results stream
over SSE from `GET /api/checks/{id}/events` (`backend/app/api/checks.py`).
Languages: `GET /api/languages` -> `{code, name, nlp_available, model}` with codes
`en de fr es it ja zh` (`backend/app/api/languages.py`).

| LT field | Ours | Gap |
|---|---|---|
| `offset`/`length` (UTF-16 units) | `Span.start/end` as Python code points (`backend/app/core/models.py`) | Convert per match; `frontend/src/embed/offsets.ts` already maps code points <-> UTF-16, reuse the logic server-side. `length = end - start` after conversion. |
| `message` | `Finding.message` | direct. `shortMessage` can be empty. |
| `replacements[].value` | `Finding.suggestions: list[str]` | direct (`[{"value": s}]`). `Finding.advice` has no LT equivalent. |
| `rule.id` | `Finding.rule_id` (nullable) | LLM findings have none: synthesize e.g. `FW_LLM_<category>`. |
| `rule.category.id/name`, `rule.issueType` | `Category` (7 values), `Severity` | Needs a mapping table (e.g. spelling -> `TYPOS`/`misspelling`, grammar -> `GRAMMAR`/`grammar`, style/clarity/vividness -> `STYLE`/`style`, terminology -> `TERMINOLOGY`/`terminology`). Severity has no LT field. |
| `context{text,offset,length}`, `sentence` | none | Compute from the source text at serialization (required by swagger; LTeX+ reads `sentence`). |
| `language`, `software`, `warnings` | none | Constants; `detectedLanguage` can echo the requested one. |
| `language=auto`, `en-US`, `de-DE` | `Language` enum is bare `en/de/...` | Parse `en-US` -> `en`; refuse unsupported codes with a 400 like LT; `auto` needs detection or a fixed default. |
| `data` annotated text | none | Must flatten markup, run checkers on plain text, then map offsets back to the original string. LTeX+ and Obsidian send only `data`, so this is needed for them. |
| `username`/`apiKey` | JWT-style `get_current_user` | New key-based auth path. |
| Response time | LLM checker is slow/streamed | LibreOffice core uses a 10 s timeout; serve rules/terminology only (or cached LLM) from the compat route. |
| `max_document_chars` | exists | Expose via `/v2/maxtextlength` and 413 on overflow. |

## 7. Suggested minimal scope if pursued

1. `GET /v2/languages`, `POST /v2/check` (form-encoded, `text` + `data`, `language`,
   enabled/disabled rules and categories, `level` ignored), CORS
   `Access-Control-Allow-Origin` on success and error responses, `Content-Type:
   application/json`.
2. `POST /v2/maxtextlength`, `POST /v2/configinfo` only if the LibreOffice Java
   extension matters (it is unmaintained; LibreOffice core does not need them).
3. Skip `/v2/words*` (Premium dictionary) unless a client requires it; none of the
   researched clients' read paths needed it.
4. Test with: LibreOffice core, LTeX+ (`data` path), and the browser extension in
   "Other server" mode (CORS + HTTPS) before claiming Word support.

## Sources

Primary, LanguageTool:
- https://languagetool.org/http-api/ and https://languagetool.org/http-api/languagetool-swagger.json
- https://github.com/languagetool-org/languagetool (commit `2c9b51e`):
  `languagetool-server/src/main/java/org/languagetool/server/{ApiV2,TextChecker,V2TextChecker,LanguageToolHttpHandler,ServerTools,HTTPServerConfig}.java`;
  `languagetool-core/src/main/java/org/languagetool/tools/RuleMatchesAsJsonSerializer.java`;
  `languagetool-core/src/main/java/org/languagetool/rules/RuleMatch.java`;
  `languagetool-http-client/src/main/java/org/languagetool/remote/RemoteLanguageTool.java`;
  `languagetool-gui-commons/src/main/java/org/languagetool/gui/Configuration.java`;
  `COPYING.txt`, `README.md`
- https://github.com/languagetool-org/languagetool-org.github.io (commit `f11acb7`): `http-server.md`, `public-http-api.md`, `software-that-supports-languagetool-as-a-plug-in-or-add-on.md`
- https://github.com/languagetool-org/languagetool-for-libreoffice (commit `6f9eb45`)
- https://github.com/languagetool-org/languagetool-browser-addon (commit `c3b1919`; issue 279)
- https://github.com/languagetool-org/languagetool/issues/11232
- https://languagetool.org/webextension/premium-announcement
- https://languagetool.org/word-add-in, https://languagetool.org/word
- https://languagetool.org/legal/terms
- https://help.languagetool.org/hc/en-us/articles/39254524980119 (LibreOffice article, via search snippet)
- Forum (staff answers by user `dnaber`): topics 8171, 9265, 8077, 9842, 9180, 10271, 7100, 11057, 12035, 8865 at https://forum.languagetool.org/t/<id>

Primary, clients:
- https://github.com/LibreOffice/core (commit `563e5cd`): `lingucomponent/source/spellcheck/languagetool/languagetoolimp.cxx`, `cui/source/options/optlanguagetool.cxx`
- https://github.com/ltex-plus/ltex-ls-plus (`bcfe86a`) `src/main/kotlin/org/bsplines/ltexls/languagetool/LanguageToolHttpInterface.kt`, `LanguageToolRuleMatch.kt`; https://github.com/ltex-plus/vscode-ltex-plus `package.json`, `package.nls.json`
- https://github.com/Clemens-E/obsidian-languagetool-plugin (`f181770`) `README.md`, `src/api.ts`
- https://github.com/davidlday/vscode-languagetool-linter (`ba008ea`) `package.json`
- https://github.com/texstudio-org/texstudio (`86c2109`) `src/grammarcheck_config.h`, `src/grammarcheck.cpp`
- https://github.com/mhayashi1120/Emacs-langtool `langtool.el`; https://github.com/emacs-languagetool/flycheck-languagetool `flycheck-languagetool.el`

Prior art (third-party, treated as project claims):
- https://github.com/chethan62/grammar-server (`f097adc`), https://github.com/legion-works/grammar-forge (`d9e5171`), https://github.com/juliarscat/ClariCat (`01c5bc9`), https://github.com/PiratesIRC/Proofline

Local: `docs/notes/2026-08-24-languagetool-integration.md`,
`backend/app/api/checks.py`, `backend/app/api/languages.py`,
`backend/app/core/models.py`, `frontend/src/embed/offsets.ts`.

## Not verified (summary)

- Current (2026) Word add-in server field, endpoints, `data` vs `text`, auth, and any plan gating.
- Current browser extension: menu labels, `data` vs `text`, timeouts, whether it sends `username`/`apiKey` to a custom server, and the date of the Premium-only announcement.
- Windows desktop app, Outlook, mobile keyboards: no custom-server evidence found (absence of evidence, not proof).
- Which repo/entity maintains the Swagger JSON and under what licence.
- Trademark registrant and registration scope; Learneo Terms of Service text; Word add-in terms.
- Thunderbird add-on, vim plugins, Joplin, Logseq, Zotero, Typora, `languagetool-rust`, textidote, Vale: not source-checked.
- UTF-16 offset claim is derived from source and LibreOffice/Obsidian behaviour, not from a live emoji test.
- The CJEU interoperability point in section 4 is from general knowledge, not checked against a primary source.
