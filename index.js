/**
 * Self-evolution for DSH: bounded self-managed memory + skill distillation + skill health check.
 *
 * The three capabilities Hermes Agent ships and DSH lacks, rebuilt on DSH's own primitives:
 *
 * 1. `memory` — a bounded, entry-based, agent-curated memory store (Hermes `MEMORY.md` / `USER.md`
 *    semantics: `§`-separated entries, hard character limits, exact-duplicate rejection, overflow
 *    reported with the current entries so the model consolidates in the same turn, plus an
 *    injection/exfiltration/invisible-character scan before anything becomes durable).
 * 2. `skill_learn` — the write side of procedural memory: author or patch a `SKILL.md` under a
 *    scanned skill root. It always emits quoted YAML scalars and re-reads + re-lints the file after
 *    writing, so a written skill can never be silently dropped by the skill loader.
 * 3. `skill_doctor` — the curator Hermes has and DSH does not: it scans every skill root DSH
 *    actually reads, reports skills that the loader would silently discard, and (opt-in) repairs the
 *    one class of frontmatter damage it can fix surgically.
 *
 * A prompt section injects both the memory entries and a short, stable learning-loop nudge.
 *
 * Trust boundary: this plugin writes with `node:fs` from the Host process, so its writes are NOT
 * subject to the session file sandbox. Every default path is explicit and configurable; see README.
 *
 * @module dsh-self-evolution
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import z from '@deepseek-ai/schemastery';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { BlockAssembler, boundContextSummary, createUserMessage } from '@deepseek-ai/dsh-llm';

export const name = 'self-evolution';
export const inject = ['tools', 'systemPrompt', 'agents'];
/** The injected agent registry: `get(sessionId)` answers the live agent, or undefined. */
let agentRegistry = null;

/**
 * The durable conversation line this plugin writes when a turn taught it something.
 *
 * Hermes renders its own review result as a persistent system row inside the transcript ("💾
 * Self-improvement review: …") and its source says that line "must not be a transient toast that
 * can be missed". DSH has no system-role row a plugin can append, but it does have the durable
 * `notice` context row: a user-role message whose source carries a producer kind, a short summary
 * (drawn collapsed, so it is readable without expanding), and a model-facing body. That is the same
 * thing in DSH's own vocabulary — a line in the conversation, not a card above the composer.
 *
 * The body is prefixed with a bracketed marker: the row is logged as a user message, so without it
 * a model reading the transcript back could mistake the record for something the person asked for.
 */
const TRANSCRIPT_KIND = 'self-evolution';
/** How many remembered entries the transcript body lists before it only counts the rest. */
const TRANSCRIPT_ENTRY_LIMIT = 8;

