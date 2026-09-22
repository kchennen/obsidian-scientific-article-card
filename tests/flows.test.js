"use strict";
/* End-to-end workflows on an in-memory vault, with recorded API responses. */
const test = require("node:test");
const assert = require("node:assert/strict");
const env = require("./helpers/env");
const { replay } = require("./helpers/network");
const { createApp } = require("./helpers/fake-app");
const { I, yaml } = env;

const LIST = "Projects/IMPatienT/Biblios/Biblios.md";
const DIR = "Projects/IMPatienT/Biblios";
const card = (fields) => "```paper\n" + Object.entries(fields).map(([k, v]) => `${k}: ${typeof v === "number" ? v : JSON.stringify(v)}`).join("\n") + "\n```";
const ALPHAFOLD = { url: "https://pubmed.ncbi.nlm.nih.gov/34265844/", title: "Highly accurate protein structure prediction with AlphaFold", authors: "Jumper J, Evans R", journal: "Nature", year: "2021", doi: "10.1038/s41586-021-03819-2", pmid: "34265844", pmcid: "PMC8371605" };
const ZUCCA = { url: "https://pubmed.ncbi.nlm.nih.gov/38520562/", title: "An AI-based approach", authors: "Zucca S, Nicora G", journal: "Human genetics", year: "2025", doi: "10.1007/s00439-023-02638-x", pmid: "38520562" };

async function until(fn, ms = 3000) {
	const t0 = Date.now();
	while (!fn()) {
		if (Date.now() - t0 > ms) throw new Error("timed out waiting for " + fn);
		await new Promise((r) => setTimeout(r, 10));
	}
}

async function setup(listText, settings = {}) {
	env.setNetwork(replay());
	env.notices.length = 0;
	const vault = createApp({ [LIST]: listText });
	const plugin = await env.loadPlugin(vault.app, settings);
	/** Render the card containing `needle` through the registered processor, like Obsidian. */
	const render = (needle, path = LIST) => {
		const lines = vault.text(path).split("\n");
		const start = lines.findIndex((l, i) => l.startsWith("```paper") && !l.startsWith("```paper-note") && lines.slice(i, i + 25).join("\n").includes(needle));
		assert.notEqual(start, -1, "card not found: " + needle);
		let end = start + 1;
		while (lines[end] !== "```") end++;
		const el = env.mount();
		const source = lines.slice(start + 1, end).join("\n");
		plugin.processors.paper(source, el, { sourcePath: path, getSectionInfo: () => ({ lineStart: start }), addChild: (c) => c.load() });
		return { el, source, data: yaml.load(source), block: { source, el, ctx: { sourcePath: path, getSectionInfo: () => ({ lineStart: start }) } } };
	};
	const renderNote = (path) => {
		const el = env.mount();
		plugin.processors["paper-note"]("", el, { sourcePath: path, getSectionInfo: () => null, addChild: (c) => c.load() });
		return el;
	};
	return { vault, plugin, render, renderNote };
}
const texts = (el, sel) => [...el.querySelectorAll(sel)].map((x) => x.textContent);
const cardFields = (vault, needle) => {
	const t = vault.text(LIST);
	const i = t.indexOf(needle);
	const s = t.lastIndexOf("```paper", i);
	return yaml.load(t.slice(s + 9, t.indexOf("\n```", i)));
};

test("inserting a card: placeholder, then the card; failures restore the text", async () => {
	const { plugin } = await setup("# List\n");
	let doc = "Notes\n";
	const lines = () => doc.split("\n");
	const off = ({ line, ch }) => lines().slice(0, line).reduce((a, l) => a + l.length + 1, 0) + ch;
	const pos = (o) => {
		const L = lines();
		let line = 0;
		while (line < L.length - 1 && o > L[line].length) (o -= L[line].length + 1), line++;
		return { line, ch: o };
	};
	let cursor = { line: 1, ch: 0 };
	const editor = {
		getValue: () => doc,
		getLine: (n) => lines()[n],
		getCursor: () => cursor,
		offsetToPos: pos,
		replaceRange: (t, f, to) => (doc = doc.slice(0, off(f)) + t + doc.slice(off(to || f))),
		replaceSelection: (t) => {
			const a = off(cursor);
			doc = doc.slice(0, a) + t + doc.slice(a);
			cursor = pos(a + t.length);
		},
	};
	const ident = I.parseIdentifier("PMID: 34265844", {});
	const pending = plugin.convertIdentifiers(editor, [ident], null);
	assert.match(doc, /⏳ Fetching paper metadata for PMID: 34265844/);
	await pending;
	assert.doesNotMatch(doc, /Fetching/);
	const block = yaml.load(doc.match(/```paper\n([\s\S]*?)```/)[1]);
	assert.equal(block.pmid, "34265844");
	assert.match(block.image, /Fig1_HTML\.jpg$/);

	doc = "Notes\n";
	cursor = { line: 1, ch: 0 };
	await plugin.convertIdentifiers(editor, [I.parseIdentifier("PMID: 1", {})], null);
	assert.equal(doc, "Notes\nPMID: 1");
	assert.ok(env.notices.some((n) => /PMID: 1/.test(n)));
});

