# FR/ES/IT/ZH Rules, Packs & Profiles (Phase 3) — Design

**Date:** 2026-07-07
**Status:** Approved
**Builds on:** `2026-07-07-rule-packs-en-de-design.md` (phase 1: pack mechanism, profile seeding), `2026-07-07-ja-rules-consistency-design.md` (phase 2: consistency check type, CJK boundary handling)

## Goal

Bring French, Spanish, Italian, and Chinese to full parity with EN/DE/JA: new
general grammar/style rules (the candidates parked in earlier phases),
marketing/techdocs/blog pack rules, seeded example profiles with localized LLM
instructions, and demo texts. Additionally, prove that the phase-2
`consistency` check type generalizes beyond Japanese with one address-register
rule per language.

**No engine changes.** Phase 3 is pure YAML rules + seeding + demos + docs:

- The loader validates `token_pattern` rules through spaCy's own
  `Matcher(validate=True)`, so `MORPH` conditions (`IS_SUPERSET`) and
  case-sensitive `TEXT` are already supported.
- Chinese characters (U+4E00–9FFF etc.) fall inside the phase-2 `_CJK_CHAR`
  ranges, so `bounded_pattern` already handles ZH substitution/existence keys.
- All four spaCy models (`fr_core_news_sm`, `es_core_news_sm`,
  `it_core_news_sm`, `zh_core_web_sm`) are installed locally and wired in the
  NLP registry defaults.

## Current state

`rules/{fr,es,it,zh}/` already hold baseline sets from the first NLP
milestone (FR/ES/IT: 7 rules each; ZH: 4) — long sentences, repeated words,
passive voice, fillers, clichés, dequeísmo (ES), malgré que (FR), ma però
(IT), 进行 overuse (ZH). Phase 3 must not duplicate any of these.

`EXAMPLE_LANGUAGES` and `BLOG_LANGUAGES` in
`app/services/seed_profiles.py` are `{EN, DE, JA}`; the instruction dicts
have entries for those three languages only. Demo files exist as
`{lang}.txt` for all seven languages but `{lang}-marketing.txt` /
`-technical-documentation.txt` / `-blog.txt` only for en/de/ja.

## Rule inventory

40 new rule files, 10 per language (3 general grammar/style + 1 consistency
+ 3 marketing + 2 techdocs + 1 blog). Conventions carried over from phases
1–2: one rule per file under `rules/<lang>/<category>/<name>.yml`; pack rules
carry `pack: marketing|techdocs|blog`; messages in the rule's own language;
substitution messages use the "first %s = good replacement, second %s =
matched bad" convention; every rule has `examples.bad` / `examples.good`
exercised by the catalog tests; a header comment explains intent and any
deliberate narrowing.

### Consistency rules (one per language, general grammar, `level: warning`)

Same semantics as `ja/style/desu-masu.yml`: variants vote per sentence,
fewer than 2 voting sentences → silent, each minority sentence flagged, ties
go to the first-declared variant. None of these four rules uses a `default`
variant — sentences containing neither register simply don't vote (unlike
desu-masu, there is no predicate-ending heuristic that could classify them).

| Lang | Rule | Informal variant (declared first) | Formal variant |
|---|---|---|---|
| fr | `grammar/tutoiement-vouvoiement` | tokens `tu, te, toi, ton, ta, tes` (LOWER) | `vous, votre, vos` (LOWER) |
| es | `grammar/tuteo-ustedeo` | `tú, ti, contigo, te` (LOWER) | `usted, ustedes` (LOWER) |
| it | `grammar/tu-lei` | `tu, ti, te, tuo, tua, tuoi, tue` (LOWER) | `Lei, Le, La` case-sensitive `TEXT` |
| zh | `grammar/ni-nin` | `你` | `您` |

Documented limitations (header comments + README):

- FR/ES: plural/impersonal readings of vous/ustedes vote as formal; possessives
  like `su` (ES) are 3rd-person-ambiguous and deliberately excluded.
- IT: sentence-initial `Lei`/`Le`/`La` capitalized by position (meaning
  "she"/"her"/article) is a known false-formal vote; the implementation should
  probe how often `it_core_news_sm` sentence starts collide and may exclude
  sentence-initial matches from the formal token list only if expressible in a
  Matcher pattern — otherwise document the limitation and keep `level: warning`.
- ZH: 你/您 tokens are unambiguous; this is the cleanest case.

Implementation-time check: variant patterns must compile against a **blank**
vocab (loader validation), so only vocab-independent attributes (TEXT, LOWER,
POS, IN) are used — all four rules satisfy this.

### French (9 non-consistency rules)

