There is one thing this project knows about itself that is worth writing down: **a plugin's client half can lose its own stylesheets without anyone noticing.**

`client.js` is a browser module. A mistake in it is invisible from the outside — the module still loads and the card still renders. A hand-written edit during development once dropped 18 stylesheet rules and one translation key; `node --check` stayed happy, the UI still looked fine at a glance, and the only symptom was that the panel's text had quietly fallen back to browser defaults.

So the rule this project follows: **never rewrite a large part of `client.js` with a script.** Use small, targeted edits, and run the check below afterwards. It takes a second and it is the only thing standing between "looks fine" and "actually fine".

```bash
node test/client.test.mjs
```

It evaluates the real `factory()` with a stub module loader and a fake Cordis context, then cross-checks the file against itself:

- every `dshse-*` class the components render has a rule in the stylesheet,
- every `animation:` name has its `@keyframes`, and every `@keyframes` is used,
- every `t('…')` key exists in **both** dictionaries,
- `prefers-reduced-motion` cancels every class that animates,
- the stylesheet is one well-formed block (balanced braces, no declaration-shaped garbage).

It also renders the transcript row for real and checks the collapsed line, the expand toggle, and that the expanded body is the injected text verbatim.

For the host half (`index.js`), `node test/host.test.mjs` does the equivalent job against a fake Cordis context — registration surface, the memory write path, the provenance ledger, the approval queue, the endpoints, the background review driven by a fake model stream, and the transcript row that review appends.

One trap in that half is worth knowing about before you edit it: **the plugin's conversation-row writer swallows every error.** An observability aid that could fail a review is worse than a missing line, so the write is wrapped in a `try`/`catch` that discards the exception — which means a wrong service accessor or a typo in the row builder looks exactly like "the feature does nothing". When the row stops appearing, put a temporary `console.error(error.message)` inside that `catch` and run `node test/host.test.mjs` again; that is how both of the bugs in the row's first version were found.

## Layout

| Path | What it is |
|---|---|
| `index.js` | Host half: the `memory` / `skill_learn` / `skill_doctor` / `session_search` / `evolution_log` tools, the system-prompt section, the background review, the transcript row it appends, and the two HTTP routes |
| `client.js` | Client half: the card above the composer and the transcript row inside the conversation. Loaded as a browser module by DSH's Web UI — it must define `window.__ModuleLoader__.load({ id, factory })` and must not use `import` or `require` beyond `react` |
| `cordis.patch.yml` | The bundle layer: one `insert` row, so a profile can still address it by id `self-evolution` |
| `test/host.test.mjs` | Host half against a fake context |
| `test/client.test.mjs` | Client half cross-checks (the guard described above) |

Both halves are plain JavaScript with no build step and no dependencies of their own; they use what the DSH host already provides (`@deepseek-ai/dsh-tools`, `@deepseek-ai/dsh-llm`, `@deepseek-ai/schemastery` on the host side, the module loader's `react` on the client side).

## The two halves reload differently

| Changed | Takes effect |
|---|---|
| `client.js` | Immediately: DSH polls client artifacts, notices they changed, and reloads the plugin in the browser. No restart, no page refresh. |
| `index.js` | Only after restarting DSH — module caching is keyed by URL, so replacing the file does not reload it in a running process. |
