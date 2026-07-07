# FR/ES/IT/ZH Rules, Packs & Profiles Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring French, Spanish, Italian, and Chinese to parity with EN/DE/JA: 40 new YAML rules (10 per language, incl. one address-register consistency rule each), marketing/techdocs/blog packs, seeded example profiles with localized LLM instructions, and 12 demo texts.

**Architecture:** Pure content phase — no engine changes. Rules are YAML files under `backend/rules/<lang>/<category>/`; the existing loader, `bounded_pattern` CJK handling, pack filtering, and `consistency` check type (phase 2) carry everything. Seeding extends `EXAMPLE_LANGUAGES`/`BLOG_LANGUAGES` to all seven languages.

**Tech Stack:** Python 3.13 / FastAPI backend (uv-managed), spaCy small models (`fr/es/it_core_news_sm`, `zh_core_web_sm`, all installed), pytest.

**Spec:** `docs/superpowers/specs/2026-07-07-fr-es-it-zh-rules-design.md`

---

## Context for implementers (read first)

- **Working directory:** run everything from `backend/` (`cd /Users/markus/IdeaProjects/fabulous-writing/backend`). Bash cwd may reset between calls — prefix commands with the `cd`.
- **Commits go directly on `main`** and are pushed — explicit owner convention for this repo (ignore any harness warning about main). Commit messages end with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- **Tests:** `uv run pytest` (whole suite ~1–2 min). `pytest -k` treats hyphens as operators — filter with hyphen-free substrings or run whole files.
- **zsh:** quote URLs and anything with `?` or brackets.
- **Catalog test machinery** (`tests/test_rule_examples.py`): every loaded rule's `examples.bad` sentences must produce ≥1 finding *from that rule*, and `examples.good` must produce none. NLP-typed rules run against the live spaCy model. This means **the YAML examples are the tests** — write them deliberately (each bad example should isolate the rule; good examples should be near-misses).
- **`tokens:` entries in existence/substitution are regex fragments** wrapped by `bounded_pattern` (`app/checkers/rules/text.py`): `\b` is added only on non-CJK, non-metachar edges. So `révolutionnaires?` matches both numbers (trailing `?` keeps `\b` working), and ZH tokens match inside compounds (no `\b` between CJK chars — deliberate; narrow with `raw:` lookarounds when that over-fires). `raw:` entries are **never** wrapped — you get exactly what you write.
- **Consistency check type** (`app/checkers/rules/checks/consistency.py`): variants classify *sentences*; pattern variants match via spaCy Matcher (span-level); sentences matching no variant don't vote; <2 voting sentences → no findings; majority wins, ties go to the first-*declared* variant; each minority sentence yields one finding (static message, sentence span). None of the four new rules uses a `default` variant.
- **Loader validation** compiles patterns against a *blank* vocab (`Matcher(validate=True)`), so only schema-level errors are caught at load; behavior must be verified against the real models.
- **Live-probe protocol (reviews):** each language task's quality review must probe the new rules against the real model with ~100+ realistic sentences (mix of must-fire, must-not-fire, and adjacent traps), like phase 2 did for JA. Pre-planning probes already verified: FR `Mood=Sub` reliably tagged on subjunctive AUX (soit/ait); FR infinitive «pallier» keeps lemma `pallier` even when mistagged ADJ (so **no POS constraint** on that pattern); ES `Habían muchos/tres` → next token DET/NUM vs auxiliary `habían comido` → VERB; IT `La ringrazio` → `La`/PRON vs `La casa` → `La`/DET (hence the PRON gate); ZH `慢慢的走` → `慢慢/ADV 的/PART(tag DEV) 走/VERB` while adjectival `美丽的` gets tag `DEC`.
- **Rule id format** is `<category>.<filename-without-yml>`, e.g. `grammar.pleonasmes`. Findings carry it as `rule_id`.
- **Pack rules** carry `pack: marketing|techdocs|blog` and only run when a profile enables the pack; general rules always run.

### Verification snippet (used in several steps)

To check which rules fire on a text (packs included):

```bash
cd /Users/markus/IdeaProjects/fabulous-writing/backend && uv run python -c "
from pathlib import Path
from app.checkers.rules.engine import RuleEngine, RuleConfig
from app.core.config import NlpSettings
from app.core.models import Language
from app.nlp.registry import NlpRegistry
engine = RuleEngine(Path('rules')); reg = NlpRegistry(NlpSettings().models)
text = Path('demos/fr-marketing.txt').read_text()
doc = reg.analyze(text, 'fr')
for f in engine.check(text, Language.FR, doc=doc, config=RuleConfig(packs_on=['marketing'])):
    print(f.rule_id, '|', f.span.text[:40])
"
```

(Adjust language / file / packs per use.)

---

## File map

| Task | Creates | Modifies |
|---|---|---|
| 1 FR | `rules/fr/grammar/{pleonasmes,pallier-a,apres-que-subjonctif,tutoiement-vouvoiement}.yml`, `rules/fr/style/{hype-mots,affirmations-inverifiables,inflation-exclamation,hedging,langage-familier,cliches-ouverture}.yml`, `demos/fr-{marketing,technical-documentation,blog}.txt`, `tests/test_register_consistency.py` | `demos/fr.txt`, `tests/test_demo_texts.py` |
| 2 ES | `rules/es/grammar/{queismo,haber-impersonal,tuteo-ustedeo}.yml`, `rules/es/style/{en-base-a,palabras-hype,afirmaciones-inverificables,inflacion-exclamacion,hedging,coloquialismos,cliches-apertura}.yml`, `demos/es-*.txt` (3) | `demos/es.txt`, `tests/test_demo_texts.py`, `tests/test_register_consistency.py` |
| 3 IT | `rules/it/grammar/{a-me-mi,apostrofo-errato,pleonasmi,tu-lei}.yml`, `rules/it/style/{parole-hype,affermazioni-inverificabili,inflazione-esclamativi,hedging,colloquialismi,cliches-apertura}.yml`, `demos/it-*.txt` (3) | `demos/it.txt`, `tests/test_demo_texts.py`, `tests/test_register_consistency.py` |
| 4 ZH | `rules/zh/grammar/{de-di-de,ni-nin}.yml`, `rules/zh/style/{dayue-zuoyou,rongyu,xuanchuan-ci,wufa-zhengshi,gantanhao-fanlan,hedging,yuqi-ci,taoban-kaitou}.yml`, `demos/zh-*.txt` (3) | `demos/zh.txt`, `tests/test_demo_texts.py`, `tests/test_register_consistency.py` |
| 5 Seeding | — | `app/services/seed_profiles.py`, `tests/test_profiles.py` |
| 6 Docs | — | `rules/README.md`, `docs/backend-architecture.md`, `docs/LOGBOOK.md` |

---

### Task 1: French rules, demos, and the register-consistency test file

**Files:**
- Create: 10 rule YAMLs under `rules/fr/`, 3 demo files, `tests/test_register_consistency.py`
- Modify: `demos/fr.txt` (append fodder), `tests/test_demo_texts.py` (extend `EXPECTED[Language.FR]`)

- [ ] **Step 1: Write the 10 FR rule files** (examples are the failing tests — the catalog test will exercise them)

`rules/fr/grammar/pleonasmes.yml`:
```yaml
# Pléonasmes courants. Substitution matches literal strings, so conjugated
# forms (« il est monté en haut ») escape — accepted recall limitation;
# the invariant keys (au jour d'aujourd'hui, voire même, …) carry the rule.
extends: substitution
message: "«%s» suffit — «%s» est un pléonasme."
level: warning
category: grammar
ignorecase: true
swap:
  monter en haut: monter
  descendre en bas: descendre
  prévoir à l'avance: prévoir
  au jour d'aujourd'hui: aujourd'hui
  voire même: voire
  comme par exemple: par exemple
  puis ensuite: ensuite
  s'avérer vrai: s'avérer
examples:
  bad:
    - "Il faut prévoir à l'avance chaque étape."
    - "Au jour d'aujourd'hui, rien n'est décidé."
    - "C'est utile, voire même indispensable."
  good:
    - "Il faut prévoir chaque étape."
    - "Aujourd'hui, rien n'est décidé."
    - "C'est utile, voire indispensable."
```