| Rule | Type | Content |
|---|---|---|
| `grammar/pleonasmes` | substitution | monter en haut→monter, descendre en bas→descendre, prévoir à l'avance→prévoir, au jour d'aujourd'hui→aujourd'hui, voire même→voire, comme par exemple→par exemple, puis ensuite→ensuite, s'avérer vrai→s'avérer |
| `grammar/pallier-a` | token_pattern | `{LEMMA: pallier}` + `{LOWER: {IN: [à, au, aux]}}` — pallier is transitive; message suggests dropping the preposition |
| `grammar/apres-que-subjonctif` | token_pattern | `{LOWER: après}` + `{LOWER: {IN: [que, qu']}}` + up to ~3 filler tokens + `{MORPH: {IS_SUPERSET: [Mood=Sub]}}` — après que takes the indicative. **Risk rule:** implementer must verify against live `fr_core_news_sm` that common subjunctives (soit, ait, fasse) get Mood=Sub; if precision is bad, fall back to a curated raw list (`après qu'il/elle/on soit`, `après que … ait été`, …) or drop with a spec-amendment note |
| `style/hype-mots` | existence, `pack: marketing` | révolutionnaire, incontournable, ultime, exceptionnel, inégalé, époustouflant |
| `style/affirmations-inverifiables` | existence, `pack: marketing` | numéro 1, leader mondial, le meilleur du marché, unique au monde — legal-risk framing like EN/JA counterparts |
| `style/inflation-exclamation` | existence/occurrence, `pack: marketing` | repeated `!` / `!!` — mirror the EN/JA exclamation-inflation shape |
| `style/hedging` | existence, `pack: techdocs` | il semble que, peut-être que, probablement, il se pourrait que |
| `style/langage-familier` | existence, `pack: techdocs` | truc, machin, ça marche, du coup |
| `style/cliches-ouverture` | existence, `pack: blog` | Depuis la nuit des temps, Force est de constater, Qui n'a jamais rêvé, Il était une fois (as opener cliché), De nos jours |

### Spanish (9 non-consistency rules)

| Rule | Type | Content |
|---|---|---|
| `grammar/queismo` | substitution | Deliberately narrow, high-precision keys: me di cuenta que→me di cuenta de que, a pesar que→a pesar de que, estoy seguro que→estoy seguro de que, estoy segura que→…, no cabe duda que→no cabe duda de que. Bare «seguro que» is legitimate colloquial and must NOT fire. Complements the existing `dequeismo.yml` (opposite error) |
| `grammar/haber-impersonal` | token_pattern | `{LOWER: {IN: [habían, habrían, habrán]}}` + `{POS: {IN: [DET, NUM, NOUN]}}` — existential haber is impersonal («había muchos problemas»); the POS gate keeps auxiliary uses («habían comido») from firing |
| `style/en-base-a` | substitution | en base a→con base en |
| `style/palabras-hype` | existence, `pack: marketing` | revolucionario, espectacular, imprescindible, inigualable, alucinante |
| `style/afirmaciones-inverificables` | existence, `pack: marketing` | número 1, líder del mercado, el mejor del mundo, único en el mundo |
| `style/inflacion-exclamacion` | existence/occurrence, `pack: marketing` | repeated `!`/`¡…!` inflation — include inverted mark handling in examples |
| `style/hedging` | existence, `pack: techdocs` | quizás, tal vez, creo que, me parece que, a lo mejor |
| `style/coloquialismos` | existence, `pack: techdocs` | un montón, cosa (as vague noun — narrow to «una cosa que» style keys if probing shows FPs), o sea |
| `style/cliches-apertura` | existence, `pack: blog` | Desde tiempos inmemoriales, Como todos sabemos, En la era digital, Hoy en día (opener) |

### Italian (9 non-consistency rules)

