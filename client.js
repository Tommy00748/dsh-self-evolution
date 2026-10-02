/**
 * Client half of dsh-self-evolution: the learning strip above the composer.
 *
 * Design (2026-10-02, second pass — "proactive reveal"):
 *
 * Hermes Agent, whose learning loop this plugin ports, prints one persistent line in the
 * conversation after a background review saved something — `💾 Self-improvement review: …` — and
 * its own source notes that this "must not be a transient toast that can be missed". The first DSH
 * version put the whole feature behind a 38%-opacity `◈` glyph inside the bottom stats row: nothing
 * said what it was, nothing said when it had learned something, so the learning was invisible.
 *
 * This half therefore renders the same thing Hermes does, in DSH's own language for it: a card in
 * the composer's input dock (the slot the Todo panel and the Goal bar already use, directly under
 * the conversation). Collapsed it is one 36px row:
 *
 *     ◈  自我进化   刚学会：记住了一条经验 —— 本机构建命令是 pnpm build        ⌃
 *
 * The right-hand text is the reveal: the newest unattended learning, named the way Hermes names it
 * (`notify: on` names the operation, `verbose` adds the content). It stays until the user opens the
 * card, after which the row quiets down to `已学 N 次 · 记忆 73%` and the card is the way back to
 * the full journey. Expanding shows memory usage, the learning timeline (what, when, and the model's
 * reason), and the entries currently remembered.
 *
 * Motion (2026-10-02, third pass): the card rises 6px as it appears, the panel unfolds downward
 * (clip-path), the rows inside cascade in behind it, and the two usage bars grow left-to-right one
 * after the other. A newly learned item's `◈` gives one short pulse. Every animation is short
 * (200–460ms), uses `animation-fill-mode: backwards` so nothing stays pinned to a transform, and is
 * cancelled wholesale under `prefers-reduced-motion`. Stagger delays are computed in JS from the
 * list index — `:nth-of-type` cannot express them, because the rows are not the only children of
 * the panel.
 *
 * Every string goes through the Client locale seat, every color is a theme token, and every failure
 * path renders nothing: this is an ambient record of what the agent learned, never a thing to manage.
 */
