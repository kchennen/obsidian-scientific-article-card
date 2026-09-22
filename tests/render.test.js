"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { I, mount } = require("./helpers/env");

const S = I.DEFAULT_SETTINGS;
const data = {
	url: "https://pubmed.ncbi.nlm.nih.gov/1/",
	title: "A title",
	authors: "Doe J, Roe R",
	journal: "Nature",
	year: "2021",
	volume: "1",
	issue: "2",
	pages: "3-4",
	doi: "10.1/x",
	pmid: "1",
	pmcid: "PMC1",
	type: "Review",
	host: "pubmed.ncbi.nlm.nih.gov",
	image: "https://img/x.png",
	keywords: "Deep Learning; Proteins",
	abstract: "Background: foo.\n\nResults: bar.",
};
const q = (el, sel) => [...el.querySelectorAll(sel)].map((x) => x.textContent);

test("card structure: header, title link, citation, identifiers, image, keywords, abstract", () => {
	const el = mount();
	const card = I.renderCardData(data, el, S, {});
	assert.ok(card.classList.contains("scientific-article-card"));
	assert.deepEqual(q(el, ".scientific-article-card-badge"), ["Review"]);
	const title = el.querySelector("a.scientific-article-card-title");
	assert.equal(title.textContent, "A title");
	assert.equal(title.getAttribute("href"), data.url);
	assert.equal(el.querySelector(".scientific-article-card-citation").textContent, "Nature · 2021;1(2):3-4");
	assert.deepEqual(q(el, ".scientific-article-card-id-label"), ["DOI", "PMID", "PMC"]);
	assert.equal(el.querySelector(".scientific-article-card-thumb img").getAttribute("src"), data.image);
	assert.deepEqual(q(el, ".scientific-article-card-keyword"), ["Deep Learning", "Proteins"]);
	assert.deepEqual(q(el, ".scientific-article-card-toggle.is-keywords > summary"), ["Keywords (2)"]);
	assert.deepEqual(q(el, ".scientific-article-card-abstract strong"), ["Background: ", "Results: "]);
	assert.equal(el.querySelector(".scientific-article-card-abstract").hasAttribute("open"), false);
	assert.equal(el.querySelector(".scientific-article-card-mine"), null); // no notes -> no section
});

test("abstract open by default when the setting is on", () => {
	const el = mount();
	I.renderCardData(data, el, Object.assign({}, S, { abstractOpen: true }), {});
	assert.ok(el.querySelector(".scientific-article-card-abstract").hasAttribute("open"));
});

test("errors: invalid YAML, no title or URL", () => {
	const el = mount();
	I.renderCard("title: [unclosed", el, S);
	assert.match(el.textContent, /invalid YAML/);
	const el2 = mount();
	I.renderCard('journal: "x"', el2, S);
	assert.match(el2.textContent, /title.*or.*url.*required/);
});

test("your notes section: status, rating, tags, note", () => {
	const el = mount();
	I.renderCardData(Object.assign({}, data, { status: "to-read", rating: 4, tags: ["a", "#b"], note: "Para 1\n\nPara 2" }), el, S, {});
	assert.deepEqual(q(el, ".scientific-article-card-status"), ["To read"]);
	assert.ok(el.querySelector(".scientific-article-card-status").classList.contains("is-to-read"));
	assert.equal(el.querySelector(".scientific-article-card-rating").textContent, "★★★★☆");
	assert.deepEqual(q(el, ".scientific-article-card-tag"), ["#a", "#b"]);
	assert.deepEqual(q(el, ".scientific-article-card-note p"), ["Para 1", "Para 2"]);
});

test("linked card: shows the paper note's values, names the note, labelled buttons", () => {
	const el = mount();
	let opened = 0;
	let edited = 0;
	I.renderCardData(Object.assign({}, data, { status: "read", note: "card's own" }), el, S, {
		user: { status: "reading", rating: 2, tags: ["x"], note: "note summary" },
		userSource: "Doe_Nature_2021",
		note: { label: "Open note", icon: "file-text", onClick: () => opened++ },
		onEdit: () => edited++,
	});
	assert.deepEqual(q(el, ".scientific-article-card-status"), ["Reading"]);
	assert.deepEqual(q(el, ".scientific-article-card-note p"), ["note summary"]);
	assert.deepEqual(q(el, ".scientific-article-card-mine-source"), ["in Doe_Nature_2021"]);
	const btn = el.querySelector(".scientific-article-card-button");
	assert.equal(btn.textContent, "Open note");
	btn.click();
	el.querySelector('[aria-label="Edit notes"]').click();
	assert.deepEqual([opened, edited], [1, 1]);
});

