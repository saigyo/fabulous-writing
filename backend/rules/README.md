# Rule catalog

One YAML file per rule, under `<language>/<category>/<name>.yml`; the rule id is
`<category>.<name>`. Six check types exist (see the [main README](../../README.md)
for the formalism): `existence`, `substitution`, `occurrence`, and `repetition`
run on regexes; `token_pattern` and `dependency` run on the language's spaCy
pipeline and are skipped (and reported) when its model is not installed.
`occurrence` rules with `count: tokens` also need the model.

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
EN and DE currently ship three: `marketing`, `techdocs`, `blog`.

Rules marked **NLP** need the spaCy model. The *Demonstrates* column makes this
catalog double as a cookbook for writing your own rules.

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

| Rule | Type | Flags | Demonstrates |
|---|---|---|---|
| [style.mots-flous](fr/style/mots-flous.yml) | existence | mots flous (« très », « plutôt ») | word lists |
| [style.voix-passive](fr/style/voix-passive.yml) | dependency, **NLP** | « a été écrit par… » | UD relation `aux:pass` |
| [grammar.mots-repetes](fr/grammar/mots-repetes.yml) | repetition | mots doublés | adjacent duplicates |
| [grammar.malgre-que](fr/grammar/malgre-que.yml) | substitution | « malgré que » → « bien que » | contested-usage fix |
| [clarity.phrase-longue](fr/clarity/phrase-longue.yml) | occurrence | phrases de plus de 30 mots | per-sentence word counting |
| [clarity.lourdeurs](fr/clarity/lourdeurs.yml) | substitution | « au niveau de », « suite à » | swap map |
| [vividness.cliches](fr/vividness/cliches.yml) | existence | « au bout du compte » | multi-word phrases |

## Spanish (`es`)

| Rule | Type | Flags | Demonstrates |
|---|---|---|---|
| [style.muletillas](es/style/muletillas.yml) | existence | muletillas («muy», «básicamente») | word lists |
| [style.voz-pasiva](es/style/voz-pasiva.yml) | token_pattern, **NLP** | «fue escrito por…» | `MORPH` participle after lemma *ser* |
| [grammar.palabras-repetidas](es/grammar/palabras-repetidas.yml) | repetition | palabras dobladas | adjacent duplicates |
| [grammar.dequeismo](es/grammar/dequeismo.yml) | token_pattern, **NLP** | «pienso de que» | lemma sets (`LEMMA: {IN: […]}`) |
| [clarity.frase-larga](es/clarity/frase-larga.yml) | occurrence | frases de más de 30 palabras | per-sentence word counting |
| [clarity.circunloquios](es/clarity/circunloquios.yml) | substitution | «en base a» → «según» | swap map |
| [vividness.cliches](es/vividness/cliches.yml) | existence | «al fin y al cabo» | multi-word phrases |

## Italian (`it`)

| Rule | Type | Flags | Demonstrates |
|---|---|---|---|
| [style.parole-vaghe](it/style/parole-vaghe.yml) | existence | parole vaghe («molto», «praticamente») | word lists |
| [style.forma-passiva](it/style/forma-passiva.yml) | dependency, **NLP** | «è stato scritto», «viene scritto» | `aux:pass` covering *essere* and *venire* |
| [grammar.parole-ripetute](it/grammar/parole-ripetute.yml) | repetition | parole doppie | adjacent duplicates |
| [grammar.ma-pero](it/grammar/ma-pero.yml) | substitution | «ma però» → «ma» | redundancy fix |
| [clarity.frase-lunga](it/clarity/frase-lunga.yml) | occurrence | frasi di oltre 30 parole | per-sentence word counting |
| [clarity.burocratese](it/clarity/burocratese.yml) | substitution | «al fine di» → «per» | swap map |
| [vividness.cliches](it/vividness/cliches.yml) | existence | «alla fine dei conti» | multi-word phrases |

## Japanese (`ja`)

| Rule | Type | Flags | Demonstrates |
|---|---|---|---|
| [style.redundant-potential](ja/style/redundant-potential.yml) | token_pattern, **NLP** | 「〜することができる」→「〜できる」 | GiNZA lemmas in patterns |
| [style.double-negative](ja/style/double-negative.yml) | token_pattern, **NLP** | 「〜ないことはない」 | `LEMMA`+`TEXT` mix for fixed expressions |
| [style.mazu-saisho](ja/style/mazu-saisho.yml) | token_pattern, **NLP** | 「まず最初に」 | static `suggestions` on token rules |
| [clarity.long-sentence](ja/clarity/long-sentence.yml) | occurrence (`count: tokens`), **NLP** | 50トークン超の文 | token counting where `\b\w+\b` fails |
| [clarity.touten-kajou](ja/clarity/touten-kajou.yml) | occurrence | 読点（、）が4個超の文 | regex counting works for CJK punctuation |

## Chinese (`zh`)

| Rule | Type | Flags | Demonstrates |
|---|---|---|---|
| [style.filler](zh/style/filler.yml) | token_pattern, **NLP** | 填充词（基本上、众所周知） | `TEXT: {IN: […]}` (zh model has no lemmas) |
| [style.jinxing](zh/style/jinxing.yml) | token_pattern, **NLP** | “进行(了)+名词”（如“进行讨论”→“讨论”） | optional token (`OP: "?"` for 了) |
| [clarity.long-sentence](zh/clarity/long-sentence.yml) | occurrence (`count: tokens`), **NLP** | 超过 40 个词的句子 | token counting |
| [clarity.douhao-guoduo](zh/clarity/douhao-guoduo.yml) | occurrence | 逗号超过 5 个的句子 | regex counting for CJK punctuation |
