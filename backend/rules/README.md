# Rule catalog

One YAML file per rule, under `<language>/<category>/<name>.yml`; the rule id is
`<category>.<name>`. Seven check types exist (see the [main README](../../README.md)
for the formalism): `existence`, `substitution`, `occurrence`, and `repetition`
run on regexes; `token_pattern`, `dependency`, and `consistency` run on the
language's spaCy pipeline and are skipped (and reported) when its model is not
installed. `occurrence` rules with `count: tokens` also need the model.

Every rule **requires** an `examples:` block (`bad`: sentences the rule must flag;
`good`: sentences it must not) — a file without one fails to load. These examples
are not decoration: they render on the rule's card in the Rules view (so the app is
self-documenting for end users too) and the whole catalog is run against its own
examples as a parametrized test (`backend/tests/test_rule_examples.py`), so the
catalog is self-testing as well as self-documenting.

Rules can optionally carry `pack: <slug>` to mark them as use-case rules: off by
default, and only active for a profile that has enabled that pack. Pack slugs are
free-form — they are discovered from whatever `pack:` values already appear in the
rule files (`GET /api/rules?language=…` returns the sorted set as `packs`), so adding
a new use-case pack is just dropping YAML files with a new slug; no code changes.
EN, DE, and JA currently ship three: `marketing`, `techdocs`, `blog`.

Rules marked **NLP** need the spaCy model. The *Demonstrates* column makes this
catalog double as a cookbook for writing your own rules.

