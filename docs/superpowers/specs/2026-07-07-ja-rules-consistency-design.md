# Japanese rules + `consistency` check type (phase 2) — design

Phase 2 of the language-specific rule expansion (see
`2026-07-07-rule-packs-en-de-design.md` for the pack mechanism and the
phasing decision). This phase adds Japanese general and pack rules and one
engine extension: a `consistency` check type for です・ます / だ・である
style uniformity. Phase 3 (FR/ES/IT/ZH) remains parked.

The pack mechanism, mandatory `examples` blocks, the catalog-wide example
test, rules-view pack sections, profile pack chips, and i18n pack names all
shipped in phase 1 and are reused unchanged.

## Design decisions (confirmed with owner)

| Topic | Decision |
|---|---|
| Document-scoped style check | New generic `consistency` check type (named variants, minority flagged); the `scope: document` occurrence extension sketched in phase 1 is dropped — it cannot express "don't mix" |
| Flagging granularity | Each minority-style sentence gets its own finding (span = sentence); ties broken by variant declaration order in the YAML |
| Rosters | 9 general JA rules + 7 pack rules (3 marketing, 3 techdocs, 1 blog) |
| Substitution + CJK | `\b` never matches between CJK word chars (verified); substitution gains edge-aware boundaries — CJK-edged key sides drop the assertion, Latin-edged sides keep `\b` |
| Severities | Same policy as phase 1: error = near-certain, warning = context-aware heuristic, suggestion = taste |
| Examples | Mandatory `examples` block on every new rule (phase 1 invariant) |

## 1. `consistency` check type (engine)

A fifth check type alongside existence / substitution / occurrence /
token_pattern / dependency. It classifies each **sentence** of the document
into a named variant; if the document mixes variants, every sentence of a
**minority** variant becomes a finding.

### RuleSpec additions (`loader.py`)

```python
class VariantSpec(BaseModel):
    pattern: list[dict[str, Any]] | None = None   # spaCy Matcher pattern
    anchor: Literal["end", "anywhere"] = "anywhere"
    default: bool = False                          # at most one per rule

class RuleSpec(BaseModel):
    ...
    variants: dict[str, VariantSpec] | None = None  # consistency only
```

Validation (load-time, `RuleError` on violation, non-fatal as usual):

- `extends: consistency` requires `variants` with **≥ 2 entries**.
- At most one variant may set `default: true`; a default variant needs no
  `pattern` (and any `pattern` on it is rejected — ambiguous intent).
- Every non-default variant requires a non-empty `pattern`.
- `consistency` joins `NLP_CHECK_TYPES`: it needs the spaCy doc, its
  patterns are validated against the language's vocab at load time, and it
  is skipped-and-reported when the pipeline is unavailable (same behavior
  as token_pattern / dependency).

### Classification algorithm (`checks/consistency.py`)

Per sentence (using the doc's sentence segmentation, as occurrence does):

1. **Strip the tail**: ignore trailing `PUNCT`, `SYM`, `PART`, and space
   tokens. This drops 。？！ and 終助詞 (か・ね・よ), so 「行きますか？」
   ends at ます.
2. **Pattern variants first**: run each non-default variant's Matcher over
   the sentence, in YAML declaration order; the first variant that matches
   claims the sentence. With `anchor: end`, only matches whose **last token
   lies within the last 3 tokens** of the stripped sentence count — this
   catches 〜ました (まし=ます + た) and 〜でしょう (でしょ=です + う)
   while ignoring quoted polite forms mid-sentence
   (「彼は『便利です』と言った。」 stays plain).
3. **Default variant**: if no pattern matched, a `default` variant exists,
   and the stripped sentence **ends in a `VERB`, `ADJ`, or `AUX` token**
   (a predicate ending), the sentence belongs to the default variant.
4. **Otherwise unclassified**: headings (「はじめに」 ends ADP), labels
   (「概要:」 ends SYM→NOUN after stripping), and 体言止め (「結果は次の
   通り。」 ends NOUN) neither vote nor get flagged.

Then over the whole document:

- Count sentences per variant. If **fewer than two** variants have ≥ 1
  sentence, no findings.
- **Majority** = the variant with the most sentences; ties are broken by
  declaration order in the YAML (first-declared wins), so listing `polite`
  first makes 敬体 win a 50/50 tie deterministically.
- Every sentence of every non-majority variant yields one finding with the
  sentence as its span and the rule's static `message` (no `%s`
  interpolation — same convention as occurrence).