`rules/fr/grammar/pallier-a.yml`:
```yaml
# « pallier » est transitif direct : « pallier un problème », pas
# « pallier à un problème ». No POS constraint: fr_core_news_sm tags the
# infinitive « pallier » ADJ in « il faut pallier à … » but keeps the
# lemma, so LEMMA alone is the reliable signal. The noun « palier »
# (single l) has its own lemma and cannot collide.
extends: token_pattern
message: "«%s» — « pallier » est transitif direct : « pallier ce problème », sans « à »."
level: warning
category: grammar
pattern:
  - {LEMMA: pallier}
  - {LOWER: {IN: [à, au, aux]}}
examples:
  bad:
    - "Il faut pallier à ce problème rapidement."
    - "Nous avons pallié au manque de personnel."
  good:
    - "Il faut pallier ce problème rapidement."
    - "Nous avons pallié le manque de personnel."
    - "L'ascenseur s'arrête à ce palier."
```

`rules/fr/grammar/apres-que-subjonctif.yml`:
```yaml
# « après que » régit l'indicatif (le fait est accompli), pas le
# subjonctif. fr_core_news_sm tags subjunctive AUX/VERB with Mood=Sub
# (verified: soit, ait). The {0,3} wildcard bridges the subject NP
# (« après que le projet soit … »); a subjunctive further away belongs
# to another clause and must not fire. Both apostrophes (' ') are listed
# because the tokenizer keeps them attached to « qu' ».
extends: token_pattern
message: "«%s» — après « après que », on emploie l'indicatif : « après qu'il est parti »."
level: warning
category: grammar
pattern:
  - {LOWER: après}
  - {LOWER: {IN: [que, "qu'", "qu’"]}}
  - {OP: "{0,3}"}
  - {MORPH: {IS_SUPERSET: [Mood=Sub]}}
examples:
  bad:
    - "Après qu'il soit parti, nous avons mangé."
    - "Après que le projet soit terminé, on fêtera."
  good:
    - "Après qu'il est parti, nous avons mangé."
    - "Après que la réunion a commencé, il est arrivé."
```

`rules/fr/grammar/tutoiement-vouvoiement.yml`:
```yaml
# Register consistency (phase-2 consistency check type): sentences
# addressing the reader as « tu » vs « vous » vote; minority sentences
# get flagged; informal is declared first and wins a tie. The POS gate
# {PRON, DET} keeps the noun « ton » (tone) and other homographs out.
# Known limitation: plural/impersonal « vous » votes as formal.
# Bad examples must mix registers across sentences.
extends: consistency
message: "Tutoiement et vouvoiement mélangés — adressez-vous au lecteur de façon cohérente."
level: warning
category: grammar
variants:
  informel:
    pattern:
      - {LOWER: {IN: [tu, te, toi, ton, ta, tes]}, POS: {IN: [PRON, DET]}}
  formel:
    pattern:
      - {LOWER: {IN: [vous, votre, vos]}, POS: {IN: [PRON, DET]}}
examples:
  bad:
    - "Tu peux relire ton texte ce soir. Pense à corriger tes fautes. Vous pouvez ensuite le publier."
  good:
    - "Tu peux relire ton texte ce soir. Pense à corriger tes fautes."
    - "Vous pouvez relire votre texte ce soir. Vous pouvez ensuite le publier."
    - "Le ton de ce texte est juste. La conclusion est claire."
```

`rules/fr/style/hype-mots.yml`:
```yaml
extends: existence
message: "«%s» est un superlatif publicitaire — préférez un bénéfice concret ou un chiffre."
level: suggestion
category: style
pack: marketing
ignorecase: true
tokens:
  - révolutionnaires?
  - incontournables?
  - ultimes?
  - exceptionnels?
  - exceptionnelles?
  - inégalés?
  - inégalées?
  - époustouflants?
  - époustouflantes?
examples:
  bad:
    - "Une solution révolutionnaire et incontournable."
  good:
    - "Une solution qui réduit le temps de traitement de 40 %."
```

`rules/fr/style/affirmations-inverifiables.yml`:
```yaml
# Claims that competitors or regulators can challenge — legal risk.
extends: existence
message: "«%s» est une affirmation invérifiable — étayez-la ou supprimez-la (risque juridique)."
level: warning
category: style
pack: marketing
ignorecase: true
tokens:
  - numéro 1
  - "n° 1"
  - leader mondial
  - le meilleur du marché
  - la meilleure du marché
  - unique au monde
examples:
  bad:
    - "SuperWidget est le numéro 1 du marché."
  good:
    - "SuperWidget est utilisé par 12 000 équipes."
```

`rules/fr/style/inflation-exclamation.yml`:
```yaml
extends: existence
message: "Les points d'exclamation en rafale desservent le message — un seul suffit."
level: suggestion
category: style
pack: marketing
raw:
  - "!{2,}"
examples:
  bad:
    - "Essayez-le maintenant !!"
  good:
    - "Essayez-le maintenant !"
```

`rules/fr/style/hedging.yml`:
```yaml
# In documentation, hedges erode trust: state what the software does.
extends: existence
message: "«%s» affaiblit une documentation — affirmez le comportement ou documentez la condition exacte."
level: suggestion
category: style
pack: techdocs
ignorecase: true
tokens:
  - il semble que
  - peut-être que
  - probablement
  - il se pourrait que
examples:
  bad:
    - "Il semble que le cache soit parfois obsolète."
  good:
    - "Le cache expire après dix minutes."
```

`rules/fr/style/langage-familier.yml`:
```yaml
extends: existence
message: "«%s» est familier — employez un terme précis dans une documentation."
level: warning
category: style
pack: techdocs
ignorecase: true
tokens:
  - trucs?
  - machins?
  - du coup
  - ça marche
examples:
  bad:
    - "Si un truc ne fonctionne pas, redémarrez le service."
  good:
    - "Si un composant ne fonctionne pas, redémarrez le service."
```

`rules/fr/style/cliches-ouverture.yml`:
```yaml
extends: existence
message: "«%s» est une ouverture convenue — entrez directement dans le sujet."
level: suggestion
category: style
pack: blog
ignorecase: true
tokens:
  - depuis la nuit des temps
  - force est de constater
  - qui n'a jamais rêvé
  - de nos jours
  - à l'heure où
examples:
  bad:
    - "Depuis la nuit des temps, les écrivains cherchent le mot juste."
  good:
    - "Les écrivains cherchent le mot juste depuis Homère."
```

- [ ] **Step 2: Run the catalog tests — the new rules' examples must pass**

```bash
cd /Users/markus/IdeaProjects/fabulous-writing/backend && uv run pytest tests/test_rule_examples.py -x -q
```
Expected: PASS (all languages; failures name the offending rule + example). Iterate on YAML until green. If a `MORPH`/`OP` pattern is rejected at load, `test_catalog_loads_without_errors` reports the loader error.

- [ ] **Step 3: Write the failing register-consistency + morphology tests**

Create `tests/test_register_consistency.py`:

```python
"""Address-register consistency rules (FR/ES/IT/ZH) against the real
catalog and live spaCy models, plus the two morphology-gated grammar
rules. Slim by design: catalog examples already cover one bad/good pair
per rule; these tests pin the voting behavior (both minority directions,
tie-break, silence below two votes) that single examples cannot."""

from pathlib import Path

import pytest

from app.checkers.rules.engine import RuleEngine
from app.core.config import NlpSettings
from app.core.models import Language
from app.nlp.registry import NlpRegistry

RULES_DIR = Path(__file__).parent.parent / "rules"
ENGINE = RuleEngine(RULES_DIR)
REGISTRY = NlpRegistry(NlpSettings().models)


def hits(text: str, language: Language, rule_id: str):
    doc = REGISTRY.analyze(text, language.value)
    assert doc is not None, f"model for {language.value} unavailable"
    return [f for f in ENGINE.check(text, language, doc=doc) if f.rule_id == rule_id]


FR_RULE = "grammar.tutoiement-vouvoiement"


class TestTutoiementVouvoiement:
    def test_minority_formal_flagged(self) -> None:
        text = (
            "Tu peux relire ton texte ce soir. Pense à corriger tes fautes. "
            "Vous pouvez ensuite le publier."
        )
        found = hits(text, Language.FR, FR_RULE)
        assert len(found) == 1
        assert "Vous" in found[0].span.text

    def test_minority_informal_flagged(self) -> None:
        text = (
            "Vous pouvez relire votre texte ce soir. Vérifiez vos sources. "
            "Tu peux ensuite le publier."
        )
        found = hits(text, Language.FR, FR_RULE)
        assert len(found) == 1
        assert "Tu" in found[0].span.text

    def test_single_vote_is_silent(self) -> None:
        text = "Tu peux commencer maintenant. La suite viendra plus tard."
        assert hits(text, Language.FR, FR_RULE) == []

    def test_uniform_register_is_silent(self) -> None:
        text = "Vous pouvez relire votre texte. Vous pouvez le publier."
        assert hits(text, Language.FR, FR_RULE) == []


class TestApresQueSubjonctif:
    def test_subjunctive_fires(self) -> None:
        text = "Après qu'il soit parti, nous avons mangé."
        assert hits(text, Language.FR, "grammar.apres-que-subjonctif")

    def test_indicative_is_clean(self) -> None:
        text = "Après qu'il est parti, nous avons mangé."
        assert hits(text, Language.FR, "grammar.apres-que-subjonctif") == []
```

