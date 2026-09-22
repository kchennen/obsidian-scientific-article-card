"use strict";
/* Metadata lookups against recorded API responses (tests/fixtures). */
const test = require("node:test");
const assert = require("node:assert/strict");
const env = require("./helpers/env");
const { replay } = require("./helpers/network");
const { I } = env;

const resolve = async (input, settings = {}, extra = {}) => {
	env.setNetwork(replay(extra));
	const ident = I.parseIdentifier(input, { allowBare: true, domains: I.DEFAULT_SETTINGS.pasteDomains.split("\n") });
	return new I.Resolver(Object.assign({}, I.DEFAULT_SETTINGS, settings)).resolve(ident);
};

test("PMID → PubMed: metadata, Unicode superscripts, MeSH fallback, PMC figure", async () => {
	const p = await resolve("PMID: 34265844");
	assert.equal(p.source, "PubMed");
	assert.equal(p.title, "Highly accurate protein structure prediction with AlphaFold");
	assert.equal(p.authors[0].last, "Jumper");
	assert.deepEqual([p.journal, p.year, p.volume, p.issue, p.pages], ["Nature", "2021", "596", "7873", "583-589"]);
	assert.deepEqual([p.doi, p.pmid, p.pmcid], ["10.1038/s41586-021-03819-2", "34265844", "PMC8371605"]);
	assert.match(p.abstract, /effort¹⁻⁴, the structures/);
	assert.ok(p.keywordList.includes("Deep Learning"), "MeSH terms when there are no author keywords");
	assert.match(p.image, /pmc-oa-opendata\.s3\.amazonaws\.com\/PMC8371605\.\d+\/41586_2021_3819_Fig1_HTML\.jpg$/);
	assert.equal(p.url, "https://pubmed.ncbi.nlm.nih.gov/34265844/");
	assert.equal(p.host, "pubmed.ncbi.nlm.nih.gov");
	assert.equal(p.type, "Journal Article");
});

test("PMID not in PMC, publisher page blocked → PubMed's preview image", async () => {
	const p = await resolve("PMID: 33308477");
	assert.equal(p.image, "https://cdn.ncbi.nlm.nih.gov/pubmed/persistent/pubmed-meta-image-v2.jpg");
});

test("Fetch preview image off → no image at all", async () => {
	const p = await resolve("PMID: 33308477", { fetchImage: false });
	assert.equal(p.image || "", "");
});

test("MeSH terms only as fallback, or always with Include MeSH terms; none without keywords", async () => {
	assert.ok((await resolve("PMID: 38520562")).keywordList.includes("Machine Learning"));
	assert.deepEqual((await resolve("PMID: 38520562", { includeKeywords: false })).keywordList, []);
});

test("PMCID → Europe PMC", async () => {
	const p = await resolve("PMC8371605");
	assert.equal(p.source, "Europe PMC");
	assert.equal(p.pmid, "34265844");
	assert.equal(p.url, "https://pmc.ncbi.nlm.nih.gov/articles/PMC8371605/");
});

test("DOI → Europe PMC, first figure (not the inline equation)", async () => {
	const p = await resolve("10.1371/journal.pone.0012345");
	assert.equal(p.pmid, "20808812");
	assert.match(p.image, /pone\.0012345\.g001\.jpg$/);
	assert.equal(p.url, "https://doi.org/10.1371/journal.pone.0012345");
	assert.match(p.abstract, /^Background: /);
});

test("bioRxiv DOI → preprint", async () => {
	const p = await resolve("https://www.biorxiv.org/content/10.1101/2023.01.02.522505v2");
	assert.equal(p.type, "Preprint");
	assert.equal(p.journal, "bioRxiv");
	assert.doesNotMatch(p.abstract, /^abstract/i);
	assert.equal(p.url, "https://www.biorxiv.org/content/10.1101/2023.01.02.522505v2"); // keeps what was pasted
});

test("DOI only in Crossref → subtitle, decoded journal, conference type, landing host", async () => {
	const p = await resolve("10.1145/3292500.3330701");
	assert.equal(p.source, "Crossref");
	assert.equal(p.title, "Optuna: A Next-generation Hyperparameter Optimization Framework");
	assert.match(p.journal, /Knowledge Discovery & Data Mining$/);
	assert.equal(p.type, "Conference Paper");
	assert.equal(p.host, "dl.acm.org");
});

test("arXiv", async () => {
	const p = await resolve("arXiv:1706.03762");
	assert.equal(p.title, "Attention Is All You Need");
	assert.equal(p.type, "Preprint");
	assert.deepEqual(p.keywordList, ["cs.CL"]);
	assert.equal(p.url, "https://arxiv.org/abs/1706.03762");
});

test("main link setting", async () => {
	assert.equal((await resolve("PMID: 34265844", { linkTarget: "doi" })).url, "https://doi.org/10.1038/s41586-021-03819-2");
	assert.equal((await resolve("10.1371/journal.pone.0012345", { linkTarget: "pubmed" })).url, "https://pubmed.ncbi.nlm.nih.gov/20808812/");
});

test("publisher page: citation meta tags → PMID lookup + page image", async () => {
	const url = "https://www.cell.com/cell/fulltext/S0092-8674(21)00000-0";
	const html = `<html><head><meta name="citation_title" content="Ignored when the PMID resolves"><meta name="citation_pmid" content="34265844"><meta property="og:image" content="https://media.example/fig1.png"></head></html>`;
	const p = await resolve(url, { fetchImage: false }, { [url]: { body: html } });
	assert.equal(p.pmid, "34265844");
	assert.equal(p.image, "https://media.example/fig1.png");
	assert.equal(p.url, url);
});

test("publisher page without identifiers → page metadata", async () => {
	const url = "https://www.mdpi.com/fake/1";
	const html = `<html><head><meta name="citation_title" content="A page-only paper."><meta name="citation_author" content="Doe, Jane"><meta name="citation_journal_title" content="Genes"><meta name="citation_publication_date" content="2023/05/01"><meta name="citation_firstpage" content="10"><meta name="citation_lastpage" content="20"></head></html>`;
	const p = await resolve(url, {}, { [url]: { body: html } });
	assert.equal(p.title, "A page-only paper");
	assert.deepEqual([p.authors[0].last, p.authors[0].first], ["Doe", "Jane"]);
	assert.deepEqual([p.journal, p.year, p.pages], ["Genes", "2023", "10-20"]);
});

test("unknown PMID → error", async () => {
	await assert.rejects(resolve("PMID: 1"), /not found|HTTP 404/i);
});
