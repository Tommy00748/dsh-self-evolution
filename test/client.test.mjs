/**
 * Smoke test for the Client half of dsh-self-evolution.
 *
 * The Client half is one file that only ever runs inside the Web UI, so a mistake there is invisible
 * from the outside: the module still loads, the card still shows, and the damage is only visible to
 * the eye (a stylesheet rule that went missing, a dictionary key that was never added). That already
 * happened once — a large hand-written edit dropped eighteen `.dshse-*` rules and a `t()` key while
 * `node --check` stayed happy.
 *
 * This test therefore loads the real `factory()` with a fake module loader and a fake Cordis context,
 * then checks the two halves against each other:
 *
 *   1. every `dshse-*` class name the components render has a rule in the stylesheet,
 *   2. every `animation:` name in the stylesheet has its `@keyframes`,
 *   3. every `t('...')` key the components ask for exists in both dictionaries,
 *   4. `prefers-reduced-motion` cancels every class the stylesheet animates.
 *
 * Run (from this directory; `node_modules` must resolve @deepseek-ai/* — link the installed app's):
 *   ln -s "/Applications/DeepSeek Harness.app/Contents/Resources/app/dsh/node_modules" node_modules
 *   node client.test.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.join(here, '..', 'client.js'), 'utf8');

/** Capture what the module registers: the injected stylesheet, the locale seat, the slots. */
const styles = [];
const dictionaries = new Map();
const slots = [];

/** Minimal `document.head` stand-in: enough for the style tag the module appends. */
const fakeDocument = {
	querySelector: () => null,
	createElement: () => ({ dataset: {}, id: '', textContent: '', remove: () => {} }),
	head: {
		appendChild: (tag) => {
			styles.push(tag);
		}
	}
};

/** The module registers itself through the Web UI's loader; capture the factory instead of running it. */
let factory = null;
globalThis.window = {
	localStorage: { getItem: () => null, setItem: () => {} },
	document: fakeDocument,
	__ModuleLoader__: {
		load: ({ factory: loaded }) => {
			factory = loaded;
		}
	}
};
globalThis.document = fakeDocument;

/** React is only reached from inside the components, so a placeholder is enough to load the module. */
const require = (name) => {
	if (name === 'react') return { createElement: () => null };
	throw new Error(`unexpected require(${name})`);
};

// `client.js` is a browser script, not an ES module: evaluate it with the loader stub in place.
new Function('window', 'document', source)(globalThis.window, fakeDocument);
assert.ok(factory !== null, 'the module did not register itself with the module loader');

const plugin = factory(require);
assert.equal(plugin.inject.includes('slots'), true, 'the plugin no longer injects the slots seat');
assert.equal(plugin.inject.includes('locale'), true, 'the plugin no longer injects the locale seat');

const disposers = [];
plugin.apply({
	effect: (fn) => disposers.push(fn()),
	locale: {
		register: (namespace, dicts) => {
			dictionaries.set(namespace, dicts);
			return () => {};
		}
	},
	slots: {
		inject: (name, callback) => {
			slots.push(name);
			callback();
		},
		register: (definition) => definition
	}
});

// --- the stylesheet arrived, and it is one well-formed block --------------------------------

assert.equal(styles.length, 1, 'expected exactly one injected style tag');
const css = styles[0].textContent;
assert.ok(css.length > 2000, `the injected stylesheet looks truncated (${css.length} chars)`);

const opens = (css.match(/{/g) ?? []).length;
const closes = (css.match(/}/g) ?? []).length;
assert.equal(opens, closes, `unbalanced braces in the stylesheet (${opens} open, ${closes} close)`);
assert.equal(css.includes('undefined'), false, 'the stylesheet contains `undefined`');
assert.equal(css.includes('${'), false, 'an interpolation was left unexpanded in the stylesheet');

/**
 * Split the stylesheet into top-level chunks (`selector{…}`, `@media …{…}`, `@keyframes name{…}`)
 * by counting braces, then read every declaration in a plain rule. A dropped `}` or a rule written
 * without its `{` shows up here as a chunk that is not shaped like a rule.
 */
function topLevelChunks(text) {
	const chunks = [];
	let depth = 0;
	let start = 0;
	for (let i = 0; i < text.length; i += 1) {
		const char = text[i];
		if (char === '{') depth += 1;
		else if (char === '}') {
			depth -= 1;
			if (depth === 0) {
				chunks.push(text.slice(start, i + 1));
				start = i + 1;
			}
		}
	}
	assert.equal(depth, 0, 'the stylesheet ends inside an unclosed block');
	assert.equal(text.slice(start).trim(), '', `trailing text outside any rule: ${text.slice(start, start + 60)}`);
	return chunks;
}