- [ ] **Step 4: Run the new tests**

```bash
cd /Users/markus/IdeaProjects/fabulous-writing/backend && uv run pytest tests/test_register_consistency.py -q
```
Expected: PASS (rules exist from Step 1; if you wrote tests before YAML, expected failure mode is "no findings"). If `test_minority_*` fails, debug with a live-model token dump before touching the variant patterns.

- [ ] **Step 5: Write the three FR demo files**

`demos/fr-marketing.txt`:
```
Découvrez SuperWidget, la solution révolutionnaire qui va transformer votre quotidien !! Notre produit incontournable est le numéro 1 du marché : une expérience ultime, un design époustouflant, des résultats exceptionnels. Leader mondial depuis trois ans, SuperWidget vous permet de prévoir à l'avance chaque étape de vos projets et de pallier à tous les imprévus.

Comme par exemple : la planification, le suivi, les rapports — tout y est. Essayez-le au jour d'aujourd'hui : vous ne reviendrez plus en arrière !!
```
(Trips: hype-mots ×4, affirmations-inverifiables ×2, inflation-exclamation ×2, pleonasmes ×3, pallier-a. All 2nd-person tokens are «vous/votre/vos» → uniform register, consistency stays silent.)

`demos/fr-technical-documentation.txt`:
```
Le fichier de configuration est chargé au démarrage de l'application. Il semble que le cache soit parfois obsolète ; redémarrez probablement le service si un truc ne fonctionne pas. Du coup, pour pallier à ce problème, videz le répertoire temporaire.

Peut-être que la commande « widget cache clear » suffira. Si ça marche, le statut passe au vert. Après que le service soit relancé, vérifiez les journaux d'erreurs.
```
(Trips: hedging ×3, langage-familier ×3, pallier-a, apres-que-subjonctif.)

`demos/fr-blog.txt`:
```
Depuis la nuit des temps, les écrivains cherchent le mot juste. De nos jours, tout le monde écrit : des articles, des newsletters, des fils entiers. Force est de constater que la qualité varie énormément.

Tu veux progresser ? Commence par relire tes textes à voix haute. Si vous préférez une méthode plus structurée, notez vos tics d'écriture dans un carnet.

Qui n'a jamais rêvé d'écrire sans effort ? Pourtant, c'est en réécrivant qu'on s'améliore, puis ensuite on recommence.
```
(Trips: cliches-ouverture ×4, tutoiement-vouvoiement — informal 2 votes («Tu veux…», «Commence…tes…») vs formal 1 («Si vous préférez…vos…») → the vous-sentence is flagged — and pleonasmes «puis ensuite».)

- [ ] **Step 6: Append fodder to `demos/fr.txt` and extend `EXPECTED`**

Append to `demos/fr.txt` (with a blank line before):
```
Au jour d'aujourd'hui, il faudra pallier à ce genre de problème : comme par exemple relire chaque phrase, puis ensuite couper ce qui dépasse.
```

In `tests/test_demo_texts.py`, extend `EXPECTED[Language.FR]` with:
```python
        "grammar.pleonasmes",
        "grammar.pallier-a",
```
(Do **not** add the consistency rule to `EXPECTED` — the standard demo must stay register-uniform. Check: the fodder has no 2nd-person tokens.)

- [ ] **Step 7: Verify the demos with the engine**

Run the verification snippet (see Context) once per demo file with matching pack (`marketing`, `techdocs`, `blog`), and confirm the rule ids listed under each file in Step 5 appear. Then:

```bash
cd /Users/markus/IdeaProjects/fabulous-writing/backend && uv run pytest tests/test_demo_texts.py tests/test_rule_examples.py -q
```
Expected: PASS.

- [ ] **Step 8: Full suite + commit**

```bash
cd /Users/markus/IdeaProjects/fabulous-writing/backend && uv run pytest -q
cd /Users/markus/IdeaProjects/fabulous-writing && git add backend/rules/fr backend/demos backend/tests && git commit -m "feat(rules): French phase-3 rules — pléonasmes, pallier à, après que, tu/vous consistency, packs

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>" && git push
```

---

### Task 2: Spanish rules and demos

**Files:**
- Create: 10 rule YAMLs under `rules/es/`, 3 demo files
- Modify: `demos/es.txt`, `tests/test_demo_texts.py`, `tests/test_register_consistency.py`

- [ ] **Step 1: Write the 10 ES rule files**

`rules/es/grammar/queismo.yml`:
```yaml
# Queísmo: omitting the required « de » before « que ». Deliberately
# narrow, high-precision keys — bare « seguro que » is legitimate
# colloquial Spanish and must NOT fire. Complements the existing
# dequeismo.yml (the opposite error).
extends: substitution
message: "«%s» — falta la preposición: «%s» es queísmo."
level: error
category: grammar
ignorecase: true
swap:
  me di cuenta que: me di cuenta de que
  a pesar que: a pesar de que
  estoy seguro que: estoy seguro de que
  estoy segura que: estoy segura de que
  no cabe duda que: no cabe duda de que
examples:
  bad:
    - "Me di cuenta que faltaban datos."
    - "A pesar que el proceso tarda, funciona."
  good:
    - "Me di cuenta de que faltaban datos."
    - "Seguro que mañana llueve."
```

`rules/es/grammar/haber-impersonal.yml`:
```yaml
# Existential « haber » is impersonal: « había muchos problemas », never
# « habían muchos ». The POS gate (next token DET/NUM/NOUN) keeps
# auxiliary uses (« habían comido » — next token VERB) from firing.
# Verified against es_core_news_sm: "Habían muchos" → muchos/DET,
# "Habían tres" → tres/NUM, "habían comido" → comido/VERB.
extends: token_pattern
message: "«%s» — el « haber » existencial es impersonal: « había muchos », no « habían muchos »."
level: error
category: grammar
pattern:
  - {LOWER: {IN: [habían, habrían, habrán]}}
  - {POS: {IN: [DET, NUM, NOUN]}}
examples:
  bad:
    - "Habían muchos problemas en el proyecto."
    - "Habrán muchas sorpresas mañana."
  good:
    - "Había muchos problemas en el proyecto."
    - "Ellos habían comido antes de salir."
```

`rules/es/grammar/tuteo-ustedeo.yml`:
```yaml
# Register consistency: tú vs usted. Possessive « tu/tus » counts as
# informal; « su/sus » is third-person-ambiguous and deliberately
# excluded, so formal detection leans on usted/ustedes only.
# Known limitation: ustedes is also the plural of tú in Latin American
# Spanish and votes as formal.
extends: consistency
message: "Tuteo y ustedeo mezclados — trate al lector de forma coherente."
level: warning
category: grammar
variants:
  informal:
    pattern:
      - {LOWER: {IN: [tú, ti, contigo, te, tu, tus]}, POS: {IN: [PRON, DET]}}
  formal:
    pattern:
      - {LOWER: {IN: [usted, ustedes]}, POS: PRON}
examples:
  bad:
    - "Puedes empezar hoy con tu borrador. Te aviso cuando termine la revisión. Usted puede publicar después."
  good:
    - "Puedes empezar hoy con tu borrador. Te aviso cuando termine la revisión."
    - "Usted puede empezar hoy. Usted decide el ritmo."
```

