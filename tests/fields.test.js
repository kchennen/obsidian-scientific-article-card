"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { I, yaml } = require("./helpers/env");

test("parseTags: strips #, splits on commas/spaces, drops duplicates and number-only tags", () => {
	assert.deepEqual(I.parseTags("#impatient2, Rare disease  methods,#methods 2024 a/b"), ["impatient2", "Rare", "disease", "methods", "a/b"]);
	assert.deepEqual(I.parseTags(["x", "#y", "x"]), ["x", "y"]);
	assert.deepEqual(I.parseTags(undefined), []);
});

test("setFields replaces fields (incl. multi-line lists) and keeps everything else", () => {
	const lines = ['url: "u"', 'title: "T"', 'status: "read"', "tags:", "  - old", "  - older", 'abstract: "A"', 'note: "old"'];
	assert.deepEqual(I.setUserFields(lines, { status: "to-read", rating: 4, tags: ["a", "b"], note: "L1\nL2" }), [
		'url: "u"',
		'title: "T"',
		'abstract: "A"',
		'status: "to-read"',
		"rating: 4",
		'tags: ["a","b"]',
		'note: "L1\\nL2"',
	]);
	assert.deepEqual(I.setUserFields(lines, { status: "", rating: 0, tags: [], note: "" }), ['url: "u"', 'title: "T"', 'abstract: "A"']);
	assert.deepEqual(I.setFields(['title: "T"'], { "paper-note": "[[X]]" }), ['title: "T"', 'paper-note: "[[X]]"']);
	const parsed = yaml.parse(I.setUserFields(lines, { status: "read", rating: 5, tags: ["x"], note: 'a "quoted" note' }).join("\n"));
	assert.equal(parsed.note, 'a "quoted" note');
});

test("findBlock finds the card with the same content, closest to the hint", () => {
	const lines = ["# List", "```paper", 'title: "A"', "```", "", "```paper", 'title: "B"', "```", "```paper", 'title: "A"', "```"];
	assert.deepEqual(I.findBlock(lines, 'title: "B"', 0), [5, 7]);
	assert.deepEqual(I.findBlock(lines, 'title: "A"', 9), [8, 10]);
	assert.deepEqual(I.findBlock(lines, 'title: "A"', 0), [1, 3]);
	assert.equal(I.findBlock(lines, 'title: "C"', 0), null);
});

test("cardUserFields normalises a card's notes", () => {
	assert.deepEqual(I.cardUserFields({ status: "read", rating: "9", tags: "#a b", note: " n " }), { status: "read", rating: 5, tags: ["a", "b"], note: "n" });
	assert.deepEqual(I.cardUserFields({}), { status: "", rating: 0, tags: [], note: "" });
});

test("mergeUserIntoProps never overwrites", () => {
	const fm = { status: "reading", tags: ["a"] };
	assert.equal(I.mergeUserIntoProps(fm, { status: "read", rating: 3, tags: ["A", "b"], note: "sum" }), "");
	assert.deepEqual(fm, { status: "reading", rating: 3, tags: ["a", "b"], summary: "sum" });
	assert.equal(I.mergeUserIntoProps(fm, { status: "", rating: 0, tags: [], note: "other" }), "other"); // differs: goes to Notes
	assert.equal(I.mergeUserIntoProps(fm, { status: "", rating: 0, tags: [], note: "sum" }), ""); // same summary: nothing to add
});

test("appendToNotesSection", () => {
	assert.equal(I.appendToNotesSection("## Notes\n\nA\n\n## Quotes\n\nQ\n", "B"), "## Notes\n\nA\n\nB\n\n## Quotes\n\nQ\n");
	assert.equal(I.appendToNotesSection("## Notes\n\n", "B"), "## Notes\n\nB\n");
	assert.equal(I.appendToNotesSection("Body", "B"), "Body\n\n## Notes\n\nB\n");
	assert.equal(I.appendToNotesSection("## Notes\n\nB\n", "B"), "## Notes\n\nB\n"); // already there
});