`existence` `tokens:` and `substitution` keys are wrapped in CJK-edge-aware word
boundaries (`bounded_pattern` in `app/checkers/rules/text.py`): a side whose
literal edge character is CJK (Han, kana, CJK punctuation, full-width forms)
drops its `\b` — kana/kanji count as `\w`, so a boundary there would never fire
mid-sentence — while Latin-edged sides keep `\b`. Only literal edge characters
are inspected: a key whose edge is a regex metachar (e.g. an alternation group
like `ja/grammar/sa-ire.yml`'s `(?:行か|読ま|…)させ`) keeps its `\b` and would
never match after a kana character; such patterns belong in `raw:`, which is
never wrapped. Empty `tokens`/`raw` entries and empty `swap` keys are rejected
as rule errors at load time.

## Check type: consistency

Unlike the other check types, `consistency` classifies whole sentences rather
than matching a pattern per finding, and it's document-scoped: it looks at
every sentence in the document together and flags whichever style is in the
minority.

Each rule declares two or more named `variants:`. A variant is either:

- a **pattern variant** — `pattern:` is a spaCy `Matcher` pattern (same syntax
  as `token_pattern`), tested against every sentence. Variants are tried in
  YAML declaration order, and that order is both the priority (the first
  variant whose pattern matches a sentence claims it) and the tie-break (if
  the document ends up split evenly between two variants, the first-declared
  one is treated as the majority);
- the single, optional **default variant** (`default: true`) — claims any
  sentence that no pattern variant matched but that still ends in a
  predicate (`VERB`/`ADJ`/`AUX`); sentences with no predicate ending
  (headings, labels, 体言止め) stay unclassified and don't vote. A default
  variant must not set `pattern` or `anchor` — loading fails otherwise.

`anchor: end` (the alternative to the default `anchor: anywhere`) requires the
match to end within the last 3 tokens of the sentence, after stripping
trailing punctuation/symbols/final particles (`PUNCT`/`SYM`/`PART`/whitespace).
This window exists because GiNZA splits some polite endings into two tokens
— 〜ました → まし+た, 〜でしょう → でしょ+う — so the match itself doesn't reach
the literal last token.

Once every sentence is classified, the variant with the most sentences is the
majority; every sentence belonging to any other populated variant is flagged
individually. A document where only one variant (or none) is populated
produces no findings. Because at least two differently-classified sentences
are needed to demonstrate a mismatch, a `consistency` rule's `bad:` examples
must be multi-sentence strings — a single sentence can't mix styles.

Loading fails if: fewer than two variants are declared; more than one variant
sets `default: true`; a default variant sets `pattern` or `anchor`; or a
non-default variant has no `pattern`.

Known limitation: a quoted sentence that GiNZA segments into its own sentence
span is classified by its own internal register, not the surrounding
narration's — dialogue-heavy documents may see an intentionally
different-register quote flagged against the narration's dominant style.

The cookbook example, from `ja/style/desu-masu.yml` (敬体/常体 — polite vs.
plain register consistency):

```yaml
extends: consistency
message: "文体が混在しています — 敬体（です・ます）と常体（だ・である）のどちらかに統一してください。"
level: warning
category: style
variants:
  polite:
    pattern:
      - {TEXT: {IN: [です, でし, でしょ, でしょう, ます, まし, ませ, ましょ, ましょう, ください]}, POS: {IN: [AUX, VERB]}}
    anchor: end
  plain:
    default: true
examples:
  bad:
    - "本製品は高速です。設定も簡単だ。導入も容易です。"
  good:
    - "本製品は高速です。設定も簡単です。"
    - "本製品は高速だ。設定も簡単である。"
    - "資料をご確認ください。ご質問があればお知らせください。よろしくお願いします。"
    - "明日は晴れるでしょう。遠足は決行します。"
```

## English (`en`)

| Rule | Type | Flags | Pack | Demonstrates |
|---|---|---|---|---|
| [style.weasel-words](en/style/weasel-words.yml) | existence | vague intensifiers ("very", "somewhat", "a number of") | — | word/phrase lists with `ignorecase` |
| [style.exclamations](en/style/exclamations.yml) | existence | stacked exclamation marks ("!!") | — | `raw` verbatim-regex tokens |
| [style.nominalizations](en/style/nominalizations.yml) | token_pattern, **NLP** | "made a decision" instead of "decided" | — | `LEMMA` + optional `DET` + word set |
| [style.passive-voice](en/style/passive-voice.yml) | dependency, **NLP** | "was written by the team" | — | syntax-tree match on `auxpass` |
| [style.split-infinitive](en/style/split-infinitive.yml) | token_pattern, **NLP** | "to quickly finish" | — | `TAG`+`POS` mix with `OP: "+"` |
| [grammar.article-an](en/grammar/article-an.yml) | token_pattern, **NLP** | "an presentation" | — | `REGEX` text condition |
| [grammar.repeated-words](en/grammar/repeated-words.yml) | repetition | "it is is fine" | — | adjacent-duplicate detection |
| [clarity.wordiness](en/clarity/wordiness.yml) | substitution | "utilize" → "use", "in order to" → "to" | — | swap map with one-click fixes |
| [clarity.long-sentence](en/clarity/long-sentence.yml) | occurrence | sentences over 30 words | — | per-sentence regex counting |
| [vividness.cliches](en/vividness/cliches.yml) | existence | "at the end of the day", "think outside the box" | — | multi-word phrases |
| [vividness.expletive-opener](en/vividness/expletive-opener.yml) | token_pattern, **NLP** | "There are…" openers | — | `DEP` label on a token |
| [clarity.negative-phrasing](en/clarity/negative-phrasing.yml) | substitution | "not able to" → "unable to", "not sure" → "unsure" | — | positive-phrasing swap map (same mechanism as wordiness, applied to negation) |
| [clarity.noun-string](en/clarity/noun-string.yml) | token_pattern, **NLP** | "server configuration management system update" | — | `{4,}` quantifier + greedy `LONGEST` matching |
| [grammar.based-off](en/grammar/based-off.yml) | substitution | "based off (of)" instead of "based on" | — | optional group inside a swap-map key (`( of)?`) |
| [grammar.could-of](en/grammar/could-of.yml) | substitution | "should of" instead of "should have" | — | negative lookahead in a swap key guards an idiom (`(?!\s+(?:course\|necessity))`) |
| [grammar.dangling-participle](en/grammar/dangling-participle.yml) | token_pattern, **NLP** | "Walking home, it started to rain." | — | `IS_SENT_START` + bounded non-punct gap |
| [grammar.fewer-less](en/grammar/fewer-less.yml) | token_pattern, **NLP** | "less bugs" instead of "fewer bugs" | — | `MORPH` number agreement |
| [style.condescension](en/style/condescension.yml) | existence | "simply", "obviously", "needless to say" | techdocs | pack-scoped word/phrase list |
| [style.double-negative](en/style/double-negative.yml) | token_pattern, **NLP** | "not uncommon", "not impossible" | — | `REGEX` + `NOT_IN` on one attribute |
| [style.future-tense-instruction](en/style/future-tense-instruction.yml) | token_pattern, **NLP** | "The dialog will open." | techdocs | plain `LOWER`+`POS` pair, no gap needed |
| [style.hedging](en/style/hedging.yml) | existence | "arguably", "it seems that", "to some extent" | — | multi-word phrase list |
| [style.hype-words](en/style/hype-words.yml) | existence | "world-class", "revolutionary", "seamless" | marketing | pack-scoped word list |
| [style.latin-abbreviations](en/style/latin-abbreviations.yml) | existence | "e.g.", "i.e.", "etc." | techdocs | `raw` regex where a substitution's `\b…\b` boundary would never match after a period |
| [style.shouting-caps](en/style/shouting-caps.yml) | existence | consecutive 4+-letter all-caps words | marketing | `raw` regex with a repeated group (`(?:…){4,}(?:\s+…){4,})+`) |
| [style.third-person-user](en/style/third-person-user.yml) | token_pattern, **NLP** | "The user should click the Save button." | techdocs | `LEMMA` sets chained across three tokens |
| [style.throat-clearing](en/style/throat-clearing.yml) | existence | "In this post, we will…", "Let's dive in!" | blog | pack-scoped phrase list |
| [style.unverifiable-claims](en/style/unverifiable-claims.yml) | existence | "guaranteed", "award-winning", "#1" | marketing | `tokens` and `raw` combined in one rule |
| [style.very-unique](en/style/very-unique.yml) | substitution | "very unique" → "unique" | marketing | alternation inside a single swap-map key (`(?:very\|completely\|totally\|most)`) |
| [style.weak-verb-adverb](en/style/weak-verb-adverb.yml) | dependency, **NLP** | "ran quickly" instead of "sprinted" | — | `DependencyMatcher` `advmod` |

## German (`de`)

| Rule | Type | Flags | Pack | Demonstrates |
|---|---|---|---|---|
| [style.fuellwoerter](de/style/fuellwoerter.yml) | existence | Füllwörter („halt“, „quasi“, „im Grunde“) | — | word/phrase lists |
| [style.anglizismen](de/style/anglizismen.yml) | substitution | Anglizismen („gecancelt“ → „abgesagt“) | — | swap map |
| [style.passiv](de/style/passiv.yml) | token_pattern, **NLP** | „wurde … geschrieben“ | — | `OP: "{,4}"` gap between tokens |
| [style.wuerde-stil](de/style/wuerde-stil.yml) | token_pattern, **NLP** | „würde … annehmen“ statt Konjunktiv II | — | `MORPH` (`Mood=Sub`) + `OP` gap |
| [grammar.doppelte-woerter](de/grammar/doppelte-woerter.yml) | repetition | „ist ist“ | — | adjacent duplicates |
| [grammar.einzigste](de/grammar/einzigste.yml) | substitution | „einzigste“ → „einzige“ | — | inflected error forms in a swap map |
| [clarity.lange-saetze](de/clarity/lange-saetze.yml) | occurrence | Sätze mit mehr als 30 Wörtern | — | per-sentence word counting |
| [clarity.schachtelsaetze](de/clarity/schachtelsaetze.yml) | occurrence | mehr als drei Kommas pro Satz | — | counting arbitrary regexes (commas) |
| [clarity.genitivkette](de/clarity/genitivkette.yml) | token_pattern, **NLP** | „Prüfung der Umsetzung der Vorgaben der Behörde“ | — | optional tokens (`OP: "?"`) inside a rigid sequence |
| [clarity.verbklammer](de/clarity/verbklammer.yml) | token_pattern, **NLP** | weite Verbklammer, Verbpartikel weit vom Verb getrennt | — | `{8,}` gap to `PTKVZ` |
| [grammar.beliebte-fehler](de/grammar/beliebte-fehler.yml) | substitution | „Standart“ → „Standard“, „wiederspiegeln“ → „widerspiegeln“ | — | swap map of common misspellings |
| [grammar.das-dass](de/grammar/das-dass.yml) | token_pattern, **NLP** | „Ich hoffe, das er kommt.“ | — | lemma-list + `PRON` gate heuristic |
| [grammar.deppenapostroph](de/grammar/deppenapostroph.yml) | existence | „Anna's Laden“ | — | `raw` regex with a negative-lookahead contraction stoplist |
| [grammar.seit-seid](de/grammar/seit-seid.yml) | existence | „Seit ihr mit der Installation fertig?“ | — | `raw` regex narrowed to a question form (trailing `?`) plus a capitalization-based negative lookahead |
| [grammar.wie-als](de/grammar/wie-als.yml) | token_pattern, **NLP** | „schneller wie der alte“ | — | `MORPH` `Degree=Cmp` |
| [style.amtsdeutsch](de/style/amtsdeutsch.yml) | substitution | „zwecks“ → „für“, „mittels“ → „mit“ | — | swap map of bureaucratic phrases |
| [style.bitte-in-anleitungen](de/style/bitte-in-anleitungen.yml) | existence | „Bitte klicken Sie auf Speichern.“ | techdocs | pack-scoped single-token list |
| [style.doppelmoppel](de/style/doppelmoppel.yml) | existence | „bereits schon“, „einzig und allein“ | — | tautology phrase list |
| [style.e-mail-schreibung](de/style/e-mail-schreibung.yml) | substitution | „Email“ → „E-Mail“ | techdocs | case-sensitive substitution (protects code-context "email") |
| [style.floskel-einstieg](de/style/floskel-einstieg.yml) | existence | „In diesem Beitrag zeige ich euch…“ | blog | pack-scoped phrase list |
| [style.funktionsverbgefuege](de/style/funktionsverbgefuege.yml) | token_pattern, **NLP** | „Die Anmeldung erfolgt über das Portal.“ | — | `TEXT` `REGEX` + `OP` gap |
| [style.futur-in-anleitungen](de/style/futur-in-anleitungen.yml) | token_pattern, **NLP** | „Der Assistent wird die Einstellungen speichern.“ | techdocs | `MORPH` `Mood`/`Tense` + gap |
| [style.hype-anglizismen](de/style/hype-anglizismen.yml) | existence | „State of the Art“, „Game Changer“ | marketing | pack-scoped phrase list |
| [style.man-konstruktion](de/style/man-konstruktion.yml) | token_pattern, **NLP** | „Man klickt anschließend auf OK.“ | techdocs | plain `LOWER`+`POS` pair |
| [style.superlativ-inflation](de/style/superlativ-inflation.yml) | existence | „einzigartig“, „revolutionär“, „unschlagbar“ | marketing | raw stems + `\w*` (a `\b…\b`-wrapped token would miss inflected forms) |

### Known heuristic limitations

A few of the new rules above are deliberately approximate heuristics, not
guaranteed-precision parsers; each trades occasional false positives/negatives for
staying simple and fast. Known gaps, from review:

- **clarity.noun-string** can misfire when `en_core_web_sm` mistags a verb as `NOUN`
  (e.g. "stores" in "The user profile stores preferences."), creating a false 4-noun run.
- **grammar.dangling-participle** flags sentence adverbials that are actually tolerated
  ("Considering the results, it…" reads fine but matches the pattern).
- **style.double-negative**'s prefix guard list (words like "important", "intuitive"
  that start with a negative-looking prefix but aren't negations) is inherently a
  finite stoplist, so an uncommon un-prefixed word can still slip through as a false hit.
- **style.weak-verb-adverb** catches any `-ly` adverb on the watched verbs, including
  non-manner adverbs that aren't really weak-verb padding.
- **style.future-tense-instruction** also fires on genuine future-tense statements
  (roadmap language like "This feature will support X next quarter"), not just
  present-tense UI descriptions it should nudge.
- **style.shouting-caps** flags any run of consecutive 4+-letter all-caps words,
  including legitimate acronym strings ("Use the HTTP API to fetch results" is in the
  rule's own `good` example precisely because 3-letter acronyms escape, but longer
  consecutive acronyms would not).
- **grammar.deppenapostroph** cannot distinguish a genitive apostrophe error from a
  brand name that is genuinely spelled with an apostrophe (e.g. "McDonald's") — both
  are capitalized stems followed by `'s`.
- **grammar.das-dass** leaks on extended participle constructions where a complement
  verb precedes a comma and a genuine relative/article "das" happens to be followed by
  a pronoun-tagged word.

## French (`fr`)

| Rule | Type | Flags | Pack | Demonstrates |
|---|---|---|---|---|
| [style.mots-flous](fr/style/mots-flous.yml) | existence | mots flous (« très », « plutôt ») | — | word lists |
| [style.voix-passive](fr/style/voix-passive.yml) | dependency, **NLP** | « a été écrit par… » | — | UD relation `aux:pass` |
| [grammar.mots-repetes](fr/grammar/mots-repetes.yml) | repetition | mots doublés | — | adjacent duplicates |
| [grammar.malgre-que](fr/grammar/malgre-que.yml) | substitution | « malgré que » → « bien que » | — | contested-usage fix |
| [clarity.phrase-longue](fr/clarity/phrase-longue.yml) | occurrence | phrases de plus de 30 mots | — | per-sentence word counting |
| [clarity.lourdeurs](fr/clarity/lourdeurs.yml) | substitution | « au niveau de », « suite à » | — | swap map |
| [vividness.cliches](fr/vividness/cliches.yml) | existence | « au bout du compte » | — | multi-word phrases |
| [grammar.pleonasmes](fr/grammar/pleonasmes.yml) | substitution | « au jour d'aujourd'hui », « voire même » | — | swap map over fixed pléonasme strings |
| [grammar.pallier-a](fr/grammar/pallier-a.yml) | token_pattern, **NLP** | « pallier à ce problème » | — | bare `LEMMA` match, no `POS` gate (mistagged infinitive) |
| [grammar.apres-que-subjonctif](fr/grammar/apres-que-subjonctif.yml) | token_pattern, **NLP** | « après qu'il soit parti » | — | `MORPH: {IS_SUPERSET: [Mood=Sub]}` with an `{0,3}` wildcard bridge |
| [grammar.tutoiement-vouvoiement](fr/grammar/tutoiement-vouvoiement.yml) | consistency, **NLP** | tu/te/ton… vs vous/votre… mixed across sentences | — | POS-gated variants (`PRON`/`DET`) disambiguate homographs like the noun « ton » |
| [style.hype-mots](fr/style/hype-mots.yml) | existence | « révolutionnaire », « incontournable » | marketing | pack-scoped word list |
| [style.affirmations-inverifiables](fr/style/affirmations-inverifiables.yml) | existence | « numéro 1 du marché », « leader mondial » | marketing | multi-word phrase list, legal-risk framing |
| [style.inflation-exclamation](fr/style/inflation-exclamation.yml) | existence | « !! » | marketing | `raw` regex (`!{2,}`) |
| [style.hedging](fr/style/hedging.yml) | existence | « il semble que », « peut-être que » | techdocs | phrase list |
| [style.langage-familier](fr/style/langage-familier.yml) | existence | « truc », « du coup », « ça marche » | techdocs | word/phrase list |
| [style.cliches-ouverture](fr/style/cliches-ouverture.yml) | existence | « depuis la nuit des temps », « de nos jours » | blog | phrase list |

### Known heuristic limitations

- **grammar.pleonasmes** matches literal invariant strings, so conjugated
  variants of the verb-based entries (e.g. « il est monté en haut ») escape;
  the fixed-form keys (« au jour d'aujourd'hui », « voire même », « comme par
  exemple », « puis ensuite ») carry the rule's recall.
- **grammar.pallier-a** has no `POS` constraint: `fr_core_news_sm` mistags the
  infinitive « pallier » as `ADJ` in « il faut pallier à … » but keeps its
  lemma, so bare `LEMMA` is the only reliable signal. The homograph « palier »
  (landing/threshold, single l) has a distinct lemma and cannot collide.
  Known recall gap: passé simple « pallia » escapes (the model does not
  lemmatize it to « pallier ») — accepted.
- **style.affirmations-inverifiables** only flags « numéro 1 »/« n° 1 » in
  their qualified market-claim forms (« … du marché », « … mondial »): the
  bare phrase is everyday French (addresses, magazine issues, bus lines,
  « priorité numéro 1 ») and would over-fire at warning level.
- **grammar.apres-que-subjonctif** only checks subjunctive morphology within
  3 tokens of « après que/qu' », to bridge short subject NPs without reaching
  into an unrelated clause; both straight and typographic apostrophes are
  listed because the tokenizer keeps « qu' » as one token either way.
- **grammar.tutoiement-vouvoiement** treats any impersonal/plural « vous » as
  a formal-register vote — it cannot distinguish plural addressees from the
  singular formal « vous ».

## Spanish (`es`)

| Rule | Type | Flags | Pack | Demonstrates |
|---|---|---|---|---|
| [style.muletillas](es/style/muletillas.yml) | existence | muletillas («muy», «básicamente») | — | word lists |
| [style.voz-pasiva](es/style/voz-pasiva.yml) | token_pattern, **NLP** | «fue escrito por…» | — | `MORPH` participle after lemma *ser* |
| [grammar.palabras-repetidas](es/grammar/palabras-repetidas.yml) | repetition | palabras dobladas | — | adjacent duplicates |
| [grammar.dequeismo](es/grammar/dequeismo.yml) | token_pattern, **NLP** | «pienso de que» | — | lemma sets (`LEMMA: {IN: […]}`) |
| [clarity.frase-larga](es/clarity/frase-larga.yml) | occurrence | frases de más de 30 palabras | — | per-sentence word counting |
| [clarity.circunloquios](es/clarity/circunloquios.yml) | substitution | «en base a» → «según» | — | swap map |
| [vividness.cliches](es/vividness/cliches.yml) | existence | «al fin y al cabo» | — | multi-word phrases |
| [grammar.queismo](es/grammar/queismo.yml) | substitution | «me di cuenta que», «a pesar que» | — | narrow high-precision swap keys (queísmo, opposite of dequeísmo) |
| [grammar.haber-impersonal](es/grammar/haber-impersonal.yml) | token_pattern, **NLP** | «habían muchos problemas» | — | `POS`-gated (`DET`/`NUM`/`NOUN`) impersonal-*haber* check |
| [grammar.tuteo-ustedeo](es/grammar/tuteo-ustedeo.yml) | consistency, **NLP** | tú/te/tu… vs usted/ustedes mixed across sentences | — | POS-gated variants (`PRON`/`DET`) disambiguate tú-clitics from possessives |
| [style.en-base-a](es/style/en-base-a.yml) | substitution | «en base a» → «con base en» | — | RAE-recommended-form swap |
| [style.palabras-hype](es/style/palabras-hype.yml) | existence | «revolucionaria», «imprescindible» | marketing | pack-scoped word list |
| [style.afirmaciones-inverificables](es/style/afirmaciones-inverificables.yml) | existence | «número 1 del mercado», «líder del mercado» | marketing | multi-word phrase list, legal-risk framing |
| [style.inflacion-exclamacion](es/style/inflacion-exclamacion.yml) | existence | «¡¡ … !!» | marketing | `raw` regex (`[!¡]{2,}`) |
| [style.hedging](es/style/hedging.yml) | existence | «quizás», «tal vez» | techdocs | word/phrase list |
| [style.coloquialismos](es/style/coloquialismos.yml) | existence | «un montón», «o sea» | techdocs | word/phrase list |
| [style.cliches-apertura](es/style/cliches-apertura.yml) | existence | «desde tiempos inmemoriales», «hoy en día» | blog | phrase list |

### Known heuristic limitations

- **grammar.queismo** matches only a fixed set of high-precision phrases
  (« me di cuenta que », « a pesar que », « estoy segur[oa] que », « no
  cabe duda que »); bare « seguro que » is deliberately excluded because
  it is legitimate colloquial Spanish and would over-fire.
- **grammar.haber-impersonal** relies on the next token's `POS` (`DET`,
  `NUM`, or `NOUN`) to distinguish existential « habían muchos » from
  auxiliary « habían comido » (next token `VERB`). Verified against
  `es_core_news_sm`: "Habían muchos" → muchos/DET, "Habían tres" →
  tres/NUM, "habían comido" → comido/VERB.