`rules/es/style/en-base-a.yml`:
```yaml
extends: substitution
message: "«%s» es la forma recomendada — «%s» está desaconsejado por la RAE."
level: suggestion
category: style
ignorecase: true
swap:
  en base a: con base en
examples:
  bad:
    - "En base a los datos, ajustamos el plan."
  good:
    - "Con base en los datos, ajustamos el plan."
```

`rules/es/style/palabras-hype.yml`:
```yaml
extends: existence
message: "«%s» es lenguaje publicitario vacío — prefiera un beneficio concreto o una cifra."
level: suggestion
category: style
pack: marketing
ignorecase: true
tokens:
  - revolucionari[oa]s?
  - espectacular(?:es)?
  - imprescindibles?
  - inigualables?
  - alucinantes?
examples:
  bad:
    - "Un rendimiento espectacular y una herramienta imprescindible."
  good:
    - "Reduce el tiempo de procesamiento un 40 %."
```

`rules/es/style/afirmaciones-inverificables.yml`:
```yaml
# Claims competitors or regulators can challenge — legal risk.
extends: existence
message: "«%s» es una afirmación inverificable — respáldela con datos o elimínela (riesgo legal)."
level: warning
category: style
pack: marketing
ignorecase: true
tokens:
  - número 1
  - líder del mercado
  - el mejor del mundo
  - la mejor del mundo
  - único en el mundo
  - única en el mundo
examples:
  bad:
    - "Somos el número 1 del mercado."
  good:
    - "Lo usan 12 000 equipos cada semana."
```

`rules/es/style/inflacion-exclamacion.yml`:
```yaml
# Catches both stacked closing marks (!!) and doubled inverted
# openings (¡¡ … !!).
extends: existence
message: "Los signos de exclamación acumulados restan credibilidad — uno basta."
level: suggestion
category: style
pack: marketing
raw:
  - "[!¡]{2,}"
examples:
  bad:
    - "¡¡Pruébalo hoy mismo!!"
  good:
    - "¡Pruébalo hoy mismo!"
```

`rules/es/style/hedging.yml`:
```yaml
extends: existence
message: "«%s» debilita la documentación — afirme el comportamiento o documente la condición exacta."
level: suggestion
category: style
pack: techdocs
ignorecase: true
tokens:
  - quizás
  - quizá
  - tal vez
  - creo que
  - me parece que
  - a lo mejor
examples:
  bad:
    - "Quizás el caché esté obsoleto."
  good:
    - "El caché expira a los diez minutos."
```

`rules/es/style/coloquialismos.yml`:
```yaml
extends: existence
message: "«%s» es coloquial — use un término preciso en la documentación."
level: warning
category: style
pack: techdocs
ignorecase: true
tokens:
  - un montón
  - o sea
  - a tope
examples:
  bad:
    - "Esto pasa un montón después de una actualización."
  good:
    - "Esto ocurre con frecuencia después de una actualización."
```

`rules/es/style/cliches-apertura.yml`:
```yaml
extends: existence
message: "«%s» es una apertura tópica — entre directamente en materia."
level: suggestion
category: style
pack: blog
ignorecase: true
tokens:
  - desde tiempos inmemoriales
  - como todos sabemos
  - en la era digital
  - hoy en día
examples:
  bad:
    - "Desde tiempos inmemoriales, la gente escribe para ordenar sus ideas."
  good:
    - "La gente escribe para ordenar sus ideas desde antes de Homero."
```

- [ ] **Step 2: Catalog tests**

```bash
cd /Users/markus/IdeaProjects/fabulous-writing/backend && uv run pytest tests/test_rule_examples.py -x -q
```
Expected: PASS.

- [ ] **Step 3: Add ES cases to `tests/test_register_consistency.py`**

Append:

```python
ES_RULE = "grammar.tuteo-ustedeo"


class TestTuteoUstedeo:
    def test_minority_formal_flagged(self) -> None:
        text = (
            "Puedes empezar hoy con tu borrador. Te aviso cuando termine la revisión. "
            "Usted puede publicar después."
        )
        found = hits(text, Language.ES, ES_RULE)
        assert len(found) == 1
        assert "Usted" in found[0].span.text

    def test_minority_informal_flagged(self) -> None:
        text = (
            "Usted puede empezar hoy mismo. Usted decide el ritmo del proyecto. "
            "Te aviso cuando termine la revisión."
        )
        found = hits(text, Language.ES, ES_RULE)
        assert len(found) == 1
        assert "Te aviso" in found[0].span.text

    def test_single_vote_is_silent(self) -> None:
        text = "Puedes empezar hoy mismo. El resto llegará después."
        assert hits(text, Language.ES, ES_RULE) == []


class TestHaberImpersonal:
    def test_existential_plural_fires(self) -> None:
        assert hits("Habían muchos problemas en el proyecto.", Language.ES, "grammar.haber-impersonal")

    def test_auxiliary_is_clean(self) -> None:
        assert hits("Ellos habían comido antes de salir.", Language.ES, "grammar.haber-impersonal") == []
```

- [ ] **Step 4: Run**

```bash
cd /Users/markus/IdeaProjects/fabulous-writing/backend && uv run pytest tests/test_register_consistency.py -q
```
Expected: PASS.

- [ ] **Step 5: Write the three ES demo files**

`demos/es-marketing.txt`:
```
Presentamos SuperWidget, la herramienta revolucionaria que cambiará tu forma de trabajar!! Es el número 1 del mercado y el producto imprescindible de esta temporada: un rendimiento espectacular, resultados inigualables. Somos líder del mercado desde 2023.

En base a miles de opiniones, me di cuenta que nuestros clientes ahorran horas cada semana. ¡¡Pruébalo hoy mismo!!
```
(Trips: palabras-hype ×3, afirmaciones-inverificables ×2, inflacion-exclamacion ×2, en-base-a, queismo. Only informal 2nd-person tokens → uniform register.)

`demos/es-technical-documentation.txt`:
```
El archivo de configuración se carga al iniciar la aplicación. Si el servicio no responde, quizás el caché esté obsoleto; tal vez baste con reiniciarlo. Habían muchos casos donde la memoria se agotaba, o sea, conviene vigilar el consumo.

Creo que la siguiente opción ayuda un montón: ejecute «widget cache clear». A pesar que el proceso tarda unos minutos, no lo interrumpa.
```
(Trips: hedging ×3, coloquialismos ×2, haber-impersonal, queismo.)

`demos/es-blog.txt`:
```
Desde tiempos inmemoriales, la gente escribe para ordenar sus ideas. Hoy en día, cualquiera publica un blog en minutos. Como todos sabemos, escribir bien es otra historia.

¿Quieres mejorar? Lee tu texto en voz alta; te sorprenderá lo que descubres. Pídele a un amigo que lo revise contigo. Si usted prefiere un método clásico, apunte sus hábitos de escritura en un cuaderno.

En la era digital, revisar sigue siendo la mejor herramienta.
```
(Trips: cliches-apertura ×4, tuteo-ustedeo — informal 2 votes («Lee tu texto…te…», «…contigo») vs formal 1 → the usted-sentence flagged. «¿Quieres mejorar?» carries no register token and does not vote.)

- [ ] **Step 6: Fodder + EXPECTED**

Append to `demos/es.txt`:
```
En base a los datos del informe, me di cuenta que habían muchos errores sin registrar.
```

Extend `EXPECTED[Language.ES]` in `tests/test_demo_texts.py` with:
```python
        "grammar.queismo",
        "grammar.haber-impersonal",
        "style.en-base-a",
```

- [ ] **Step 7: Verify demos with the engine snippet (language `es`, packs per file), then:**

```bash
cd /Users/markus/IdeaProjects/fabulous-writing/backend && uv run pytest tests/test_demo_texts.py tests/test_rule_examples.py -q
```
Expected: PASS.

- [ ] **Step 8: Full suite + commit**

