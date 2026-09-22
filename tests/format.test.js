"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { I, yaml } = require("./helpers/env");

const paper = {
	title: "A [bracketed] title",
	authors: [
		{ last: "Jumper", first: "John", initials: "J" },
		{ last: "Evans", first: "Richard", initials: "R" },
		{ last: "", collective: "AlphaFold Team" },
	],
	journal: "Nature",
	year: "2021",
	volume: "596",
	issue: "7873",
	pages: "583-589",
	doi: "10.1038/x",
	pmid: "34265844",
	pmcid: "PMC8371605",
	url: "https://pubmed.ncbi.nlm.nih.gov/34265844/",
	keywordList: ["Deep Learning", "Protein Folding"],
	abstract: "Line one.\n\nLine two.",
	type: "Journal Article",
};

test("authors: short / full style, et al. after the maximum", () => {
	assert.equal(I.formatAuthors(paper.authors, "short", 0), "Jumper J, Evans R, AlphaFold Team");
	assert.equal(I.formatAuthors(paper.authors, "full", 0), "John Jumper, Richard Evans, AlphaFold Team");
	assert.equal(I.formatAuthors(paper.authors, "short", 2), "Jumper J, Evans R, et al.");
	assert.equal(I.formatAuthors([{ formatted: "Doe J" }], "full", 0), "Doe J");
});

test("citation line", () => {
	assert.equal(I.citationLine(paper), "Nature. 2021;596(7873):583-589");
	assert.equal(I.citationLine({ journal: "arXiv", year: "2017" }), "arXiv. 2017");
});

test("code block output is valid YAML with every field", () => {
	const block = I.toCodeBlock(I.toFields(paper, I.DEFAULT_SETTINGS));
	assert.match(block, /^```paper\n[\s\S]*\n```\n$/);
	const d = yaml.load(block.replace(/^```paper\n/, "").replace(/```\n$/, ""));
	assert.equal(d.title, paper.title);
	assert.equal(d.pmid, "34265844");
	assert.equal(d.keywords, "Deep Learning; Protein Folding");
	assert.equal(d.abstract, "Line one.\n\nLine two.");
});

test("abstract can be left out", () => {
	const f = I.toFields(paper, Object.assign({}, I.DEFAULT_SETTINGS, { includeAbstract: false }));
	assert.equal(f.abstract, "");
});

test("template: placeholders, optional sections, callout prefixes, escaped title", () => {
	const f = I.toFields(paper, I.DEFAULT_SETTINGS);
	const out = I.fillTemplate(I.DEFAULT_SETTINGS.template, f);
	assert.match(out, /^> \[!abstract\]- \[A \\\[bracketed\\\] title\]\(https:\/\/pubmed/);
	assert.match(out, /> Line one\.\n> \n> Line two\./); // multi-line abstract keeps the "> " prefix
	const noImage = I.fillTemplate("{{#image}}IMG {{image}}{{/image}}end", Object.assign({}, f, { image: "" }));
	assert.equal(noImage, "end\n");
	assert.match(I.idLinks(paper), /DOI: \[10\.1038\/x\]\(https:\/\/doi\.org\/10\.1038\/x\) · PMID: \[34265844\]/);
});
