# Rule catalog

One YAML file per rule, under `<language>/<category>/<name>.yml`; the rule id is
`<category>.<name>`. Six check types exist (see the [main README](../../README.md)
for the formalism): `existence`, `substitution`, `occurrence`, and `repetition`
run on regexes; `token_pattern` and `dependency` run on the language's spaCy
pipeline and are skipped (and reported) when its model is not installed.
`occurrence` rules with `count: tokens` also need the model.

Rules marked **NLP** need the spaCy model. The *Demonstrates* column makes this
catalog double as a cookbook for writing your own rules.

## English (`en`)

| Rule | Type | Flags | Demonstrates |
|---|---|---|---|
| [style.weasel-words](en/style/weasel-words.yml) | existence | vague intensifiers ("very", "somewhat", "a number of") | word/phrase lists with `ignorecase` |
| [style.exclamations](en/style/exclamations.yml) | existence | stacked exclamation marks ("!!") | `raw` verbatim-regex tokens |
| [style.nominalizations](en/style/nominalizations.yml) | token_pattern, **NLP** | "made a decision" instead of "decided" | `LEMMA` + optional `DET` + word set |
| [style.passive-voice](en/style/passive-voice.yml) | dependency, **NLP** | "was written by the team" | syntax-tree match on `auxpass` |
| [style.split-infinitive](en/style/split-infinitive.yml) | token_pattern, **NLP** | "to quickly finish" | `TAG`+`POS` mix with `OP: "+"` |
| [grammar.article-an](en/grammar/article-an.yml) | token_pattern, **NLP** | "an presentation" | `REGEX` text condition |
| [grammar.repeated-words](en/grammar/repeated-words.yml) | repetition | "it is is fine" | adjacent-duplicate detection |
| [clarity.wordiness](en/clarity/wordiness.yml) | substitution | "utilize" → "use", "in order to" → "to" | swap map with one-click fixes |
| [clarity.long-sentence](en/clarity/long-sentence.yml) | occurrence | sentences over 30 words | per-sentence regex counting |
| [vividness.cliches](en/vividness/cliches.yml) | existence | "at the end of the day", "think outside the box" | multi-word phrases |
| [vividness.expletive-opener](en/vividness/expletive-opener.yml) | token_pattern, **NLP** | "There are…" openers | `DEP` label on a token |

## German (`de`)

| Rule | Type | Flags | Demonstrates |
|---|---|---|---|
| [style.fuellwoerter](de/style/fuellwoerter.yml) | existence | Füllwörter („halt“, „quasi“, „im Grunde“) | word/phrase lists |
| [style.anglizismen](de/style/anglizismen.yml) | substitution | Anglizismen („gecancelt“ → „abgesagt“) | swap map |
| [style.passiv](de/style/passiv.yml) | token_pattern, **NLP** | „wurde … geschrieben“ | `OP: "{,4}"` gap between tokens |
| [style.wuerde-stil](de/style/wuerde-stil.yml) | token_pattern, **NLP** | „würde … annehmen“ statt Konjunktiv II | `MORPH` (`Mood=Sub`) + `OP` gap |
| [grammar.doppelte-woerter](de/grammar/doppelte-woerter.yml) | repetition | „ist ist“ | adjacent duplicates |
| [grammar.einzigste](de/grammar/einzigste.yml) | substitution | „einzigste“ → „einzige“ | inflected error forms in a swap map |
| [clarity.lange-saetze](de/clarity/lange-saetze.yml) | occurrence | Sätze mit mehr als 30 Wörtern | per-sentence word counting |
| [clarity.schachtelsaetze](de/clarity/schachtelsaetze.yml) | occurrence | mehr als drei Kommas pro Satz | counting arbitrary regexes (commas) |

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