```bash
cd /Users/markus/IdeaProjects/fabulous-writing/backend && uv run pytest -q
cd /Users/markus/IdeaProjects/fabulous-writing && git add backend/rules/es backend/demos backend/tests && git commit -m "feat(rules): Spanish phase-3 rules — queísmo, haber impersonal, tú/usted consistency, packs

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>" && git push
```

---

### Task 3: Italian rules and demos

**Files:**
- Create: 10 rule YAMLs under `rules/it/`, 3 demo files
- Modify: `demos/it.txt`, `tests/test_demo_texts.py`, `tests/test_register_consistency.py`

- [ ] **Step 1: Write the 10 IT rule files**

`rules/it/grammar/a-me-mi.yml`:
```yaml
# « a me mi piace »: pleonastic clitic doubling — colloquial, not for
# edited prose.
extends: token_pattern
message: "«%s» — basta « a me piace » oppure « mi piace », non entrambi."
level: warning
category: grammar
pattern:
  - {LOWER: a}
  - {LOWER: me}
  - {LOWER: mi}
examples:
  bad:
    - "A me mi piace la pizza."
  good:
    - "A me piace la pizza."
    - "Mi piace la pizza."
```

`rules/it/grammar/apostrofo-errato.yml`:
```yaml
# « qual è » never takes an apostrophe (troncamento, not elisione);
# « po' » takes one (elisione of « poco »). Both straight (U+0027) and
# typographic (U+2019) apostrophes are keyed — substitution works on the
# raw text, so tokenization is irrelevant.
extends: substitution
message: "«%s» è la grafia corretta — «%s» è un errore di apostrofo."
level: error
category: grammar
ignorecase: true
swap:
  "qual'è": qual è
  "qual’è": qual è
  "qual'era": qual era
  "qual’era": qual era
  "un pò": "un po'"
examples:
  bad:
    - "Qual'è il problema principale?"
    - "Serve un pò di pazienza."
  good:
    - "Qual è il problema principale?"
    - "Serve un po' di pazienza."
```

`rules/it/grammar/pleonasmi.yml`:
```yaml
# Redundant direction adverbs. Substitution matches literal strings, so
# only the listed forms are caught (infinitive + 3rd person singular) —
# accepted recall limitation. « ma però » is covered by ma-pero.yml.
extends: substitution
message: "«%s» basta — «%s» è un pleonasmo."
level: warning
category: grammar
ignorecase: true
swap:
  entrare dentro: entrare
  entra dentro: entra
  uscire fuori: uscire
  esce fuori: esce
examples:
  bad:
    - "Bisogna entrare dentro la questione."
  good:
    - "Bisogna entrare nella questione."
```

`rules/it/grammar/tu-lei.yml`:
```yaml
# Register consistency: tu vs Lei. The formal variant matches
# capitalized courtesy pronouns (Lei/Le/La) with a PRON gate — verified
# against it_core_news_sm: « La ringrazio » → La/PRON, « La casa » →
# La/DET (article, excluded). Known limitations: sentence-initial
# Lei/Le/La meaning « she/her/it » still votes formal (capitalized by
# position); enclitic courtesy forms (« informarLa ») are not detected.
extends: consistency
message: "Tu e Lei mescolati — rivolgersi al lettore in modo coerente."
level: warning
category: grammar
variants:
  informale:
    pattern:
      - {LOWER: {IN: [tu, ti, te, tuo, tua, tuoi, tue]}, POS: {IN: [PRON, DET]}}
  formale:
    pattern:
      - {TEXT: {IN: [Lei, Le, La]}, POS: PRON}
examples:
  bad:
    - "Leggi i tuoi testi il giorno dopo. Ti accorgerai di ogni ripetizione. Se Lei preferisce, ne parliamo lunedì."
  good:
    - "Leggi i tuoi testi il giorno dopo. Ti accorgerai di ogni ripetizione."
    - "La ringrazio per la pazienza. Se Lei preferisce, ne parliamo lunedì."
    - "La casa è grande. Le finestre danno sul giardino."
```

`rules/it/style/parole-hype.yml`:
```yaml
extends: existence
message: "«%s» è linguaggio promozionale vuoto — meglio un beneficio concreto o un numero."
level: suggestion
category: style
pack: marketing
ignorecase: true
tokens:
  - rivoluzionari[oaie]
  - imperdibil[ei]
  - straordinari[oaie]
  - senza precedenti
  - incredibil[ei]
examples:
  bad:
    - "Uno strumento rivoluzionario con prestazioni straordinarie."
  good:
    - "Riduce i tempi di elaborazione del 40 %."
```

`rules/it/style/affermazioni-inverificabili.yml`:
```yaml
# Claims competitors or regulators can challenge — legal risk.
extends: existence
message: "«%s» è un'affermazione non verificabile — va documentata o rimossa (rischio legale)."
level: warning
category: style
pack: marketing
ignorecase: true
tokens:
  - numero 1
  - "n\\. 1"
  - leader di mercato
  - il migliore al mondo
  - la migliore al mondo
  - unico al mondo
  - unica al mondo
examples:
  bad:
    - "Siamo il numero 1 del mercato."
  good:
    - "Lo usano 12.000 team ogni settimana."
```

`rules/it/style/inflazione-esclamativi.yml`:
```yaml
extends: existence
message: "I punti esclamativi in serie tolgono credibilità — ne basta uno."
level: suggestion
category: style
pack: marketing
raw:
  - "!{2,}"
examples:
  bad:
    - "Provalo oggi stesso!!"
  good:
    - "Provalo oggi stesso!"
```

`rules/it/style/hedging.yml`:
```yaml
extends: existence
message: "«%s» indebolisce la documentazione — affermare il comportamento o documentare la condizione esatta."
level: suggestion
category: style
pack: techdocs
ignorecase: true
tokens:
  - forse
  - credo che
  - mi sembra che
  - probabilmente
  - direi che
examples:
  bad:
    - "Forse la cache è obsoleta."
  good:
    - "La cache scade dopo dieci minuti."
```

`rules/it/style/colloquialismi.yml`:
```yaml
extends: existence
message: "«%s» è colloquiale — usare un termine preciso nella documentazione."
level: warning
category: style
pack: techdocs
ignorecase: true
tokens:
  - roba
  - un sacco di
examples:
  bad:
    - "Questa roba capita un sacco di volte dopo un aggiornamento."
  good:
    - "Questo problema si presenta spesso dopo un aggiornamento."
```

`rules/it/style/cliches-apertura.yml`:
```yaml
extends: existence
message: "«%s» è un'apertura di maniera — entrare subito nel merito."
level: suggestion
category: style
pack: blog
ignorecase: true
tokens:
  - fin dalla notte dei tempi
  - al giorno d'oggi
  - nell'era digitale
  - come tutti sanno
examples:
  bad:
    - "Fin dalla notte dei tempi, scrivere è il modo migliore per pensare."
  good:
    - "Scrivere è il modo migliore per pensare, e lo era già per Seneca."
```

- [ ] **Step 2: Catalog tests**

```bash
cd /Users/markus/IdeaProjects/fabulous-writing/backend && uv run pytest tests/test_rule_examples.py -x -q
```
Expected: PASS. Watch `apostrofo-errato`: if the loader or regex engine chokes on the typographic-apostrophe keys, keep both keys but escape nothing — they are plain characters.

- [ ] **Step 3: Add IT cases to `tests/test_register_consistency.py`**

```python
IT_RULE = "grammar.tu-lei"


class TestTuLei:
    def test_minority_formal_flagged(self) -> None:
        text = (
            "Leggi i tuoi testi il giorno dopo. Ti accorgerai di ogni ripetizione. "
            "Se Lei preferisce, ne parliamo lunedì."
        )
        found = hits(text, Language.IT, IT_RULE)
        assert len(found) == 1
        assert "Lei" in found[0].span.text

    def test_minority_informal_flagged(self) -> None:
        text = (
            "La ringrazio per la Sua pazienza. Se Lei preferisce, ne parliamo lunedì. "
            "Ti mando i commenti domani."
        )
        found = hits(text, Language.IT, IT_RULE)
        assert len(found) == 1
        assert "Ti mando" in found[0].span.text

    def test_article_la_does_not_vote(self) -> None:
        # Only articles/DET — no register tokens at all → silent.
        text = "La casa è grande. Le finestre danno sul giardino."
        assert hits(text, Language.IT, IT_RULE) == []

    def test_single_vote_is_silent(self) -> None:
        text = "Ti mando i commenti domani. Il resto arriva dopo."
        assert hits(text, Language.IT, IT_RULE) == []
```