test("color settings become classes on the card", () => {
	const el = mount();
	const card = I.renderCardData(data, el, Object.assign({}, S, { cardStyle: "obsidian", typeColor: "red", keywordColor: "accent", tagColor: "nope" }), {});
	assert.deepEqual([...card.classList].filter((c) => c.startsWith("sac-")).slice(0, 4), ["sac-surface-obsidian", "sac-type-red", "sac-kw-accent", "sac-tag-teal"]);
	assert.deepEqual(I.colorClasses(S), [
		"sac-surface-mantine",
		"sac-type-blue",
		"sac-kw-violet",
		"sac-tag-teal",
		"sac-badge-light",
		"sac-badge-size-md",
		"sac-badge-radius-xl",
		"sac-tt-type",
	]);
});

test("badge settings become classes; invalid values fall back to the defaults", () => {
	const cls = I.colorClasses(Object.assign({}, S, { badgeVariant: "dot", badgeSize: "lg", badgeRadius: "sm", badgeUppercase: "none" }));
	assert.deepEqual(cls.slice(4), ["sac-badge-dot", "sac-badge-size-lg", "sac-badge-radius-sm", "sac-tt-none"]);
	const bad = I.colorClasses(Object.assign({}, S, { badgeVariant: "x", badgeSize: "huge", badgeRadius: "", badgeUppercase: 1 }));
	assert.deepEqual(bad.slice(4), ["sac-badge-light", "sac-badge-size-md", "sac-badge-radius-xl", "sac-tt-type"]);
});

test("keywords and summary: collapsible, open state from the settings", () => {
	const withNote = Object.assign({}, data, { note: "Hello" });
	const el = mount();
	I.renderCardData(withNote, el, Object.assign({}, S, { keywordsOpen: false, summaryOpen: false }), {});
	assert.equal(el.querySelector(".is-keywords").hasAttribute("open"), false);
	assert.equal(el.querySelector(".is-summary").hasAttribute("open"), false);
	assert.deepEqual(q(el, ".is-summary > summary"), ["Note"]);
	const el2 = mount();
	I.renderCardData(withNote, el2, S, { user: { note: "From note" } });
	assert.ok(el2.querySelector(".is-keywords").hasAttribute("open"));
	assert.ok(el2.querySelector(".is-summary").hasAttribute("open"));
	assert.deepEqual(q(el2, ".is-summary > summary"), ["Summary"]);
});

test("changing the settings updates rendered cards (classes and open sections)", () => {
	const el = mount();
	const card = I.renderCardData(Object.assign({}, data, { note: "x" }), el, S, {});
	I.applyColorClasses(card, Object.assign({}, S, { badgeVariant: "outline", keywordsOpen: false, summaryOpen: false }));
	assert.ok(card.classList.contains("sac-badge-outline"));
	assert.equal(card.querySelector(".is-keywords").hasAttribute("open"), false);
	assert.equal(card.querySelector(".is-summary").hasAttribute("open"), false);
});

test("summary as Markdown when a renderer is given, plain text otherwise", () => {
	const md = "summary paper note\n- dfg\n - dfg";
	const el = mount();
	const seen = [];
	I.renderCardData(Object.assign({}, data), el, S, { user: { note: md }, renderMarkdown: (m, target) => { seen.push(m); target.createEl("ul"); } });
	assert.deepEqual(seen, [md]);
	assert.ok(el.querySelector(".scientific-article-card-note ul"));
	const el2 = mount();
	I.renderCardData(Object.assign({}, data, { note: md }), el2, S, {});
	assert.deepEqual(q(el2, ".scientific-article-card-note p.is-plain"), [md]);
});