- **grammar.tuteo-ustedeo** excludes possessive « su/sus » from the
  formal vote because it is third-person-ambiguous (could refer to
  someone other than the addressee); formal detection leans on
  usted/ustedes only. The formal variant admits `PROPN` alongside `PRON`
  because `es_core_news_sm` occasionally mistags « Usted » as `PROPN` in
  mixed-register contexts — the `LOWER` gate (usted/ustedes only) makes
  this loss-free. Known limitation: « ustedes » is also the plural
  of « tú » in Latin American Spanish and always votes as formal.
- **style.afirmaciones-inverificables** only flags « número 1 » in its
  qualified market-claim forms (« … del mercado », « … mundial »): the
  bare phrase is everyday Spanish (addresses, priorities, issue
  numbers — « prioridad número 1 ») and would over-fire at warning
  level.
- **style.en-base-a** and **clarity.circunloquios** both match « en base
  a »: the former flags it as an RAE-disallowed form (style pack,
  suggesting « con base en »), the latter as a wordy circumlocution
  (clarity pack, suggesting « según »). Both fire together by design —
  they address different concerns for the same phrase.

## Italian (`it`)

| Rule | Type | Flags | Pack | Demonstrates |
|---|---|---|---|---|
| [style.parole-vaghe](it/style/parole-vaghe.yml) | existence | parole vaghe («molto», «praticamente») | — | word lists |
| [style.forma-passiva](it/style/forma-passiva.yml) | dependency, **NLP** | «è stato scritto», «viene scritto» | — | `aux:pass` covering *essere* and *venire* |
| [grammar.parole-ripetute](it/grammar/parole-ripetute.yml) | repetition | parole doppie | — | adjacent duplicates |
| [grammar.ma-pero](it/grammar/ma-pero.yml) | substitution | «ma però» → «ma» | — | redundancy fix |
| [clarity.frase-lunga](it/clarity/frase-lunga.yml) | occurrence | frasi di oltre 30 parole | — | per-sentence word counting |
| [clarity.burocratese](it/clarity/burocratese.yml) | substitution | «al fine di» → «per» | — | swap map |
| [vividness.cliches](it/vividness/cliches.yml) | existence | «alla fine dei conti» | — | multi-word phrases |
| [grammar.a-me-mi](it/grammar/a-me-mi.yml) | token_pattern, **NLP** | «a me mi piace» | — | fixed 3-token `LOWER` pattern, pleonastic clitic doubling |
| [grammar.apostrofo-errato](it/grammar/apostrofo-errato.yml) | substitution | «qual'è» → «qual è», «un pò» → «un po'» | — | swap map keying both straight and typographic apostrophes |
| [grammar.pleonasmi](it/grammar/pleonasmi.yml) | substitution | «entrare dentro», «uscire fuori» | — | swap map over fixed verb forms |
| [grammar.tu-lei](it/grammar/tu-lei.yml) | consistency, **NLP** | tu/ti/tuo… vs Lei/Le/La mixed across sentences | — | POS-gated variants (`PRON`/`DET` informal, `PRON`/`PROPN` formal) |
| [style.parole-hype](it/style/parole-hype.yml) | existence | «rivoluzionario», «imperdibile» | marketing | pack-scoped word list |
| [style.affermazioni-inverificabili](it/style/affermazioni-inverificabili.yml) | existence | «numero 1 del mercato», «leader di mercato» | marketing | multi-word phrase list, legal-risk framing |
| [style.inflazione-esclamativi](it/style/inflazione-esclamativi.yml) | existence | «!!» | marketing | `raw` regex (`!{2,}`) |
| [style.hedging](it/style/hedging.yml) | existence | «forse», «credo che» | techdocs | word/phrase list |
| [style.colloquialismi](it/style/colloquialismi.yml) | existence | «roba», «un sacco di» | techdocs | word/phrase list |
| [style.cliches-apertura](it/style/cliches-apertura.yml) | existence | «fin dalla notte dei tempi», «al giorno d'oggi» | blog | phrase list |