/** Entry delimiter, matching Hermes' `MEMORY.md` format so the two are interchangeable. */
const ENTRY_SEPARATOR = '\n§\n';
const DEFAULT_MEMORY_LIMIT = 2200;
const DEFAULT_USER_LIMIT = 1375;
/** The skill catalog truncates a description beyond this, so a longer one is rejected at write time. */
const MAX_DESCRIPTION_CHARS = 500;
const KEBAB = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** Zero-width and bidirectional-control characters: invisible text that can smuggle instructions. */
const INVISIBLE = /[\u200B-\u200F\u2028\u2029\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/u;
/** Content classes that must never become durable, always-injected text. */
const THREAT_PATTERNS = [
	{ re: /ignore (?:all |any |the )?(?:previous|prior|above) (?:instruction|prompt|rule)/i, why: 'instruction-override attempt' },
	{ re: /disregard (?:your|all|any|the) (?:previous |prior |earlier )?(?:instruction|rule|prompt)/i, why: 'instruction-override attempt' },
	{ re: /(?:reveal|print|dump|show|leak|exfiltrate)[^\n]{0,40}\b(?:system|developer) prompt\b/i, why: 'system-prompt exfiltration' },
	{ re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/, why: 'private key material' },
	{ re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/, why: 'cloud access key' },
	{ re: /\bsk-[A-Za-z0-9_-]{20,}\b/, why: 'API secret' },
	{ re: /\bauthorized_keys\b/i, why: 'SSH persistence instruction' },
	{ re: /\bcurl\b[^\n]{0,120}\|\s*(?:ba|z|k)?sh\b/i, why: 'remote-script pipe' }
];

const GUIDANCE = [
	'写入时机（自省，不要等用户提醒）：',
	'- 复杂任务收尾后（≥5 次工具调用、走过弯路、或用户纠正过你）：用 `memory` 写入**稳定的**事实、偏好、环境约束与教训；用 `skill_learn` 把**可复用的流程**沉淀成技能。',
	'- 只记会改变未来行为的结论，不记流水账、不记能从代码或文档重新查到的东西。',
	'- 写入前先 `memory` + `action: "list"` 看容量；接近上限时先合并或删除旧条目，再新增。',
	'- 与用户确认过的纠正优先级最高：那是跨会话最值得保留的信号。',
	'怎么写（这条用户明确要求过）：',
	'- **一律用简体中文、大白话**。一条记忆一到两句讲完，别堆术语；非写缩写不可时用括号补一句人话解释。',
	'- 写给人看的，不是写给编译器看的：先说结论、再说为什么，不要贴代码、不要抄工具输出。',
	'- 技能描述也照此办理：一句话说清「什么时候用它」。'
].join('\n');

/**
 * Config schema for one activation. Every tunable lives here so a deployment changes values in
 * `cordis.patch.yml` and keeps them across upgrades.
 */
export const Config = z.object({
	/** Directory holding `MEMORY.md` and `USER.md`; defaults to `<dshHome>/self-evolution`. */
	storeDir: z.string().default(''),
	memoryCharLimit: z.number().min(200).step(1).default(DEFAULT_MEMORY_LIMIT),
	userCharLimit: z.number().min(200).step(1).default(DEFAULT_USER_LIMIT),
	/** Extra skill roots (absolute paths) scanned by `skill_doctor` alongside DSH's own roots. */
	extraSkillDirs: z.array(z.string()).default([]),
	/** Where `skill_learn` writes when a call does not name a root; defaults to `<projectRoot>/.dsh/skills`. */
	skillsDir: z.string().default(''),
	enableMemoryTool: z.boolean().default(true),
	enableSkillTools: z.boolean().default(true),
	/** Inject the learning-loop guidance block. Off keeps only the memory entries. */
	guidance: z.boolean().default(true),
	/** Scan memory content for injection/exfiltration/invisible characters before it becomes durable. */
	scanOnWrite: z.boolean().default(true),
	/** Run the background self-improvement review after each turn. */
	autoReview: z.boolean().default(true),
	/** Skip turns with fewer than this many tool calls or results: trivial turns teach nothing. */
	reviewMinSteps: z.number().min(0).step(1).default(2),
	/**
	 * Output budget for one review reply. Chinese costs more tokens per character than English and a
	 * skill proposal carries a whole markdown body, so a budget tuned for English silently truncates a
	 * Chinese answer — and a truncated stream is not `stop`, which the reviewer treats as "learned
	 * nothing". Raised for the Chinese-output requirement.
	 */
	reviewMaxTokens: z.number().min(1).step(1).default(1200),
	/** How many recent turn events the reviewer sees, and the character cap on that transcript. */
	reviewMaxEvents: z.number().min(4).step(1).default(40),
	reviewMaxChars: z.number().min(500).step(1).default(6000),
	/** Reviewer model route; empty means the session's own routed provider and model. */
	reviewProvider: z.string().default(''),
	reviewModel: z.string().default(''),
	reviewTimeoutMs: z.number().min(1000).step(1).default(90000),
	/** Let the reviewer improve an existing skill instead of always creating a near-duplicate one. */
	reviewSkillUpdates: z.boolean().default(true),
	/** How many existing skills the reviewer sees, so it can recognize "this is the same thing". */
	reviewSkillCatalog: z.number().min(0).step(1).default(40),
	/** A merged skill body beyond this many characters is refused, and the previous version is kept. */
	skillMaxChars: z.number().min(1000).step(1).default(12000),
	/**
	 * Write one durable row into the conversation transcript after each review that learned something,
	 * the way Hermes prints its review line: the record stays readable when scrolling back, instead of
	 * living only in the card above the composer. The card remains for changes waiting on a decision.
	 */
	transcriptRow: z.boolean().default(true),
	/** Learning-timeline file; defaults to `<storeDir>/learnings.jsonl`. */
	learningLog: z.string().default(''),
	/**
	 * Web UI footprint. `auto` (default) keeps the learning card hidden until there is news — a new
	 * learning, or a change waiting for approval — and leaves one small glyph in the composer's stats
	 * row as the way back in. `always` (and the legacy `dock`/`icon`/`strip`) keeps the card on screen.
	 * `off` removes both.
	 */
	uiMode: z.union(['auto', 'always', 'dock', 'icon', 'strip', 'off']).default('auto'),
	/**
	 * How loudly the card announces new learning, mirroring Hermes' `display.memory_notifications`:
	 * `off` never announces (the card stays quiet), `on` names the operation, `verbose` adds what was
	 * actually saved. The announce is a one-line reveal inside the card, not a transient toast: a
	 * toast can be missed, and Hermes' own desktop notes say the same thing about its transcript line.
	 */
	notify: z.union(['off', 'on', 'verbose']).default('verbose'),
	/**
	 * The unattended review may always ADD memories, but its deletions and rewrites are queued for the
	 * human instead of applied. Copied from Hermes, where the background review "may not delete memory
	 * entries unattended" and stages them with `/memory pending` — the difference between "it remembers
	 * things for me" and "it edits my memory behind my back". Turn off only to let it consolidate alone.
	 */
	approveReviewEdits: z.boolean().default(true)
});

/** Resolve the Harness configuration root without importing an internal package. */
function dshHome() {
	const fromEnv = process.env.DSH_HOME;
	if (typeof fromEnv === 'string' && fromEnv.length > 0) return fromEnv;
	return path.join(os.homedir(), '.dsh');
}

/** A config string that may be absent when a caller passes a partial configuration. */
function configText(value) {
	return typeof value === 'string' ? value : '';
}

/** Resolve the store directory for the two memory files. */
function storeDir(config) {
	const configured = configText(config.storeDir);
	return configured.length > 0 ? path.resolve(configured) : path.join(dshHome(), 'self-evolution');
}

/** The memory file backing one target. */
function memoryFile(config, target) {
	return path.join(storeDir(config), target === 'user' ? 'USER.md' : 'MEMORY.md');
}

/** The character limit for one target. */
function charLimit(config, target) {
	return target === 'user' ? config.userCharLimit : config.memoryCharLimit;
}

/** Count Unicode code points, matching how the limit is displayed. */
function countChars(text) {
	return [...text].length;
}

/** Read one memory file as its entry list; a missing file is an empty store. */
function readEntries(file) {
	let raw;
	try {
		raw = fs.readFileSync(file, 'utf8');
	} catch (error) {
		if (error !== null && typeof error === 'object' && error.code === 'ENOENT') return [];
		throw error;
	}
	return raw
		.split(ENTRY_SEPARATOR)
		.map((entry) => entry.trim())
		.filter((entry) => entry.length > 0);
}

/** Render entries back to the stored format. */
function serializeEntries(entries) {
	return entries.length === 0 ? '' : `${entries.join(ENTRY_SEPARATOR)}\n`;
}

/** Total stored characters for an entry list. */
function entriesChars(entries) {
	return countChars(entries.join(ENTRY_SEPARATOR));
}

/** Render a `used/limit` usage string. */
function usageLabel(entries, limit) {
	return `${entriesChars(entries)}/${limit} chars`;
}

/** Write atomically: a same-directory temporary file then a rename. */
function writeAtomic(file, text) {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const tmp = `${file}.tmp-${process.pid}`;
	fs.writeFileSync(tmp, text, 'utf8');
	fs.renameSync(tmp, file);
}

/**
 * Check content that is about to become durable, always-injected text.
 * @returns a refusal reason, or `null` when the content is acceptable.
 */
function scanContent(content, enabled) {
	if (!enabled) return null;
	const invisible = content.match(INVISIBLE);
	if (invisible !== null) {
		const codes = [...new Set([...invisible[0]].map((c) => `U+${c.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}`))];
		return `content contains invisible characters (${codes.join(', ')}); remove them and retry`;
	}
	for (const { re, why } of THREAT_PATTERNS) {
		if (re.test(content)) return `content matches a blocked pattern (${why}); memory is injected into every future session's prompt, so this is refused`;
	}
	return null;
}

/** Find the nearest ancestor holding `.git`, falling back to the given directory. */
function projectRoot(cwd) {
	let current = path.resolve(cwd);
	for (;;) {
		if (fs.existsSync(path.join(current, '.git'))) return current;
		const parent = path.dirname(current);
		if (parent === current) return path.resolve(cwd);
		current = parent;
	}
}

/** The default skill root for `skill_learn`: the project-local root DSH scans at its highest rank. */
function defaultSkillsDir(config, cwd) {
	const configured = configText(config.skillsDir);
	if (configured.length > 0) return path.resolve(configured);
	const base = cwd === undefined || cwd.length === 0 ? process.cwd() : cwd;
	return path.join(projectRoot(base), '.dsh', 'skills');
}

/** Every skill root DSH actually reads, in the loader's own rank order. */
function skillRoots(config, cwd) {
	const base = cwd === undefined || cwd.length === 0 ? process.cwd() : cwd;
	const root = projectRoot(base);
	const roots = [
		// The configured write target comes first so the curator and the reviewer always see the
		// skills this plugin itself wrote, even when `skillsDir` moves off the default.
		defaultSkillsDir(config, base),
		path.join(root, '.dsh', 'skills'),
		path.join(root, '.agents', 'skills'),
		...(Array.isArray(config.extraSkillDirs) ? config.extraSkillDirs : []).map((dir) => path.resolve(dir)),
		path.join(dshHome(), 'skills'),
		path.join(os.homedir(), '.agents', 'skills')
	];
	return [...new Set(roots)];
}

/**
 * Split a skill file into its frontmatter block and body.
 *
 * The block is returned with LF endings whatever the file uses, because JavaScript's `.` does not
 * match `\r`: a CRLF key line cannot be matched by `^key: (.*)$` without normalization, which would
 * make every CRLF skill look like it has no `name` or `description` at all.
 * @returns `{ block, body, eol }`, or `null` when there is no frontmatter.
 */
function splitFrontmatter(text) {
	const match = text.match(/^---(\r?\n)([\s\S]*?)\r?\n---(\r?\n|$)/);
	if (match === null) return null;
	return { block: `${match[2].replace(/\r\n/g, '\n')}\n`, body: text.slice(match[0].length), eol: match[1] };
}

/** Reassemble a file from a parsed frontmatter, preserving the original line endings. */
function joinFrontmatter(block, body, eol) {
	return `---${eol}${eol === '\r\n' ? block.replace(/\n/g, '\r\n') : block}---${eol}${body}`;
}

/** Read one frontmatter key's raw (unparsed) inline value text. */
function rawValue(block, key) {
	const match = block.match(new RegExp(`^${key}:[ \\t]*(.*)$`, 'm'));
	return match === null ? undefined : match[1];
}

/**
 * Read a frontmatter value including YAML continuation lines, which is how a valid file may write a
 * long description:
 *
 * ```yaml
 * description:
 *   第一行
 *   第二行
 * ```
 *
 * Treating only the first line as the value makes that valid form look empty, so every consumer
 * must use this instead of {@link rawValue}.
 * @returns `{ inline, continuation }`, or `undefined` when the key is absent.
 */
function valueBlock(block, key) {
	const lines = block.split('\n');
	const pattern = new RegExp(`^${key}:[ \\t]*(.*)$`);
	const index = lines.findIndex((line) => pattern.test(line));
	if (index === -1) return undefined;
	const inline = lines[index].replace(new RegExp(`^${key}:[ \\t]*`), '');
	const continuation = [];
	for (let i = index + 1; i < lines.length; i += 1) {
		const line = lines[i];
		if (/^[ \t]/.test(line)) continuation.push(line.trim());
		else if (line.trim() === '') continue;
		else break;
	}
	return { inline, continuation };
}

/** The scalar a consumer should judge: block-scalar content is literal, everything else folds. */
function effectiveValue(value) {
	if (value === undefined) return undefined;
	const inline = value.inline.trim();
	if (inline.startsWith('|') || inline.startsWith('>')) return value.continuation.join('\n').trim();
	return [inline, ...value.continuation.map((line) => line.trim())].filter((part) => part.length > 0).join('\n');
}

/**
 * Lint a skill file the way the loader will read it. DSH drops a skill whose frontmatter fails to
 * parse, with no diagnostic anywhere, so these checks are the only place the failure can surface.
 *
 * `errors` are loadability failures: with any of them the loader discards the skill silently.
 * `warnings` are quality problems the loader tolerates (the catalog truncates a long description).
 * @returns `{ name, description, errors, warnings, problems }`.
 */
function lintSkill(text) {
	const errors = [];
	const warnings = [];
	const split = splitFrontmatter(text);
	if (split === null) return { name: undefined, description: undefined, errors: ['no `---` frontmatter block'], warnings, problems: ['no `---` frontmatter block'] };

	const nameBlock = valueBlock(split.block, 'name');
	const descriptionBlock = valueBlock(split.block, 'description');
	const nameText = effectiveValue(nameBlock);
	const descriptionText = effectiveValue(descriptionBlock);
	const parsedName = nameText === undefined ? undefined : unquote(nameText);
	const parsedDescription = descriptionText === undefined ? undefined : unquote(descriptionText);

	if (nameBlock === undefined) errors.push('missing `name`');
	else if (!KEBAB.test(parsedName)) errors.push(`\`name\` is not kebab-case: ${JSON.stringify(parsedName)}`);

	if (descriptionBlock === undefined) errors.push('missing `description`');
	else {
		const inline = descriptionBlock.inline.trim();
		// A block scalar's content is literal text: ": " inside it is data, not a mapping.
		const isBlock = inline.startsWith('|') || inline.startsWith('>');
		const isQuoted = inline.startsWith('"') || inline.startsWith("'");
		const singleLine = descriptionBlock.continuation.length === 0 || isBlock;

		if (parsedDescription.length === 0) errors.push('empty `description`');
		else if (isQuoted) {
			if (singleLine && !(inline.endsWith('"') || inline.endsWith("'"))) {
				errors.push('`description` opens a quote that never closes');
			}
		} else if (!isBlock) {
			// Each line of an unquoted (plain) scalar is subject to YAML's mapping rules.
			for (const line of parsedDescription.split('\n')) {
				if (line.includes(': ')) {
					errors.push('unquoted `description` contains ": " — YAML reads this as a nested mapping, the whole skill is discarded');
					break;
				}
				if (line.endsWith(':')) {
					errors.push('unquoted `description` ends with ":" — YAML reads this as a nested mapping that never opens');
					break;
				}
				if (line.includes(' #')) {
					errors.push('unquoted `description` contains " #" — YAML reads the rest as a comment');
					break;
				}
			}
		}
		if (countChars(parsedDescription) > MAX_DESCRIPTION_CHARS) {
			warnings.push(`\`description\` is ${countChars(parsedDescription)} chars; the catalog truncates past ${MAX_DESCRIPTION_CHARS}`);
		}
	}

	const keys = [...split.block.matchAll(/^([A-Za-z0-9_-]+):/gm)].map((m) => m[1]);
	const seen = new Set();
	for (const key of keys) {
		if (seen.has(key)) errors.push(`duplicate key \`${key}\``);
		seen.add(key);
	}
	if (/\t/.test(split.block)) errors.push('frontmatter contains a tab character');

	return { name: parsedName, description: parsedDescription, errors, warnings, problems: [...errors, ...warnings] };
}

/** Read a description out of a raw frontmatter value, undoing simple quoting. */
function unquote(value) {
	const trimmed = value.trim();
	if (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length > 1) {
		try {
			return JSON.parse(trimmed);
		} catch {
			return trimmed.slice(1, -1);
		}
	}
	if (trimmed.startsWith("'") && trimmed.endsWith("'") && trimmed.length > 1) return trimmed.slice(1, -1).replace(/''/g, "'");
	return trimmed;
}

/** Emit a YAML scalar that can never be misread: a JSON-quoted double-quoted scalar. */
function yamlScalar(value) {
	return JSON.stringify(value);
}

/** Compose a canonical, always-loadable skill file. */
function buildSkillFile(skillName, description, body) {
	const trimmedBody = body.replace(/^\s+/, '').replace(/\s+$/, '');
	return `---\nname: ${yamlScalar(skillName)}\ndescription: ${yamlScalar(description)}\n---\n\n${trimmedBody}\n`;
}

/** Locate one skill by directory name across the roots DSH reads. */
function findSkillFile(config, cwd, skillName) {
	for (const root of skillRoots(config, cwd)) {
		const bundled = path.join(root, skillName, 'SKILL.md');
		const flat = path.join(root, `${skillName}.md`);
		if (fs.existsSync(bundled)) return bundled;
		if (fs.existsSync(flat)) return flat;
	}
	return null;
}

/** The existing-skill catalog the reviewer sees, so it can recognize the same kind of task. */
function skillCatalog(config, cwd, limit) {
	if (limit <= 0) return [];
	const seen = new Set();
	const entries = [];
	for (const root of skillRoots(config, cwd)) {
		for (const candidate of listSkillFiles(root)) {
			if (seen.has(candidate.name)) continue;
			seen.add(candidate.name);
			let text;
			try {
				text = fs.readFileSync(candidate.file, 'utf8');
			} catch {
				continue;
			}
			const lint = lintSkill(text);
			if (lint.errors.length > 0) continue;
			const description = String(lint.description ?? '').replace(/\s+/g, ' ').slice(0, 180);
			entries.push(`- ${candidate.name}: ${description}`);
			if (entries.length >= limit) return entries;
		}
	}
	return entries;
}

/** Back up a file before a rewrite, so any automatic change can be undone. */
function backupFile(file) {
	const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
	fs.copyFileSync(file, `${file}.bak-${stamp}`);
}

/** Enumerate candidate skill files under one root, at the depth the loader reads. */
function listSkillFiles(root) {
	let dirents;
	try {
		dirents = fs.readdirSync(root, { withFileTypes: true });
	} catch (error) {
		if (error !== null && typeof error === 'object' && error.code === 'ENOENT') return [];
		throw error;
	}
	const files = [];
	for (const dirent of dirents) {
		if (dirent.name.startsWith('.')) continue;
		const full = path.join(root, dirent.name);
		// The loader follows symlinks, so a skill installed by symlink must be scanned too.
		let isDirectory = dirent.isDirectory();
		let isFile = dirent.isFile();
		if (dirent.isSymbolicLink()) {
			try {
				const target = fs.statSync(full);
				isDirectory = target.isDirectory();
				isFile = target.isFile();
			} catch {
				continue;
			}
		}
		if (isDirectory) {
			const bundled = path.join(full, 'SKILL.md');
			if (fs.existsSync(bundled)) files.push({ name: dirent.name, file: bundled });
		} else if (isFile && dirent.name.endsWith('.md')) {
			files.push({ name: dirent.name.slice(0, -3), file: full });
		}
	}
	return files;
}

/** Resolve the calling session's working directory. */
function sessionCwd(exec) {
	const cwd = exec?.agent?.session?.header?.cwd;
	return typeof cwd === 'string' && cwd.length > 0 ? cwd : process.cwd();
}

/** Render one recorded session event compactly enough for a read window. */
function compactEvent(event) {
	let text;
	try {
		text = typeof event.data === 'string' ? event.data : JSON.stringify(event.data);
	} catch {
		text = String(event.data);
	}
	const collapsed = String(text ?? '').replace(/\s+/g, ' ').trim();
	return collapsed.length > 400 ? `${collapsed.slice(0, 400)}…` : collapsed;
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared write paths. The model-facing tools and the automatic reviewer both go
// through these, so the scan, the bounds, and the read-back check cannot diverge.
// ─────────────────────────────────────────────────────────────────────────────

/** Collect the semantic text of one content-block list, the way the Harness does. */
function blocksText(content) {
	if (!Array.isArray(content)) return '';
	const parts = [];
	for (const block of content) {
		if (block === null || typeof block !== 'object') continue;
		if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
		else if (block.type === 'tool-call') parts.push(typeof block.name === 'string' ? block.name : '');
	}
	return parts.map((part) => part.trim()).filter((part) => part.length > 0).join('\n');
}

/** One compact, human-readable line for a transcript entry, or `null` when the event carries no text. */
function eventLine(event) {
	switch (event.type) {
		case 'user/message': return { role: 'USER', text: blocksText(event.data.content) };
		case 'assistant/message': return { role: 'ASSISTANT', text: blocksText(event.data.message?.content) };
		case 'tool/call': return { role: 'TOOL', text: `${String(event.data.name ?? '?')} ${String(event.data.arguments ?? '')}` };
		case 'tool/result': {
			const text = blocksText(event.data.message?.content);
			const failure = event.data.error === undefined || event.data.error === null ? '' : `ERROR ${String(event.data.error.name ?? '')}`;
			return { role: 'RESULT', text: [failure, text].filter((part) => part.length > 0).join(' ') };
		}
		default: return null;
	}
}

/** Add one memory entry under exactly the rules the `memory` tool enforces. */
function addMemoryEntry(config, target, content, origin = 'tool') {
	const limit = charLimit(config, target);
	const file = memoryFile(config, target);
	const entries = readEntries(file);
	const trimmed = content.trim();
	if (trimmed.length === 0) return { ok: false, message: 'empty entry' };
	const refusal = scanContent(trimmed, config.scanOnWrite);
	if (refusal !== null) return { ok: false, message: refusal, usage: usageLabel(entries, limit) };
	if (entries.includes(trimmed)) return { ok: true, message: 'no duplicate added', usage: usageLabel(entries, limit) };
	const next = [...entries, trimmed];
	if (entriesChars(next) > limit) return { ok: false, message: 'over the limit', usage: usageLabel(entries, limit), entries };
	writeAtomic(file, serializeEntries(next));
	writeOrigins(config, [{ target, content: trimmed, origin }]);
	return { ok: true, message: 'saved', usage: usageLabel(next, limit) };
}

/**
 * Write a skill with the same validation, canonical frontmatter, and read-back
 * check the `skill_learn` tool uses. Throws on anything that would leave an
 * unloadable skill behind.
 * @returns the written path and size.
 */
function writeSkill(config, cwd, { name, description, body, mode, root }) {
	const skillName = String(name ?? '').trim();
	if (!KEBAB.test(skillName)) throw new Error(`\`name\` must be kebab-case (got ${JSON.stringify(skillName)})`);
	const summary = String(description ?? '').trim();
	if (summary.length === 0) throw new Error('`description` must be a non-empty string');
	if (countChars(summary) > MAX_DESCRIPTION_CHARS) throw new Error(`\`description\` is ${countChars(summary)} chars; the catalog truncates past ${MAX_DESCRIPTION_CHARS}`);
	const text = String(body ?? '').trim();
	if (text.length === 0) throw new Error('`body` must be a non-empty string');

	const targetRoot = typeof root === 'string' && root.length > 0 ? path.resolve(root) : defaultSkillsDir(config, cwd);
	const file = path.join(targetRoot, skillName, 'SKILL.md');
	const exists = fs.existsSync(file);
	if (mode === 'create' && exists) throw new Error(`${file} already exists; use mode "replace" or "append"`);
	if (mode !== 'create' && !exists) throw new Error(`${file} does not exist; use mode "create"`);

	const previous = exists ? fs.readFileSync(file, 'utf8') : undefined;
	const next = mode === 'append' && previous !== undefined ? `${previous.replace(/\s+$/, '')}\n\n${text}\n` : buildSkillFile(skillName, summary, text);
	writeAtomic(file, next);

	const reread = fs.readFileSync(file, 'utf8');
	const lint = lintSkill(reread);
	if (lint.errors.length > 0 || lint.name !== skillName) {
		if (previous === undefined) fs.rmSync(file, { force: true });
		else writeAtomic(file, previous);
		throw new Error(`refusing to leave an unloadable skill at ${file}: ${lint.errors.join('; ') || 'name mismatch'}`);
	}
	return { path: file, chars: countChars(reread) };
}

/** Resolve the learning timeline file. */
function learningsFile(config) {
	const configured = configText(config.learningLog);
	return configured.length > 0 ? path.resolve(configured) : path.join(storeDir(config), 'learnings.jsonl');
}

/** Append one learning record; failures here must never break a session. */
function appendLearning(config, record) {
	try {
		const file = learningsFile(config);
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.appendFileSync(file, `${JSON.stringify(record)}\n`, 'utf8');
	} catch {
		// The timeline is an observability aid; never let it fail the review.
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Provenance and the approval queue.
//
// Two ideas, both copied from Hermes Agent, and both about trust rather than features:
//
// 1. Provenance: the card must let a person tell "it decided to remember this" apart from "I asked it
//    to remember this". The memory file itself may only contain the entry text (it is injected into
//    every prompt), so the source lives in a side ledger keyed by exact entry text.
// 2. Approval: unattended reviews may always ADD, but their deletions and rewrites are queued, with
//    the exact text they would destroy pinned at staging time — same as Hermes, where the background
//    review "may not delete memory entries unattended" and approval "lists the full text of every
//    entry it overwrote or removed", because the approver is the last one who can notice the loss.
// ─────────────────────────────────────────────────────────────────────────────

/** The provenance ledger: which stored entry came from the reviewer and which from a tool call. */
function originsFile(config) {
	return path.join(storeDir(config), 'origins.json');
}

/** Read the provenance ledger as `target\u0000text` → `{origin, t}`. A broken ledger reads as empty. */
function readOrigins(config) {
	try {
		const parsed = JSON.parse(fs.readFileSync(originsFile(config), 'utf8'));
		const out = new Map();
		if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
			for (const [key, value] of Object.entries(parsed)) {
				if (typeof key !== 'string') continue;
				const origin = value?.origin === 'auto' ? 'auto' : 'tool';
				out.set(key, { origin, t: typeof value?.t === 'number' ? value.t : 0 });
			}
		}
		return out;
	} catch {
		return new Map();
	}
}

/** The ledger key for one entry: target plus the exact text, because the text is the identity. */
function originKey(target, content) {
	return `${target}\u0000${content}`;
}

/**
 * Remember where one entry came from, and forget every entry that is no longer stored, so the ledger
 * cannot outgrow the memory files. Best-effort: provenance is a display aid, never a write blocker.
 * @param config - this deployment's configuration.
 * @param entries - the two stores' current entry lists, used to prune.
 * @param writes - `{target, content, origin}` records to set.
 */
function writeOrigins(config, writes) {
	try {
		const previous = readOrigins(config);
		const stored = { memory: readEntries(memoryFile(config, 'memory')), user: readEntries(memoryFile(config, 'user')) };
		const kept = new Map();
		for (const target of ['memory', 'user']) {
			for (const entry of stored[target]) {
				const known = previous.get(originKey(target, entry));
				if (known !== undefined) kept.set(originKey(target, entry), known);
			}
		}
		const now = Date.now();
		for (const write of writes) kept.set(originKey(write.target, write.content), { origin: write.origin, t: now });
		const out = {};
		for (const [key, value] of kept) out[key] = value;
		const file = originsFile(config);
		fs.mkdirSync(path.dirname(file), { recursive: true });
		writeAtomic(file, `${JSON.stringify(out, null, 0)}\n`);
	} catch {
		// A missing ledger only costs the "automatic" tag in the UI.
	}
}

/** The queue of changes an unattended review proposed but may not apply by itself. */
function pendingFile(config) {
	return path.join(storeDir(config), 'pending.json');
}

/** Read the approval queue, dropping anything malformed. */
function readPending(config) {
	try {
		const parsed = JSON.parse(fs.readFileSync(pendingFile(config), 'utf8'));
		if (!Array.isArray(parsed)) return [];
		const out = [];
		for (const item of parsed) {
			if (item === null || typeof item !== 'object') continue;
			const action = item.action === 'remove' ? 'remove' : item.action === 'replace' ? 'replace' : null;
			if (action === null || typeof item.id !== 'string' || typeof item.current !== 'string') continue;
			out.push({
				id: item.id,
				t: typeof item.t === 'number' ? item.t : 0,
				target: item.target === 'user' ? 'user' : 'memory',
				action,
				current: item.current,
				content: typeof item.content === 'string' ? item.content : '',
				reason: typeof item.reason === 'string' ? item.reason : '',
				session: typeof item.session === 'string' ? item.session : ''
			});
		}
		return out;
	} catch {
		return [];
	}
}

/** Replace the approval queue. Best-effort, like every other bookkeeping write here. */
function writePending(config, items) {
	try {
		const file = pendingFile(config);
		fs.mkdirSync(path.dirname(file), { recursive: true });
		writeAtomic(file, `${JSON.stringify(items, null, 2)}\n`);
	} catch {
		// The queue is durable convenience; a failed write just re-proposes next time.
	}
}

/** A short, stable id for one queued change; the human only ever reads it back to the UI. */
function pendingId(t) {
	return `${t.toString(36)}-${Math.floor(Math.random() * 36 ** 3).toString(36)}`;
}

/**
 * Queue one unattended deletion or rewrite. The entry it targets is copied out verbatim ("pinned"),
 * so approval applies to exactly what the human was shown: if that entry changed in the meantime the
 * change is refused rather than silently applied to something else.
 * @returns a learning-timeline record fragment, or null when nothing could be staged.
 */
function stagePending(config, { target, action, oldText, content, reason, session }) {
	const entries = readEntries(memoryFile(config, target));
	const index = locate(entries, oldText);
	if (index === -1) return null;
	const current = entries[index];
	const trimmed = typeof content === 'string' ? content.trim() : '';
	if (action === 'replace') {
		if (trimmed.length === 0) return null;
		const refusal = scanContent(trimmed, config.scanOnWrite);
		if (refusal !== null) return null;
	}
	const items = readPending(config).filter((item) => !(item.target === target && item.action === action && item.current === current));
	const item = {
		id: pendingId(Date.now()),
		t: Date.now(),
		target,
		action,
		current,
		content: action === 'replace' ? trimmed : '',
		reason: String(reason ?? '').slice(0, 200),
		session: String(session ?? '')
	};
	writePending(config, [...items, item].slice(-20));
	return { id: item.id, target, action, current, content: item.content };
}

/**
 * Apply or drop one queued change. Approval re-checks the pinned text: the entry must still be there,
 * verbatim and unique, or the change is refused — never applied to a different entry.
 * @returns `{ok, message, applied}` where `message` is the human-readable outcome.
 */
function decidePending(config, id, approve) {
	const items = readPending(config);
	const index = items.findIndex((item) => item.id === id);
	if (index === -1) return { ok: false, message: '这条已经在队列里找不到了。', applied: false };
	const item = items[index];
	const rest = items.filter((_entry, i) => i !== index);
	if (!approve) {
		writePending(config, rest);
		return { ok: true, message: '已忽略，你的记忆没有变化。', applied: false };
	}
	const file = memoryFile(config, item.target);
	const entries = readEntries(file);
	const limit = charLimit(config, item.target);
	const matches = entries.filter((entry) => entry === item.current);
	if (matches.length !== 1) {
		writePending(config, rest);
		return { ok: false, message: '那条记忆后来变过，这次改动已作废（没有动你的记忆）。', applied: false };
	}
	let next;
	if (item.action === 'remove') {
		next = entries.filter((entry) => entry !== item.current);
	} else {
		const refusal = scanContent(item.content, config.scanOnWrite);
		if (refusal !== null) {
			writePending(config, rest);
			return { ok: false, message: `这次改动没通过内容检查：${refusal}`, applied: false };
		}
		next = entries.map((entry) => (entry === item.current ? item.content : entry));
		if (entriesChars(next) > limit) {
			writePending(config, rest);
			return { ok: false, message: `改完会超上限（${usageLabel(next, limit)}），所以没有动。`, applied: false };
		}
	}
	writeAtomic(file, serializeEntries(next));
	writeOrigins(config, item.action === 'replace' ? [{ target: item.target, content: item.content, origin: 'tool' }] : []);
	writePending(config, rest);
	return {
		ok: true,
		applied: true,
		message:
			item.action === 'remove'
				? `已删除那条记忆，现在 ${usageLabel(next, limit)}。删掉的是：${item.current}`
				: `已改成新的说法，现在 ${usageLabel(next, limit)}。被换掉的原文是：${item.current}`
	};
}

/** Bound one summary to the durable row's collapsed line: the rest is expandable, not lost. */
function oneLine(text, limit = 200) {
	const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
	return flat.length <= limit ? flat : `${flat.slice(0, limit - 1)}…`;
}

/** One learned marker, named for a person rather than by its internal kind. */
function transcriptMarker(entry) {
	const kind = String(entry?.kind ?? '');
	const summary = String(entry?.summary ?? '');
	switch (kind) {
		case 'memory': return `记住了一条经验：${summary}`;
		case 'user': return `更新了一条对你的了解：${summary}`;
		case 'memory-pending': return `有一条旧记忆想改，等你确认：${summary}`;
		case 'skill-created': return `新建了技能「${summary}」`;
		case 'skill-updated': return `改进了技能「${summary}」`;
		case 'skill-skipped': return `暂缓改写技能「${summary}」`;
		default: return summary;
	}
}

/**
 * Build the durable row for one finished review: the one-line account the collapsed row draws, and
 * the model-facing body that explains what the record is and what is now remembered.
 *
 * The body is written for a reader with no programming background, in plain Chinese, and always
 * leads with the bracketed marker — the row is logged as a user message, and without the marker a
 * model reading the session back could take it for something the person said.
 * @param config - this deployment's configuration.
 * @param record - the learning-timeline record just appended (`{t, reason, learned}`).
 * @returns the collapsed summary and the message body.
 */
function buildTranscriptRow(config, record) {
	const learned = Array.isArray(record?.learned) ? record.learned : [];
	const markers = learned.map(transcriptMarker).filter((line) => line.length > 0);
	const summary = oneLine(markers.join(' · '));

	const memory = readEntries(memoryFile(config, 'memory'));
	const user = readEntries(memoryFile(config, 'user'));
	const limit = TRANSCRIPT_ENTRY_LIMIT;
	const shown = [];
	for (const [label, entries] of [['记忆', memory], ['对你的了解', user]]) {
		for (const entry of entries.slice(0, limit)) shown.push(`- ${label} · ${oneLine(entry, 120)}`);
	}
	const remembered = memory.length + user.length;

	const lines = [
		`[自我进化记录 · 不是用户发来的消息] ${summary}`,
		'',
		'这一轮结束后，后台有一次自动复盘，下面是它这次留下的东西：'
	];
	for (const marker of markers) lines.push(`- ${marker}`);
	if (String(record?.reason ?? '').trim().length > 0) lines.push('', `它当时的判断：${oneLine(record.reason, 300)}`);
	lines.push(
		'',
		`现在长期记忆里一共 ${remembered} 条（记忆 ${memory.length} 条 · 对你的了解 ${user.length} 条，占用 ${usageLabel(memory, charLimit(config, 'memory'))} / ${usageLabel(user, charLimit(config, 'user'))}）。`,
		shown.length === 0 ? '具体记住了什么：暂时还没有条目。' : `具体记住了什么（每类最多列 ${limit} 条）：`,
		...shown
	);
	return { summary: summary.length === 0 ? '学到了一件小事' : summary, body: lines.join('\n') };
}

/** What the review learned, newest first; a missing or torn log reads as "nothing yet". */
function readLearnings(config, limit) {
	let raw;
	try {
		raw = fs.readFileSync(learningsFile(config), 'utf8');
	} catch {
		return [];
	}
	const lines = raw.split('\n').filter((line) => line.trim().length > 0);
	const records = [];
	for (const line of lines.slice(-limit)) {
		try {
			records.push(JSON.parse(line));
		} catch {
			// Skip a torn trailing line rather than losing the whole timeline.
		}
	}
	return records.reverse();
}

/** The reviewer's fixed policy. Small, strict, and JSON-only so parsing never guesses. */
const REVIEW_SYSTEM = [
	'You are the background self-improvement reviewer for a coding agent. You see the transcript of ONE finished turn.',
	'Decide whether the turn produced anything worth keeping, and reply with ONE JSON object and nothing else:',
	'{"memory":[{"target":"memory"|"user","action":"add"|"replace"|"remove","content":"...","old_text":"..."}],"skill":{"action":"create"|"improve","name":"kebab-case","description":"one sentence","body":"markdown","why":"..."}|null,"reason":"..."}',
	'LANGUAGE (hard requirement, set by the human who reads this):',
	'- Every string you write — memory content, skill description, skill body, why, reason — MUST be Simplified Chinese (简体中文) written in plain, everyday words (大白话).',
	'- One memory entry is one or two short sentences. No jargon, no code, no stack traces, no tool output pasted in. If a term cannot be avoided, explain it in a few plain words in the same sentence.',
	'- Write for a person with no programming background: say what is true and why it matters, not how it was implemented.',
	'- The JSON keys stay English; only the values are Chinese.',
	'Rules:',
	'- Save to "memory" only durable, behavior-changing facts: environment constraints, project conventions, corrected mistakes, tool quirks.',
	'- Save to "user" only stable things about the human: preferences, communication style, expertise level, how they want to be answered.',
	'- Never save: task-specific ephemera, values that are trivially re-discovered, anything already stated in the agent instructions, secrets, or restatements of what the user just said.',
	'- Memory entries are injected into every future session, so be ruthless: 0 to 2 entries is the normal answer, and an empty result is a correct answer.',
	'- A CURRENT-MEMORY list is given below the transcript. Use "action":"add" for genuinely new facts.',
	'- Use "action":"replace" (with an exact "old_text" substring copied from CURRENT-MEMORY, plus the new "content") only when the new fact makes an existing entry wrong or duplicates it — that edit is QUEUED FOR HUMAN APPROVAL and is not applied by you.',
	'- Use "action":"remove" (with an exact "old_text" substring copied from CURRENT-MEMORY) only for an entry that is now wrong or worthless — that deletion is QUEUED FOR HUMAN APPROVAL and is not applied by you.',
	'- Prefer "replace" over "add"+"remove" when consolidating: one entry that says it well beats two that overlap.',
	'- Skills: an EXISTING-SKILLS list is given below the transcript. If the turn established a repeatable procedure that an existing skill already covers, use "action":"improve" and put the NEW knowledge only in "body" — it will be merged into that skill and the result condensed, so never restate what the skill already says.',
	'- Use "action":"create" only for a genuinely new procedure with concrete steps worth reusing. One skill for one kind of task: do not create a second near-duplicate of an existing skill.',
	'- For a skill, "description" must stay under 400 characters and must say when to use it.',
	'- If nothing is worth keeping, reply {"memory":[],"skill":null,"reason":"..."}.',
	'Output must be valid JSON on one line.'
].join('\n');

/** The second-pass prompt that merges new knowledge into an existing skill body. */
const MERGE_SYSTEM = [
	'You maintain one skill file for a coding agent. You are given the skill\'s current body and a piece of newly learned knowledge.',
	'Return ONLY the complete new markdown body — no frontmatter, no code fences, no commentary.',
	'LANGUAGE: write the body in Simplified Chinese (简体中文), in plain everyday words. Keep the frontmatter fields you were not asked to change as they are.',
	'Merge rules:',
	'- Fold the new knowledge into the right existing section; add a section only if none fits.',
	'- Remove duplication and contradictions, keeping the newer, more specific fact.',
	'- Condense: the merged body must be no longer than the current body plus the new knowledge, and shorter whenever entries overlap.',
	'- Preserve every step, command, pitfall, and verification hint that is still true.',
	'- If the current body is not Chinese, translate it into plain Chinese as you go; keep every fact.',
	'- Keep the same heading structure.'
].join('\n');

/** Extract the first JSON object from model output that may carry prose or code fences. */
function parseReviewJson(text) {
	const trimmed = text.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
	const start = trimmed.indexOf('{');
	const end = trimmed.lastIndexOf('}');
	if (start === -1 || end === -1 || end <= start) return null;
	try {
		return JSON.parse(trimmed.slice(start, end + 1));
	} catch {
		return null;
	}
}

/**
 * Install the background self-improvement review: after each finished turn, one cheap auxiliary
 * model call decides whether the turn produced anything durable, and anything it accepts is written
 * through the same scanned, bounded, read-back-verified paths the tools use.
 *
 * Design constraints, in order of importance:
 * - A review failure of any kind is swallowed: the session must never be affected by it.
 * - At most one review runs at a time, and interrupted or failed turns are never learned from.
 * - A turn with fewer than `reviewMinSteps` tool steps is skipped: it teaches nothing.
 * @param ctx - a context carrying the `llm` service and the live-agent registry.
 * @param config - this deployment's configuration.
 * @param toolMarkers - the shared per-session list of learnings the tools recorded themselves.
 * @returns the collector the tools call, or null when this deployment writes no conversation row.
 */
function installAutoReview(ctx, config, toolMarkers) {
	/** Per-session ring buffer of the current turn's compact transcript lines. */
	const buffers = new Map();
	/** Timestamp of the last row posted per session, so one turn never leaves two. */
	const posted = new Map();
	let inFlight = 0;

	/** Record one learning the tools themselves caused; the review posts it with its own record. */
	function collect(exec, entry) {
		const sessionId = typeof exec?.agent?.id === 'string' ? exec.agent.id : '';
		if (sessionId.length === 0 || String(entry?.summary ?? '').trim().length === 0) return;
		const list = toolMarkers.get(sessionId) ?? [];
		list.push(entry);
		toolMarkers.set(sessionId, list.slice(-20));
	}

	/** Append one durable conversation row for a finished learning record. */
	function post(session, record) {
		try {
			// The live-agent registry the harness mounts as the `agents` service. A session with no live
			// agent simply gets no row.
			const agent = agentRegistry?.get(session.id);
			if (agent === undefined) return false;
			const row = buildTranscriptRow(config, record);
			agent.followup(createUserMessage({
				content: [{ type: 'text', text: row.body }],
				source: { kind: TRANSCRIPT_KIND, form: 'notice', summary: boundContextSummary(row.summary) }
			}));
			return true;
		} catch {
			// The conversation row is an observability aid; never let it fail the learning itself.
			return false;
		}
	}

	/** One auxiliary completion: a fixed system prompt, one user text, text out. */
	async function complete(system, text, route, signal) {
		const messages = [createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'dsh-self-evolution' } })];
		const assembler = new BlockAssembler();
		for await (const chunk of ctx.llm.stream({
			provider: route.provider,
			model: route.model,
			messages,
			system,
			maxTokens: config.reviewMaxTokens,
			sessionId: route.sessionId,
			purpose: 'self-evolution-review',
			signal
		})) {
			assembler.push(chunk);
		}
		if (assembler.finish?.kind !== 'stop') return null;
		return assembler.blocks()
			.filter((block) => block.type === 'text')
			.map((block) => block.text)
			.join('\n');
	}

	/**
	 * Apply one accepted decision. Memory entries go through the shared add path; a skill is either
	 * created or merged into the existing one, so repeated lessons refine a single skill instead of
	 * piling up near-duplicates.
	 */
	async function applyDecision(session, decision, route, signal) {
		const learned = [];
		const items = Array.isArray(decision.memory) ? decision.memory.slice(0, 3) : [];
		for (const item of items) {
			if (item === null || typeof item !== 'object') continue;
			const target = item.target === 'user' ? 'user' : 'memory';
			const action = item.action === 'replace' || item.action === 'remove' ? item.action : 'add';
			const content = typeof item.content === 'string' ? item.content.trim() : '';
			const oldText = typeof item.old_text === 'string' ? item.old_text.trim() : '';
			// Additions are the review's own business; deletions and rewrites are the human's.
			if (action !== 'add' && config.approveReviewEdits) {
				try {
					const staged = stagePending(config, {
						target,
						action,
						oldText,
						content,
						reason: String(decision.reason ?? ''),
						session: String(session.id ?? '')
					});
					if (staged !== null) learned.push({ kind: 'memory-pending', target, summary: `${staged.action === 'remove' ? '想删掉' : '想改写'}一条记忆，已排队等你确认：${staged.current.slice(0, 160)}`, detail: staged.id });
				} catch {
					// A staging failure is a normal outcome: nothing was queued, nothing was changed.
				}
				continue;
			}
			if (content.length === 0) continue;
			try {
				const outcome = addMemoryEntry(config, target, content, 'auto');
				if (outcome.ok === true && outcome.message === 'saved') {
					learned.push({ kind: 'memory', target, summary: content.slice(0, 200) });
				}
			} catch {
				// A rejected entry (scan or bound) is a normal outcome, not an error.
			}
		}

		const proposal = decision.skill;
		if (proposal !== null && typeof proposal === 'object' && typeof proposal.name === 'string') {
			const cwd = session.header?.cwd;
			const name = proposal.name.trim();
			const existing = KEBAB.test(name) ? findSkillFile(config, cwd, name) : null;
			const wantsImprove = proposal.action === 'improve' || (existing !== null && proposal.action !== 'create' && config.reviewSkillUpdates);
			try {
				if (existing !== null && wantsImprove && config.reviewSkillUpdates) {
					const current = fs.readFileSync(existing, 'utf8');
					const split = splitFrontmatter(current);
					const currentBody = split === null ? current : split.body.trim();
					const merged = await complete(
						MERGE_SYSTEM,
						`CURRENT SKILL BODY:\n${currentBody}\n\nNEWLY LEARNED KNOWLEDGE:\n${String(proposal.body ?? '').trim()}\n\nWHY: ${String(proposal.why ?? '').slice(0, 300)}`,
						route,
						signal
					);
					if (merged !== null && merged.trim().length > 0) {
						const mergedBody = merged.trim();
						if (countChars(mergedBody) > config.skillMaxChars) {
							learned.push({ kind: 'skill-skipped', summary: `${name}: merged body would reach ${countChars(mergedBody)} chars (limit ${config.skillMaxChars}); kept the previous version` });
						} else {
							const description = typeof proposal.description === 'string' && proposal.description.trim().length > 0
								? proposal.description.trim()
								: (lintSkill(current).description ?? name);
							backupFile(existing);
							fs.writeFileSync(existing, buildSkillFile(name, description.slice(0, MAX_DESCRIPTION_CHARS), mergedBody), 'utf8');
							const check = lintSkill(fs.readFileSync(existing, 'utf8'));
							if (check.errors.length > 0) {
								const backup = `${existing}.bak-${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}`;
								if (fs.existsSync(backup)) fs.copyFileSync(backup, existing);
								learned.push({ kind: 'skill-skipped', summary: `${name}: merged result would not load (${check.errors.join('; ')}); kept the previous version` });
							} else {
								learned.push({ kind: 'skill-updated', summary: `${name}: ${String(proposal.why ?? '').slice(0, 160)}`, detail: existing });
							}
						}
					}
				} else {
					const written = writeSkill(config, cwd, {
						name,
						description: proposal.description,
						body: proposal.body,
						mode: 'create'
					});
					learned.push({ kind: 'skill-created', summary: `${name}: ${String(proposal.description ?? '').slice(0, 160)}`, detail: written.path });
				}
			} catch {
				// An invalid proposal or an existing name is skipped, not an error.
			}
		}

		if (learned.length === 0) return;
		const sessionKey = String(session.id ?? '');
		learned.push(...(toolMarkers.get(sessionKey) ?? []));
		toolMarkers.set(sessionKey, []);
		const record = {
			t: Date.now(),
			session: sessionKey,
			reason: String(decision.reason ?? '').slice(0, 300),
			learned
		};
		appendLearning(config, record);
		if (config.transcriptRow) {
			posted.set(sessionKey, record.t);
			post(session, record);
		}
	}

	/**
	 * Write the row for learning that happened outside a review — a direct `memory` or `skill_learn`
	 * write mid-turn. It waits for the turn to close, because a row appended while the agent is still
	 * working would be spliced into the turn it describes and would wake another one.
	 * @param session - the session the write happened in.
	 * @param record - the record to post, built from the markers the tools left behind.
	 */
	function postAfterTurn(session, record) {
		Promise.resolve()
			.then(() => session.whenIdle?.())
			.then(() => {
				const key = String(session.id ?? '');
				if (posted.get(key) === record.t) return;
				if (post(session, record)) posted.set(key, record.t);
			})
			.catch(() => {});
	}

	/**
	 * Append the durable row for one review into the conversation itself.
	 *
	 * `followup` rather than `inject`: the row opens the next turn, which is what makes it land in
	 * the transcript scrollback instead of only in the card above the composer. A session that has
	 * since gone away simply gets no row — a record is never worth failing a review over.
	 * @param session - the session the review belongs to.
	 * @param config - this deployment's configuration.
	 * @param record - the learning-timeline record just appended.
	 */
	/** Run one review for a finished turn. Never throws. */
	async function review(session, reason, buffer) {
		if (!config.autoReview) return;
		if (reason === 'aborted' || reason === 'error') return;
		if (inFlight > 0) return;
		const steps = buffer.filter((line) => line.startsWith('TOOL: ') || line.startsWith('RESULT: ')).length;
		if (steps < config.reviewMinSteps) return;

		const transcript = [];
		let chars = 0;
		for (let i = buffer.length - 1; i >= 0; i -= 1) {
			const line = buffer[i];
			if (chars + line.length > config.reviewMaxChars) break;
			transcript.unshift(line);
			chars += line.length + 1;
		}
		if (transcript.length === 0) return;

		const route = session.requestHeader?.()?.config;
		const provider = configText(config.reviewProvider).length > 0 ? config.reviewProvider : route?.provider;
		const model = configText(config.reviewModel).length > 0 ? config.reviewModel : route?.model;
		if (typeof provider !== 'string' || typeof model !== 'string') return;

		inFlight += 1;
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), config.reviewTimeoutMs);
		try {
			const target = { provider, model, sessionId: session.id };
			const catalog = config.reviewSkillUpdates && config.reviewSkillCatalog > 0
				? skillCatalog(config, session.header?.cwd, config.reviewSkillCatalog)
				: [];
			// The reviewer may propose an edit to an existing entry, so it has to see them: with no list
			// it can only ever add, and memory fills up with near-duplicates.
			const currentMemory = [];
			for (const storeTarget of ['memory', 'user']) {
				for (const entry of readEntries(memoryFile(config, storeTarget))) {
					currentMemory.push(`[${storeTarget}] ${entry.length > 400 ? `${entry.slice(0, 400)}…` : entry}`);
				}
			}
			const prompt = [
				'TRANSCRIPT OF THE FINISHED TURN:',
				transcript.join('\n'),
				currentMemory.length === 0
					? 'CURRENT-MEMORY: (empty)'
					: `CURRENT-MEMORY (copy an exact substring from one of these as "old_text" when you replace or remove it; never rewrite one just to reword it):\n${currentMemory.join('\n')}`,
				catalog.length === 0
					? 'EXISTING-SKILLS: (none listed)'
					: `EXISTING-SKILLS (use "action":"improve" with an exact name from this list when one already covers what you learned):\n${catalog.join('\n')}`
			].join('\n\n');
			const reply = await complete(REVIEW_SYSTEM, prompt, target, controller.signal);
			if (reply === null) return;
			const decision = parseReviewJson(reply);
			if (decision === null) return;
			// The row lands only after the reviewed turn has really closed, so it can never be spliced
			// into the turn it describes.
			await session.whenIdle?.();
			await applyDecision(session, decision, target, controller.signal);
		} catch {
			// Silent by design: the reviewer is an optimization, never a dependency.
		} finally {
			clearTimeout(timer);
			inFlight -= 1;
		}
	}

	ctx.on('session/event', (session, event) => {
		const sessionId = typeof session?.id === 'string' ? session.id : '';
		if (sessionId.length === 0) return;

		if (event.type === 'turn/end') {
			const finished = buffers.get(sessionId) ?? [];
			buffers.set(sessionId, []);
			const markers = toolMarkers.get(sessionId) ?? [];
			toolMarkers.set(sessionId, []);
			void review(session, event.data?.reason?.kind, finished);
			// Learning the tools caused themselves also leaves a row — but only when the turn was not
			// aborted mid-write, and only if the review has not just posted a row of its own (the
			// review carries these markers along, so the fallback below stays quiet).
			const kind = event.data?.reason?.kind;
			if (config.transcriptRow && markers.length > 0 && kind !== 'aborted' && kind !== 'error') {
				postAfterTurn(session, { t: Date.now(), reason: '', learned: markers });
			}
			return;
		}
		if (event.type === 'turn/start') posted.delete(sessionId);

		const line = eventLine(event);
		if (line === null) return;
		const text = line.text.length > 1200 ? `${line.text.slice(0, 1200)}…` : line.text;
		if (text.length === 0) return;
		const buffer = buffers.get(sessionId) ?? [];
		buffer.push(`${line.role}: ${text}`);
		while (buffer.length > config.reviewMaxEvents) buffer.shift();
		buffers.set(sessionId, buffer);
	});

	return config.transcriptRow ? collect : null;
}