test("option A: the pencil saves notes into the card and copies tags to the note's tags", async () => {
	const { vault, render } = await setup(`---\ntags:\n  - IMPatienT\n---\n\n${card(ZUCCA)}\n`);
	const r = render("38520562");
	assert.deepEqual(texts(r.el, ".scientific-article-card-button"), ["Create note"]);
	r.el.querySelector('[aria-label="Edit notes"]').click();
	await env.lastModal().onSubmit({ status: "reading", rating: 4, tags: ["impatient2", "ml"], note: "Check CAGI6." });
	assert.deepEqual((({ status, rating, tags, note }) => ({ status, rating, tags, note }))(cardFields(vault, "38520562")), { status: "reading", rating: 4, tags: ["impatient2", "ml"], note: "Check CAGI6." });
	assert.deepEqual(vault.frontmatter(LIST).tags, ["IMPatienT", "impatient2", "ml"]);
});

test("Create note: named, placed next to the list, notes moved, card linked, backlinks, opened", async () => {
	const { vault, render } = await setup(`---\ntags:\n  - IMPatienT\n---\n\n${card(Object.assign({}, ZUCCA, { status: "reading", rating: 4, tags: ["impatient2"], note: "Check CAGI6." }))}\n`);
	const r = render("38520562");
	r.el.querySelector(".scientific-article-card-button").click();
	const NOTE = `${DIR}/Zucca_HumGenet_2025.md`;
	await until(() => vault.opened.includes(NOTE));
	const fm = vault.frontmatter(NOTE);
	assert.equal(fm.type, "paper");
	assert.deepEqual([fm.pmid, fm.doi, fm.year, fm.journal], ["38520562", "10.1007/s00439-023-02638-x", 2025, "Human genetics"]);
	assert.deepEqual([fm.status, fm.rating, fm.tags, fm.summary], ["reading", 4, ["impatient2"], "Check CAGI6."]);
	assert.deepEqual(fm["reading-lists"], ["[[Biblios]]"]);
	assert.deepEqual(vault.frontmatter(LIST).papers, ["[[Zucca_HumGenet_2025]]"]);
	assert.ok(vault.text(NOTE).includes("```paper-note\n" + I.PAPER_NOTE_PLACEHOLDER + "\n```"));
	const c = cardFields(vault, "38520562");
	assert.deepEqual([c["paper-note"], c.status, c.rating, c.tags, c.note], ["[[Zucca_HumGenet_2025]]", undefined, undefined, undefined, undefined]);
});

test("linked card: Open note, the note's values, re-rendered when the note changes", async () => {
	const { vault, plugin, render } = await setup(`${card(ZUCCA)}\n`);
	await plugin.createPaperNote({ ident: I.identFromCard(ZUCCA), card: ZUCCA, sourcePath: LIST, block: render("38520562").block });
	const NOTE = `${DIR}/Zucca_HumGenet_2025.md`;
	const r = render("38520562");
	assert.deepEqual(texts(r.el, ".scientific-article-card-button"), ["Open note"]);
	assert.deepEqual(texts(r.el, ".scientific-article-card-mine-source"), []);
	await vault.app.fileManager.processFrontMatter(vault.file(NOTE), (f) => {
		f.status = "read";
		f.summary = "Now read.";
	});
	assert.deepEqual(texts(r.el, ".scientific-article-card-status"), ["Read"], "re-rendered after the note's properties changed");
	assert.deepEqual(texts(r.el, ".scientific-article-card-note p"), ["Now read."]);
	assert.deepEqual(texts(r.el, ".scientific-article-card-mine-source"), ["in Zucca_HumGenet_2025"]);
	r.el.querySelector('[aria-label="Edit notes"]').click();
	assert.equal(env.lastModal().options.noteLabel, "Summary");
	await env.lastModal().onSubmit({ status: "to-read", rating: 2, tags: ["x"], note: "" });
	const fm = vault.frontmatter(NOTE);
	assert.deepEqual([fm.status, fm.rating, fm.tags, "summary" in fm], ["to-read", 2, ["x"], false]);
	assert.equal(cardFields(vault, "38520562").status, undefined, "the card itself is untouched");
});