### Known heuristic limitations

- **grammar.apostrofo-errato** keys both the straight (`'`) and typographic
  (`’`) apostrophe for the elided « qual'è »/« qual'era » forms — substitution
  matches raw text, so tokenization does not matter, but both glyphs must be
  listed since real text uses either.
- **grammar.pleonasmi** matches only fixed infinitive and third-person-
  singular forms (« entrare dentro », « entra dentro », « uscire fuori »,
  « esce fuori »); other conjugations escape — an accepted recall limitation,
  the same trade-off as the French/Spanish pleonasm rules.
- **grammar.tu-lei** gates the formal variant on `TEXT: {IN: [Lei, Le, La]}`
  with `POS: {IN: [PRON, PROPN]}` — verified live against `it_core_news_sm`:
  « La ringrazio » tags La/PRON, « La casa » tags La/DET (article, excluded
  by the gate), and PROPN is included because small models occasionally
  mistag courtesy pronouns in mixed-register contexts (the literal-TEXT gate
  makes that addition loss-free). Known limitations: sentence-initial
  Lei/Le/La meaning "she/her/it" is capitalized by position and still votes
  formal; enclitic courtesy forms (« informarLa ») collapse into a single
  PROPN token and are not detected (recall gap, accepted).
- **style.affermazioni-inverificabili** only flags « numero 1 » in its
  qualified market-claim forms (« … del mercato », « … al mondo »): the bare
  phrase is everyday Italian (addresses, issue numbers, « priorità numero 1 »)
  and would over-fire at warning level.