- [ ] **Step 4: Run**

```bash
cd /Users/markus/IdeaProjects/fabulous-writing/backend && uv run pytest tests/test_register_consistency.py -q
```
Expected: PASS. If `test_minority_informal_flagged` fails because «La ringrazio»'s `La` or «Sua» isn't tagged PRON, dump the tokens live and adjust the test text (not the rule) to another unambiguous formal sentence, e.g. «Le scrivo per informarla del ritardo.» — keep the rule tokens as specified.

- [ ] **Step 5: Write the three IT demo files**

`demos/it-marketing.txt`:
```
Scopri SuperWidget, lo strumento rivoluzionario che cambierà il tuo modo di lavorare!! È il numero 1 del mercato: prestazioni straordinarie, un'offerta imperdibile, risultati senza precedenti. Siamo leader di mercato dal 2023.

Qual'è il segreto? Un design che entra dentro il tuo flusso di lavoro. Provalo oggi stesso!!
```
(Trips: parole-hype ×4, affermazioni-inverificabili ×2, inflazione-esclamativi ×2, apostrofo-errato, pleonasmi. Informal-only register → consistency silent.)

`demos/it-technical-documentation.txt`:
```
Il file di configurazione viene caricato all'avvio dell'applicazione. Se il servizio non risponde, forse la cache è obsoleta; credo che un riavvio basti nella maggior parte dei casi. Mi sembra che questa roba capiti un sacco di volte dopo un aggiornamento.

Qual'è la soluzione rapida? Eseguire «widget cache clear» e ricordarsi di uscire fuori dalla modalità manutenzione.
```
(Trips: hedging ×3, colloquialismi ×2, apostrofo-errato, pleonasmi.)

`demos/it-blog.txt`:
```
Fin dalla notte dei tempi, scrivere è il modo migliore per mettere ordine nei pensieri. Al giorno d'oggi chiunque può aprire un blog in pochi minuti. Come tutti sanno, scrivere bene è un'altra storia.

A me mi piace rileggere ogni testo ad alta voce. Leggi i tuoi testi il giorno dopo: ti accorgerai di ogni ripetizione. Poi confronta le tue versioni.

Se Lei preferisce un approccio classico, annoti i vizi di stile su un quaderno.
```
(Trips: cliches-apertura ×3, a-me-mi, tu-lei — informal 2 votes vs formal 1 → the Lei-sentence flagged.)

- [ ] **Step 6: Fodder + EXPECTED**

Append to `demos/it.txt`:
```
A me mi sembra un buon punto di partenza; qual'è il capitolo da rileggere prima di entrare dentro i dettagli?
```

Extend `EXPECTED[Language.IT]` in `tests/test_demo_texts.py` with:
```python
        "grammar.a-me-mi",
        "grammar.apostrofo-errato",
        "grammar.pleonasmi",
```

- [ ] **Step 7: Verify demos (engine snippet, language `it`), then:**

```bash
cd /Users/markus/IdeaProjects/fabulous-writing/backend && uv run pytest tests/test_demo_texts.py tests/test_rule_examples.py -q
```
Expected: PASS.

- [ ] **Step 8: Full suite + commit**

```bash
cd /Users/markus/IdeaProjects/fabulous-writing/backend && uv run pytest -q
cd /Users/markus/IdeaProjects/fabulous-writing && git add backend/rules/it backend/demos backend/tests && git commit -m "feat(rules): Italian phase-3 rules — a me mi, apostrofo errato, tu/Lei consistency, packs

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>" && git push
```

---

### Task 4: Chinese rules and demos

**Files:**
- Create: 10 rule YAMLs under `rules/zh/`, 3 demo files
- Modify: `demos/zh.txt`, `tests/test_demo_texts.py`, `tests/test_register_consistency.py`

**ZH-specific notes:** existence/substitution `tokens:` are CJK-edged → matched anywhere in the text (no `\b`); when that over-fires, use `raw:` with lookarounds (JA unverifiable-claims precedent). `raw:` is never edge-wrapped. Token patterns depend on `zh_core_web_sm` segmentation — probe live before trusting multi-token patterns.

- [ ] **Step 1: Write the 10 ZH rule files**

`rules/zh/grammar/de-di-de.yml`:
```yaml
# 的/地/得 confusion, deliberately narrow: adverb + 的 + verb, where the
# tagger itself marks 的 with fine-grained tag DEV (adverbial particle —
# i.e. the model already reads it as 地). Adjectival 的 gets tag DEC and
# never matches. Verified: 慢慢的走 → 慢慢/ADV 的/DEV 走/VERB;
# 美丽的花园 → 的/DEC. Coverage is limited to this high-precision
# subcase by design.
extends: token_pattern
message: "「%s」— 副词修饰动词应用「地」:「慢慢地走」,不是「慢慢的走」。"
level: warning
category: grammar
pattern:
  - {POS: ADV}
  - {TEXT: 的, TAG: DEV}
  - {POS: VERB}
examples:
  bad:
    - "他慢慢的走过来了。"
    - "她悄悄的离开了房间。"
  good:
    - "他慢慢地走过来了。"
    - "这是一个美丽的花园。"
```

`rules/zh/grammar/ni-nin.yml`:
```yaml
# Register consistency: 你 vs 您. Tokens are unambiguous PRON in
# zh_core_web_sm; 你们 (informal plural) also votes informal. Fewer than
# two voting sentences → silent.
extends: consistency
message: "「你」和「您」混用 — 对读者的称呼应保持一致。"
level: warning
category: grammar
variants:
  informal:
    pattern:
      - {TEXT: {IN: [你, 你们]}}
  formal:
    pattern:
      - {TEXT: 您}
examples:
  bad:
    - "你可以先看第一章。等你有空我们再讨论。您需要重新登录。"
  good:
    - "你可以先看第一章。等你有空我们再讨论。"
    - "您可以先看第一章。您有空我们再讨论。"
```

`rules/zh/style/dayue-zuoyou.yml`:
```yaml
# 大约/大概 …… 左右: the approximation is stated twice. Bare 约 is
# deliberately absent — raw patterns are not edge-wrapped, and 约 occurs
# inside 预约/合约/条约. The gap excludes clause punctuation so the two
# markers stay in the same clause.
extends: existence
message: "「大约/大概」和「左右」只留一个 — 约数表达重复。"
level: warning
category: style
raw:
  - "(大约|大概)[^。！？，；]{0,10}左右"
examples:
  bad:
    - "大约需要三个小时左右。"
  good:
    - "大约需要三个小时。"
    - "需要三个小时左右。"
    - "请提前预约三天左右。"
```

`rules/zh/style/rongyu.yml`:
```yaml
# 冗余表达: the modifier repeats what the verb already says. CJK-edged
# substitution keys rely on bounded_pattern's edge handling.
extends: substitution
message: "「%s」即可 —「%s」是冗余表达。"
level: warning
category: style
swap:
  免费赠送: 赠送
  提前预约: 预约
  亲眼目睹: 目睹
  涉及到: 涉及
  凯旋归来: 凯旋
examples:
  bad:
    - "这个功能涉及到三个模块。"
    - "活动奖品免费赠送。"
  good:
    - "这个功能涉及三个模块。"
    - "活动奖品赠送。"
```

`rules/zh/style/xuanchuan-ci.yml`:
```yaml
extends: existence
message: "「%s」是空洞的宣传语 — 用具体的收益或数字代替。"
level: suggestion
category: style
pack: marketing
tokens: [极致, 颠覆, 震撼, 尖端, 王牌]
examples:
  bad:
    - "带来极致体验的颠覆性产品。"
  good:
    - "把处理时间缩短了40%。"
```

`rules/zh/style/wufa-zhengshi.yml`:
```yaml
# Claims competitors or regulators can challenge — legal risk under
# advertising law (广告法 bans absolute superlatives).
extends: existence
message: "「%s」是无法证实的绝对化用语 — 广告法风险,请用可验证的数据。"
level: warning
category: style
pack: marketing
tokens: [全网第一, 史上最, 全球领先, 业界第一, 销量第一]
examples:
  bad:
    - "上线三个月,销量全网第一。"
  good:
    - "上线三个月,服务了一万两千个团队。"
```