### The です・ます rule (`rules/ja/style/desu-masu.yml`)

```yaml
extends: consistency
message: "文体が混在しています — 敬体（です・ます）と常体（だ・である）のどちらかに統一してください。"
level: warning
category: style
variants:
  polite:            # 敬体 — declared first: wins ties
    pattern:
      - {LEMMA: {IN: [です, ます]}, POS: AUX}
    anchor: end
  plain:             # 常体 — any other predicate ending (だ, である, plain verb/adj)
    default: true
examples:
  bad:
    - "本製品は高速です。設定も簡単だ。導入も容易です。"
  good:
    - "本製品は高速です。設定も簡単です。"
    - "本製品は高速だ。設定も簡単である。"
```

GiNZA evidence backing the classifier (probed 2026-07-07):
食べれるようになりました ends まし(LEMMA=ます,AUX)+た(AUX);
設定は簡単である ends で(LEMMA=だ,AUX)+ある(VERB);
高速だ ends だ(AUX); 行きますか？ ends ます+か(PART)+？ —
stripping PART/PUNCT exposes ます; はじめに ends に(ADP) → unclassified.

### Example-test interaction

The catalog-wide example test (`test_rule_examples.py`) runs each `bad`
sentence and asserts the rule fires. For consistency rules a *single*
sentence can never mix styles, so each `bad` example must be a
**multi-sentence string** (as above). No test-harness change is needed —
the harness already feeds whole example strings through `RuleEngine.check`.

## 2. General Japanese rules (9 new)

All under `backend/rules/ja/`. Exact token analyses were probed against
GiNZA (`ja_ginza`, split_mode C); patterns below reflect real output.
Curated lists are precision-first: they may grow later, false positives at
`warning`+ are unacceptable.

### grammar/ranuki.yml — ら抜き言葉 (token_pattern, warning)

GiNZA tokenizes ら抜き potentials as a **single token whose lemma is the
ら抜き form itself** (食べれる → LEMMA=食べれる), so a lemma list catches
every conjugation (見れます, 見れない, 見れれば…):

```yaml
pattern:
  - {LEMMA: {IN: [見れる, 食べれる, 来れる, 出れる, 寝れる, 起きれる,
                  着れる, 降りれる, 決めれる, 信じれる, 覚えれる, 変えれる]},
     POS: VERB}
```

Godan potentials (走れる, 読める) are legitimate and are simply not in the
list. Message suggests the ら-inclusive form (「見られる」など).

### grammar/sa-ire.yml — さ入れ言葉 (existence raw, warning)

Godan 未然形 stem + させ is さ入れ; ichidan 見させる is legal causative.
Curated godan stems only:

```yaml
raw: '(?:行か|読ま|書か|飲ま|休ま|待た|帰ら|取ら|作ら|置か|急が|払わ)させ'
```

### grammar/nijuu-keigo.yml — 二重敬語 〜になられる (existence raw, warning)

The bare pattern に+なる+れる is **not** reliable: 「社長になられました」
is legitimate single 尊敬語 (plain なる + honorific られる), while
「ご覧になられます」 doubles the honorific because ご覧になる is already
尊敬語. The safe signal is the お/ご prefix, so this is a curated raw list
(precision-first, extendable):

```yaml
raw:
  - 'ご覧になられ'
  - 'お読みになられ'
  - 'お越しになられ'
  - 'お帰りになられ'
  - 'お聞きになられ'
  - 'お会いになられ'
  - 'お使いになられ'
```

Message: 尊敬語「お/ご〜になる」 already suffices; drop られる.

### grammar/nijuu-keigo-honorific.yml — おっしゃられる型 (token_pattern, warning)

Honorific verbs already carry 尊敬 meaning; adding られる doubles it:

```yaml
pattern:
  - {LEMMA: {IN: [おっしゃる, なさる, いらっしゃる, 召し上がる, くださる]}}
  - {LEMMA: れる, POS: AUX}
```

### clarity/no-renzoku.yml — の連続 (token_pattern, suggestion)

Three or more chained genitive の (probed: の is ADP/助詞-格助詞):