| Rule | Type | Content |
|---|---|---|
| `grammar/a-me-mi` | token_pattern | `{LOWER: a}` + `{LOWER: me}` + `{LOWER: mi}` — classic pleonastic doubling |
| `grammar/apostrofo-errato` | substitution | qual'è→qual è, qual'era→qual era, un pò→un po'. Verify tokenizer keeps `qual'è` matchable as plain-text substitution (substitution is regex-based on raw text, so tokenization is irrelevant — apostrophe variants (' vs ') must both be keyed or normalized) |
| `grammar/pleonasmi` | substitution | entrare dentro→entrare, uscire fuori→uscire, ma però is already covered by the existing `ma-pero.yml` — do not duplicate |
| `style/parole-hype` | existence, `pack: marketing` | rivoluzionario, imperdibile, straordinario, senza precedenti, incredibile |
| `style/affermazioni-inverificabili` | existence, `pack: marketing` | numero 1, leader di mercato, il migliore al mondo, unico al mondo |
| `style/inflazione-esclamativi` | existence/occurrence, `pack: marketing` | repeated `!` |
| `style/hedging` | existence, `pack: techdocs` | forse, credo che, mi sembra che, probabilmente, direi che |
| `style/colloquialismi` | existence, `pack: techdocs` | roba, un sacco di, tipo (as filler — narrow if probing shows FPs on legitimate "tipo di" uses; consider raw `\btipo\b(?! di)`) |
| `style/cliches-apertura` | existence, `pack: blog` | Fin dalla notte dei tempi, Al giorno d'oggi, Nell'era digitale, Come tutti sanno |

### Chinese (9 non-consistency rules)

All ZH existence/substitution keys are CJK and rely on `bounded_pattern`'s
edge-aware handling; raw regexes with lookaheads follow the JA
unverifiable-claims precedent where compound collisions exist.

| Rule | Type | Content |
|---|---|---|
| `grammar/de-di-de` | token_pattern | 的/地/得 confusion, **deliberately narrow**: reduplicated adverb + 的 + verb (e.g. 慢慢的走 → 慢慢地走). **Risk rule:** implementer must probe `zh_core_web_sm` tagging (的 as PART, reduplicated adverbs' POS) live; if the tagger can't support acceptable precision, fall back to a curated raw list of high-frequency errors (慢慢的+verb chars, 渐渐的, 悄悄的, 好好的+verb) or drop with a spec-amendment note |
| `style/dayue-zuoyou` | existence raw | `(大约\|大概\|约).{0,10}左右` — approximation stated twice; bounded gap keeps it sentence-local |
| `style/rongyu` | substitution | redundancies: 免费赠送→赠送, 提前预约→预约, 亲眼目睹→目睹, 涉及到→涉及, 凯旋归来→凯旋 |
| `style/xuanchuan-ci` | existence, `pack: marketing` | hype: 极致, 颠覆, 震撼, 尖端, 王牌 |
| `style/wufa-zhengshi` | existence/raw, `pack: marketing` | unverifiable claims: 全网第一, 史上最, 全球领先, 业界第一 — use lookaheads if probing finds legitimate compounds, per the JA precedent |
| `style/gantanhao-fanlan` | existence, `pack: marketing` | ！！ inflation (fullwidth), mirror JA exclamation-inflation |
| `style/hedging` | existence, `pack: techdocs` | 可能, 大概, 我觉得, 应该是, 或许 — probe 可能/大概 for FP rate in legitimate technical hedging ("可能值" etc.); narrow with lookarounds if needed |
| `style/yuqi-ci` | existence, `pack: techdocs` | casual sentence-final particles in docs: 啦, 哦, 呗, 嘛 — CJK-bounded; probe for collisions inside compounds (e.g. 哦 is rare in compounds; 嘛 check 干嘛) |
| `style/taoban-kaitou` | existence, `pack: blog` | cliché openers: 随着社会的发展, 众所周知, 在这个快节奏的时代, 随着科技的进步 |

## Seeding & profiles

In `app/services/seed_profiles.py`:

- `EXAMPLE_LANGUAGES = set(Language)` and `BLOG_LANGUAGES = set(Language)`
  (all seven languages get Marketing/TechDoc/Blog example profiles).
- Add fr/es/it/zh entries to `_MARKETING_INSTRUCTIONS`,
  `_TECHDOC_INSTRUCTIONS`, `_BLOG_INSTRUCTIONS` — native-language LLM
  instructions matching the EN/DE/JA entries' shape and intent (audience,
  preferred register, what to flag).
- Update the module docstring (currently names "EN, DE, JA").
- No schema or marker-table changes: `profile_seed_markers` +
  `_create_ignoring_collision` already make re-seeding safe per language.
  Existing installs get the new profiles on next startup because their
  fr/es/it/zh marker rows don't exist yet.

## Demo texts

Twelve new files: `backend/demos/{fr,es,it,zh}-{marketing,technical-documentation,blog}.txt`.
Each must:

- be a plausible, coherent text in the target language (marketing: product
  copy; techdocs: install/config instructions; blog: personal post);
- trip **every pack rule of its profile at least once** plus at least two
  general rules (including the consistency rule for at least one of the three
  texts per language);
- stay in the 500–1200 character range like the EN/DE/JA demos.

Existing `{lang}.txt` demos get a short appended paragraph exercising the new
general (non-pack) rules, mirroring what phase 2 did for `ja-*.txt`.

## Tests

- **Catalog tests** (existing machinery): every new YAML's `examples.bad`
  must fire and `examples.good` must not — free coverage for all 44 rules.
  NLP-typed rules' catalog examples run against the live spaCy models, which
  the test environment has installed.
- **Targeted live-model tests** (new, in `backend/tests/`): the 4 consistency
  rules (minority flagging in both directions, tie-break, silence below 2
  votes — pattern after `test_consistency.py`'s desu-masu tests but slimmer:
  2–3 tests per language) and the 2 morphology-dependent rules
  (`apres-que-subjonctif`, `haber-impersonal`: one must-fire, one
  must-not-fire each).
- `test_profiles.py::test_seed_pack_profiles` extended: all seven languages
  now have Marketing/TechDoc/Blog.
- **Review-time FP probing** (process, not committed tests): each language
  task's quality review probes ~100+ realistic sentences against the live
  model, per the phase-2 protocol that caught the JA compound collisions.

## Docs

- `backend/rules/README.md`: FR/ES/IT/ZH tables get the new rows with a Pack
  column (mirroring the JA table); a short "Romance & Chinese heuristic
  limitations" note covering plural-vous/ustedes, sentence-initial Lei, and
  the de-di-de narrowing.
- `docs/backend-architecture.md`: seeding section updated (all languages get
  example profiles); consistency-type paragraph notes it is now used by five
  rules across two script families.
- `docs/LOGBOOK.md`: consolidated phase-3 entry per convention.

## Risks & fallbacks

| Risk | Mitigation |
|---|---|
| `fr_core_news_sm` subjunctive tagging unreliable | Verified live during implementation; fallback to curated raw list or drop (documented in spec amendment) |
| `zh_core_web_sm` tagging too weak for 的/地/得 | Same protocol; fallback to curated raw patterns of high-frequency reduplicated-adverb errors |
| IT `Lei` sentence-initial ambiguity | Warning level + documented limitation; probing quantifies the FP rate before ship |
| Small-model POS errors causing haber-impersonal FPs | POS gate is conservative (DET/NUM/NOUN); probing validates |
| Apostrophe variants (U+0027 vs U+2019) in IT keys | Both variants keyed explicitly in `apostrofo-errato` |

## Implementation notes (phase 3)

Shipped in `f9b8293..0d70a8d` plus a follow-up doc-parity commit; 602 tests
green. Precision amendments made during review, all verified with live
false-positive probing (~480 probe sentences total) and documented in the
YAML headers and `rules/README.md`:

- **FR `affirmations-inverifiables`:** bare «numéro 1»/«n° 1» over-fired on
  addresses, issue numbers, and «priorité numéro 1»; replaced with qualified
  forms («numéro 1 du marché/mondial»). ES/IT shipped with qualified digit
  forms from the start for the same reason.
- **ES `tuteo-ustedeo`:** formal variant gate widened to
  `POS: {IN: [PRON, PROPN]}` — `es_core_news_sm` occasionally tags «Usted»
  PROPN in mixed-register contexts; the LOWER gate makes this loss-free. The
  IT `tu-lei` formal variant shipped with the same hardening.
- **ZH lookarounds:** `(?<!历)史上最` (factual 历史上最… prose collided with
  the advertising-law rule), `左右(?![了着])` (verb reading "to sway"),
  `(?<![不尽])可能(?!性)` and `大概(?![率念])` (不可能/尽可能/大概率 are not
  hedges). 大概 and 史上最 moved from `tokens` to `raw` accordingly.
- **ES/IT colloquialisms:** spec candidates «cosa» (ES) and «tipo» (IT)
  dropped as inseparable from neutral uses; ES gained «a tope».
- **ZH `ni-nin`:** 你/您 are *not* perfectly unambiguous — 迷你 can be
  mis-segmented in some contexts, yielding a standalone 你 token and a
  spurious informal vote. Documented as a low-frequency edge case.
- **ES pre-existing fix (adjacent):** `clarity.circunloquios` rendered its
  substitution message with the %s roles inverted; un-inverted during the
  Task 2 review. `es-blog.txt` also gained a queísmo sentence to meet the
  ≥2-general-rules demo requirement.
- FR `apres-que-subjonctif` and ZH `de-di-de` shipped as the spec'd NLP
  patterns — the live-model fallbacks were not needed (`Mood=Sub` and the
  DEV/DEC tag distinction held up under probing; `de-di-de` measured ~47%
  recall at 100% precision on its narrow subcase, accepted precision-first).

## Out of scope

- Engine changes of any kind (none are needed).
- Verb-conjugation-based register detection for FR/ES/IT consistency rules
  (pronoun/possessive tokens only in this phase).
- Terminology seeding for the new languages.
- Frontend changes (pack UI is slug-driven; nothing to do).