`rules/zh/style/gantanhao-fanlan.yml`:
```yaml
extends: existence
message: "感叹号连用适得其反 — 一个就够了。"
level: suggestion
category: style
pack: marketing
raw:
  - "[！!]{2,}"
examples:
  bad:
    - "快来体验吧！！"
  good:
    - "快来体验吧！"
```

`rules/zh/style/hedging.yml`:
```yaml
# Hedges undermine documentation. 可能 uses a lookahead because 可能性
# ("possibility") is a legitimate noun and CJK tokens have no word
# boundary to stop the match.
extends: existence
message: "「%s」削弱文档的确定性 — 说明确切行为或给出确切条件。"
level: suggestion
category: style
pack: techdocs
tokens: [大概, 或许, 我觉得, 应该是]
raw:
  - "可能(?!性)"
examples:
  bad:
    - "缓存可能已经过期,大概重启一下就行。"
  good:
    - "缓存十分钟后过期,重启服务即可清除。"
    - "需要评估这种做法的可能性。"
```

`rules/zh/style/yuqi-ci.yml`:
```yaml
# Casual sentence-final particles in documentation. Anchored to the
# following punctuation so mid-word hits are impossible; the lookbehind
# excludes 干嘛 ("why") and onomatopoeia (哗啦/呼啦).
extends: existence
message: "语气词「%s」过于随意 — 技术文档请用陈述句。"
level: warning
category: style
pack: techdocs
raw:
  - "(?<![干哗呼噼])[啦哦呗嘛](?=[。！？，、])"
examples:
  bad:
    - "大概重启一下就行啦。"
    - "然后查看日志哦。"
  good:
    - "重启服务即可恢复。"
    - "干嘛这么着急？"
```

`rules/zh/style/taoban-kaitou.yml`:
```yaml
extends: existence
message: "「%s」是套版开头 — 直接进入主题更有力。"
level: suggestion
category: style
pack: blog
tokens: [随着社会的发展, 众所周知, 在这个快节奏的时代, 随着科技的进步]
examples:
  bad:
    - "随着社会的发展,写作已经成为每个人的必修课。"
  good:
    - "写作已经成为每个人的必修课。"
```

- [ ] **Step 2: Catalog tests**

```bash
cd /Users/markus/IdeaProjects/fabulous-writing/backend && uv run pytest tests/test_rule_examples.py -x -q
```
Expected: PASS. Most likely failure: `de-di-de` examples if segmentation differs from the probe — dump tokens live (`text/pos_/tag_`) before changing anything; if the DEV tag proves unstable across sentences, fall back to a curated `raw:` list (`(慢慢|悄悄|渐渐|好好)的(?=[走读看写说做听拿来去到])`) and note the spec amendment.

- [ ] **Step 3: Add ZH cases to `tests/test_register_consistency.py`**

```python
ZH_RULE = "grammar.ni-nin"


class TestNiNin:
    def test_minority_formal_flagged(self) -> None:
        text = "你可以先看第一章。等你有空我们再讨论。您需要重新登录。"
        found = hits(text, Language.ZH, ZH_RULE)
        assert len(found) == 1
        assert "您" in found[0].span.text

    def test_minority_informal_flagged(self) -> None:
        text = "您可以先看第一章。您有空我们再讨论。你需要重新登录。"
        found = hits(text, Language.ZH, ZH_RULE)
        assert len(found) == 1
        assert "你" in found[0].span.text

    def test_tie_first_declared_wins(self) -> None:
        # 1 informal vs 1 formal: informal is declared first → 您 flagged.
        text = "你可以先看第一章。您需要重新登录。"
        found = hits(text, Language.ZH, ZH_RULE)
        assert len(found) == 1
        assert "您" in found[0].span.text

    def test_single_vote_is_silent(self) -> None:
        text = "你可以先看第一章。剩下的以后再说。"
        assert hits(text, Language.ZH, ZH_RULE) == []
```

- [ ] **Step 4: Run**

```bash
cd /Users/markus/IdeaProjects/fabulous-writing/backend && uv run pytest tests/test_register_consistency.py -q
```
Expected: PASS. If a 你-sentence doesn't vote, check segmentation live (e.g. 你的 may fuse) and reword the test sentence, not the rule.

- [ ] **Step 5: Write the three ZH demo files**

`demos/zh-marketing.txt`:
```
SuperWidget 带来极致体验,是一款颠覆行业的智能工具！！上线三个月,销量全网第一,是史上最受欢迎的效率应用。震撼功能免费赠送,名额大约剩五百个左右。

现在提前预约,即可解锁全部尖端模块。快来体验吧！！
```
(Trips: xuanchuan-ci ×4, wufa-zhengshi ×2, gantanhao-fanlan ×2, rongyu ×2, dayue-zuoyou.)

`demos/zh-technical-documentation.txt`:
```
配置文件在应用启动时加载。如果服务没有响应,缓存可能已经过期,大概重启一下就行啦。我觉得这个问题涉及到缓存模块。

你可以先运行 widget cache clear,然后查看日志哦。如果你看到错误代码,请把日志发给管理员。完成后,您需要重新登录管理面板。
```
(Trips: hedging ×3, yuqi-ci ×2, rongyu, ni-nin — informal 2 votes vs formal 1 → the 您-sentence flagged.)

`demos/zh-blog.txt`:
```
随着社会的发展,写作已经成为每个人的必修课。众所周知,写得好并不容易。在这个快节奏的时代,我们更需要慢下来。

我的方法很简单:写完之后先放一放,第二天再慢慢的读一遍,大约读两遍左右就能发现大部分问题。悄悄的告诉大家:大声朗读最有效。
```
(Trips: taoban-kaitou ×3, de-di-de ×2, dayue-zuoyou.)

- [ ] **Step 6: Fodder + EXPECTED**

Append to `demos/zh.txt`:
```
整理结果大约需要两周左右,其中涉及到三个模块。
```

Extend `EXPECTED[Language.ZH]` in `tests/test_demo_texts.py` with:
```python
        "style.dayue-zuoyou",
        "style.rongyu",
```

- [ ] **Step 7: Verify demos (engine snippet, language `zh`, packs per file), then:**

```bash
cd /Users/markus/IdeaProjects/fabulous-writing/backend && uv run pytest tests/test_demo_texts.py tests/test_rule_examples.py -q
```
Expected: PASS. Verify specifically that de-di-de fires twice on the blog demo (慢慢的读 / 悄悄的告诉) — if 告诉 isn't tagged VERB after 悄悄的, adjust the demo sentence to another verb the model tags reliably.

- [ ] **Step 8: Full suite + commit**

```bash
cd /Users/markus/IdeaProjects/fabulous-writing/backend && uv run pytest -q
cd /Users/markus/IdeaProjects/fabulous-writing && git add backend/rules/zh backend/demos backend/tests && git commit -m "feat(rules): Chinese phase-3 rules — 的/地/得, 大约…左右, 你/您 consistency, packs

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>" && git push
```

---

### Task 5: Seeding — example profiles for all seven languages

**Files:**
- Modify: `app/services/seed_profiles.py`, `tests/test_profiles.py`

- [ ] **Step 1: Write the failing test** — in `tests/test_profiles.py`, replace the body of `test_seed_pack_profiles` (keep the EN/DE/JA assertions, add the four new languages):

```python
def test_seed_pack_profiles(tmp_path) -> None:
    store = ProfileStore(tmp_path / "profiles.sqlite")
    seed_profiles(store, DEMOS, seed_examples=True)
    en = {p.name: p for p in store.list_profiles(Language.EN)}
    assert en["Marketing"].packs_on == ["marketing"]
    assert en["Technical Documentation"].packs_on == ["techdocs"]
    assert en["Blog"].packs_on == ["blog"]
    assert en["Blog"].example_text  # demo file exists and is non-empty
    de = {p.name: p for p in store.list_profiles(Language.DE)}
    assert de["Blog"].packs_on == ["blog"]
    ja = {p.name: p for p in store.list_profiles(Language.JA)}
    assert ja["Blog"].packs_on == ["blog"]
    assert ja["Blog"].llm_instructions
    assert "いかがでしたか" in ja["Blog"].example_text
    for language in (Language.FR, Language.ES, Language.IT, Language.ZH):
        profiles = {p.name: p for p in store.list_profiles(language)}
        assert profiles["Marketing"].packs_on == ["marketing"]
        assert profiles["Technical Documentation"].packs_on == ["techdocs"]
        assert profiles["Blog"].packs_on == ["blog"]
        for name in ("Marketing", "Technical Documentation", "Blog"):
            assert profiles[name].llm_instructions, f"{language}: {name}"
            assert profiles[name].example_text, f"{language}: {name}"
```