const chunks = topLevelChunks(css);
assert.ok(chunks.length >= 30, `expected a rule per class, found ${chunks.length}`);
for (const chunk of chunks) {
	if (chunk.startsWith('@')) continue;
	const brace = chunk.indexOf('{');
	assert.ok(brace > 0, `rule without a selector or without its opening brace: ${chunk.slice(0, 60)}`);
	assert.equal(chunk.endsWith('}'), true, `rule without its closing brace: ${chunk.slice(0, 60)}`);
	for (const declaration of chunk.slice(brace + 1, -1).split(';')) {
		if (declaration.trim() === '') continue;
		assert.match(
			declaration,
			/^\s*-{0,2}[a-z][a-zA-Z0-9-]*\s*:/,
			`not a CSS declaration: \`${declaration.trim().slice(0, 60)}\``
		);
	}
}

// --- 1. every class the components render is styled -----------------------------------------

/** Class names the stylesheet defines a rule for. */
const styled = new Set([...css.matchAll(/\.dshse-([a-zA-Z]+)/g)].map((m) => m[1]));
/** Class names the components pass to `className`. */
const rendered = new Set([...source.matchAll(/className: 'dshse-([a-zA-Z]+)'/g)].map((m) => m[1]));

assert.ok(rendered.size >= 25, `expected the card to render many classes, found ${rendered.size}`);
const unstyled = [...rendered].filter((name) => !styled.has(name)).sort();
assert.deepEqual(unstyled, [], `rendered but never styled: ${unstyled.join(', ')}`);

// --- 2. every animation name has its keyframes ----------------------------------------------

const animated = new Set([...css.matchAll(/animation:\s*(dshse-[a-z-]+)/g)].map((m) => m[1]));
const keyframes = new Set([...css.matchAll(/@keyframes\s+(dshse-[a-z-]+)/g)].map((m) => m[1]));
assert.ok(animated.size > 0, 'the stylesheet animates nothing');
for (const name of animated) {
	assert.ok(keyframes.has(name), `animation \`${name}\` has no @keyframes`);
}
for (const name of keyframes) {
	assert.ok(animated.has(name), `@keyframes \`${name}\` is never used`);
}

// --- 3. every `t('...')` key exists in every dictionary --------------------------------------

const dictionaries_ = dictionaries.get('self-evolution');
assert.ok(dictionaries_ !== undefined, 'the plugin no longer registers its dictionaries');
for (const [language, dict] of Object.entries(dictionaries_)) {
	for (const key of new Set([...source.matchAll(/\bt\('([a-zA-Z.]+)'/g)].map((m) => m[1]))) {
		assert.ok(key in dict, `t('${key}') has no ${language} string`);
	}
}

// --- 4. reduced motion cancels everything the stylesheet animates ----------------------------

const reduced = css.slice(css.indexOf('prefers-reduced-motion'));
assert.ok(reduced.length > 0, 'the stylesheet has no prefers-reduced-motion block');
/** Classes the reduced-motion block turns back off. */
const silenced = new Set([...reduced.matchAll(/\.dshse-([a-zA-Z]+)/g)].map((m) => m[1]));
/** Classes that carry an animation in their own rule. */
for (const rule of css.matchAll(/\.dshse-([a-zA-Z]+)(?:\[[^\]]*\])?\{([^}]*)\}/g)) {
	if (!/animation:/.test(rule[2])) continue;
	assert.ok(
		silenced.has(rule[1]),
		`.dshse-${rule[1]} animates but is not cancelled under prefers-reduced-motion`
	);
}

// --- 5. the transcript row actually renders --------------------------------------------------

/**
 * The row inside the conversation is driven by node data the Host supplies, so render it for real:
 * a fake React that keeps the element tree, one fake host node, and the registered component. The
 * collapse/expand buttons take a click handler; this calls it and checks the body appears.
 */