test("leftover card notes on a linked card: warning, then Move to paper note (the Meyer case)", async () => {
	const { vault, plugin, render } = await setup(`${card(ZUCCA)}\n`);
	await plugin.createPaperNote({ ident: I.identFromCard(ZUCCA), card: Object.assign({}, ZUCCA, { note: "test note" }), sourcePath: LIST, block: render("38520562").block });
	const NOTE = `${DIR}/Zucca_HumGenet_2025.md`;
	let r = render("38520562");
	await plugin.rewriteCard(r.block, (L) => I.setFields(L, { status: "read", rating: 4, note: "test note summary" }));
	r = render("38520562");
	const strip = r.el.querySelector(".scientific-article-card-conflict");
	assert.ok(strip, "warning shown");
	assert.match(strip.textContent, /test note summary/);
	strip.querySelector("button").click();
	await until(() => cardFields(vault, "38520562").note === undefined);
	const fm = vault.frontmatter(NOTE);
	assert.deepEqual([fm.status, fm.rating, fm.summary], ["read", 4, "test note"]);
	assert.match(vault.text(NOTE), /## Notes\n\ntest note summary\n/);
	assert.equal(render("38520562").el.querySelector(".scientific-article-card-conflict"), null);
});

test("no duplicates: double click, same paper again, same name for another paper → a", async () => {
	const { vault, plugin, render } = await setup(`${card(ALPHAFOLD)}\n`);
	const args = { ident: I.identFromCard(ALPHAFOLD), card: ALPHAFOLD, sourcePath: LIST, block: render("34265844").block };
	await Promise.all([plugin.createPaperNote(args), plugin.createPaperNote(args)]);
	const notes = () => [...vault.files.keys()].filter((k) => k.endsWith(".md") && k !== LIST);
	assert.deepEqual(notes(), [`${DIR}/Jumper_Nature_2021.md`]);
	await plugin.createPaperNote({ ident: { type: "doi", id: ALPHAFOLD.doi, raw: ALPHAFOLD.doi }, card: null, sourcePath: LIST, block: null });
	assert.equal(notes().length, 1);
	await plugin.createPaperNote({ ident: null, card: { title: "Other", authors: "Jumper J", journal: "Nature", year: "2021", doi: "10.9/other" }, sourcePath: LIST, block: null });
	assert.deepEqual(notes().sort(), [`${DIR}/Jumper_Nature_2021.md`, `${DIR}/Jumper_Nature_2021a.md`]);
});

test("paper note location: subfolder, dedicated folder", async () => {
	let t = await setup(`${card(ALPHAFOLD)}\n`, { paperNoteSubfolder: "Papers" });
	await t.plugin.createPaperNote({ ident: I.identFromCard(ALPHAFOLD), card: null, sourcePath: LIST, block: null });
	assert.ok(t.vault.files.has(`${DIR}/Papers/Jumper_Nature_2021.md`));
	t = await setup(`${card(ALPHAFOLD)}\n`, { paperNoteLocation: "folder", paperNoteFolder: "4_Resources/Papers" });
	await t.plugin.createPaperNote({ ident: I.identFromCard(ALPHAFOLD), card: null, sourcePath: LIST, block: null });
	assert.ok(t.vault.files.has("4_Resources/Papers/Jumper_Nature_2021.md"));
});

test("cards find their paper note by DOI/PMID: renamed note, note made elsewhere; Open note records the link", async () => {
	const { vault, plugin, render } = await setup(`${card(ALPHAFOLD)}\n`);
	await plugin.createPaperNote({ ident: I.identFromCard(ALPHAFOLD), card: null, sourcePath: "Elsewhere.md", block: null });
	plugin.recentNotes.clear();
	vault.rename("Jumper_Nature_2021.md", "Papers/AlphaFold paper.md");
	const r = render("34265844");
	assert.deepEqual(texts(r.el, ".scientific-article-card-button"), ["Open note"]);
	r.el.querySelector(".scientific-article-card-button").click();
	await until(() => cardFields(vault, "34265844")["paper-note"] === "[[AlphaFold paper]]" && vault.frontmatter(LIST) && vault.frontmatter(LIST).papers);
	assert.deepEqual(vault.frontmatter("Papers/AlphaFold paper.md")["reading-lists"], ["[[Biblios]]"]);
	assert.deepEqual(vault.frontmatter(LIST).papers, ["[[AlphaFold paper]]"]);
});

test("paper note: its card, Refresh keeps your properties and text, commands", async () => {
	const { vault, plugin, renderNote } = await setup(`${card(ZUCCA)}\n`);
	await plugin.createPaperNote({ ident: I.identFromCard(ZUCCA), card: null, sourcePath: LIST, block: null });
	const NOTE = `${DIR}/Zucca_HumGenet_2025.md`;
	const el = renderNote(NOTE);
	assert.deepEqual(texts(el, ".scientific-article-card-button"), ["Refresh"]);
	assert.ok(el.querySelector('[aria-label="Edit notes"]'));
	await vault.app.fileManager.processFrontMatter(vault.file(NOTE), (f) => Object.assign(f, { title: "OLD", status: "read", summary: "S", tags: ["mine"], custom: 1 }));
	await vault.app.vault.process(vault.file(NOTE), (t) => t + "\nMy paragraph.\n");
	const body = vault.text(NOTE).replace(/^---[\s\S]*?---\n/, "");
	el.querySelector(".scientific-article-card-button").click();
	await until(() => vault.frontmatter(NOTE).title !== "OLD");
	const fm = vault.frontmatter(NOTE);
	assert.deepEqual([fm.status, fm.summary, fm.tags, fm.custom], ["read", "S", ["mine"], 1]);
	assert.equal(vault.text(NOTE).replace(/^---[\s\S]*?---\n/, ""), body);
	const refresh = plugin.commands["refresh-paper-metadata"];
	vault.setActive(NOTE);
	assert.equal(refresh.checkCallback(true), true);
	vault.setActive(LIST);
	assert.equal(refresh.checkCallback(true), false, "only in paper notes");
	for (const id of ["create-paper-note", "connect-cards-and-paper-notes", "create-papers-base", "convert-selection-to-scientific-article-card", "insert-scientific-article-card"])
		assert.ok(plugin.commands[id], id);
});

test("Papers base: created next to the list, then reused", async () => {
	const { vault, plugin } = await setup(`${card(ZUCCA)}\n`);
	await plugin.createPapersBase(LIST);
	const BASE = `${DIR}/Papers.base`;
	assert.deepEqual(yaml.load(vault.text(BASE)).filters.and, ['type == "paper"', `file.inFolder("${DIR}")`]);
	const before = vault.files.size;
	await plugin.createPapersBase(LIST);
	assert.equal(vault.files.size, before);
	assert.equal(vault.opened.filter((p) => p === BASE).length, 2);
});

test("backlink command links existing cards once", async () => {
	const { vault, plugin, render } = await setup(`${card(ZUCCA)}\n`);
	await plugin.createPaperNote({ ident: I.identFromCard(ZUCCA), card: ZUCCA, sourcePath: LIST, block: render("38520562").block });
	await vault.app.fileManager.processFrontMatter(vault.file(LIST), (f) => delete f.papers);
	assert.equal(await plugin.connectCardsInNote(vault.file(LIST)), 1);
	await plugin.connectCardsInNote(vault.file(LIST));
	assert.deepEqual(vault.frontmatter(LIST).papers, ["[[Zucca_HumGenet_2025]]"]);
});

test("color settings update cards already on screen", async () => {
	const { plugin, render } = await setup(`${card(ZUCCA)}\n`);
	const r = render("38520562");
	plugin.settings.keywordColor = "pink";
	plugin.refreshColors();
	assert.ok(r.el.querySelector(".scientific-article-card").classList.contains("sac-kw-pink"));
});
