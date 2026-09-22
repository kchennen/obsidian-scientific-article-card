"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { I } = require("./helpers/env");

const DOMAINS = I.DEFAULT_SETTINGS.pasteDomains.split("\n");
const parse = (s, allowBare = true) => I.parseIdentifier(s, { allowBare, domains: DOMAINS });
const pick = (r) => r && { type: r.type, id: r.id };

test("PMIDs", () => {
	assert.deepEqual(pick(parse("PMID: 34265844")), { type: "pmid", id: "34265844" });
	assert.deepEqual(pick(parse("pmid34265844")), { type: "pmid", id: "34265844" });
	assert.deepEqual(pick(parse("https://pubmed.ncbi.nlm.nih.gov/34265844/")), { type: "pmid", id: "34265844" });
	assert.deepEqual(pick(parse("https://www.ncbi.nlm.nih.gov/pubmed/34265844")), { type: "pmid", id: "34265844" });
	assert.deepEqual(pick(parse("https://europepmc.org/article/MED/34265844")), { type: "pmid", id: "34265844" });
});

test("bare numbers are PMIDs only when allowed", () => {
	assert.deepEqual(pick(parse("34265844", true)), { type: "pmid", id: "34265844" });
	assert.equal(parse("34265844", false), null);
});

test("PMCIDs", () => {
	assert.deepEqual(pick(parse("PMC8371605")), { type: "pmcid", id: "PMC8371605" });
	assert.deepEqual(pick(parse("pmcid: pmc8371605")), { type: "pmcid", id: "PMC8371605" });
	assert.deepEqual(pick(parse("https://pmc.ncbi.nlm.nih.gov/articles/PMC8371605/")), { type: "pmcid", id: "PMC8371605" });
	assert.deepEqual(pick(parse("https://www.ncbi.nlm.nih.gov/pmc/articles/PMC8371605/")), { type: "pmcid", id: "PMC8371605" });
});

test("DOIs and publisher URLs containing a DOI", () => {
	const cases = {
		"10.1038/s41586-021-03819-2": "10.1038/s41586-021-03819-2",
		"doi:10.1016/S0092-8674(23)00001-X).": "10.1016/S0092-8674(23)00001-X",
		"https://doi.org/10.1038/s41586-021-03819-2": "10.1038/s41586-021-03819-2",
		"https://www.biorxiv.org/content/10.1101/2023.01.02.522505v2.full.pdf": "10.1101/2023.01.02.522505",
		"https://www.science.org/doi/full/10.1126/science.abj8754": "10.1126/science.abj8754",
		"https://journals.plos.org/plosone/article?id=10.1371/journal.pone.0012345&type=printable": "10.1371/journal.pone.0012345",
		"https://www.frontiersin.org/articles/10.3389/fimmu.2020.00001/full": "10.3389/fimmu.2020.00001",
		"https://www.nature.com/articles/s41586-021-03819-2": "10.1038/s41586-021-03819-2",
	};
	for (const [input, doi] of Object.entries(cases)) assert.deepEqual(pick(parse(input)), { type: "doi", id: doi }, input);
});

test("arXiv", () => {
	assert.deepEqual(pick(parse("arXiv:1706.03762")), { type: "arxiv", id: "1706.03762" });
	assert.deepEqual(pick(parse("https://arxiv.org/pdf/1706.03762v7")), { type: "arxiv", id: "1706.03762" });
	assert.deepEqual(pick(parse("https://arxiv.org/abs/1706.03762")), { type: "arxiv", id: "1706.03762" });
	assert.deepEqual(pick(parse("1706.03762", true)), { type: "arxiv", id: "1706.03762" });
});

test("markdown links and angle brackets are unwrapped", () => {
	assert.deepEqual(pick(parse("[AlphaFold](https://pubmed.ncbi.nlm.nih.gov/34265844/)")), { type: "pmid", id: "34265844" });
	assert.deepEqual(pick(parse("<https://doi.org/10.1038/s41586-021-03819-2>")), { type: "doi", id: "10.1038/s41586-021-03819-2" });
});

test("other URLs: scholarly only on listed publisher domains", () => {
	const sd = parse("https://www.sciencedirect.com/science/article/pii/S0092867421001094");
	assert.equal(sd.type, "url");
	assert.equal(sd.scholarly, true);
	const gh = parse("https://github.com/foo");
	assert.equal(gh.type, "url");
	assert.equal(gh.scholarly, false);
	assert.equal(parse("not an identifier"), null);
});

test("cleanDoi strips suffixes and unbalanced punctuation", () => {
	assert.equal(I.cleanDoi("10.1002/abc.123/full"), "10.1002/abc.123");
	assert.equal(I.cleanDoi("10.1101/2023.01.02.522505v3"), "10.1101/2023.01.02.522505");
	assert.equal(I.cleanDoi("10.1016/S0092-8674(23)00001-X"), "10.1016/S0092-8674(23)00001-X");
	assert.equal(I.cleanDoi("10.1016/S0092-8674(23)00001-X);"), "10.1016/S0092-8674(23)00001-X");
	assert.equal(I.cleanDoi("doi:10.1234/X%2FY"), "10.1234/X/Y");
});

test("identFromCard prefers PMID, then DOI, arXiv, PMCID, URL", () => {
	assert.equal(I.identFromCard({ pmid: "1", doi: "10.1/x" }).type, "pmid");
	assert.equal(I.identFromCard({ doi: "10.1/x" }).type, "doi");
	assert.equal(I.identFromCard({ arxiv: "1706.03762" }).type, "arxiv");
	assert.equal(I.identFromCard({ pmcid: "PMC1" }).type, "pmcid");
	assert.equal(I.identFromCard({ url: "https://pubmed.ncbi.nlm.nih.gov/5/" }).id, "5");
	assert.equal(I.identFromCard({ title: "x" }), null);
});