```yaml
pattern:
  - {POS: NOUN}
  - {TEXT: の}
  - {POS: NOUN}
  - {TEXT: の}
  - {POS: NOUN}
  - {TEXT: の}
  - {POS: NOUN}
```

PRON heads (私の…) deliberately excluded from the first slot to keep the
pattern simple; the chain still fires on the three NOUN-の links that
follow. Message: restructure with 助詞 or split the phrase.

### style/wo-okonau.yml — 「検討を行う」型の冗長 (token_pattern, suggestion)

サ変 noun + を + 行う is a light-verb detour for the plain verb (検討を行う
→ 検討する). サ変 nouns carry TAG 名詞-普通名詞-サ変可能:

```yaml
pattern:
  - {TAG: 名詞-普通名詞-サ変可能}
  - {TEXT: を}
  - {LEMMA: 行う}
```

### style/juufuku-hyougen.yml — 重複表現 (substitution, warning)

```yaml
swap:
  一番最初: 最初
  一番最後: 最後
  後で後悔: 後悔
  違和感を感じ: 違和感を覚え
  過半数を超え: 半数を超え
  まだ未定: 未定
  必ず必要: 必要
```

**Requires a small engine fix** (verified 2026-07-07): both the
substitution check and the existence check's `tokens:` wrap keys in
`\b…\b`, and `\b` never fires between two word characters — kana/kanji are
word characters, so `\b一番最初\b` does **not** match 「彼は一番最初に…」.
Fix: a shared `bounded_pattern(fragment)` helper in `rules/text.py`, used
by `checks/substitution.py` and `checks/existence.py`, that wraps each
key individually and drops the boundary assertion on any side whose edge
character is CJK (Han, Hiragana, Katakana, CJK punctuation, full-width
forms); all other keys keep `\b` on that side, so existing EN/DE rules are
byte-for-byte unchanged. `raw:` entries stay unwrapped as today. Keys
mixing widths **inside** CJK text (業界No.1 — ends in a Latin digit that
would demand a `\b` before a following kana) go into `raw:` with
hand-written patterns instead. This also unblocks ZH in phase 3.
Pinned by tests: a JA swap key and a JA existence token match
mid-sentence; an EN key still refuses to match inside a longer word.

### style/redundant-phrases.yml — 冗長表現 (substitution, suggestion)

```yaml
swap:
  することが可能です: できます
  することができません: できません
  という結果になりました: という結果でした
  を行うことができ: でき
```

Complements the existing `redundant-potential` token_pattern rule with
fixed-string variants it does not reach. Depends on the same CJK-boundary
engine fix as juufuku-hyougen.

### style/desu-masu.yml — 文体統一 (consistency, warning)

Specified in section 1.

## 3. Japanese pack rules (7 new)

### marketing (3)

- **style/hype-words.yml** (existence, suggestion): 究極, 最強, 絶対,
  圧倒的, 爆速, 神レベル, 革命的, 異次元. Message: show, don't tell.
- **style/unverifiable-claims.yml** (existence, warning): 日本一,
  世界初, 業界No.1, 満足度No.1, 世界一, 国内初 — legal-risk claims that
  need substantiation (景品表示法). Mixed-width claims (業界No.1) as
  `raw:` patterns; pure-CJK ones as `tokens:`. Lives under `style/` to
  match the EN pack convention (`rules/en/style/unverifiable-claims.yml`).
- **style/exclamation-inflation.yml** (existence raw, suggestion):
  `[！!]{2,}` runs plus occurrence-style overuse folded into one raw
  alternation: `(?:[！!]{2,})`. One ！ is emphasis; more is shouting.

### techdocs (3)

- **style/i-nuki.yml** (token_pattern, warning): い抜き言葉 — GiNZA
  tokenizes してる as し + てる(AUX, LEMMA=てる):

  ```yaml
  pattern:
    - {LEMMA: {IN: [てる, でる]}, POS: AUX}
  ```

  Note: でる as AUX lemma is the 〜でる contraction (読んでる); the verb
  出る is POS VERB, so the AUX constraint keeps it safe. The implementer
  probes 読んでる/泳いでる before finalizing.