## Japanese (`ja`)

| Rule | Type | Flags | Pack | Demonstrates |
|---|---|---|---|---|
| [style.redundant-potential](ja/style/redundant-potential.yml) | token_pattern, **NLP** | 「〜することができる」→「〜できる」 | — | GiNZA lemmas in patterns |
| [style.double-negative](ja/style/double-negative.yml) | token_pattern, **NLP** | 「〜ないことはない」 | — | `LEMMA`+`TEXT` mix for fixed expressions |
| [style.mazu-saisho](ja/style/mazu-saisho.yml) | token_pattern, **NLP** | 「まず最初に」 | — | static `suggestions` on token rules |
| [clarity.long-sentence](ja/clarity/long-sentence.yml) | occurrence (`count: tokens`), **NLP** | 50トークン超の文 | — | token counting where `\b\w+\b` fails |
| [clarity.touten-kajou](ja/clarity/touten-kajou.yml) | occurrence | 読点（、）が4個超の文 | — | regex counting works for CJK punctuation |
| [grammar.ranuki](ja/grammar/ranuki.yml) | token_pattern, **NLP** | 「見れる」「食べれる」など、融合トークンのら抜き言葉 | — | curated `LEMMA` list, no `POS` constraint |
| [grammar.ranuki-split](ja/grammar/ranuki-split.yml) | token_pattern, **NLP** | 一段動詞語幹+れる（AUX）に分割されたら抜き言葉 | — | sibling rule covering the split-token analysis |
| [grammar.sa-ire](ja/grammar/sa-ire.yml) | existence | 「休まさせて」などのさ入れ言葉 | — | curated `raw` godan-stem list |
| [grammar.nijuu-keigo](ja/grammar/nijuu-keigo.yml) | existence | 「ご覧になられ」などお/ご〜になられる二重敬語 | — | curated `raw` list dodges a legitimate single-敬語 collision |
| [grammar.nijuu-keigo-honorific](ja/grammar/nijuu-keigo-honorific.yml) | token_pattern, **NLP** | 「おっしゃられました」など尊敬語+れるの二重敬語 | — | honorific `LEMMA` list + AUX れる |
| [clarity.no-renzoku](ja/clarity/no-renzoku.yml) | token_pattern, **NLP** | 「の」が3回以上連続する名詞句 | — | `NOUN`+の chain repeated three times |
| [style.wo-okonau](ja/style/wo-okonau.yml) | token_pattern, **NLP** | 「検討を行う」→「検討する」 | — | `TAG` match on サ変可能名詞 |
| [style.juufuku-hyougen](ja/style/juufuku-hyougen.yml) | substitution | 「一番最初」「まだ未定で」など重複表現 | — | CJK-edged swap keys narrowed to dodge substring collisions (未定義 etc.) |
| [style.redundant-phrases](ja/style/redundant-phrases.yml) | substitution | 「することが可能です」→「できます」 | — | fixed-string swap map beyond token-level rules |
| [style.desu-masu](ja/style/desu-masu.yml) | consistency, **NLP** | 敬体・常体の混在 | — | variant classification with `anchor: end` and a `default` variant |
| [style.hype-words](ja/style/hype-words.yml) | existence | 「究極」「最強」などの誇張表現 | marketing | pack-scoped word list |
| [style.unverifiable-claims](ja/style/unverifiable-claims.yml) | existence | 「日本一」「業界No.1」など根拠のない優位性主張 | marketing | `raw` regex with negative lookaheads guarding compound collisions |
| [style.exclamation-inflation](ja/style/exclamation-inflation.yml) | existence | 感嘆符の連続（！！） | marketing | `raw` regex over full/half-width exclamation marks |
| [style.i-nuki](ja/style/i-nuki.yml) | token_pattern, **NLP** | 「〜してる」などのい抜き言葉 | techdocs | AUX-only `LEMMA` set avoids the homograph verb 出る |
| [style.hedging](ja/style/hedging.yml) | token_pattern, **NLP** | 「〜と思います」などの断定回避 | techdocs | fixed `TEXT`+`LEMMA` pair spanning voice/polarity variants |
| [style.casual-contractions](ja/style/casual-contractions.yml) | token_pattern, **NLP** | 「〜しとく」「〜しちゃう」などの縮約形 | techdocs | rendaku-paired `LEMMA` set |
| [style.kotatsu-cliche](ja/style/kotatsu-cliche.yml) | existence | 「いかがでしたか」などの定型導入・締めくくり | blog | pack-scoped phrase list |