/** A capacity refusal that hands the model everything it needs to consolidate in the same turn. */
function overflow(target, entries, limit, addition) {
	return {
		ok: false,
		target,
		usage: usageLabel(entries, limit),
		entries,
		message:
			`Memory at ${usageLabel(entries, limit)}. Adding this entry (${countChars(addition)} chars) would exceed the limit. ` +
			'Consolidate now: use `replace` to merge overlapping entries into shorter ones or `remove` stale entries, then retry this add — all in this turn.'
	};
}

/** Resolve one memory entry by a unique substring. */
function locate(entries, needle) {
	const trimmed = needle.trim();
	if (trimmed.length === 0) throw new Error('`old_text` must be a non-empty string');
	const exact = entries.indexOf(trimmed);
	if (exact !== -1) return exact;
	const matches = entries.map((entry, index) => (entry.includes(trimmed) ? index : -1)).filter((index) => index !== -1);
	if (matches.length === 0) throw new Error(`no entry matches ${JSON.stringify(trimmed)}`);
	if (matches.length > 1) throw new Error(`${matches.length} entries match ${JSON.stringify(trimmed)}; use a longer, more specific substring`);
	return matches[0];
}

/**
 * Register the memory store, the skill tools, and the prompt section.
 * @param ctx - registrant context carrying the tool registry and the prompt registry.
 * @param config - this deployment's explicit configuration.
 */
