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
	assert.deepEqual(q(el, ".scientific-article-card-abstract strong"), ["Background: ", "Results: "]);
	assert.equal(el.querySelector("details").hasAttribute("open"), false);
	assert.equal(el.querySelector(".scientific-article-card-mine"), null); // no notes -> no section
});

test("abstract open by default when the setting is on", () => {
	const el = mount();
	I.renderCardData(data, el, Object.assign({}, S, { abstractOpen: true }), {});
	assert.ok(el.querySelector("details").hasAttribute("open"));
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

test("conflict strip with its action", () => {
	const el = mount();
	let moved = 0;
	I.renderCardData(data, el, S, { conflict: { text: "Leftover notes", label: "Move to paper note", onClick: () => moved++ } });
	const strip = el.querySelector(".scientific-article-card-conflict");
	assert.match(strip.textContent, /Leftover notes/);
	strip.querySelector("button").click();
	assert.equal(moved, 1);
});

test("color settings become classes on the card", () => {
	const el = mount();
	const card = I.renderCardData(data, el, Object.assign({}, S, { cardStyle: "obsidian", typeColor: "red", keywordColor: "accent", tagColor: "nope" }), {});
	assert.deepEqual([...card.classList].filter((c) => c.startsWith("sac-")), ["sac-surface-obsidian", "sac-type-red", "sac-kw-accent", "sac-tag-teal"]);
	assert.deepEqual(I.colorClasses(S), ["sac-surface-mantine", "sac-type-blue", "sac-kw-violet", "sac-tag-teal"]);
});