const created = [];
const fakeReact = {
	createElement: (type, props, ...children) => {
		const element = {
			type,
			props: props ?? {},
			children: children.flat().filter((child) => child !== null && child !== undefined && child !== false)
		};
		created.push(element);
		return element;
	},
	useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
	useEffect: () => {},
	useCallback: (fn) => fn,
	memo: (component) => component
};
const registered = new Map();
let capturedFactory = null;
globalThis.window.__ModuleLoader__ = { load: ({ factory: loaded }) => { capturedFactory = loaded; } };
new Function('window', 'document', source)(globalThis.window, fakeDocument);
const realRequire = (name) => {
	if (name === 'react') return fakeReact;
	throw new Error(`unexpected require(${name})`);
};
capturedFactory(realRequire).apply({
	effect: (fn) => fn(),
	locale: { register: () => () => {} },
	slots: {
		inject: (name, callback) => callback(),
		// `register(definition, component)` — the component is the second argument and is what the host
		// renders for that seat, so it is the thing this test must call.
		register: (definition, component) => {
			registered.set(`${definition.name}#${definition.key ?? ''}`, component ?? definition);
			return definition;
		}
	}
});
const rowSlot = registered.get('conversation.chat.node#context');
assert.ok(rowSlot !== undefined, 'the transcript row is no longer registered on the context node');
const rowComponent = rowSlot;
assert.equal(typeof rowComponent, 'function', 'the context node seat no longer holds a component');

/** Render the row once and hand back the tree it produced. */
function renderRow(node) {
	created.length = 0;
	const tree = rowComponent({ node, t: (key, params) => `${key}${params === undefined ? '' : JSON.stringify(params)}` });
	return { tree, elements: [...created] };
}

const hostNode = {
	data: {
		time: 1700000000000,
		producer: { role: 'inject', label: '记住了一条经验：本机构建命令是 pnpm build' },
		content: [{ type: 'text', text: '[自我进化记录] 正文第一段\n正文第二段' }]
	}
};
const collapsed = renderRow(hostNode);
const collapsedClasses = collapsed.elements.map((element) => element.props.className).filter(Boolean);
assert.ok(collapsedClasses.includes('dshse-row'), 'the row renders without its own class');
assert.ok(collapsedClasses.includes('dshse-rowText'), 'the collapsed line is missing');
assert.equal(
	collapsedClasses.includes('dshse-rowBody'),
	false,
	'the row renders its body while collapsed'
);
const summaryText = collapsed.elements
	.filter((element) => element.props.className === 'dshse-rowText')
	.flatMap((element) => element.children)
	.join('');
assert.equal(summaryText, hostNode.data.producer.label, 'the collapsed line is not the record summary');

// The chevron is the expand toggle; clicking it must reveal the injected body verbatim.
const chevron = collapsed.elements.find((element) => element.props.className === 'dshse-rowChevron');
assert.ok(chevron !== undefined, 'the row has no expand toggle');

/** Render an expanded row by flipping the component's own state through its click handler. */
let openState = null;
const statefulReact = {
	...fakeReact,
	useState: (initial) => {
		if (openState === null) openState = typeof initial === 'function' ? initial() : initial;
		return [openState, (next) => { openState = typeof next === 'function' ? next(openState) : next; }];
	}
};
const statefulRequire = (name) => {
	if (name === 'react') return statefulReact;
	throw new Error(`unexpected require(${name})`);
};
capturedFactory(statefulRequire).apply({
	effect: (fn) => fn(),
	locale: { register: () => () => {} },
	slots: {
		inject: (name, callback) => callback(),
		register: (definition, component) => {
			registered.set(`${definition.name}#${definition.key ?? ''}`, component ?? definition);
			return definition;
		}
	}
});
const statefulRow = registered.get('conversation.chat.node#context');
created.length = 0;
statefulRow({ node: hostNode, t: (key) => key });
const toggle = created.find((element) => element.props.className === 'dshse-rowChevron');
toggle.props.onClick();
assert.equal(openState, true, 'clicking the chevron does not open the row');
// The stub keeps the flipped value in `openState`, so the next render is the open one.
created.length = 0;
statefulRow({ node: hostNode, t: (key) => key });
globalThis.__opened = openState;
const openedBody = created.find((element) => element.props.className === 'dshse-rowBody');
assert.ok(openedBody !== undefined, 'the opened row still renders no body');
const openedText = openedBody.children.join('');
assert.equal(
	openedText,
	'[自我进化记录] 正文第一段\n正文第二段',
	'the expanded row does not show the injected body verbatim'
);

console.log(`client.test.mjs: ok — ${rendered.size} classes styled, ${animated.size} animations, ${Object.keys(dictionaries_).join('/')} dictionaries, transcript row verified`);