window.__ModuleLoader__.load({
	id: 'dsh-self-evolution',
	factory(require) {
		const React = require('react');
		const h = React.createElement;

		/** Dictionary namespace owned by this plugin. */
		const NS = 'self-evolution';
		/** Host endpoint publishing the memory numbers and the learning timeline. */
		const ENDPOINT = '/self-evolution/timeline';
		/** Host endpoint that applies or drops one queued change a person decided on. */
		const PENDING_ENDPOINT = '/self-evolution/pending';
		/** LocalStorage key holding the newest learning time the user has already seen. */
		const SEEN_KEY = 'dsh:self-evolution:seen';
		/** The mark this row draws in the transcript; small, monochrome, and never a tool glyph. */
		const ROW_MARK = '◈';
		/** Poll period. The background review finishes seconds after a turn, so a few seconds of lag is invisible. */
		const POLL_MS = 5000;

		const STYLE_TAG = 'dsh-self-evolution/dock.css';
		const STYLE_ID = 'dsh-self-evolution-dock';
		/** Own class prefix: no host class name is reused or assumed. */
		const CSS = [
			'.dshse-root{box-sizing:border-box;width:calc(100% - var(--dsh-composer-side-clearance) - var(--dsh-composer-side-clearance) - var(--dsh-composer-dock-inset) - var(--dsh-composer-dock-inset) - var(--dsh-composer-dock-inset) - var(--dsh-composer-dock-inset));max-width:calc(var(--dsh-composer-card-max-width) - var(--dsh-composer-dock-inset) - var(--dsh-composer-dock-inset) - var(--dsh-composer-dock-inset) - var(--dsh-composer-dock-inset));--dsw-elevation-stroke-color:var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-lg);background:var(--dsw-specific-menu);backdrop-filter:var(--dsw-menu-backdrop-filter);box-shadow:var(--dsw-elevation-panel);border:0;flex:none;margin:0 auto;overflow:hidden;animation:dshse-card-in 200ms cubic-bezier(.2,.8,.2,1) backwards}',
			'.dshse-body{flex-direction:column;gap:8px;padding:6px 12px;display:flex}',
			'.dshse-head{text-align:left;cursor:pointer;background:0 0;border:none;align-items:center;gap:10px;width:100%;padding:0;display:flex;color:inherit;font:inherit;transition:transform 140ms cubic-bezier(.2,.8,.2,1)}',
			'.dshse-head:hover{transform:translateX(1px)}',
			'.dshse-head:active{transform:translateX(1px) scale(.997)}',
			'.dshse-lead{color:var(--dsw-alias-label-tertiary);flex:none;place-items:center;display:grid;line-height:0;transition:color 180ms ease-out}',
			'.dshse-lead[data-fresh=true]{color:var(--dsw-alias-state-business-primary);animation:dshse-pop 1.3s cubic-bezier(.2,.8,.2,1) 1}',
			'.dshse-title{color:var(--dsw-alias-label-primary);flex:none;font-size:13px;font-weight:500;line-height:24px}',
			'.dshse-status{min-width:0;color:var(--dsw-alias-label-tertiary);text-overflow:ellipsis;white-space:nowrap;flex:auto;font-size:13px;line-height:20px;overflow:hidden;transition:color 180ms ease-out}',
			'.dshse-status[data-fresh=true]{color:var(--dsw-alias-label-primary);animation:dshse-slide-in 260ms cubic-bezier(.2,.8,.2,1) backwards}',
			'.dshse-chevron{color:var(--dsw-alias-label-tertiary);flex:none;place-items:center;display:grid;line-height:0;transition:transform 180ms cubic-bezier(.2,.8,.2,1)}',
			'.dshse-chevron[data-open=true]{transform:rotate(180deg)}',
			'.dshse-panel{flex-direction:column;gap:9px;max-height:300px;margin:0;padding:0 0 2px;display:flex;overflow-y:auto;--dsh-scrollbar-thumb:var(--dsw-alias-scrollbar-bg-l2);--dsh-scrollbar-thumb-hover:var(--dsw-alias-scrollbar-hover-l2);animation:dshse-unfold 190ms cubic-bezier(.2,.8,.2,1) backwards;transform-origin:top}',
			'.dshse-usage{flex-direction:column;gap:4px;display:flex}',
			'.dshse-usageRow{align-items:center;gap:8px;font-size:12px;display:flex}',
			'.dshse-usageLabel{color:var(--dsw-alias-label-tertiary);flex:0 0 auto}',
			'.dshse-track{border-radius:2px;background:currentColor;opacity:.16;flex:0 0 68px;height:4px;position:relative;overflow:hidden}',
			'.dshse-fill{border-radius:2px;background:currentColor;opacity:.8;position:absolute;inset:0 auto 0 0;transform-origin:left;animation:dshse-grow 460ms cubic-bezier(.2,.8,.2,1) backwards}',
			'.dshse-usageText{color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}',
			'.dshse-section{color:var(--dsw-alias-label-caption);font-size:11px;letter-spacing:.02em;margin-top:2px}',
			'.dshse-record{border-left:2px solid var(--dsw-alias-border-l2);padding-left:8px;flex-direction:column;gap:2px;display:flex;animation:dshse-rise 200ms cubic-bezier(.2,.8,.2,1) backwards}',
			'.dshse-when{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px}',
			'.dshse-line{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;word-break:break-word}',
			'.dshse-reason{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px;word-break:break-word}',
			'.dshse-entry{gap:8px;align-items:baseline;font-size:12px;line-height:18px;display:flex;animation:dshse-rise 200ms cubic-bezier(.2,.8,.2,1) backwards}',
			'.dshse-tag{color:var(--dsw-alias-label-caption);flex:0 0 auto;font-size:10px;letter-spacing:.04em}',
			'.dshse-entryText{color:var(--dsw-alias-label-secondary);min-width:0;word-break:break-word;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;overflow:hidden}',
			'.dshse-pending{border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-md);flex-direction:column;gap:6px;padding:8px 10px;display:flex;animation:dshse-rise 220ms cubic-bezier(.2,.8,.2,1) backwards}',
			'.dshse-pendingHead{align-items:baseline;gap:8px;display:flex}',
			'.dshse-pendingTitle{color:var(--dsw-alias-label-primary);flex:1;font-size:12px;line-height:18px}',
			'.dshse-quote{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;word-break:break-word}',
			'.dshse-quoteLabel{color:var(--dsw-alias-label-caption);font-size:11px;line-height:16px}',
			'.dshse-actions{align-items:center;gap:8px;margin-top:2px;display:flex}',
			'.dshse-btn{color:var(--dsw-alias-label-primary);cursor:pointer;background:0 0;border:.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-sm);padding:3px 10px;font:inherit;font-size:12px;line-height:18px;transition:background 140ms ease-out,transform 100ms ease-out}',
			'.dshse-btn:hover{background:var(--dsw-alias-interactive-bg-hover);transform:translateY(-1px)}',
			'.dshse-btn:active{transform:translateY(0)}',
			'.dshse-btn[data-primary=true]{border-color:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-state-business-primary)}',
			'.dshse-btn:disabled{opacity:.5;cursor:default;transform:none}',
			'.dshse-note{color:var(--dsw-alias-label-caption);font-size:11px;line-height:16px}',
			'.dshse-empty{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}',
			'.dshse-glyph{display:inline-flex;align-items:center;justify-content:center;background:0 0;border:none;border-radius:var(--dsw-radius-sm);color:inherit;cursor:pointer;opacity:.4;padding:0 4px;font-size:13px;line-height:1;transition:opacity 120ms,transform 140ms}',
			'.dshse-glyph:hover{opacity:.9;transform:scale(1.12)}',
			'.dshse-more{color:var(--dsw-alias-label-caption);font-size:11px}',
			'.dshse-row{box-sizing:border-box;width:100%;min-width:0;margin:0}',
			'.dshse-rowHead{align-items:center;gap:8px;width:100%;color:inherit;font:inherit;text-align:left;cursor:pointer;background:0 0;border:0;border-radius:var(--dsw-radius-sm);padding:2px 4px;display:flex;transition:background-color .1s}',
			'.dshse-rowHead:hover{background:var(--dsw-alias-interactive-bg-hover)}',
			'.dshse-rowGlyph{color:var(--dsw-alias-label-tertiary);flex:none;place-items:center;display:grid;line-height:0}',
			'.dshse-rowLabel{color:var(--dsw-alias-label-tertiary);flex:none;font-size:13px;line-height:24px}',
			'.dshse-rowText{min-width:0;color:var(--dsw-alias-label-secondary);text-overflow:ellipsis;white-space:nowrap;flex:auto;font-size:13px;line-height:24px;overflow:hidden}',
			'.dshse-rowChevron{color:var(--dsw-alias-label-tertiary);flex:none;place-items:center;display:grid;line-height:0;transition:transform 180ms cubic-bezier(.2,.8,.2,1)}',
			'.dshse-rowChevron[data-open=true]{transform:rotate(180deg)}',
			'.dshse-rowBody{max-height:240px;margin:6px 0 0 calc(14px + var(--dsh-content-font-delta,0px));border-radius:var(--dsw-radius-md);background:var(--dsw-alias-markdown-code-block);color:var(--dsw-alias-label-tertiary);white-space:pre-wrap;overflow-wrap:anywhere;font:400 11px/16px var(--ds-font-family-code);padding:10px 14px 12px 12px;overflow:auto;animation:dshse-unfold 190ms cubic-bezier(.2,.8,.2,1) backwards;transform-origin:top}',
			'@media (prefers-reduced-motion:reduce){.dshse-rowBody{animation:none!important}.dshse-rowChevron{transition:none!important}}',
			'@keyframes dshse-card-in{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:translateY(0)}}',
			'@keyframes dshse-unfold{from{opacity:0;transform:translateY(-5px);clip-path:inset(0 0 100% 0)}to{opacity:1;transform:translateY(0);clip-path:inset(0 0 0 0)}}',
			'@keyframes dshse-rise{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:translateY(0)}}',
			'@keyframes dshse-slide-in{from{opacity:0;transform:translateX(-4px)}to{opacity:1;transform:translateX(0)}}',
			'@keyframes dshse-pop{0%{transform:scale(1)}30%{transform:scale(1.22)}100%{transform:scale(1)}}',
			'@keyframes dshse-grow{from{transform:scaleX(0)}to{transform:scaleX(1)}}',
			'@media (prefers-reduced-motion:reduce){.dshse-root,.dshse-panel,.dshse-record,.dshse-entry,.dshse-pending,.dshse-status,.dshse-lead,.dshse-fill{animation:none!important}.dshse-head,.dshse-chevron,.dshse-lead,.dshse-status,.dshse-btn,.dshse-glyph{transition:none!important;transform:none!important}}'
		].join('');

		/** Where one learned kind is named for a person; unknown kinds fall back to their raw summary. */
		const KIND_KEY = {
			memory: 'kind.memory',
			user: 'kind.user',
			'memory-pending': 'kind.memoryPending',
			'skill-created': 'kind.skillCreated',
			'skill-updated': 'kind.skillUpdated',
			'skill-skipped': 'kind.skillSkipped'
		};
		/** Skill kinds whose summary is conventionally `name: why`, so the name can be lifted out. */
		const SKILL_KINDS = new Set(['skill-created', 'skill-updated', 'skill-skipped']);

		const zh = {
			title: '自我进化',
			'aria.strip': '自我进化：这次学会了什么',
			'glyph.title': '自我进化：已学 {count} 次 · 记忆 {percent}%（点这里看学了什么）',
			'aria.expand': '展开学习记录',
			'aria.collapse': '收起学习记录',
			'reveal.prefix': '刚学会',
			'stat.learned': '已学 {count} 次',
			'stat.memory': '记忆 {percent}%',
			'stat.none': '还没有学习记录',
			'kind.memory': '记住了一条经验',
			'kind.memory.verbose': '记住了一条经验：{text}',
			'kind.user': '更新了对你的一条了解',
			'kind.user.verbose': '更新了对你的了解：{text}',
			'kind.memoryPending': '想改一条旧记忆，等你点头',
			'kind.memoryPending.verbose': '想改一条旧记忆，等你点头：{text}',
			'kind.skillCreated': '新建了技能“{name}”',
			'kind.skillCreated.verbose': '新建技能“{name}”：{why}',
			'kind.skillUpdated': '改进了技能“{name}”',
			'kind.skillUpdated.verbose': '改进技能“{name}”：{why}',
			'kind.skillSkipped': '暂缓改写技能“{name}”',
			'kind.skillSkipped.verbose': '暂缓改写技能“{name}”：{why}',
			'usage.memory': '记忆',
			'usage.user': '用户画像',
			'section.timeline': '最近学到',
			'section.entries': '已记住的 {count} 条',
			'section.pending': '等你确认（{count} 条）',
			'pending.remove': '它想把这条删掉',
			'pending.replace': '它想把这条换成新的说法',
			'pending.current': '现在的原文',
			'pending.next': '换成这句',
			'pending.approve': '同意',
			'pending.reject': '不用了',
			'pending.busy': '处理中…',
			'pending.note': '它自己不会动你的记忆，你点同意才会生效。',
			'pending.failed': '操作没成功：{message}',
			'tag.auto': '自动',
			'tag.memory': '记忆',
			'tag.user': '画像',
			'entry.empty': '还没有长期记忆。完成一个较复杂的任务后，这里会出现它自己学到的东西。',
			'time.seconds': '{count} 秒前',
			'time.minutes': '{count} 分钟前',
			'time.hours': '{count} 小时前',
			'time.days': '{count} 天前',
			'auto.on': '自动复盘已开启',
			'auto.off': '自动复盘已关闭',
			'more': '还有 {count} 条更早的记录',
			'transcript.label': '自我进化',
			'transcript.empty': '（这条记录没有正文）',
			'aria.transcriptRow': '展开这条自我进化记录'
		};
		const en = {
			title: 'Self-evolution',
			'aria.strip': 'Self-evolution: what it learned',
			'glyph.title': 'Self-evolution: learned {count}× · memory {percent}% (click to see what it learned)',
			'aria.expand': 'Expand the learning log',
			'aria.collapse': 'Collapse the learning log',
			'reveal.prefix': 'Just learned',
			'stat.learned': 'Learned {count}×',
			'stat.memory': 'Memory {percent}%',
			'stat.none': 'Nothing learned yet',
			'kind.memory': 'Saved a note',
			'kind.memory.verbose': 'Saved a note: {text}',
			'kind.user': 'Updated one thing about you',
			'kind.user.verbose': 'Updated one thing about you: {text}',
			'kind.memoryPending': 'Wants to change an old note — waiting for you',
			'kind.memoryPending.verbose': 'Wants to change an old note — waiting for you: {text}',
			'kind.skillCreated': 'Created skill "{name}"',
			'kind.skillCreated.verbose': 'Created skill "{name}": {why}',
			'kind.skillUpdated': 'Improved skill "{name}"',
			'kind.skillUpdated.verbose': 'Improved skill "{name}": {why}',
			'kind.skillSkipped': 'Deferred a skill rewrite of "{name}"',
			'kind.skillSkipped.verbose': 'Deferred a skill rewrite of "{name}": {why}',
			'usage.memory': 'Memory',
			'usage.user': 'User profile',
			'section.timeline': 'Recently learned',
			'section.entries': '{count} remembered',
			'section.pending': 'Waiting for you ({count})',
			'pending.remove': 'It wants to delete this',
			'pending.replace': 'It wants to reword this',
			'pending.current': 'What it says now',
			'pending.next': 'The new wording',
			'pending.approve': 'Agree',
			'pending.reject': 'No thanks',
			'pending.busy': 'Working…',
			'pending.note': 'It never edits your memory by itself — this takes effect only after you agree.',
			'pending.failed': 'That did not work: {message}',
			'tag.auto': 'auto',
			'tag.memory': 'memory',
			'tag.user': 'profile',
			'entry.empty': 'No long-term memory yet. After a more involved task, what it learned shows up here.',
			'time.seconds': '{count}s ago',
			'time.minutes': '{count}m ago',
			'time.hours': '{count}h ago',
			'time.days': '{count}d ago',
			'auto.on': 'Auto review is on',
			'auto.off': 'Auto review is off',
			'more': '{count} earlier records',
			'transcript.label': 'Self-evolution',
			'transcript.empty': '(this record has no body)',
			'aria.transcriptRow': 'Expand this self-evolution record'
		};

		/** "3 分钟前"-style relative time. */
		function ago(t, ms) {
			const seconds = Math.max(0, Math.round((Date.now() - ms) / 1000));
			if (seconds < 60) return t('time.seconds', { count: seconds });
			const minutes = Math.round(seconds / 60);
			if (minutes < 60) return t('time.minutes', { count: minutes });
			const hours = Math.round(minutes / 60);
			if (hours < 24) return t('time.hours', { count: hours });
			return t('time.days', { count: Math.round(hours / 24) });
		}

		function percent(used, limit) {
			if (!limit) return 0;
			return Math.min(100, Math.round((used / limit) * 100));
		}

		/** The newest learning time already seen, or `null` on a first visit (nothing is "new" yet). */
		function readSeen() {
			try {
				const raw = window.localStorage.getItem(SEEN_KEY);
				if (raw === null) return null;
				const value = Number(raw);
				return Number.isFinite(value) && value > 0 ? value : null;
			} catch {
				return null;
			}
		}

		function writeSeen(ms) {
			try {
				window.localStorage.setItem(SEEN_KEY, String(ms));
			} catch {
				// A blocked storage only costs the reveal coming back once.
			}
		}

		/** Split a skill summary's conventional `name: why` shape without guessing beyond the first separator. */
		function skillParts(summary) {
			const at = summary.indexOf(': ');
			if (at <= 0) return { name: summary, why: '' };
			return { name: summary.slice(0, at), why: summary.slice(at + 2) };
		}

		/** One learned item, named the way Hermes names it: the operation, plus the content under `verbose`. */
		function entryText(t, entry, verbose) {
			const key = KIND_KEY[entry.kind];
			const summary = typeof entry.summary === 'string' ? entry.summary : '';
			if (key === undefined) return summary;
			if (SKILL_KINDS.has(entry.kind)) {
				const { name, why } = skillParts(summary);
				return verbose && why.length > 0 ? t(`${key}.verbose`, { name, why }) : t(key, { name });
			}
			return verbose && summary.length > 0 ? t(`${key}.verbose`, { text: summary }) : t(key);
		}

		/** One record's headline: every item it saved, joined the way Hermes joins them. */
		function recordText(t, record, verbose) {
			return record.learned.map((entry) => entryText(t, entry, verbose)).join(' · ');
		}

		/**
		 * The one piece of state both surfaces share: the Host's payload, whether the panel is open, and
		 * the newest learning the user has already seen. One poll serves both entries, and polling stops
		 * when neither is mounted.
		 *
		 * The card is not permanent furniture: it exists only while there is something to say (a new
		 * learning, or a change waiting for a decision) or while the user has it open. The rest of the
		 * time a single small glyph in the composer's stats row is the way back in.
		 */
		function createSource() {
			let snapshot = { data: null, panelOpen: false, seen: readSeen() };
			const listeners = new Set();
			let timer = null;
			const publish = (next) => {
				snapshot = next;
				for (const listener of listeners) listener();
			};
			const load = () => {
				fetch(ENDPOINT, { headers: { accept: 'application/json' } })
					.then((response) => (response.ok ? response.json() : null))
					.then((payload) => {
						if (payload === null || payload.ok !== true) return;
						// The first visit adopts the newest record as already seen: only learning that
						// happens while the user is here is worth announcing.
						if (snapshot.seen === null) {
							const newest = (payload.timeline ?? []).find((record) => record.learned.length > 0);
							if (newest !== undefined) {
								writeSeen(newest.time);
								publish({ ...snapshot, data: payload, seen: newest.time });
								return;
							}
						}
						publish({ ...snapshot, data: payload });
					})
					.catch(() => {});
			};
			return {
				getSnapshot: () => snapshot,
				subscribe(listener) {
					listeners.add(listener);
					if (listeners.size === 1) {
						load();
						timer = setInterval(load, POLL_MS);
					}
					return () => {
						listeners.delete(listener);
						if (listeners.size === 0 && timer !== null) {
							clearInterval(timer);
							timer = null;
						}
					};
				},
				setPanelOpen(panelOpen) {
					publish({ ...snapshot, panelOpen });
				},
				markSeen(time) {
					if (snapshot.seen !== null && time <= snapshot.seen) return;
					writeSeen(time);
					publish({ ...snapshot, seen: time });
				},
				/** Adopt a whole new payload (after the user approved or dropped a queued change). */
				adopt(data) {
					publish({ ...snapshot, data });
				}
			};
		}

		const source = createSource();

		/** Subscribe one component to the shared state. */
		function useEvolution() {
			const [state, setState] = React.useState(source.getSnapshot);
			React.useEffect(() => source.subscribe(() => setState(source.getSnapshot())), []);
			return state;
		}

		const { useEffect, useState } = React;

		/** Everything both surfaces derive from the payload, computed once per render. */
		function derive(data, seen) {
			const records = (data?.timeline ?? []).filter((record) => record.learned.length > 0);
			const latest = records[0];
			const notify = typeof data?.notify === 'string' ? data.notify : 'verbose';
			const waiting = (data?.pending ?? []).length;
			const fresh = notify !== 'off' && latest !== undefined && (seen === null || latest.time > seen);
			return {
				records,
				latest,
				waiting,
				notify,
				fresh,
				learnedCount: records.reduce((total, record) => total + record.learned.length, 0),
				remembered: (data?.memory?.count ?? 0) + (data?.user?.count ?? 0),
				/** Something the user has not seen: drive the card's appearance. */
				hasNews: fresh || waiting > 0
			};
		}

		/** Whether the card owns the space above the composer right now. */
		function cardVisible(state) {
			return state.data !== null && (state.panelOpen || state.data.uiMode === 'always' || derive(state.data, state.seen).hasNews);
		}

		/** One usage bar. `delay` staggers the two bars so they grow one after the other. */
		function Bar({ used, limit, label, delay }) {
			return h('div', { className: 'dshse-usageRow' },
				h('span', { className: 'dshse-usageLabel' }, label),
				h('span', { className: 'dshse-track' },
					h('span', { className: 'dshse-fill', style: { width: `${percent(used, limit)}%`, animationDelay: `${delay}ms` } })),
				h('span', { className: 'dshse-usageText' }, `${used}/${limit}`));
		}

		/**
		 * One change the unattended review proposed but is not allowed to make on its own. It shows the
		 * exact text it would destroy — the whole point of asking is that the person can see what they
		 * would lose before they say yes.
		 */
		function PendingItem({ item, index, busy, onDecide, t }) {
			const working = busy !== null;
			return h('div', { className: 'dshse-pending', style: { animationDelay: `${Math.min(index, 4) * 45}ms` } },
				h('div', { className: 'dshse-pendingHead' },
					h('span', { className: 'dshse-pendingTitle' }, t(item.action === 'remove' ? 'pending.remove' : 'pending.replace')),
					h('span', { className: 'dshse-tag' }, t('tag.auto'))),
				h('div', null,
					h('div', { className: 'dshse-quoteLabel' }, t('pending.current')),
					h('div', { className: 'dshse-quote' }, item.current)),
				item.action === 'replace' && item.content.length > 0
					? h('div', null,
						h('div', { className: 'dshse-quoteLabel' }, t('pending.next')),
						h('div', { className: 'dshse-quote' }, item.content))
					: null,
				h('div', { className: 'dshse-actions' },
					h('button', {
						type: 'button',
						className: 'dshse-btn',
						'data-primary': true,
						disabled: working,
						onClick: () => onDecide(item.id, 'approve')
					}, busy === item.id ? t('pending.busy') : t('pending.approve')),
					h('button', {
						type: 'button',
						className: 'dshse-btn',
						disabled: working,
						onClick: () => onDecide(item.id, 'reject')
					}, t('pending.reject'))));
		}

		/** The expanded card: what is waiting for a decision, usage, the timeline, and what is remembered. */
		function Panel({ data, t, busy, onDecide, failure }) {
			const records = data.timeline.filter((record) => record.learned.length > 0);
			const shown = records.slice(0, 6);
			const entries = data.entries ?? [];
			const pending = data.pending ?? [];
			return h('div', { className: 'dshse-panel' },
				pending.length > 0
					? h('div', { className: 'dshse-section' }, t('section.pending', { count: pending.length }))
					: null,
				...pending.map((item, index) => h(PendingItem, { key: item.id, item, index, busy, onDecide, t })),
				pending.length > 0 ? h('div', { className: 'dshse-note' }, t('pending.note')) : null,
				failure === '' ? null : h('div', { className: 'dshse-note' }, t('pending.failed', { message: failure })),
				h('div', { className: 'dshse-usage' },
					h(Bar, { used: data.memory.used, limit: data.memory.limit, label: t('usage.memory'), delay: 40 }),
					h(Bar, { used: data.user.used, limit: data.user.limit, label: t('usage.user'), delay: 110 })),
				records.length > 0
					? h('div', { className: 'dshse-section' }, `${t('section.timeline')} · ${data.autoReview ? t('auto.on') : t('auto.off')}`)
					: null,
				...shown.map((record, index) => h('div', { key: `r${index}`, className: 'dshse-record', style: { animationDelay: `${index * 40}ms` } },
					h('div', { className: 'dshse-when' }, ago(t, record.time)),
					...record.learned.map((entry, i) => h('div', { key: i, className: 'dshse-line' }, entryText(t, entry, true))),
					record.reason.length > 0 ? h('div', { className: 'dshse-reason' }, record.reason) : null)),
				records.length > shown.length
					? h('div', { className: 'dshse-more' }, t('more', { count: records.length - shown.length }))
					: null,
				entries.length > 0
					? h('div', { className: 'dshse-section' }, t('section.entries', { count: entries.length }))
					: null,
				entries.length > 0
					? entries.map((entry, index) => h('div', { key: `e${index}`, className: 'dshse-entry', style: { animationDelay: `${Math.min(index, 8) * 28}ms` } },
						h('span', { className: 'dshse-tag' }, entry.target === 'user' ? t('tag.user') : t('tag.memory')),
						entry.origin === 'auto' ? h('span', { className: 'dshse-tag', title: t('tag.auto') }, `· ${t('tag.auto')}`) : null,
						h('span', { className: 'dshse-entryText', title: entry.text }, entry.text)))
					: h('div', { className: 'dshse-empty' }, t('entry.empty')));
		}

		function Dock({ t }) {
			const state = useEvolution();
			const [busy, setBusy] = React.useState(null);
			const [failure, setFailure] = React.useState('');
			const { data, panelOpen, seen } = state;

			/** Approve or drop one queued change: the only thing this card ever writes. */
			const decide = React.useCallback((id, decision) => {
				setBusy(id);
				setFailure('');
				fetch(PENDING_ENDPOINT, {
					method: 'POST',
					headers: { 'content-type': 'application/json', accept: 'application/json' },
					body: JSON.stringify({ id, decision })
				})
					.then((response) => (response.ok ? response.json() : null))
					.then((payload) => {
						if (payload === null || payload.ok !== true) {
							setFailure(typeof payload?.error === 'string' ? payload.error : 'unknown');
							return;
						}
						if (payload.state && payload.state.ok === true) source.adopt(payload.state);
					})
					.catch(() => setFailure('unknown'))
					.finally(() => setBusy(null));
			}, []);

			// Nothing to show, or the user turned the interface off: the card takes no space.
			if (data === null || data.uiMode === 'off') return null;
			const derived = derive(data, seen);
			if (derived.learnedCount === 0 && derived.remembered === 0) return null;
			const { fresh, waiting, latest, notify, learnedCount } = derived;
			// The card is not permanent: it appears for news, for a decision it is waiting on, when the
			// user opens it, or when `uiMode: always` asks for the old always-on strip.
			if (!cardVisible(state)) return null;
			const open = panelOpen;
			const toggle = () => {
				if (open) {
					source.setPanelOpen(false);
					return;
				}
				source.setPanelOpen(true);
				if (fresh && latest !== undefined) source.markSeen(latest.time);
			};
			const status = fresh
				? `${t('reveal.prefix')}：${recordText(t, latest, notify === 'verbose')}`
				: learnedCount === 0
					? t('stat.none')
					: `${t('stat.learned', { count: learnedCount })} · ${t('stat.memory', { percent: percent(data.memory.used, data.memory.limit) })}`;
			const statusWithWaiting = waiting > 0 && !fresh
				? `${status} · ${t('section.pending', { count: waiting })}`
				: status;
			return h('div', { className: 'dshse-root', 'data-self-evolution': 'dock' },
				h('div', { className: 'dshse-body' },
					h('button', {
						type: 'button',
						className: 'dshse-head',
						'aria-expanded': open,
						'aria-label': open ? t('aria.collapse') : t('aria.expand'),
						title: t('aria.strip'),
						onClick: toggle
					},
						h('span', { className: 'dshse-lead', 'aria-hidden': true, 'data-fresh': fresh || waiting > 0 }, '◈'),
						h('span', { className: 'dshse-title' }, t('title')),
						h('span', { className: 'dshse-status', 'data-fresh': fresh || waiting > 0, title: statusWithWaiting }, statusWithWaiting),
						h('span', { className: 'dshse-chevron', 'aria-hidden': true, 'data-open': open }, '⌃')),
					open ? h(Panel, { data, t, busy, onDecide: decide, failure }) : null));
		}

		/**
		 * The way back in when the card is not showing: one small glyph in the composer's stats row,
		 * where this feature originally lived. It renders only while the card is hidden, so the two
		 * surfaces never both take space.
		 */
		function Glyph({ t }) {
			const state = useEvolution();
			const { data, seen } = state;
			if (data === null || data.uiMode === 'off') return null;
			const derived = derive(data, seen);
			if (derived.learnedCount === 0 && derived.remembered === 0) return null;
			if (cardVisible(state)) return null;
			return h('button', {
				type: 'button',
				className: 'dshse-glyph',
				title: t('glyph.title', { count: derived.learnedCount, percent: percent(data.memory.used, data.memory.limit) }),
				'aria-label': t('title'),
				onClick: () => source.setPanelOpen(true)
			}, '◈');
		}

		/**
		 * The durable half of this feature: the row the Host writes into the conversation when a turn
		 * taught the agent something.
		 *
		 * Hermes renders its review result as a line inside the transcript, so the record is still
		 * readable when you scroll back. DSH logs that line as an injected context row — a collapsed
		 * one-liner plus an expandable body — so this half only supplies the row's chrome and, while
		 * it is being drawn, quietly marks that learning as already seen (there is no reason to
		 * announce above the composer something that is right there in the conversation).
		 *
		 * Only the injected body is rendered, never the extracted tab title beside it: the title is a
		 * property of the host node and this component does not own it.
		 */
		function TranscriptRow({ node, t }) {
			const [open, setOpen] = useState(false);
			const summary = node?.data?.producer?.label ?? '';
			const body = (node?.data?.content ?? [])
				.filter((block) => block?.type === 'text' && typeof block.text === 'string')
				.map((block) => block.text)
				.join('\n');
			useEffect(() => {
				if (!node?.data?.time) return;
				source.markSeen(node.data.time);
			}, [node?.data?.time]);
			return h('div', { className: 'dshse-row', 'data-self-evolution': 'transcript' },
				h('div', { className: 'dshse-rowHead' },
					h('span', { className: 'dshse-rowGlyph', 'aria-hidden': true }, ROW_MARK),
					h('span', { className: 'dshse-rowLabel' }, t('transcript.label')),
					h('span', { className: 'dshse-rowText', title: summary }, summary),
					h('button', {
						type: 'button',
						className: 'dshse-rowChevron',
						'aria-expanded': open,
						'aria-label': t('aria.transcriptRow'),
						'data-open': open,
						onClick: () => setOpen((value) => !value)
					}, '⌃')),
				open ? h('div', { className: 'dshse-rowBody' }, body.length > 0 ? body : t('transcript.empty')) : null);
		}

		return {
			inject: ['slots', 'locale'],
			apply(ctx) {
				ctx.effect(() => {
					if (document.querySelector(`style[data-plugin-css=${JSON.stringify(STYLE_TAG)}]`) !== null) return () => {};
					const tag = document.createElement('style');
					tag.dataset.plugin = 'dsh-self-evolution';
					tag.dataset.pluginCss = STYLE_TAG;
					tag.id = STYLE_ID;
					tag.textContent = CSS;
					document.head.appendChild(tag);
					return () => {
						tag.remove();
					};
				}, 'self-evolution: dock styles');
				ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'self-evolution: dictionaries');
				ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
					name: 'conversation.input.dock',
					id: 'self-evolution',
					order: 15,
					locale: NS
				}, Dock));
				ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
					name: 'conversation.composer.dock',
					id: 'self-evolution-glyph',
					order: 40,
					locale: NS
				}, Glyph));
				ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({
					name: 'conversation.chat.node',
					key: 'context',
					id: 'self-evolution-transcript',
					order: 10,
					locale: NS
				}, TranscriptRow));
			}
		};
	}
});
