"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { I, yaml } = require("./helpers/env");

test("file names: FirstAuthor_JournalAbbreviation_Year", () => {
	assert.equal(I.paperNoteBaseName({ authors: [{ last: "Jumper" }], journalAbbr: "Nature", year: "2021" }), "Jumper_Nature_2021");
	assert.equal(I.paperNoteBaseName({ authors: [{ last: "Zucca" }], journalAbbr: "Hum Genet", year: "2025" }), "Zucca_HumGenet_2025");
	assert.equal(I.paperNoteBaseName({ authors: [{ last: "De Paoli" }], journalAbbr: "J. Neuromuscul. Dis.", year: "2024" }), "DePaoli_JNeuromusculDis_2024");
	assert.equal(I.paperNoteBaseName({ authors: [{ last: "Ou" }], journal: "bioRxiv", year: "2023" }), "Ou_bioRxiv_2023");
	assert.equal(I.paperNoteBaseName({ authors: [{ last: "Akiba" }], journal: "Proceedings of the 25th ACM SIGKDD International Conference", year: "2019" }), "Akiba_PASIC_2019");
	assert.equal(I.paperNoteBaseName({ authors: [{ formatted: "Žídek A" }], journal: "Nature", year: "2021" }), "Žídek_Nature_2021");
	assert.equal(I.paperNoteBaseName({}), "Paper");
});

test("paper properties: type, lists, numbers, user fields, empty values dropped", () => {
	const p = { title: "T", authors: [{ last: "A", initials: "B" }], journal: "J", year: "2024", pmid: 123, doi: "10.1/x", keywordList: ["k"], type: "Review", image: "" };
	const props = I.paperProps(p, { status: "to-read", rating: 4, tags: ["x"], note: "sum" }, I.DEFAULT_SETTINGS);
	assert.equal(props.type, "paper");
	assert.deepEqual(props.authors, ["A B"]);
	assert.equal(props.year, 2024);
	assert.equal(props.pmid, "123");
	assert.equal(props["publication-type"], "Review");
	assert.deepEqual([props.status, props.rating, props.summary, props.tags], ["to-read", 4, "sum", ["x"]]);
	assert.equal("image" in props, false);
	assert.match(props.created, /^\d{4}-\d{2}-\d{2}$/);
});

test("paper note body: abstract and Notes only (no card block)", () => {
	assert.equal(I.paperNoteBody("The abstract.", ""), "## Abstract\n\nThe abstract.\n\n## Notes\n\n");
	assert.equal(I.paperNoteBody("", ""), "## Notes\n\n");
	assert.doesNotMatch(I.paperNoteBody("A", "n"), /```/);
});

test("fmToCard maps properties to card fields", () => {
	const d = I.fmToCard({ title: "T", authors: ["A", "B", "C"], url: "https://pubmed.ncbi.nlm.nih.gov/1/", keywords: ["k1", "k2"], "publication-type": "Review", summary: "S", status: "read" }, Object.assign({}, I.DEFAULT_SETTINGS, { maxAuthors: 2 }));
	assert.equal(d.authors, "A, B, et al.");
	assert.equal(d.keywords, "k1; k2");
	assert.equal(d.type, "Review");
	assert.equal(d.host, "pubmed.ncbi.nlm.nih.gov");
	assert.equal(d.note, "S");
});

test("refresh updates only fetched properties; empty values keep the old one", () => {
	const fm = { title: "Old", journal: "J", status: "read", rating: 5, tags: ["mine"], summary: "S", created: "2020-01-01", custom: 1, image: "old.png" };
	const changed = I.refreshProps(fm, { title: "New", journal: "J", status: "to-read", summary: "X", tags: [], created: "2026-01-01", custom: 2 });
	assert.deepEqual(changed, ["title"]);
	assert.deepEqual(fm, { title: "New", journal: "J", status: "read", rating: 5, tags: ["mine"], summary: "S", created: "2020-01-01", custom: 1, image: "old.png" });
	assert.ok(!I.FETCHED_PROPS.some((k) => ["status", "rating", "tags", "summary", "created", "reading-lists"].includes(k)));
});

test("Papers.base: valid YAML, filters, four views, cards with the image cover", () => {
	const base = yaml.load(I.papersBase("Projects/A/Biblios"));
	assert.deepEqual(base.filters, { and: ['type == "paper"', 'file.inFolder("Projects/A/Biblios")'] });
	assert.deepEqual(base.views.map((v) => [v.type, v.name]), [["table", "All papers"], ["table", "To read"], ["table", "By status"], ["cards", "Shelf"]]);
	assert.deepEqual(base.views[0].sort, [{ property: "note.year", direction: "DESC" }]);
	assert.deepEqual(base.views[1].filters, { and: ['status == "to-read"'] });
	assert.deepEqual(base.views[2].groupBy, { property: "note.status", direction: "ASC" });
	assert.equal(base.views[3].image, "note.image");
	assert.equal(base.views[3].imageFit, "contain");
	assert.deepEqual(yaml.load(I.papersBase("/")).filters, { and: ['type == "paper"'] });
});

test("link helpers", () => {
	assert.equal(I.linkpathFrom("[[Jumper_Nature_2021]]"), "Jumper_Nature_2021");
	assert.equal(I.linkpathFrom("[[Folder/Note|alias]]"), "Folder/Note");
	assert.equal(I.linkpathFrom("[Note](Folder/My%20Note.md)"), "Folder/My Note");
	assert.equal(I.linkpathFrom("Note.md"), "Note");
});