### Known heuristic limitations

- **grammar.ranuki** / **grammar.ranuki-split** / **grammar.sa-ire** /
  **grammar.nijuu-keigo** / **grammar.nijuu-keigo-honorific** all rely on
  curated verb/lemma lists rather than a general morphological rule, so recall
  is limited to the forms listed. GiNZA's tokenization of ら抜き verbs is
  itself context-dependent — some inputs fuse the whole verb+れる into a
  single token carrying a ら抜き lemma, others split it into stem + れる
  (AUX) — which is why ら抜き needs two sibling rules (`ranuki` for the
  fused analysis, `ranuki-split` for the split one) instead of one pattern.
- **style.desu-masu** classifies a standalone quoted sentence (one GiNZA
  segments into its own sentence span) by its own internal register, not the
  surrounding narration's — a document that otherwise commits to one style
  consistently may still see an intentionally different-register quote
  flagged as the minority.
- **style.hype-words**, **style.unverifiable-claims**, and
  **style.exclamation-inflation**'s word/phrase lists are precision-first
  curated sets, not exhaustive — extend them as new marketing clichés or
  unverifiable-claim patterns turn up in practice.
- **style.juufuku-hyougen**'s まだ未定 key is narrowed to まだ未定で/まだ未定だ
  (i.e. it requires a で/だ continuation) specifically so it can never fire
  inside 未定義 ("undefined"), a common techdocs term that contains 未定 as a
  substring.

