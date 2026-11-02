# Microsoft Word add-in — feasibility

Date: 2026-11-02. Scope: research only, no implementation. Primary sources only
(learn.microsoft.com, OfficeDev GitHub repos, Microsoft devblogs, npm/GitHub
READMEs of Microsoft packages). Question: can Fabulous Writing (FastAPI backend,
React 19 + Vite + TS frontend, bearer auth, findings as `{start,end}` code-point
offsets into plain text) ship as a Word add-in, from a macOS-only developer setup?

Source pins (so claims stay checkable):
- Docs source: `OfficeDev/office-js-docs-pr` branch `live` (`DOCS-PR`) and
  `OfficeDev/office-js-docs-reference` branch `live` (`DOCS-REF`), raw files fetched 2026-11-02.
- Tool sources: `OfficeDev/Office-Addin-Scripts` branch `master` (`SCRIPTS`).

## Bottom line

1. **Feasible, and the web app is mostly reusable.** An Office Add-in is a hosted
   HTTPS web app shown in a task pane, plus a manifest. No Windows machine is
   needed to build, run or debug it: Word on Mac and Word on the web both sideload.
   VSTO/COM (Windows-only) is not needed.
2. **The native squiggle UI exists and is not Windows-only.** `Paragraph.insertAnnotations`
   with `Word.Critique` (colored underline plus a popup of up to three suggestions,
   accept/reject events) is in **WordApi 1.7/1.8**, not WordApiDesktop 1.1 as the task
   brief assumed. The requirement-set table lists WordApi 1.7 and 1.8 as supported on
   the web, Windows, Mac and iPad. **Catch:** it requires Word connected to a
   **Microsoft 365 subscription**; with a perpetual license `isSetSupported` still
   returns true but it does not work, and there is no detection API (Microsoft:
   "by design", "no such way"). Fallback for those users: highlight via
   `Range.search` + `Range.highlight()` (WordApi 1.8) or a task-pane list with
   "Apply" buttons.
3. **The hard part is offsets, not platform.** Docs do not state the unit of
   `Critique.start`/`length`, nor which text model `start` is relative to. They
   state that `Paragraph.getText()` excludes equations, graphics and the special
   characters that mark fields, content controls, comments, footnotes and endnotes.
   Expect to build a per-paragraph mapping and verify on all three platforms.
   Our findings are code points; the existing `frontend/src/embed/offsets.ts`
   converter covers code point to UTF-16.
4. **Manifest choice.** The unified (JSON) manifest for Word went GA on 2026-07-16 and
   works on Word for web, Windows (2501+ with subscription) and Mac (16.103+). It does
   not work on perpetual Office on Windows, iPad, or mobile. The XML add-in-only
   manifest works everywhere and is still supported for Word. For a first version the
   XML manifest is the lower-risk choice; the unified manifest is the direction of travel.
5. **Dev loop on Mac works** (`npx office-addin-debugging start manifest desktop`, or
   copy the manifest into the `wef` folder). Safari Web Inspector debugging works.
   `office-addin-dev-certs` has macOS and Linux branches. The Yeoman and Agents
   Toolkit scaffolding is optional; our Vite app can be hosted as is.
6. **Distribution without a company is hard.** Public AppSource listing requires a
   Partner Center account created with a Microsoft Entra work account and "authority
   to sign legal agreements on your company's behalf" plus legal business name.
   Organisation-wide deployment goes through the Microsoft 365 admin center. For a
   solo developer the realistic channels are sideload and an org admin deploy.
   I found no other documented install path for a personal Microsoft account.
7. **Free test tenant is no longer open to everyone.** The Microsoft 365 Developer
   Program sandbox now requires Visual Studio Pro/Enterprise, ISV Success/AI Cloud
   Partner Program, or Premier/Unified Support. Word on the web with a personal
   Microsoft account can still be sideloaded per the docs.
8. **No Windows runner is required** for build or validation. `office-addin-manifest
   validate` is a Node CLI. Automated UI tests against real Word are not documented;
   `office-addin-mock` supports unit tests only.
9. **Microsoft Editor has no documented third-party plug-in point.** Annotations are
   the route. The Ignite 2025 post mentions new proofing helpers (language
   detection, hyphenation control), not an Editor extension API.

## 1. Platform model

- Office Add-ins are web apps: "HTML, CSS, and JavaScript"; the package is "a manifest
  file, two app icons" and logic and data are "hosted elsewhere and accessed … via
  HTTPS". They run in Word on the web, Windows, Mac and iPad.
  https://learn.microsoft.com/en-us/office/dev/add-ins/overview/office-add-ins