- [ ] **Step 2: Run it — must fail**

```bash
cd /Users/markus/IdeaProjects/fabulous-writing/backend && uv run pytest tests/test_profiles.py::test_seed_pack_profiles -q
```
Expected: FAIL with `KeyError: 'Marketing'` for FR.

- [ ] **Step 3: Extend the seeding module** — in `app/services/seed_profiles.py`:

Replace the module docstring's first lines with:
```python
"""Seed checking profiles: a Standard profile per language, plus deletable
Marketing / Technical Documentation / Blog examples for every language
(tracked in a marker table so deletions stick across restarts)."""
```

Replace the two constants:
```python
EXAMPLE_LANGUAGES = set(Language)
BLOG_LANGUAGES = set(Language)
```

Add to `_MARKETING_INSTRUCTIONS`:
```python
    Language.FR: (
        "Public : clients potentiels. Privilégier des formulations énergiques, "
        "concrètes, axées sur les bénéfices ; phrases courtes ; voix active. "
        "Signaler le jargon, les affirmations vagues et les tournures hésitantes."
    ),
    Language.ES: (
        "Audiencia: clientes potenciales. Preferir formulaciones enérgicas, "
        "concretas y centradas en los beneficios; frases cortas; voz activa. "
        "Señalar la jerga, las afirmaciones vagas y las expresiones dubitativas."
    ),
    Language.IT: (
        "Pubblico: potenziali clienti. Preferire formulazioni energiche, "
        "concrete, orientate ai benefici; frasi brevi; forma attiva. Segnalare "
        "gergo, affermazioni vaghe e formule esitanti."
    ),
    Language.ZH: (
        "目标读者:潜在客户。倾向有力、具体、以收益为先的表达;短句;主动语态。"
        "指出行话、空泛的主张和含糊其辞。"
    ),
```

Add to `_TECHDOC_INSTRUCTIONS`:
```python
    Language.FR: (
        "Public : utilisateurs suivant des instructions. Priorité à la précision, "
        "à la terminologie cohérente et aux formulations sans ambiguïté ; "
        "impératif pour les étapes ; signaler le langage marketing et les "
        "quantités vagues."
    ),
    Language.ES: (
        "Audiencia: usuarios que siguen instrucciones. Prioridad a la precisión, "
        "la terminología coherente y las formulaciones inequívocas; imperativo "
        "para los pasos; señalar el lenguaje comercial y las cantidades vagas."
    ),
    Language.IT: (
        "Pubblico: utenti che seguono istruzioni. Priorità a precisione, "
        "terminologia coerente e formulazioni univoche; imperativo per i "
        "passaggi; segnalare linguaggio promozionale e quantità vaghe."
    ),
    Language.ZH: (
        "目标读者:按步骤操作的用户。以准确、术语一致、表达无歧义为最高优先;"
        "步骤使用祈使句;指出营销化语言和模糊的数量表述。"
    ),
```

Add to `_BLOG_INSTRUCTIONS`:
```python
    Language.FR: (
        "Public : lecteurs de blog. Style personnel mais resserré ; exemples "
        "concrets plutôt qu'abstractions ; paragraphes courts. Signaler les "
        "introductions creuses, les digressions et les généralisations non "
        "étayées."
    ),
    Language.ES: (
        "Audiencia: lectores de blog. Voz personal pero contenida; ejemplos "
        "concretos en lugar de abstracciones; párrafos cortos. Señalar aperturas "
        "tópicas, divagaciones y generalizaciones sin respaldo."
    ),
    Language.IT: (
        "Pubblico: lettori di blog. Voce personale ma asciutta; esempi concreti "
        "invece di astrazioni; paragrafi brevi. Segnalare aperture di maniera, "
        "divagazioni e generalizzazioni non supportate."
    ),
    Language.ZH: (
        "目标读者:博客读者。提倡个人化而紧凑的文风;用具体例子代替抽象论述;"
        "段落要短。指出套话开头、离题和缺乏依据的概括。"
    ),
```

- [ ] **Step 4: Run the test — must pass**

```bash
cd /Users/markus/IdeaProjects/fabulous-writing/backend && uv run pytest tests/test_profiles.py tests/test_seed.py -q
```
Expected: PASS (example_text assertions pass because Tasks 1–4 created the demo files).

- [ ] **Step 5: Full suite + commit**

```bash
cd /Users/markus/IdeaProjects/fabulous-writing/backend && uv run pytest -q
cd /Users/markus/IdeaProjects/fabulous-writing && git add backend/app/services/seed_profiles.py backend/tests/test_profiles.py && git commit -m "feat(profiles): seed Marketing/TechDoc/Blog examples for all seven languages

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>" && git push
```

---

### Task 6: Documentation

**Files:**
- Modify: `rules/README.md`, `docs/backend-architecture.md`, `docs/LOGBOOK.md`

- [ ] **Step 1: Update `rules/README.md`**

For each of the four language sections (`## French (fr)`, `## Spanish (es)`, `## Italian (it)`, `## Chinese (zh)`): add a **Pack** column to the rule table if not present (existing rows get an empty cell, matching the JA table's format at `## Japanese (ja)`), and add one row per new rule with id, check type, pack, and a one-line description. Read the JA table first and copy its column layout exactly.

Then add a `### Known heuristic limitations` subsection after the French and Chinese tables' language blocks (matching the existing EN/JA limitation subsections' placement), covering:
- FR/ES: plural/impersonal «vous»/«ustedes» vote as formal in the register-consistency rules; substitution-based pleonasm rules only match the listed literal forms.
- FR: `apres-que-subjonctif` trusts `fr_core_news_sm`'s `Mood=Sub` tagging within 3 tokens of «après que».
- IT: sentence-initial «Lei/Le/La» meaning she/her votes formal (capitalized by position); enclitic courtesy forms («informarLa») are not detected.
- ZH: `de-di-de` covers only the adverb+的+verb subcase where the tagger emits `DEV`; `dayue-zuoyou` deliberately omits bare 约 (预约/合约 collisions).

- [ ] **Step 2: Update `docs/backend-architecture.md`**

In the seeding paragraph: example profiles (Marketing/TechDoc/Blog) are now seeded for **all seven languages**. In the consistency-check-type paragraph: note it now backs five rules (JA desu-masu + four address-register rules: FR tu/vous, ES tú/usted, IT tu/Lei, ZH 你/您).

- [ ] **Step 3: Append the phase-3 entry to `docs/LOGBOOK.md`** — consolidated summary: 40 new rules across fr/es/it/zh (list the headline rules), consistency type generalized to address registers, packs + example profiles + 12 demos for the four languages, commit range, test count. Follow the phase-2 entry's format.

- [ ] **Step 4: Full suite + commit + push**

```bash
cd /Users/markus/IdeaProjects/fabulous-writing/backend && uv run pytest -q
cd /Users/markus/IdeaProjects/fabulous-writing && git add backend/rules/README.md docs && git commit -m "docs: phase-3 rule catalog, architecture, and logbook updates

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>" && git push
```

---

## Final verification (after all tasks)

- `uv run pytest -q` — whole suite green.
- Engine snippet on all 12 new demos + 4 refreshed `{lang}.txt` — every intended rule id fires; **no consistency findings on any demo except the three that mix registers by design** (fr-blog, es-blog, it-blog, zh-technical-documentation — four, one per language).
- `git log --oneline` — one commit per task, all pushed, CI green.
- Final whole-feature review per superpowers:subagent-driven-development (spec: `docs/superpowers/specs/2026-07-07-fr-es-it-zh-rules-design.md`).