## Chinese (`zh`)

| Rule | Type | Flags | Pack | Demonstrates |
|---|---|---|---|---|
| [style.filler](zh/style/filler.yml) | token_pattern, **NLP** | 填充词（基本上、众所周知） | — | `TEXT: {IN: […]}` (zh model has no lemmas) |
| [style.jinxing](zh/style/jinxing.yml) | token_pattern, **NLP** | “进行(了)+名词”（如“进行讨论”→“讨论”） | — | optional token (`OP: "?"` for 了) |
| [clarity.long-sentence](zh/clarity/long-sentence.yml) | occurrence (`count: tokens`), **NLP** | 超过 40 个词的句子 | — | token counting |
| [clarity.douhao-guoduo](zh/clarity/douhao-guoduo.yml) | occurrence | 逗号超过 5 个的句子 | — | regex counting for CJK punctuation |
| [grammar.de-di-de](zh/grammar/de-di-de.yml) | token_pattern, **NLP** | “慢慢的走”应作“慢慢地走” | — | fine-grained `TAG: DEV` catches the tagger's own adverbial reading of 的 |
| [grammar.ni-nin](zh/grammar/ni-nin.yml) | consistency, **NLP** | 你/你们 vs 您 混用 | — | plain `TEXT` variants, no POS gate needed |
| [style.dayue-zuoyou](zh/style/dayue-zuoyou.yml) | existence | “大约……左右” 约数重复 | — | `raw` regex with a bounded same-clause gap |
| [style.rongyu](zh/style/rongyu.yml) | substitution | “免费赠送”→“赠送”，“涉及到”→“涉及” | — | CJK-edged swap map |
| [style.xuanchuan-ci](zh/style/xuanchuan-ci.yml) | existence | “极致”“颠覆”“震撼” | marketing | pack-scoped word list |
| [style.wufa-zhengshi](zh/style/wufa-zhengshi.yml) | existence | “全网第一”“史上最” | marketing | phrase list plus a `raw` lookbehind (`(?<!历)史上最`), 广告法 legal-risk framing |
| [style.gantanhao-fanlan](zh/style/gantanhao-fanlan.yml) | existence | “！！” | marketing | `raw` regex (`[！!]{2,}`) |
| [style.hedging](zh/style/hedging.yml) | existence | “大概”“或许”“可能” | techdocs | word list plus `raw` lookarounds excluding 可能性/不可能/尽可能/大概率 |
| [style.yuqi-ci](zh/style/yuqi-ci.yml) | existence | “……啦”“……哦” | techdocs | `raw` regex anchored on trailing punctuation, with a lookbehind excluding 干嘛/onomatopoeia |
| [style.taoban-kaitou](zh/style/taoban-kaitou.yml) | existence | “随着社会的发展”“众所周知” | blog | phrase list |

