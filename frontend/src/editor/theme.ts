import {
  defaultHighlightStyle,
  HighlightStyle,
  syntaxHighlighting,
} from '@codemirror/language'
import { Compartment, type Extension } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { tags } from '@lezer/highlight'

const QUERY = '(prefers-color-scheme: dark)'

// dark: true flips CM's darkTheme facet, activating the complete built-in
// dark chrome (caret #ddd, focused selection #233, dark active line,
// panels, tooltips). The body token-aligns only the gutter family;
// caret/selection/active line keep the proven base-dark values. No gutter
// border: CM's dark base draws none (width/style exist only under its
// &light rules), so a color alone would be dead config (#66).
const darkChrome = EditorView.theme(
  {
    '.cm-gutters': {
      backgroundColor: 'var(--panel)',
      color: 'var(--text-dim)',
    },
    '.cm-activeLineGutter': {
      backgroundColor: 'var(--bg-raised)',
    },
  },
  { dark: true },
)

// basicSetup registers defaultHighlightStyle as a FALLBACK highlighter;
// a main highlighter — which a themeType:'dark' style is while the dark
// facet is on — replaces the fallback wholesale rather than layering on
// it. So the dark style is the default's own specs with exactly two
// color substitutions; every non-color decoration (heading
// bold+underline, strong, emphasis, link underline) survives verbatim.
// The two: the tags.meta entry (#404740 — markdown formatting marks via
// processingInstruction's tag-parent fallback) and the array entry
// carrying tags.url/tags.contentSeparator (#219 — link destinations and
// thematic breaks; the entry also carries atom/bool/labelName —
// atom/bool are unreachable under CommonMark; labelName covers CodeInfo
// and LinkLabel, which want the same treatment), both unreadable on the
// dark canvas.
export const darkSpecs = defaultHighlightStyle.specs.map((spec) =>
  spec.tag === tags.meta
    ? { ...spec, color: 'var(--text-dim)' }
    : Array.isArray(spec.tag) && spec.tag.includes(tags.url)
      ? { ...spec, color: 'var(--accent)' }
      : spec,
)

const darkMarkdownColors = syntaxHighlighting(
  HighlightStyle.define(darkSpecs, { themeType: 'dark' }),
)

// Module-level singleton shared across editor remounts — a Compartment
// is just a reconfiguration key, safe to reuse.
const compartment = new Compartment()

function forScheme(dark: boolean): Extension {
  // Light mode contributes zero style rules — the light editor must stay
  // byte-identical (spec: no declared light-mode diffs).
  return dark ? [darkChrome, darkMarkdownColors] : []
}

/** Theme extension pre-loaded for the OS scheme at view creation. */
export function editorTheme(): Extension {
  return compartment.of(forScheme(window.matchMedia(QUERY).matches))
}

/**
 * Follow live OS theme changes. Returns the cleanup that unregisters the
 * listener; callers run it before destroying the view.
 */
export function watchTheme(view: EditorView): () => void {
  const media = window.matchMedia(QUERY)
  const onChange = (event: MediaQueryListEvent) => {
    view.dispatch({
      effects: compartment.reconfigure(forScheme(event.matches)),
    })
  }
  media.addEventListener('change', onChange)
  return () => media.removeEventListener('change', onChange)
}