export function apply(ctx, config) {
	// The agent registry arrives as an injected service; a context without one (a headless or
	// embedded host) keeps every other capability and simply writes no conversation rows.
	agentRegistry = typeof ctx?.agents?.get === 'function' ? ctx.agents : null;
	/**
	 * Markers recorded by the learning tools during the current turn, keyed by session id. The
	 * background review publishes them together with its own record, so one turn leaves one row.
	 */
	const toolMarkers = new Map();
	/** The review's marker collector; null until an `llm` service made a review possible. */
	let collectToolMarker = null;

	/**
	 * Record one learning the tools themselves caused. The row is written at the end of the turn, not
	 * now: appending while the agent is still working would splice the row into the turn it describes
	 * and wake another one.
	 * @param exec - the tool execution context, carrying the calling agent.
	 * @param entry - `{kind, summary}` of what was written.
	 */
	function noteTranscriptWrite(exec, entry) {
		if (!config.transcriptRow) return;
		const sessionId = typeof exec?.agent?.id === 'string' ? exec.agent.id : '';
		if (sessionId.length === 0 || String(entry?.summary ?? '').trim().length === 0) return;
		if (collectToolMarker === null) return;
		collectToolMarker(exec, entry);
	}

	if (config.enableMemoryTool) {
		ctx.tools.register(defineTool({
			name: 'memory',
			description:
				'Read or change your durable long-term memory. It is injected into every future session, so it is only for stable facts that change future behavior: user preferences, environment constraints, project conventions, corrections the user made, lessons learned. Write every entry in Simplified Chinese (简体中文) using plain everyday words — one or two short sentences, no jargon, no code, no pasted tool output; the person who reads this list has no programming background. Use `target: "user"` for who the user is and how they want to be answered; `target: "memory"` for everything else. Entries are separated by §. There is no read action — the entries are already in your context; use `list` only to re-check capacity. When a write would exceed the limit the call is refused and returns the current entries: consolidate in the same turn, then retry.',
			parameters: {
				action: {
					type: 'string',
					required: true,
					enum: ['add', 'replace', 'remove', 'list'],
					description: 'add = append one entry; replace = overwrite the one entry located by `old_text`; remove = delete it; list = return current entries and capacity.'
				},
				target: {
					type: 'string',
					required: true,
					enum: ['memory', 'user'],
					description: 'Which store: `memory` (agent notes, conventions, lessons) or `user` (user profile, preferences).'
				},
				content: {
					type: 'string',
					description: 'The complete new entry. Required for `add` and `replace`; for `replace` it replaces the whole matched entry, so include every part you want to keep.'
				},
				old_text: {
					type: 'string',
					description: 'A unique substring identifying the entry to `replace` or `remove`. Required for those actions.'
				}
			},
			output: {
				schema: {
					type: 'object',
					additionalProperties: false,
					properties: {
						ok: { type: 'boolean', required: true },
						target: { type: 'string', required: true },
						usage: { type: 'string', required: true },
						entries: { type: 'array', required: true, items: { type: 'string' } },
						message: { type: 'string', required: true }
					}
				},
				render: (_args, value) => [{ type: 'text', text: value.message }]
			},
			presentCall: (args) => ({
				card: 'generic',
				title: `Memory ${args.action}`,
				kind: 'other',
				rawInput: args.action === 'list' ? { action: args.action, target: args.target } : args
			}),
			execute(args, exec) {
				const target = args.target;
				const label = target === 'user' ? 'USER' : 'MEMORY';
				const limit = charLimit(config, target);
				const file = memoryFile(config, target);
				const entries = readEntries(file);

				if (args.action === 'list') {
					const waiting = readPending(config).length;
					return Promise.resolve({
						ok: true,
						target,
						usage: usageLabel(entries, limit),
						entries,
						pending: waiting,
						message:
							entries.length === 0
								? `${label} memory is empty (0/${limit} chars).`
								: `${label} memory: ${usageLabel(entries, limit)}, ${entries.length} entries.${waiting === 0 ? '' : ` (${waiting} change(s) are queued for the human's approval and are not applied yet.)`}`
					});
				}

				if (args.action === 'add') {
					const content = typeof args.content === 'string' ? args.content.trim() : '';
					if (content.length === 0) throw new Error('`content` must be a non-empty string for `add`');
					const outcome = addMemoryEntry(config, target, content);
					if (outcome.ok === false && outcome.entries !== undefined) return Promise.resolve(overflow(target, outcome.entries, limit, content));
					if (outcome.ok === false) throw new Error(outcome.message);
					const after = readEntries(file);
					if (outcome.message === 'saved') {
						noteTranscriptWrite(exec, { kind: target === 'user' ? 'user' : 'memory', summary: oneLine(content, 160) });
					}
					return Promise.resolve({
						ok: true,
						target,
						usage: outcome.usage,
						entries: after,
						message: outcome.message === 'saved' ? `Saved to ${label} memory (${outcome.usage}).` : 'No duplicate added: that entry already exists.'
					});
				}

				const oldText = typeof args.old_text === 'string' ? args.old_text : '';
				const index = locate(entries, oldText);

				if (args.action === 'remove') {
					const next = entries.filter((_entry, i) => i !== index);
					writeAtomic(file, serializeEntries(next));
					writeOrigins(config, []);
					return Promise.resolve({
						ok: true,
						target,
						usage: usageLabel(next, limit),
						entries: next,
						message: `Removed 1 entry from ${target} memory (${usageLabel(next, limit)}).`
					});
				}

				const content = typeof args.content === 'string' ? args.content.trim() : '';
				if (content.length === 0) throw new Error('`content` must be a non-empty string for `replace`');
				const refusal = scanContent(content, config.scanOnWrite);
				if (refusal !== null) throw new Error(refusal);
				const next = entries.map((entry, i) => (i === index ? content : entry));
				if (entriesChars(next) > limit) return Promise.resolve(overflow(target, entries, limit, content));
				writeAtomic(file, serializeEntries(next));
				writeOrigins(config, [{ target, content, origin: 'tool' }]);
				return Promise.resolve({
					ok: true,
					target,
					usage: usageLabel(next, limit),
					entries: next,
					message: `Replaced 1 entry in ${target} memory (${usageLabel(next, limit)}).`
				});
			}
		}));
	}

	if (config.enableSkillTools) {
		ctx.tools.register(defineTool({
			name: 'skill_learn',
			description:
				'Write procedural memory: create or update a skill (`SKILL.md`) under a root DSH scans, so a workflow you just worked out becomes reusable. Use it after finishing a complex or repeated task, when the user corrects your approach, or when the user asks you to remember how to do something. The file is validated by re-reading it after the write, so a skill created here always loads. It becomes available without restarting. Write procedures, not transcripts: trigger conditions, ordered steps, pitfalls, and how to verify.',
			parameters: {
				name: {
					type: 'string',
					required: true,
					description: 'Skill name in kebab-case, e.g. `release-checklist`. It is the skill\'s identity for every later load.'
				},
				description: {
					type: 'string',
					required: true,
					description: `One sentence saying what the skill does and when to use it; drives discovery. At most ${MAX_DESCRIPTION_CHARS} characters (the catalog truncates beyond that).`
				},
				body: {
					type: 'string',
					required: true,
					description: 'The skill body in markdown. Recommended sections: When to Use / Procedure / Pitfalls / Verification.'
				},
				mode: {
					type: 'string',
					required: true,
					enum: ['create', 'replace', 'append'],
					description: 'create = fail if it already exists; replace = overwrite the whole file; append = add the body to the end of the existing skill.'
				},
				root: {
					type: 'string',
					description: 'Optional absolute skill root to write into. Omit to use the configured project-local root.'
				}
			},
			output: {
				schema: {
					type: 'object',
					additionalProperties: false,
					properties: {
						ok: { type: 'boolean', required: true },
						path: { type: 'string', required: true },
						mode: { type: 'string', required: true },
						chars: { type: 'integer', required: true },
						message: { type: 'string', required: true }
					}
				},
				render: (_args, value) => [{ type: 'text', text: value.message }]
			},
			presentCall: (args) => ({ card: 'generic', title: `Skill ${args.mode}: ${args.name}`, kind: 'other', rawInput: { name: args.name, mode: args.mode } }),
			execute(args, exec) {
				const written = writeSkill(config, sessionCwd(exec), {
					name: args.name,
					description: args.description,
					body: args.body,
					mode: args.mode,
					root: args.root
				});
				const skillName = args.name.trim();
				noteTranscriptWrite(exec, {
					kind: args.mode === 'create' ? 'skill-created' : 'skill-updated',
					summary: `${skillName}：${oneLine(args.description, 160)}`
				});
				return Promise.resolve({
					ok: true,
					path: written.path,
					mode: args.mode,
					chars: written.chars,
					message:
						`${args.mode === 'create' ? 'Created' : args.mode === 'replace' ? 'Replaced' : 'Appended to'} skill \`${skillName}\` at ${written.path} (${written.chars} chars). ` +
						'It is in the session skill catalog from the next step — no restart needed. Load it with the `skill` tool when it applies.'
				});
			}
		}));

		ctx.tools.register(defineTool({
			name: 'skill_doctor',
			description:
				'Check that your skills actually load. DSH silently discards any skill whose frontmatter fails to parse — no warning, the skill just never appears — so a broken skill stays invisible forever. This scans every skill root DSH reads, lists the skills it would drop and why, and can repair the unquoted-value case surgically. Use it after writing skills, when a skill seems missing, or as periodic maintenance of your own procedural memory.',
			parameters: {
				fix: {
					type: 'boolean',
					description: 'Repair repairable frontmatter (unquoted values containing ": "), backing up each file first. Defaults to false: report only.'
				}
			},
			output: {
				schema: {
					type: 'object',
					additionalProperties: false,
					properties: {
						scanned: { type: 'integer', required: true },
						valid: { type: 'integer', required: true },
						broken: {
							type: 'array',
							required: true,
							items: {
								type: 'object',
								additionalProperties: false,
								properties: {
									path: { type: 'string', required: true },
									problems: { type: 'array', required: true, items: { type: 'string' } },
									repaired: { type: 'boolean', required: true }
								}
							}
						},
						warnings: {
							type: 'array',
							required: true,
							items: {
								type: 'object',
								additionalProperties: false,
								properties: {
									path: { type: 'string', required: true },
									warnings: { type: 'array', required: true, items: { type: 'string' } }
								}
							}
						},
						message: { type: 'string', required: true }
					}
				},
				render: (_args, value) => [{ type: 'text', text: value.message }]
			},
			presentCall: () => ({ card: 'generic', title: 'Check skill health', kind: 'other' }),
			execute(args, exec) {
				const fix = args.fix === true;
				const roots = skillRoots(config, sessionCwd(exec));
				let scanned = 0;
				let valid = 0;
				const broken = [];
				const warnings = [];
				for (const root of roots) {
					for (const candidate of listSkillFiles(root)) {
						let text;
						try {
							text = fs.readFileSync(candidate.file, 'utf8');
						} catch {
							continue;
						}
						scanned += 1;
						const lint = lintSkill(text);
						if (lint.errors.length === 0) {
							valid += 1;
							if (lint.warnings.length > 0) warnings.push({ path: candidate.file, warnings: lint.warnings });
							continue;
						}
						let repaired = false;
						if (fix) repaired = repairFrontmatter(candidate.file, text);
						broken.push({ path: candidate.file, problems: lint.errors, repaired });
					}
				}
				const lines = [`Scanned ${scanned} skill files across ${roots.length} roots: ${valid} load correctly, ${broken.length} would be silently discarded.`];
				for (const entry of broken) {
					lines.push(`- ${entry.path}${entry.repaired ? ' [repaired]' : ''}\n  ${entry.problems.join('\n  ')}`);
				}
				for (const entry of warnings) {
					lines.push(`- warning: ${entry.path}\n  ${entry.warnings.join('\n  ')}`);
				}
				if (broken.length > 0 && !fix) lines.push('Re-run with `fix: true` to repair the unquoted-value cases (each file is backed up first).');
				return Promise.resolve({ scanned, valid, broken, warnings, message: lines.join('\n') });
			}
		}));
	}

	ctx.tools.register(defineTool({
		name: 'evolution_log',
		description:
			'Show what the background self-improvement review has learned, newest first: the memory entries it saved and the skills it created, with the reviewer\'s stated reason for each. Also reports current memory usage. Use it to audit or explain what the agent has taught itself, and to check that the learning loop is actually running.',
		parameters: {
			limit: {
				type: 'integer',
				description: 'How many review records to show, newest first. Defaults to 10.'
			}
		},
		output: {
			schema: {
				type: 'object',
				additionalProperties: false,
				properties: {
					count: { type: 'integer', required: true },
					memoryUsage: { type: 'string', required: true },
					userUsage: { type: 'string', required: true },
					items: {
						type: 'array',
						required: true,
						items: {
							type: 'object',
							additionalProperties: false,
							properties: {
								time: { type: 'integer', required: true },
								session: { type: 'string', required: true },
								summary: { type: 'string', required: true },
								reason: { type: 'string', required: true }
							}
						}
					},
					message: { type: 'string', required: true }
				}
			},
			render: (_args, value) => [{ type: 'text', text: value.message }]
		},
		presentCall: (args) => ({ card: 'generic', title: 'Learning timeline', kind: 'other', rawInput: { limit: args.limit } }),
		execute(args) {
			const limit = Number.isInteger(args.limit) && args.limit > 0 ? Math.min(args.limit, 50) : 10;
			const records = readLearnings(config, limit);
			const memoryUsage = usageLabel(readEntries(memoryFile(config, 'memory')), config.memoryCharLimit);
			const userUsage = usageLabel(readEntries(memoryFile(config, 'user')), config.userCharLimit);
			const items = records.map((record) => {
				const learned = Array.isArray(record.learned) ? record.learned : [];
				const summary = learned.length === 0
					? '(no durable change)'
					: learned.map((entry) => `${entry.kind === 'skill' ? '技能' : '记忆'} · ${String(entry.summary ?? '')}`).join('\n');
				return {
					time: typeof record.t === 'number' ? record.t : 0,
					session: String(record.session ?? ''),
					summary,
					reason: String(record.reason ?? '')
				};
			});
			const head = `长期记忆占用：MEMORY ${memoryUsage} · USER ${userUsage}。共 ${items.length} 条学习记录（最新在前）。`;
			const body = items.length === 0
				? '\n还没有任何学习记录：要么还没跑完一轮足够复杂的任务，要么这几轮确实没有值得沉淀的东西（这很正常）。'
				: `\n${items.map((item) => `- ${new Date(item.time).toISOString()}\n  ${item.summary}${item.reason.length === 0 ? '' : `\n  理由：${item.reason}`}`).join('\n')}`;
			return Promise.resolve({ count: items.length, memoryUsage, userUsage, items, message: head + body });
		}
	}));

	ctx.systemPrompt.section({
		name: 'self-evolution:memory',
		order: 100,
		// Memory content is data: never let it be read as a `{{variable}}` prompt template.
		interpolate: false,
		text: () => {
			const blocks = [];
			for (const target of ['memory', 'user']) {
				const entries = readEntries(memoryFile(config, target));
				if (entries.length === 0) continue;
				const limit = charLimit(config, target);
				const used = entriesChars(entries);
				const percent = Math.round((used / limit) * 100);
				const label = target === 'user' ? 'USER (user profile)' : 'MEMORY (your notes)';
				blocks.push(`### ${label} [${percent}% — ${used}/${limit} chars]\n\n${entries.join(ENTRY_SEPARATOR)}`);
			}
			const head = '## 长期记忆（self-evolution）';
			const hasEntries = blocks.length > 0;
			if (!hasEntries && !config.guidance) return '';
			const parts = [head];
			if (hasEntries) parts.push('以下是跨会话持久记忆。工具响应显示的是实时状态，本节内容在本会话内固定。', blocks.join('\n\n'));
			if (config.guidance) parts.push(GUIDANCE);
			return parts.join('\n\n');
		}
	});

	// Cross-session recall. Registered only when a session-query backend is mounted, so a profile
	// with search disabled (the shipped `openAt: never`) still activates every other capability.
	ctx.inject(['sessionQuery'], (child) => {
		child.tools.register(defineTool({
			name: 'session_search',
			description:
				'Search your own past conversations, across sessions or inside one. Use it before asking the user something their history may already answer, and when an earlier decision, fix, or preference matters. Memory holds what you chose to keep; this searches everything that was actually said. `mode: "search"` finds matching messages (add `session_id` to search within one session), `mode: "list"` lists recent sessions, and `mode: "read"` opens a window of raw events around one `seq` for full context. Prefer ONE distinctive term per call: a multi-word query matches as an exact phrase, so each extra word narrows the result sharply. Chinese matches whole space- or punctuation-delimited words, but not a fragment inside a longer unbroken run — shorten or re-delimit the term instead of adding words.',
			parameters: {
				mode: {
					type: 'string',
					required: true,
					enum: ['search', 'list', 'read'],
					description: 'search = full-text search; list = recent sessions; read = a raw-event window around one seq.'
				},
				query: {
					type: 'string',
					description: 'Literal search phrase for `search` (trimmed, whitespace-normalized; token matching, not substring).'
				},
				session_id: {
					type: 'string',
					description: 'Target session for `read`, or the session to search within for `search`. Omit on `search` to search every session.'
				},
				seq: {
					type: 'integer',
					description: 'Event index to open for `read`, usually taken from a `search` hit.'
				},
				window: {
					type: 'integer',
					description: 'How many events before and after `seq` to include in `read`. Defaults to 2.'
				},
				limit: {
					type: 'integer',
					description: 'Maximum results to return. Defaults to 10; the backend caps it.'
				}
			},
			output: {
				schema: {
					type: 'object',
					additionalProperties: false,
					properties: {
						ok: { type: 'boolean', required: true },
						mode: { type: 'string', required: true },
						count: { type: 'integer', required: true },
						nextCursor: { type: 'string', required: true },
						items: {
							type: 'array',
							required: true,
							items: {
								type: 'object',
								additionalProperties: false,
								properties: {
									sessionId: { type: 'string', required: true },
									seq: { type: 'integer', required: true },
									time: { type: 'integer', required: true },
									type: { type: 'string', required: true },
									snippet: { type: 'string', required: true },
									cwd: { type: 'string', required: true }
								}
							}
						},
						message: { type: 'string', required: true }
					}
				},
				render: (_args, value) => [{ type: 'text', text: value.message }]
			},
			presentCall: (args) => ({
				card: 'generic',
				title: args.mode === 'read' ? 'Read past session' : args.mode === 'list' ? 'List past sessions' : 'Search past sessions',
				kind: 'other',
				rawInput: args.mode === 'search' ? { mode: args.mode, query: args.query } : args
			}),
			async execute(args, exec) {
				const query = child.sessionQuery;
				const signal = exec?.signal;
				const limit = Number.isInteger(args.limit) && args.limit > 0 ? Math.min(args.limit, 100) : 10;
				const mode = args.mode;

				if (mode === 'list') {
					const sessions = await query.listSessions(signal);
					const items = sessions.slice(0, limit).map((entry) => ({
						sessionId: entry.header.id,
						seq: 0,
						time: typeof entry.header.createdAt === 'number' ? entry.header.createdAt : 0,
						type: 'session',
						snippet: entry.header.cwd ?? '',
						cwd: entry.header.cwd ?? ''
					}));
					return {
						ok: true,
						mode,
						count: items.length,
						nextCursor: '',
						items,
						message:
							items.length === 0
								? 'No sessions recorded yet.'
								: `Recent sessions (${items.length}):\n${items.map((i) => `- ${i.sessionId}  ${new Date(i.time).toISOString()}  ${i.cwd}`).join('\n')}`
					};
				}

				if (mode === 'read') {
					if (typeof args.session_id !== 'string' || args.session_id.length === 0) throw new Error('`session_id` is required for `read`');
					if (!Number.isInteger(args.seq) || args.seq < 0) throw new Error('`seq` must be a non-negative integer for `read`');
					const window = Number.isInteger(args.window) && args.window >= 0 ? Math.min(args.window, 50) : 2;
					const read = await query.readEvent({ sessionId: args.session_id, seq: args.seq, before: window, after: window }, signal);
					const items = read.events.map((event) => ({
						sessionId: args.session_id,
						seq: event.seq,
						time: typeof event.time === 'number' ? event.time : 0,
						type: String(event.type),
						snippet: compactEvent(event),
						cwd: read.session.cwd ?? ''
					}));
					return {
						ok: true,
						mode,
						count: items.length,
						nextCursor: '',
						items,
						message: `Events ${read.startSeq}–${read.endSeq} of ${args.session_id}:\n${items
							.map((i) => `[${i.seq}] ${i.type}: ${i.snippet}`)
							.join('\n')}`
					};
				}

				const phrase = typeof args.query === 'string' ? args.query.trim() : '';
				if (phrase.length === 0) throw new Error('`query` must be a non-empty string for `search`');
				if (typeof args.session_id === 'string' && args.session_id.length > 0) {
					const page = await query.searchEvents({ sessionId: args.session_id, query: phrase, limit }, { signal });
					const items = page.items.map((hit) => ({
						sessionId: hit.sessionId,
						seq: hit.seq,
						time: typeof hit.time === 'number' ? hit.time : 0,
						type: String(hit.type),
						snippet: String(hit.snippet ?? ''),
						cwd: ''
					}));
					return {
						ok: true,
						mode,
						count: items.length,
						nextCursor: page.nextCursor ?? '',
						items,
						message: items.length === 0
							? `No match for ${JSON.stringify(phrase)} in ${args.session_id}.`
							: `Matches for ${JSON.stringify(phrase)} in ${args.session_id}:\n${items.map((i) => `[${i.seq}] ${i.type}: ${i.snippet}`).join('\n')}`
					};
				}
				const page = await query.searchSessions({ query: phrase, limit }, { signal });
				const items = page.items.map((hit) => ({
					sessionId: hit.bestMatch.sessionId,
					seq: hit.bestMatch.seq,
					time: typeof hit.bestMatch.time === 'number' ? hit.bestMatch.time : 0,
					type: String(hit.bestMatch.type),
					snippet: String(hit.bestMatch.snippet ?? ''),
					cwd: hit.header.cwd ?? ''
				}));
				return {
					ok: true,
					mode,
					count: items.length,
					nextCursor: page.nextCursor ?? '',
					items,
					message: items.length === 0
						? `No match for ${JSON.stringify(phrase)} in any session.`
						: `Matches for ${JSON.stringify(phrase)} (newest first):\n${items
								.map((i) => `- ${i.sessionId} [${i.seq}] ${new Date(i.time).toISOString()}  ${i.cwd}\n  ${i.snippet}`)
								.join('\n')}${page.nextCursor === undefined ? '' : '\n(more results available; pass the cursor to continue)'}`
				};
			}
		}));
	});

	// The background reviewer needs a model route; without an `llm` service it stays off and every
	// tool above keeps working.
	if (config.autoReview) {
		ctx.inject(['llm'], (child) => {
			collectToolMarker = installAutoReview(child, config, toolMarkers);
		});
	}

	// One read-only JSON endpoint for the Web UI panel: the Client cannot read files, so the Host
	// publishes exactly the numbers and records the panel renders.
	ctx.inject(['webServer'], (child) => {
		/** Both stores' current entries, with where each one came from. */
		const snapshot = () => {
			const memory = readEntries(memoryFile(config, 'memory'));
			const user = readEntries(memoryFile(config, 'user'));
			const origins = readOrigins(config);
			const entries = [];
			for (const target of ['memory', 'user']) {
				for (const text of readEntries(memoryFile(config, target))) {
					const origin = origins.get(originKey(target, text));
					entries.push({ target, text: text.slice(0, 500), origin: origin === undefined ? '' : origin.origin, originTime: origin === undefined ? 0 : origin.t });
				}
			}
			const records = readLearnings(config, 40);
			return {
				ok: true,
				autoReview: config.autoReview === true,
				uiMode: config.uiMode === 'off' ? 'off' : config.uiMode === 'auto' ? 'auto' : 'always',
				notify: ['off', 'on', 'verbose'].includes(config.notify) ? config.notify : 'verbose',
				approveReviewEdits: config.approveReviewEdits === true,
				memory: { used: entriesChars(memory), limit: config.memoryCharLimit, count: memory.length },
				user: { used: entriesChars(user), limit: config.userCharLimit, count: user.length },
				entries,
				pending: readPending(config).map((item) => ({
					id: item.id,
					time: item.t,
					target: item.target,
					action: item.action,
					current: item.current.slice(0, 800),
					content: item.content.slice(0, 800),
					reason: item.reason.slice(0, 240)
				})),
				timeline: records.map((record) => ({
					time: typeof record.t === 'number' ? record.t : 0,
					reason: String(record.reason ?? '').slice(0, 240),
					learned: (Array.isArray(record.learned) ? record.learned : []).map((entry) => ({
						kind: String(entry.kind ?? ''),
						summary: String(entry.summary ?? '').slice(0, 300)
					}))
				}))
			};
		};

		child.effect(() => child.webServer.register({
			kind: 'exact',
			path: '/self-evolution/timeline',
			handler: (req, res) => {
				if (req.method !== 'GET' && req.method !== 'HEAD') {
					res.writeHead(405, { 'content-type': 'application/json' });
					res.end('{"error":"method not allowed"}');
					return;
				}
				let payload;
				try {
					payload = snapshot();
				} catch (error) {
					payload = { ok: false, error: error instanceof Error ? error.message : 'unavailable' };
				}
				const body = JSON.stringify(payload);
				res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
				res.end(req.method === 'HEAD' ? undefined : body);
			}
		}), 'self-evolution: timeline endpoint');

		// The one write route in this plugin: approving or dropping a change the unattended review was
		// not allowed to make. It answers only this machine's own page, and only to a JSON request —
		// requiring a non-simple content type forces a CORS preflight, which no other origin can pass.
		child.webServer.register({
			kind: 'exact',
			path: '/self-evolution/pending',
			handler: (req, res) => {
				const address = String(req.socket?.remoteAddress ?? '');
				const loopback = address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
				const json = String(req.headers?.['content-type'] ?? '').startsWith('application/json');
				const refuse = (code, message) => {
					res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
					res.end(JSON.stringify({ ok: false, error: message }));
				};
				if (req.method !== 'POST') return refuse(405, 'method not allowed');
				if (!loopback || !json) return refuse(403, 'forbidden');
				let body = '';
				req.on('data', (chunk) => {
					body += chunk;
					if (body.length > 4096) req.destroy();
				});
				req.on('end', () => {
					let request;
					try {
						request = JSON.parse(body);
					} catch {
						return refuse(400, 'invalid JSON body');
					}
					const id = typeof request?.id === 'string' ? request.id : '';
					const approve = request?.decision === 'approve';
					if (id.length === 0 || (request?.decision !== 'approve' && request?.decision !== 'reject')) {
						return refuse(400, 'expected {"id": "...", "decision": "approve" | "reject"}');
					}
					let outcome;
					try {
						outcome = decidePending(config, id, approve);
					} catch (error) {
						return refuse(500, error instanceof Error ? error.message : 'failed');
					}
					res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
					res.end(JSON.stringify({ ...outcome, state: snapshot() }));
				});
				req.on('error', () => refuse(400, 'request failed'));
			}
		});
	});
}

/**
 * Repair the one frontmatter damage class that can be fixed without touching anything else: an
 * unquoted `description` (or `name`) whose value contains `": "`, which YAML reads as a nested
 * mapping and the loader therefore discards. Every other byte — including other keys and the whole
 * body — is preserved, and the original file is backed up first.
 * @returns whether the file was rewritten.
 */
function repairFrontmatter(file, text) {
	const split = splitFrontmatter(text);
	if (split === null) return false;
	let block = split.block;
	let changed = false;
	for (const key of ['description', 'name']) {
		const value = rawValue(block, key);
		if (value === undefined) continue;
		const trimmed = value.trim();
		if (trimmed.startsWith('"') || trimmed.startsWith("'") || trimmed.startsWith('|') || trimmed.startsWith('>')) continue;
		// A multi-line value cannot be repaired by rewriting one line; leave it for a human.
		const block_ = valueBlock(block, key);
		if (block_ !== undefined && block_.continuation.length > 0) continue;
		if (!trimmed.includes(': ') && !trimmed.includes(' #') && !trimmed.endsWith(':')) continue;
		block = block.replace(new RegExp(`^${key}:[ \\t]*.*$`, 'm'), `${key}: ${yamlScalar(trimmed)}`);
		changed = true;
	}
	if (!changed) return false;

	const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
	fs.copyFileSync(file, `${file}.bak-${stamp}`);
	const text2 = joinFrontmatter(block, split.body, split.eol);
	// Gate on loadability, not on quality warnings: a long description still loads.
	if (lintSkill(text2).errors.length > 0) return false;
	writeAtomic(file, text2);
	return true;
}