- Word clients targeted: Word on the web, Word 2016 or later on Windows, Word on Mac,
  Word on iPad.
  https://learn.microsoft.com/en-us/office/dev/add-ins/word/word-add-ins-programming-overview
- Two manifest types: add-in-only manifest (XML; "can be used for production add-ins in
  Excel, OneNote, Outlook, PowerPoint, Project, and Word") and the unified manifest for
  Microsoft 365 (JSON).
  DOCS-PR `docs/develop/add-in-manifests.md`
  (https://learn.microsoft.com/en-us/office/dev/add-ins/develop/add-in-manifests)
- Unified manifest status for Word: GA announced 2026-07-16 for Word, Excel, PowerPoint
  (after Outlook); installable on web, Windows and Mac.
  https://devblogs.microsoft.com/microsoft365dev/unified-manifest-for-office-add-ins-now-ga/
- Unified manifest platform table (docs, updated 2026-10-14):
  https://learn.microsoft.com/en-us/office/dev/add-ins/develop/unified-manifest-overview

  | Client | Unified manifest |
  | --- | --- |
  | Office on the web | Yes |
  | Word on Windows, 2501 (18407.20002)+, Microsoft 365 subscription | Yes |
  | Word on Mac, 16.103 (25101427)+ | Yes |
  | Office on Windows, perpetual | No |
  | Mobile (incl. iPad per the sideload note) | No |

  Gaps: Word/Excel/PowerPoint `OnDocumentOpened` event is not supported with it. Docs
  say to ship two manifests if you need unsupported platforms. A unified-manifest
  add-in cannot be sideloaded on iPad
  (https://learn.microsoft.com/en-us/office/dev/add-ins/testing/sideload-add-in-with-unified-manifest).
  The docs' own sample still uses `"manifestVersion": "devPreview"`; see Not verified.
- COM and VSTO add-ins "run only in Office on Windows" and are "earlier Office
  integration solutions"; web add-ins are the cross-platform route (same overview page
  as above). Nothing in the platform requires VSTO.

## 2. Development on macOS and Linux

| Tool | macOS | Linux | Source |
| --- | --- | --- | --- |
| `yo office` (generator-office) | yes (Node tool) | yes (Node tool) | set-up-your-dev-environment (DOCS-PR `docs/overview/set-up-your-dev-environment.md`) |
| `office-addin-debugging` | yes, platform arg `desktop` = "Windows or Mac", or `web` | no desktop Word exists; `web` target only (inference) | SCRIPTS `packages/office-addin-debugging/README.md` |
| `office-addin-dev-certs` | yes (adds trust to login keychain via `security add-trusted-cert`) | has `scripts/install_linux.sh` | SCRIPTS `packages/office-addin-dev-certs/src/install.ts` |
| `office-addin-manifest validate` | yes (Node CLI) | yes | SCRIPTS `packages/office-addin-manifest/README.md` |
| Agents Toolkit (VS Code) | yes | yes (VS Code extension; not tested by the docs) | agents-toolkit-overview |

Notes with sources:
- Docs: "Visual Studio for Mac doesn't include the project scaffolding templates for
  Office Add-ins, so if your development computer is a Mac, you should work with the
  Node.js or Visual Studio Code environments."
  https://learn.microsoft.com/en-us/office/dev/add-ins/overview/set-up-your-dev-environment
- Dev certs: localhost certificate valid 30 days by default, stored in
  `<userhome>/.office-addin-dev-certs`.
  https://github.com/OfficeDev/Office-Addin-Scripts/tree/master/packages/office-addin-dev-certs
- Agents Toolkit: for Word, "install the prerelease version" of the toolkit; the
  toolkit emits unified-manifest projects.
  https://learn.microsoft.com/en-us/office/dev/add-ins/develop/agents-toolkit-overview
- Yo Office offers a Word/Excel/PowerPoint unified-manifest option still labelled
  "(preview)" in the docs, and uses webpack plus webpack-dev-server.
  https://learn.microsoft.com/en-us/office/dev/add-ins/develop/yeoman-generator-overview
- Vite is acknowledged for add-in projects (TypeScript config example).
  DOCS-PR `docs/develop/connect-to-javascript-frameworks.md`
  (https://learn.microsoft.com/en-us/office/dev/add-ins/develop/connect-to-javascript-frameworks).
  Nothing requires webpack; the manifest only points at URLs.

### Sideloading

- **Word for Mac, XML manifest:** copy the manifest to
  `/Users/<username>/Library/Containers/com.microsoft.Word/Data/Documents/wef`
  (create `wef` if missing), restart Word, then Home > Add-ins. Minimum Word 15.18.
  https://learn.microsoft.com/en-us/office/dev/add-ins/testing/sideload-an-office-add-in-on-mac
- **Word for Mac, unified manifest** (16.103+): `npm run start` /
  `npx office-addin-debugging start <manifest> desktop`; always end with `stop`.
  https://learn.microsoft.com/en-us/office/dev/add-ins/testing/sideload-add-in-with-unified-manifest
- **Word on the web, XML manifest:** Home > Add-ins > More Settings > Upload My Add-in
  > browse > Upload. The manifest is kept in browser local storage, so another browser
  means sideload again. The docs list separate paths "with a Microsoft account" and
  "with an account in a Microsoft 365 tenant", i.e. a personal Microsoft account is
  documented as sufficient for web sideloading.
  https://learn.microsoft.com/en-us/office/dev/add-ins/testing/sideload-office-add-ins-for-testing
- **Unified manifest on web:** sideloading on Windows also sideloads to the web; a
  Teams-app-store route also exists. On macOS the documented routes are the npm
  scripts and Agents Toolkit CLI.
- Office on Mac "must be installed from Office.com, not the Apple App Store or Mac
  App Store" for debugging.
  https://learn.microsoft.com/en-us/office/dev/add-ins/testing/debug-office-add-ins-on-ipad-and-mac

### Debugging on Mac

Run `defaults write com.microsoft.Word OfficeWebAddinDeveloperExtras -bool true`,
sideload, then right-click in the task pane > Inspect Element (Safari Web
Inspector). Needs Office on Mac 16.9.1 or later. Clear the add-in cache per
https://learn.microsoft.com/en-us/office/dev/add-ins/testing/clear-cache.
Same page: https://learn.microsoft.com/en-us/office/dev/add-ins/testing/debug-office-add-ins-on-ipad-and-mac

### Microsoft 365 Developer Program

Not freely available any more. Qualifying paths: Visual Studio Professional or
Enterprise subscribers; ISV Success Program or eligible Microsoft AI Cloud Partner
Program tiers; Premier or Unified Support customers. Sandbox is E5, 25 licenses,
"up to 90 days", renewable while eligible. Setup requires linking a billing account
(Microsoft Customer Agreement with an active Azure subscription); "remains free of
charge". Page dated 2026-09-04.
https://learn.microsoft.com/en-us/office/developer-program/microsoft-365-developer-program-faq

## 3. Word JavaScript API for a checker

Requirement-set table (updated 2026-09-10; "minimum" builds):
https://learn.microsoft.com/en-us/javascript/api/requirement-sets/word/word-api-requirement-sets

| Set | Web | Windows (365 / retail) | Windows volume-licensed | Mac | iPad |
| --- | --- | --- | --- | --- | --- |
| WordApi 1.1 | yes | 1509 | Office 2016 | 15.19 | 1.18 |
| WordApi 1.3 | yes | 1612 | Office 2019 | 15.32 | 2.22 |
| WordApi 1.6 | yes | 2308 | Office 2024 | 16.76 | 16.76 |
| WordApi 1.7 | yes | 2311 | Office 2024 | 16.79 | 16.79 |
| WordApi 1.8 | yes | 2405 | Office 2024 | 16.85 | 16.85 |
| WordApi 1.9 | yes | 2411 | not available | 16.91 | 16.91 |
| WordApiDesktop 1.1 | n/a | 2408 | Office 2024 | 16.88 | 16.88 |
| WordApiDesktop 1.4 | n/a | 2508 | not available | 16.100.4 | not available |
| WordApiOnline 1.1 | latest | n/a | n/a | n/a | n/a |

Which API needs which set (member-level `API set:` remarks in DOCS-REF
`docs/docs-ref-autogen/word/word/word.{paragraph,range,document,selection}.yml`
and `docs/includes/word-1-*.md`):

| Need | API | Set |
| --- | --- | --- |
| Paragraph text | `Body.paragraphs`, `Paragraph.text` (load first) | WordApi 1.1 |
| Paragraph text, selectable exclusions | `Paragraph.getText({IncludeHiddenText, IncludeTextMarkedAsDeleted})` | WordApi 1.7 |
| Find a span by content | `Paragraph.search` / `Range.search` (options: `matchCase`, `matchWholeWord`, `ignorePunct`, `ignoreSpace`, `matchWildcards`, ...) | WordApi 1.1 |
| Sub-ranges | `Range.getTextRanges`, `Range.split`, `Paragraph.getRange`, `Range.getRange`, `Range.expandTo` | WordApi 1.3 |
| Replace | `Range.insertText(text, "Replace")` | WordApi 1.1 |
| Select and scroll | `Range.select()` ("Selects and navigates the Word UI to the range") | WordApi 1.1 |
| Temporary highlight | `Range.highlight()` / `removeHighlight()` | WordApi 1.8 |
| Character positions | `Range.start`, `Range.end` (read/write "character position"), `Selection.setRange(start, end)` | WordApiDesktop 1.4 (Windows, Mac only) |
| Edit events | `Document.onParagraphAdded/Changed/Deleted` | WordApi 1.6 |
| Annotations | `Paragraph.insertAnnotations`, `getAnnotations`, `Document.onAnnotation*` | WordApi 1.7 (popup + `onAnnotationPopupAction`: 1.8) |

Observations:
- There is **no** cross-platform "range from character offset" API in WordApi 1.x. The
  offset-based reads (`Range.start/end`, `Selection.setRange`) are desktop-only
  (WordApiDesktop 1.4). On the web the way to locate a span is `search` (by text, then
  disambiguate by occurrence index) or sub-ranges via `getTextRanges`/`split`.
- Events: `onParagraphChanged` fires for UI edits, add-in code and coauthors, with an
  `event.source` of Local or Remote; handlers are not persisted and die when the add-in
  reloads. https://learn.microsoft.com/en-us/office/dev/add-ins/word/word-add-ins-events
  The event args carry paragraph identifiers, not text; the handler must reload text.
  (Args shape not independently verified; see Not verified.)
- `Paragraph.text` has no documented remarks; `getText` is documented to exclude
  non-text content (section 5).

## 4. Critique annotations

Concept page ("Use annotations in your Word add-in", 2026-05-21):
https://learn.microsoft.com/en-us/office/dev/add-ins/word/annotations
Runnable sample (Script Lab snippet, not in Office-Add-in-samples):
https://github.com/OfficeDev/office-js-snippets/blob/prod/samples/word/50-document/manage-annotations.yaml

What it does: "Word highlights affected text and can show a popup with suggested
actions when the user points to the annotation." A critique is "feedback about an
affected area of a paragraph, indicated by a colored underline."

API surface:
- `paragraph.insertAnnotations({ critiques: [...] })` returns ids;
  `paragraph.getAnnotations()`; `context.document.getAnnotationById(id)`;
  `annotation.critiqueAnnotation.accept()/reject()`; `annotation.delete()`;
  `annotation.state` (e.g. `created`); `critiqueAnnotation.range` ("range of text that
  is annotated"). WordApi 1.7.
  https://learn.microsoft.com/en-us/javascript/api/requirement-sets/word/word-api-1-7-requirement-set
- `Word.Critique`: `colorScheme` (Red, Green, Blue, Lavender, Berry), `start`,
  `length`, `popupOptions`.
  https://learn.microsoft.com/en-us/javascript/api/word/word.critique
- `Word.CritiquePopupOptions` (WordApi 1.8): `titleResourceId`, `subtitleResourceId`,
  `brandingTextResourceId` — all **manifest resource IDs**, not literal strings — and
  `suggestions: string[]`. "Word critique annotation cards display a maximum of three
  suggestions." There is no `brandingTextColor`; the task brief's field names are
  wrong.
  https://learn.microsoft.com/en-us/javascript/api/word/word.critiquepopupoptions
- Events on `Document`: `onAnnotationClicked` (click or Alt+Down), `onAnnotationHovered`,
  `onAnnotationInserted`, `onAnnotationRemoved` (WordApi 1.7), and
  `onAnnotationPopupAction` (1.8; args `id`, `action` Accept/Reject,
  `critiqueSuggestion`). Annotation events are not triggered during coauthoring.
  https://learn.microsoft.com/en-us/javascript/api/requirement-sets/word/word-api-1-8-requirement-set
  https://learn.microsoft.com/en-us/office/dev/add-ins/word/word-add-ins-events
- **Not persisted:** "when the document is reopened, the annotations need to be
  regenerated." Accepted suggestions persist as normal text edits.
- **Subscription requirement:** "The annotation APIs rely on a service that requires a
  Microsoft 365 subscription. As such, using this feature in Word with a one-time
  purchase license won't work." Microsoft, 2024-10-17: "by design since the annotation
  service … requires a subscription"; `isSetSupported` returns true anyway and "there is
  currently no such way" to detect it.
  https://github.com/OfficeDev/office-js/issues/4953
- **Platforms:** the reference lists the annotation types in the `word-js-1.7`,
  `1.8`, `1.9`, `desktop-1.x` and `word-js-online` moniker sets (DOCS-REF
  `docs/docs-ref-autogen/word_online/word/word.annotationset.yml`), and the 1.7/1.8
  rows are "Supported" on the web, Windows, Mac and iPad. So the web is not excluded by
  the docs. I did not find any platform-specific caveat for annotations beyond the
  subscription note, and I could not test it (see Not verified).
- Suggestion handling gap: the popup returns the chosen suggestion text to the add-in
  (`critiqueSuggestion`); Word does not apply it itself in the docs' example. The
  add-in should replace the range and remove the annotation.

## 5. Offsets and text model

- `Critique.start` / `length`: "start index of the critique inside paragraph", "length of
  the critique inside paragraph". **Unit, base (0 or 1), and treatment of non-text
  content are not documented** on the Critique, `insertAnnotations` or annotations
  pages (the `insertAnnotations` page has no remarks on them; sample uses
  `start: 1, length: 3` without explanation).
- `Paragraph.getText()` (WordApi 1.7): "This excludes equations, graphics (e.g., images,
  videos, drawings), and special characters that mark various content (e.g., for content
  controls, fields, comments, footnotes, endnotes). By default, hidden text and text
  marked as deleted are excluded." DOCS-REF `word.paragraph.yml`
  (https://learn.microsoft.com/en-us/javascript/api/word/word.paragraph).
  Implication: use `getText` as the checker input so that the text sent to the backend
  matches the "visible text" model, then confirm empirically that `Critique.start`
  indexes that same string. `Paragraph.text` itself has no such remark, so do not
  assume they are equal.
- `Range.start/end` are "character position" (WordApiDesktop 1.4), also unit-undocumented
  in the fragments I read.
- Practical pitfall for us: backend offsets are code points over our own plain text. A
  per-paragraph checking model is needed (send each paragraph's `getText()`; offsets are
  then paragraph-relative, matching `insertAnnotations`). Convert code points to UTF-16
  code units via `frontend/src/embed/offsets.ts`, and test with emoji (astral plane),
  a footnote, a field and a line break (`\v`) inside a paragraph on Mac and web.

## 6. Authentication and networking

- **Dialog API for login:** `Office.context.ui.displayDialogAsync(url, opts)`; the first
  URL must be in the same domain as the host page; after load the user can navigate to
  any HTTPS site; default size 80% of the screen. In the dialog only `messageParent`
  (and `isSetSupported`) are available; results come back to the task pane through
  `DialogMessageReceived`. Only one dialog per host window. Do not use `window.open`.
  `displayInIframe: true` is a web-only option and must not be used for IdP pages that
  forbid iframes.
  https://learn.microsoft.com/en-us/office/dev/add-ins/develop/dialog-api-in-office-add-ins
  Pattern doc: https://learn.microsoft.com/en-us/office/dev/add-ins/develop/auth-with-office-dialog-api
- **Cross-domain messaging:** if the dialog or the parent navigates off the add-in
  domain, `messageParent` needs `{ targetOrigin: ... }` (Dialog Origin 1.1). Trusted
  domains come from `<AppDomains>` (XML) or `"validDomains"` (unified).
- **Navigation inside the task pane:** on desktop, navigating the task pane to a domain
  other than the start-page domain opens a **new external browser window** unless the
  domain is listed in `AppDomains`/`validDomains`; on the web the task pane can navigate
  anywhere.
  https://learn.microsoft.com/en-us/office/dev/add-ins/develop/unified-manifest-overview#specify-safe-domains
- **Username/password in the task pane:** documented as a normal pattern: a sign-in form
  with `type="text"` and `type="password"` fields works, and WebView2 can offer to
  save credentials after a redirect.
  https://learn.microsoft.com/en-us/office/dev/add-ins/develop/auth-save-passwords
  Storing the bearer token in `localStorage` or `OfficeRuntime.storage` is not
  addressed in the pages I read (see Not verified).
- **CORS:** same-origin policy applies to the task pane page. The docs' answer for
  calling another origin is CORS or a token-based server side.
  https://learn.microsoft.com/en-us/office/dev/add-ins/develop/addressing-same-origin-policy-limitations
  The task pane page is served from our own HTTPS host, so our API either lives on the
  same origin or must allow that origin.
- **Webviews:** Windows uses Edge/WebView2, Mac and iOS use Safari WKWebView, Android
  uses Chrome; the web uses iframes in the user's browser. Conditional Access is not
  supported on iOS/Android.
  https://learn.microsoft.com/en-us/office/dev/add-ins/concepts/browsers-used-by-office-web-add-ins
  Add-ins on Windows "require Microsoft Edge" webview components (IE/legacy Edge are
  not used any more).
  https://learn.microsoft.com/en-us/office/dev/add-ins/concepts/requirements-for-running-office-add-ins
- **HTTPS:** mandatory for Office on the web and for Marketplace publishing; strongly
  recommended otherwise; self-signed certs are fine for development if trusted locally
  (same requirements page).
- Task pane in an iframe on the web: third-party cookie and storage partitioning rules
  of the user's browser apply. Not covered by the Office docs I read.

## 7. Distribution

| Route | Who | Notes |
| --- | --- | --- |
| Sideload | developer/testers | Not for production (publish.md). Per user, per machine; on web, per browser. |
| Integrated apps portal, Microsoft 365 admin center | users in one organization | Admin deploys to users/groups; appears immediately. Unified-manifest internal add-ins "won't be installable by users with certain versions of Office". Sovereign clouds use Centralized Deployment. |
| Microsoft Marketplace (AppSource), Partner Center | public | See below. |

https://learn.microsoft.com/en-us/office/dev/add-ins/publish/publish

Marketplace details:
- Needs a Partner Center account "using your Microsoft Entra ID work account", "authority
  to sign legal agreements on your company's behalf", company legal name and address,
  verified during creation; enroll in the "Microsoft 365 and Copilot" program and
  accept the Microsoft Publisher Agreement.
  https://learn.microsoft.com/en-us/partner-center/marketplace-offers/open-a-developer-account
- Review: automated checks, then manual validation "can take 3-5 working days".
  Validators test on every platform the add-in claims to support; provide test notes
  and a ready test account. Re-certification after changes.
  https://learn.microsoft.com/en-us/partner-center/marketplace-offers/submit-to-appsource-via-partner-center
- Policy note: to pass validation the add-in "must work across all platforms that
  support the methods that you define" (certification policy section 1120.3), per the
  Word overview page. This matters for annotations: a WordApi 1.7 requirement is
  checked against all platforms listed for 1.7, including iPad and the web.
- Registration fee: not stated in the pages I read (see Not verified).
- A personal (non-organizational) user cannot be reached by admin-center deployment.
  No other documented install route for them besides sideloading (web upload;
  Mac `wef` folder) — absence of a documented route, not proof it does not exist.
- No code signing and no Windows-specific build step: the package is a manifest, two
  icons, optional localization files; the code is the hosted site.
  https://learn.microsoft.com/en-us/office/dev/add-ins/overview/office-add-ins
  (The Windows installer route for bundling with COM/VSTO is optional and not relevant.)

## 8. CI/CD

- Build: any bundler. Yo Office templates use webpack; Vite is mentioned in the docs'
  framework guide, so our existing Vite build can produce the task-pane pages. The
  manifest must point at the deployed HTTPS URLs.
- Validate: `npx office-addin-manifest validate <manifest>` (Node CLI, works on any OS).
  https://github.com/OfficeDev/Office-Addin-Scripts/tree/master/packages/office-addin-manifest
  For unified manifests the same package has `export` to zip manifest and icons.
- Unit tests: `office-addin-mock` gives an `OfficeMockObject` that mimics
  `ClientRequestContext` `load`/`sync` behaviour (fails if you read an unloaded
  property); framework-agnostic (Jest, Mocha examples). It cannot exercise real
  Word behaviour such as offsets.
  https://learn.microsoft.com/en-us/office/dev/add-ins/testing/unit-testing
- No Windows runner needed for any of the above. UI automation against real Word
  (Playwright on Word on the web or desktop automation): **no supported harness is
  documented** in the Office docs or Office-Add-in-samples; a search of
  `office-js-docs-pr` for Playwright found nothing relevant.
- Repos: https://github.com/OfficeDev/Office-Addin-Scripts (tooling, last push
  2026-10-27), https://github.com/OfficeDev/Office-Add-in-samples (no annotations
  sample; the Word samples there are OpenXML, label-on-open, citations, templates),
  https://github.com/OfficeDev/office-js-snippets (the `manage-annotations` snippet,
  runnable in Script Lab), https://github.com/OfficeDev/generator-office.

## 9. Known constraints

- **Subscription vs perpetual:** annotations need a Microsoft 365 subscription
  (section 4). The WordApi table lists volume-licensed rows as "Office 2024" for 1.6-1.8
  and "Not available" for 1.9 and for WordApiDesktop 1.4; Office 2021/2019 appear only
  for lower sets (1.1 = 2016, 1.3 = 2019). WordApiDesktop 1.1 is the only desktop set
  with an Office 2024 entry.
- **iPad:** supports WordApi 1.7/1.8 (16.79/16.85) and WordApiDesktop 1.1/1.2 only;
  unified-manifest add-ins cannot be sideloaded there. The user-facing impact on an
  XML-manifest add-in is untested.
- **Word for Mac minimum for Office.js at all:** 15.18; see the table above for
  the version needed per set.
- **Task pane width:** the design page documents task pane sizes only for fixed
  resolutions (Outlook on the web 320x570 in the text I saw). Word's pane width was not
  retrievable; plan for a narrow pane (see Not verified).
  https://learn.microsoft.com/en-us/office/dev/add-ins/concepts/requirements-for-running-office-add-ins
- **WebView2 quirks:** scrollbars hidden until hover (set `overflow-y: scroll`);
  blob PDF downloads unsupported (use `Office.context.ui.openBrowserWindow`).
  https://learn.microsoft.com/en-us/office/dev/add-ins/concepts/browsers-used-by-office-web-add-ins
- **Events do not persist** across sessions; annotations do not persist in the file.
  Re-check on open and on `onParagraphChanged` (WordApi 1.6).
- **WordApiDesktop sets** are production APIs but only on Windows/Mac (and some iPad);
  guard with `Office.context.requirements.isSetSupported("WordApiDesktop", "1.4")`
  and fall back to `search` on the web.
  https://learn.microsoft.com/en-us/javascript/api/requirement-sets/word/word-api-desktop-1-4-requirement-set

## 10. Microsoft Editor and third-party proofing

No primary source documents an extension point in Word's built-in Editor/proofing
for third parties. The only documented writing-assistance route for add-ins is the
annotation API (WordApi 1.7 "mainly added support for writing assistance"; 1.8
"further support"). The Ignite 2025 developer post mentions Word language detection
and manual hyphenation aimed at "multilingual proofreading extensions", not an Editor
plug-in.
https://learn.microsoft.com/en-us/javascript/api/requirement-sets/word/word-api-1-7-requirement-set
https://devblogs.microsoft.com/microsoft365dev/ignite-2025-whats-new-for-office-add-ins/

## Suggested next step (if pursued)

A one-day spike on the Mac, XML manifest, Vite-served task pane over
`office-addin-dev-certs`: read paragraphs with `getText`, call the existing check
endpoint, insert critiques, and log `start`/`length` against known test strings
(astral emoji, footnote, field, tab, soft line break). That answers the offset
question, which is the main unknown, in the same session it is asked.

## Sources

- https://learn.microsoft.com/en-us/office/dev/add-ins/overview/office-add-ins
- https://learn.microsoft.com/en-us/office/dev/add-ins/develop/add-in-manifests
- https://learn.microsoft.com/en-us/office/dev/add-ins/develop/unified-manifest-overview
- https://devblogs.microsoft.com/microsoft365dev/unified-manifest-for-office-add-ins-now-ga/
- https://learn.microsoft.com/en-us/office/dev/add-ins/word/word-add-ins-programming-overview
- https://learn.microsoft.com/en-us/office/dev/add-ins/word/annotations
- https://learn.microsoft.com/en-us/office/dev/add-ins/word/word-add-ins-events
- https://learn.microsoft.com/en-us/javascript/api/requirement-sets/word/word-api-requirement-sets
- https://learn.microsoft.com/en-us/javascript/api/requirement-sets/word/word-api-1-7-requirement-set
- https://learn.microsoft.com/en-us/javascript/api/requirement-sets/word/word-api-1-8-requirement-set
- https://learn.microsoft.com/en-us/javascript/api/requirement-sets/word/word-api-desktop-1-4-requirement-set
- https://learn.microsoft.com/en-us/javascript/api/word/word.critique
- https://learn.microsoft.com/en-us/javascript/api/word/word.critiquepopupoptions
- https://learn.microsoft.com/en-us/javascript/api/word/word.paragraph
- https://learn.microsoft.com/en-us/javascript/api/word/word.range
- https://github.com/OfficeDev/office-js/issues/4953
- https://github.com/OfficeDev/office-js-docs-reference (raw `docs/docs-ref-autogen/word/word/*.yml`, `docs/includes/word-*.md`)
- https://github.com/OfficeDev/office-js-snippets/blob/prod/samples/word/50-document/manage-annotations.yaml
- https://learn.microsoft.com/en-us/office/dev/add-ins/overview/set-up-your-dev-environment
- https://learn.microsoft.com/en-us/office/dev/add-ins/develop/yeoman-generator-overview
- https://learn.microsoft.com/en-us/office/dev/add-ins/develop/agents-toolkit-overview
- https://learn.microsoft.com/en-us/office/dev/add-ins/develop/connect-to-javascript-frameworks
- https://learn.microsoft.com/en-us/office/dev/add-ins/testing/sideload-an-office-add-in-on-mac
- https://learn.microsoft.com/en-us/office/dev/add-ins/testing/sideload-office-add-ins-for-testing
- https://learn.microsoft.com/en-us/office/dev/add-ins/testing/sideload-add-in-with-unified-manifest
- https://learn.microsoft.com/en-us/office/dev/add-ins/testing/debug-office-add-ins-on-ipad-and-mac
- https://learn.microsoft.com/en-us/office/dev/add-ins/testing/unit-testing
- https://learn.microsoft.com/en-us/office/developer-program/microsoft-365-developer-program-faq
- https://learn.microsoft.com/en-us/office/dev/add-ins/develop/dialog-api-in-office-add-ins
- https://learn.microsoft.com/en-us/office/dev/add-ins/develop/auth-with-office-dialog-api
- https://learn.microsoft.com/en-us/office/dev/add-ins/develop/auth-save-passwords
- https://learn.microsoft.com/en-us/office/dev/add-ins/develop/addressing-same-origin-policy-limitations
- https://learn.microsoft.com/en-us/office/dev/add-ins/concepts/browsers-used-by-office-web-add-ins
- https://learn.microsoft.com/en-us/office/dev/add-ins/concepts/requirements-for-running-office-add-ins
- https://learn.microsoft.com/en-us/office/dev/add-ins/publish/publish
- https://learn.microsoft.com/en-us/partner-center/marketplace-offers/open-a-developer-account
- https://learn.microsoft.com/en-us/partner-center/marketplace-offers/submit-to-appsource-via-partner-center
- https://github.com/OfficeDev/Office-Addin-Scripts (packages `office-addin-debugging`, `office-addin-dev-certs`, `office-addin-manifest`, `office-addin-mock`)
- https://github.com/OfficeDev/Office-Add-in-samples
- https://devblogs.microsoft.com/microsoft365dev/ignite-2025-whats-new-for-office-add-ins/

## Not verified

- Unit of `Critique.start`/`length` (UTF-16 units vs characters), whether 0- or 1-based,
  and whether it indexes `getText()` or `text`. Docs are silent; needs an empirical test.
- Behaviour of annotations on **Word on the web** and **iPad** in practice. The
  requirement tables say supported; no hands-on confirmation, and no platform caveat
  found. Whether a *personal* Microsoft 365 subscription (Family/Personal) satisfies the
  "subscription" the annotation service needs: docs say "Microsoft 365 subscription" and
  the Microsoft reply says just "a subscription"; not tested.
- How custom values for `titleResourceId`, `subtitleResourceId`, `brandingTextResourceId`
  map to manifest `Resources`/`strings` (the sample uses `PG.TabLabel`-style ids that
  look like built-in Word strings). Not found in the pages read.
- Shape of `ParagraphChangedEventArgs`/`ParagraphAddedEventArgs` (which fields identify
  the paragraph) and event debouncing; only the event table was read.
- Task pane width for Word on each platform; whether Word on Mac/iPad enforce a minimum
  width. Only an Outlook-on-the-web figure was seen (320x570).
- Whether `localStorage`/`OfficeRuntime.storage` persist across task-pane sessions on
  Mac (WKWebView) and in Word on the web (iframe, third-party storage partitioning).
  Same for the exact `Origin` header the task pane sends on each platform.
- Whether `office-addin-debugging start ... web` works from Linux without Word desktop,
  and whether Agents Toolkit works end to end on Linux; only Node-level OS branches
  were seen (dev-certs has a Linux branch).
- Whether the "(preview)" label on the Yo Office unified-manifest option is stale after
  the July 2026 GA, and whether the manifest schema should be `devPreview` or a numbered
  release for production validation (the docs sample uses `devPreview`; a Q&A answer
  suggests production validation may reject it, which is not official).
- Partner Center registration fee and whether a sole proprietor (no company) can enroll;
  docs require company details and authority to sign for the company, nothing on fees.
- Whether a personal-account user can install a private add-in by any route other than
  sideloading.
- Whether Office 2021 (LTSC) is covered: the requirement table has no "Office 2021"
  entries for the sets above (rows say "Office 2016/2019/2024").
- Full text of `Range` and `Paragraph` reference remarks beyond the first ~100 KB
  fetched; any later remark on `start`/`text` semantics could have been missed (the
  YAML source was checked for API-set tags only).