### Known heuristic limitations

- **grammar.de-di-de** is deliberately narrow: it only matches
  `ADV + 的(TAG=DEV) + VERB`, relying on `zh_core_web_sm`'s own fine-grained
  tagging of 的 as adverbial particle (DEV) versus adjectival (DEC).
  Verified live: 慢慢的走过来了 → 慢慢/ADV 的/DEV 走/VERB (fires); 美丽的花园
  → 的/DEC (never fires). Coverage is limited to this high-precision
  subcase — other 的/地/得 confusions are not attempted.
- **grammar.ni-nin** treats 你们 (informal plural) as an informal vote
  alongside 你, and 您 as the sole formal signal; these are generally
  clean PRON tokens in `zh_core_web_sm`, so no POS gate is used (unlike
  the French/Spanish/Italian sibling rules, which must disambiguate
  possessive/pronoun homographs). Documented low-frequency edge case:
  compounds containing 你 can be mis-segmented in some contexts — e.g.
  迷你 ("mini") in 这款迷你相机 can yield a standalone 你 token, casting
  a spurious informal vote for that sentence.
- **style.dayue-zuoyou** excludes bare 约 by design: `raw` patterns are not
  edge-wrapped by `bounded_pattern`, and 约 occurs inside 预约/合约/条约,
  which would over-fire. The gap in the pattern excludes clause
  punctuation (。！？，；) so the two approximation markers must stay in
  the same clause. A trailing lookahead (`左右(?![了着])`) excludes the
  verb readings 左右了/左右着 ("influenced/sways"); a residual bare-verb
  collision (左右大局) is accepted.
- **style.hedging**'s regex entries carry lookarounds because CJK tokens
  have no `\b` word boundary to stop a bare match: `(?<![不尽])可能(?!性)`
  excludes the noun 可能性, the assertion 不可能, and the intensifier
  尽可能; `大概(?![率念])` excludes 大概率 ("high probability") and 大概念.
- **style.wufa-zhengshi**'s 史上最 lives in `raw` with a lookbehind
  (`(?<!历)史上最`) because the phrase also occurs inside 历史上最… in
  ordinary factual historical prose (历史上最长的河流), which is not an
  advertising claim.
- **style.yuqi-ci** anchors each particle to the punctuation that follows
  it (`(?=[。！？，、])`) so it can never match mid-word, and excludes
  嘛 preceded by 干 (干嘛, "why") plus 啦/哦 preceded by 哗/呼/噼
  (onomatopoeia) via a negative lookbehind — existence rules match raw
  text, so without these guards a bare token pattern would hit inside
  those compounds.
