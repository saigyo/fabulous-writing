# Architecture atlas

An interactive map of Fabulous Writing: its components, the processes that
run through them, the third-party services it uses, and how it is built and
deployed. Open `index.html` in a browser (a local file works; no server or
build step needed).

- Drag to pan, scroll or pinch to zoom; zooming in shows more detail.
- Click a component for its description, key files, connections and the
  processes it takes part in.
- Pick a process in the left panel and step through it with ← and →.
- Links like `index.html#flow=llmcheck&step=3` or `index.html#node=b-gate`
  open a specific process step or component.

## Files

- `atlas-data.js` holds all content: zones, components, connections and
  processes. Update it when the architecture changes.
- `atlas.js` renders the data and handles interaction.
- `index.html` holds the page structure and styles.

Content was written from `docs/backend-architecture.md`,
`docs/frontend-architecture.md`, `docs/browser-extension.md`,
`docs/fly-deployment.md` and the code as of v0.7.3. Those documents stay the
detailed reference; the atlas links to them.