- **style/hedging.yml** (token_pattern, warning): と思います /
  かもしれません in instructions — state facts:

  ```yaml
  pattern:
    - {TEXT: と}
    - {LEMMA: 思う}
  ```

  A second alternation for かもしれない goes in the same file only if the
  formalism gains multi-pattern support; otherwise かもしれません joins the
  message as advice and the pattern stays single (YAGNI — one pattern per
  rule is the phase-1 status quo).
- **style/casual-contractions.yml** (token_pattern, warning): ちゃう /
  じゃう / とく contractions of てしまう / ておく. Exact GiNZA analysis is
  probed during implementation (expected: AUX with lemma ちゃう / とく);
  if the parse is unstable, fall back to existence raw
  `(?:しちゃ|じゃっ|しとく|しとい)` with a curated list.

### blog (1)

- **style/kotatsu-cliche.yml** (existence, suggestion): いかがでしたか,
  いかがだったでしょうか, 個人的な意見ですが, あくまで個人の感想です —
  the こたつ記事 closers/openers that pad affiliate-style posts.

## 4. Seeding, demos, docs

- **Blog profile → JA**: `BLOG_LANGUAGES` gains `JA`;
  `_BLOG_INSTRUCTIONS["ja"]` added; new demo `backend/demos/ja-blog.txt`
  (ends with いかがでしたか so the pack rule fires). Marker-gated seeding
  semantics are unchanged — existing installs that already ran the phase-1
  seed get the JA Blog profile via the same mechanism phase 1 used for new
  profiles (implementer follows whatever the seed marker logic dictates;
  if the marker blocks re-seeding, the JA Blog profile ships for fresh
  installs only and that is acceptable).
- **Demo fodder**: append pack-triggering paragraphs to
  `backend/demos/ja-marketing.txt` (hype + No.1 claim + ！！) and
  `backend/demos/ja-technical-documentation.txt` (してる + と思います).
- **Seeded JA profiles**: the phase-1 JA Marketing / Technical
  Documentation profiles already carry `packs_on: ["marketing"]` /
  `["techdocs"]`; the new pack rules activate there automatically. This is
  the intended payoff of phase 1's seeding, not a migration.
- **`backend/rules/README.md`**: new "consistency" section in the check-type
  cookbook (variant semantics, tie-break, anchor, default-variant predicate
  gate, multi-sentence bad examples) + 16 new catalog rows + JA additions
  to "Known heuristic limitations" (curated-list recall for ら抜き/さ入れ,
  quoted-speech edge cases for 文体統一).
- **No frontend changes**: pack sections, example rendering, pack chips,
  and i18n pack names are slug-driven and already cover
  marketing/techdocs/blog.
- **Architecture docs + LOGBOOK**: update `docs/backend-architecture.md`
  (new check type) and append the work summary per convention.

## 5. Testing

- **Engine unit tests** (`test_rule_engine.py` or a new
  `test_consistency.py`): variant classification (polite/plain/default),
  minority flagging with correct spans, tie-break by declaration order,
  default-variant predicate gate (fragments/headings/体言止め unclassified),
  quoted-polite-inside-plain stays plain (anchor window), fewer-than-two
  variants → no findings, missing pipeline → skipped-and-reported,
  loader validation errors (0/1 variants, two defaults, default with
  pattern, non-default without pattern).
- **Substitution boundary fix**: JA swap key matches mid-sentence
  (「彼は一番最初に確認した。」 fires); EN key with `\b` semantics is
  unchanged (no match inside a longer word); mixed-edge key (e.g. starting
  Latin, ending CJK) gets the assertion only on the Latin side.
- **Catalog-wide example test**: all 16 new rules enroll automatically via
  their mandatory `examples`; consistency rules use multi-sentence bad
  examples.
- **Review protocol**: as phase 1, quality reviewers probe candidate false
  positives live through GiNZA (legit godan potentials for ら抜き, ichidan
  causatives for さ入れ, 出る-the-verb for い抜き, honorific-れる ambiguity).

## Out of scope

- Phase 3: FR/ES/IT/ZH rules.
- Multi-pattern support per rule file (each rule keeps exactly one
  pattern; near-variants become sibling rule files).
- `scope: document` for occurrence — superseded by `consistency`.
- Configurable preferred style per profile for 文体統一 (minority-based is
  zero-config; revisit only if users ask).
