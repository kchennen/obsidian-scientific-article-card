/*
 * Scientific Article Card — Obsidian plugin
 * Turns a PMID / PMCID / DOI / arXiv ID / article URL into a metadata card,
 * in the spirit of "Auto Card Link" but backed by scholarly APIs
 * (PubMed E-utilities, Europe PMC, Crossref, arXiv) plus the article page's meta tags.
 *
 * Plain CommonJS, no build step required.
 */
"use strict";

const obsidian = require("obsidian");
const {
	Plugin,
	PluginSettingTab,
	Setting,
	Notice,
	Modal,
	requestUrl,
	parseYaml,
	editorInfoField,
} = obsidian;
const { EditorView } = require("@codemirror/view");

const CODE_BLOCK_LANG = "paper";
const EUTILS = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils";
const EUROPEPMC = "https://www.ebi.ac.uk/europepmc/webservices/rest/search";

const DEFAULT_TEMPLATE = [
	"> [!abstract]- [{{title}}]({{url}})",
	"> {{authors}}",
	"> *{{citation}}*",
	"> {{ids}}",
	"{{#image}}>",
	"> ![|250]({{image}})",
	"{{/image}}{{#abstract}}>",
	"> {{abstract}}",
	"{{/abstract}}",
].join("\n");

const DEFAULT_SETTINGS = {
	outputFormat: "card", // "card" | "template"
	template: DEFAULT_TEMPLATE,
	enhancePaste: true,
	pasteBarePmid: false,
	pasteDomains: [
		"nature.com", "science.org", "cell.com", "sciencedirect.com", "springer.com",
		"link.springer.com", "biomedcentral.com", "frontiersin.org", "mdpi.com", "plos.org",
		"academic.oup.com", "pnas.org", "elifesciences.org", "embopress.org", "jci.org",
		"thelancet.com", "nejm.org", "bmj.com", "jamanetwork.com", "wiley.com",
		"tandfonline.com", "biorxiv.org", "medrxiv.org", "genome.cshlp.org", "journals.asm.org",
		"aacrjournals.org", "ahajournals.org", "rupress.org", "life-science-alliance.org",
	].join("\n"),
	linkTarget: "input", // "input" | "doi" | "pubmed"
	includeAbstract: true,
	includeKeywords: true,
	includeMesh: false,
	fetchImage: true,
	maxAuthors: 10,
	authorFormat: "short", // "short" (Smith JA) | "full" (John A. Smith)
	abstractOpen: false,
	showInMenu: true,
	email: "",
	ncbiApiKey: "",
};

/* ------------------------------------------------------------------ */
/* Small helpers                                                       */
/* ------------------------------------------------------------------ */

function safeDecode(s) {
	try {
		return decodeURIComponent(s);
	} catch (e) {
		return s;
	}
}

function hostOf(url) {
	try {
		return new URL(url).hostname.replace(/^www\./, "");
	} catch (e) {
		return "";
	}
}

function hostMatches(host, domain) {
	domain = domain.trim().toLowerCase().replace(/^www\./, "");
	return !!domain && (host === domain || host.endsWith("." + domain));
}

function clean(s) {
	return (s == null ? "" : String(s)).replace(/\s+/g, " ").trim();
}

function stripTrailingDot(s) {
	return clean(s).replace(/([^.])\.$/, "$1");
}

function uniq(arr) {
	const seen = new Set();
	return arr.filter((x) => {
		const k = String(x).toLowerCase();
		if (!x || seen.has(k)) return false;
		seen.add(k);
		return true;
	});
}

function asArray(x) {
	if (x == null) return [];
	return Array.isArray(x) ? x : [x];
}

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

function isoDate(y, m, d) {
	if (!y) return "";
	let mm = m ? (/^\d+$/.test(String(m)) ? Number(m) : MONTHS[String(m).slice(0, 3).toLowerCase()]) : 0;
	let out = String(y);
	if (mm) {
		out += "-" + String(mm).padStart(2, "0");
		if (d) out += "-" + String(d).padStart(2, "0");
	}
	return out;
}

const SUP = { 0: "⁰", 1: "¹", 2: "²", 3: "³", 4: "⁴", 5: "⁵", 6: "⁶", 7: "⁷", 8: "⁸", 9: "⁹", "+": "⁺", "-": "⁻", "–": "⁻", "−": "⁻", "=": "⁼", "(": "⁽", ")": "⁾", n: "ⁿ", i: "ⁱ", ",": ",", " ": "" };
const SUB = { 0: "₀", 1: "₁", 2: "₂", 3: "₃", 4: "₄", 5: "₅", 6: "₆", 7: "₇", 8: "₈", 9: "₉", "+": "₊", "-": "₋", "–": "₋", "−": "₋", "=": "₌", "(": "₍", ")": "₎", " ": "" };

/** "1-4" -> "¹⁻⁴", so citation markers and exponents don't merge with the text (effort1-4, cm2). */
function toScript(text, map) {
	const chars = Array.from(clean(text));
	return chars.every((c) => c in map) ? chars.map((c) => map[c]).join("") : chars.join("");
}

/** Replace <sup>/<sub> elements of an XML/HTML tree with Unicode super/subscript text. */
function scriptifyTree(root) {
	for (const [tag, map] of [["sup", SUP], ["sub", SUB]]) {
		for (const el of Array.from(root.getElementsByTagName(tag))) {
			el.replaceWith(el.ownerDocument.createTextNode(toScript(el.textContent, map)));
		}
	}
}

function parseXml(text) {
	return new DOMParser().parseFromString(text, "text/xml");
}

function parseHtml(text) {
	return new DOMParser().parseFromString(text, "text/html");
}

/** HTML / JATS fragment -> plain text with paragraph breaks and "Label: " section headers. */
function htmlToText(html) {
	if (!html) return "";
	let s = String(html)
		.replace(/<(jats:)?title>\s*abstract\s*<\/(jats:)?title>/gi, "")
		.replace(/<(h\d|jats:title|title)[^>]*>([\s\S]*?)<\/\1>/gi, "\n\n$2: ")
		.replace(/<sup[^>]*>([\s\S]*?)<\/sup>/gi, (_, t) => toScript(t.replace(/<[^>]+>/g, ""), SUP))
		.replace(/<sub[^>]*>([\s\S]*?)<\/sub>/gi, (_, t) => toScript(t.replace(/<[^>]+>/g, ""), SUB))
		.replace(/<br\s*\/?>/gi, "\n")
		.replace(/<\/(p|div|jats:p|jats:sec|sec)>/gi, "\n\n");
	const doc = parseHtml("<body>" + s + "</body>");
	const text = doc.body ? doc.body.textContent || "" : s.replace(/<[^>]+>/g, "");
	return text
		.split(/\n{2,}/)
		.map((p) => clean(p).replace(/:\s*:\s*/, ": "))
		.filter(Boolean)
		.join("\n\n")
		.replace(/^(\w[\w ]{0,40}): \n\n/gm, "$1: ")
		.replace(/^abstract:?\s+/i, "");
}

function withTimeout(promise, ms, what) {
	let t;
	return Promise.race([
		promise,
		new Promise((_, rej) => {
			t = setTimeout(() => rej(new Error(`Timed out: ${what}`)), ms);
		}),
	]).finally(() => clearTimeout(t));
}

async function http(url, opts = {}) {
	const res = await withTimeout(
		requestUrl({ url, method: "GET", headers: opts.headers, throw: false }),
		opts.timeout || 15000,
		url
	);
	if (res.status >= 400) throw new Error(`HTTP ${res.status} from ${hostOf(url)}`);
	return opts.json ? res.json : res.text;
}

/* ------------------------------------------------------------------ */
/* Identifier parsing                                                  */
/* ------------------------------------------------------------------ */

const DOI_IN_TEXT = /(10\.\d{4,9}\/[^\s"<>?#&]+)/;

function cleanDoi(doi) {
	doi = safeDecode(String(doi)).trim().replace(/^doi:\s*/i, "");
	let prev;
	do {
		prev = doi;
		doi = doi.replace(/[.,;:\]]+$/, "");
		// strip an unbalanced trailing ")"
		if (doi.endsWith(")") && (doi.match(/\(/g) || []).length < (doi.match(/\)/g) || []).length) {
			doi = doi.slice(0, -1);
		}
		doi = doi.replace(/\/(full|abstract|pdf|epdf|epub|summary|meta|figures|references|suppl|html|fulltext|full-text|tab-figures-data|tab-article-info)\/?$/i, "");
		doi = doi.replace(/\.(full|abstract|pdf|full-text|supplementary-material|article-info|article-metrics)$/i, "");
	} while (doi !== prev);
	// bioRxiv / medRxiv version suffix
	doi = doi.replace(/^(10\.1101\/[\d.]+)v\d+$/i, "$1");
	return doi;
}

/**
 * @returns {null | {type: "pmid"|"pmcid"|"doi"|"arxiv"|"url", id?: string, url?: string, scholarly?: boolean, raw: string}}
 */
function parseIdentifier(input, opts = {}) {
	const raw = String(input || "").trim();
	let s = raw.replace(/^<(.+)>$/, "$1");
	const md = s.match(/^\[[^\]]*\]\((\S+?)\)$/);
	if (md) s = md[1];
	let m;

	if ((m = s.match(/^pmid\s*:?\s*(\d{1,9})$/i))) return { type: "pmid", id: m[1], raw };
	if (opts.allowBare && (m = s.match(/^(\d{1,9})$/))) return { type: "pmid", id: m[1], raw };
	if ((m = s.match(/^(?:pmcid\s*:?\s*)?(pmc\d+)$/i))) return { type: "pmcid", id: m[1].toUpperCase(), raw };
	if ((m = s.match(/^(?:doi\s*:?\s*)?(10\.\d{4,9}\/\S+)$/i))) return { type: "doi", id: cleanDoi(m[1]), raw };
	if ((m = s.match(/^arxiv\s*:\s*([\w./-]+?)(v\d+)?$/i))) return { type: "arxiv", id: m[1], raw };
	if (opts.allowBare && (m = s.match(/^(\d{4}\.\d{4,5})(v\d+)?$/))) return { type: "arxiv", id: m[1], raw };

	if (/^www\./i.test(s)) s = "https://" + s;
	if (!/^https?:\/\//i.test(s)) return null;

	let u;
	try {
		u = new URL(s);
	} catch (e) {
		return null;
	}
	const host = u.hostname.replace(/^www\./, "").toLowerCase();
	const path = u.pathname;
	const url = u.href;

	if (host === "pubmed.ncbi.nlm.nih.gov" && (m = path.match(/^\/(\d+)/))) return { type: "pmid", id: m[1], url, raw };
	if (host === "ncbi.nlm.nih.gov" && (m = path.match(/^\/pubmed\/(\d+)/))) return { type: "pmid", id: m[1], url, raw };
	if ((host === "pmc.ncbi.nlm.nih.gov" || host === "ncbi.nlm.nih.gov") && (m = path.match(/\/articles\/(PMC\d+)/i)))
		return { type: "pmcid", id: m[1].toUpperCase(), url, raw };
	if (host === "europepmc.org") {
		if ((m = path.match(/\/(?:abstract|article)\/MED\/(\d+)/i))) return { type: "pmid", id: m[1], url, raw };
		if ((m = path.match(/\/(PMC\d+)/i))) return { type: "pmcid", id: m[1].toUpperCase(), url, raw };
	}
	if (host === "doi.org" || host === "dx.doi.org") {
		const doi = cleanDoi(path.slice(1));
		if (/^10\./.test(doi)) return { type: "doi", id: doi, url, raw };
	}
	if (host === "arxiv.org" || host === "export.arxiv.org") {
		if ((m = path.match(/^\/(?:abs|pdf|html)\/(.+?)(?:v\d+)?(?:\.pdf)?\/?$/))) return { type: "arxiv", id: m[1], url, raw };
	}
	if (host === "nature.com" && (m = path.match(/^\/articles\/([a-z0-9.-]+?)(?:\.pdf)?\/?$/i)))
		return { type: "doi", id: "10.1038/" + m[1], url, raw };

	const hay = safeDecode(path + u.search);
	if ((m = hay.match(DOI_IN_TEXT))) {
		const doi = cleanDoi(m[1]);
		if (/^10\.\d{4,9}\/\S+/.test(doi)) return { type: "doi", id: doi, url, raw };
	}

	const domains = (opts.domains || []).filter(Boolean);
	return { type: "url", url, raw, scholarly: domains.some((d) => hostMatches(host, d)) };
}

/* ------------------------------------------------------------------ */
/* Metadata resolution                                                 */
/* ------------------------------------------------------------------ */

class Resolver {
	constructor(settings) {
		this.settings = settings;
	}

	ncbiParams() {
		let p = "&tool=obsidian-scientific-article-card";
		if (this.settings.email) p += "&email=" + encodeURIComponent(this.settings.email);
		if (this.settings.ncbiApiKey) p += "&api_key=" + encodeURIComponent(this.settings.ncbiApiKey);
		return p;
	}

	async resolve(ident) {
		let paper;
		switch (ident.type) {
			case "pmid":
				paper = await this.byPmid(ident.id);
				break;
			case "pmcid":
				paper = await this.byEuropePmc(`PMCID:${ident.id}`, true);
				if (!paper) throw new Error(`${ident.id} not found`);
				break;
			case "doi":
				paper = await this.byDoi(ident.id);
				break;
			case "arxiv":
				paper = await this.byArxiv(ident.id);
				break;
			case "url":
				paper = await this.byUrl(ident.url);
				break;
			default:
				throw new Error("Unsupported identifier");
		}
		return this.finalize(paper, ident);
	}

	async byPmid(pmid) {
		try {
			return await this.fetchPubmed(pmid);
		} catch (e) {
			console.warn("[scientific-article-card] PubMed failed, trying Europe PMC", e);
			const p = await this.byEuropePmc(`EXT_ID:${pmid} AND SRC:MED`, true);
			if (p) return p;
			throw e;
		}
	}

	async byDoi(doi) {
		let p = null;
		try {
			p = await this.byEuropePmc(`DOI:"${doi}"`, false, doi);
		} catch (e) {
			console.warn("[scientific-article-card] Europe PMC failed", e);
		}
		if (p) {
			// Europe PMC sometimes lacks the abstract for a record PubMed has
			if (!p.abstract && p.pmid) {
				try {
					const pm = await this.fetchPubmed(p.pmid);
					p = Object.assign({}, p, pm, { image: p.image });
				} catch (e) {
					/* keep Europe PMC record */
				}
			}
			return p;
		}
		return this.byCrossref(doi);
	}

	/* ---------- PubMed E-utilities ---------- */
	async fetchPubmed(pmid) {
		const xml = await http(`${EUTILS}/efetch.fcgi?db=pubmed&id=${pmid}&retmode=xml${this.ncbiParams()}`);
		const doc = parseXml(xml);
		const art = doc.querySelector("PubmedArticle");
		if (!art) throw new Error(`PMID ${pmid} not found on PubMed`);
		scriptifyTree(art);
		const txt = (sel, root = art) => clean(root.querySelector(sel) && root.querySelector(sel).textContent);
		const all = (sel, root = art) => Array.from(root.querySelectorAll(sel));

		const abstract = all("Article > Abstract > AbstractText")
			.map((n) => {
				const label = n.getAttribute("Label");
				const body = clean(n.textContent);
				if (!label || /^unlabelled$/i.test(label)) return body;
				return `${label.charAt(0) + label.slice(1).toLowerCase()}: ${body}`;
			})
			.filter(Boolean)
			.join("\n\n");

		const authors = all("Article > AuthorList > Author").map((a) => ({
			last: txt("LastName", a),
			first: txt("ForeName", a),
			initials: txt("Initials", a),
			collective: txt("CollectiveName", a),
		}));

		const pubDate = art.querySelector("Article > Journal > JournalIssue > PubDate");
		const artDate = art.querySelector("Article > ArticleDate");
		let year = pubDate ? txt("Year", pubDate) || (txt("MedlineDate", pubDate).match(/\d{4}/) || [""])[0] : "";
		let date = pubDate ? isoDate(year, txt("Month", pubDate), txt("Day", pubDate)) : "";
		if (artDate && (!date || date.length < 10)) {
			const ad = isoDate(txt("Year", artDate), txt("Month", artDate), txt("Day", artDate));
			if (!year || ad.startsWith(year)) date = ad;
		}
		year = year || date.slice(0, 4);

		const doi =
			txt('PubmedData > ArticleIdList > ArticleId[IdType="doi"]') || txt('Article > ELocationID[EIdType="doi"]');

		return {
			source: "PubMed",
			title: stripTrailingDot(txt("Article > ArticleTitle") || txt("Article > VernacularTitle")),
			authors,
			journal: txt("Article > Journal > Title"),
			journalAbbr: txt("Article > Journal > ISOAbbreviation") || txt("MedlineJournalInfo > MedlineTA"),
			year,
			date,
			volume: txt("Article > Journal > JournalIssue > Volume"),
			issue: txt("Article > Journal > JournalIssue > Issue"),
			pages: txt("Article > Pagination > MedlinePgn"),
			doi,
			pmid: txt("MedlineCitation > PMID") || String(pmid),
			pmcid: txt('PubmedData > ArticleIdList > ArticleId[IdType="pmc"]'),
			abstract,
			keywords: all("KeywordList > Keyword").map((k) => clean(k.textContent)),
			mesh: all("MeshHeadingList > MeshHeading > DescriptorName").map((k) => clean(k.textContent)),
			types: all("PublicationTypeList > PublicationType").map((k) => clean(k.textContent)),
		};
	}

	/* ---------- Europe PMC ---------- */
	async byEuropePmc(query, required, doi) {
		const url = `${EUROPEPMC}?query=${encodeURIComponent(query)}&format=json&resultType=core&pageSize=5`;
		const json = await http(url, { json: true });
		const results = (json && json.resultList && json.resultList.result) || [];
		if (!results.length) {
			if (required) throw new Error(`Not found on Europe PMC (${query})`);
			return null;
		}
		const r =
			(doi && results.find((x) => x.doi && x.doi.toLowerCase() === doi.toLowerCase() && x.source === "MED")) ||
			(doi && results.find((x) => x.doi && x.doi.toLowerCase() === doi.toLowerCase())) ||
			results[0];
		if (doi && (!r.doi || r.doi.toLowerCase() !== doi.toLowerCase())) return null;

		const ji = r.journalInfo || {};
		const j = ji.journal || {};
		const preprintServer = r.bookOrReportDetails && r.bookOrReportDetails.publisher;
		const authors = asArray(r.authorList && r.authorList.author).map((a) => ({
			last: a.lastName || "",
			first: a.firstName || "",
			initials: a.initials || "",
			collective: a.collectiveName || (!a.lastName ? a.fullName : "") || "",
		}));
		const types = asArray(r.pubTypeList && r.pubTypeList.pubType);
		if (r.source === "PPR" && !types.some((t) => /preprint/i.test(t))) types.unshift("Preprint");
		return {
			source: "Europe PMC",
			title: stripTrailingDot(htmlToText(r.title)),
			authors,
			journal: clean(j.title || preprintServer || ""),
			journalAbbr: clean(j.isoabbreviation || j.medlineAbbreviation || ""),
			year: String(r.pubYear || ji.yearOfPublication || ""),
			date: r.firstPublicationDate || ji.printPublicationDate || "",
			volume: ji.volume || "",
			issue: ji.issue || "",
			pages: r.pageInfo || "",
			doi: r.doi || "",
			pmid: r.pmid || "",
			pmcid: r.pmcid || "",
			abstract: htmlToText(r.abstractText),
			keywords: asArray(r.keywordList && r.keywordList.keyword),
			mesh: asArray(r.meshHeadingList && r.meshHeadingList.meshHeading).map((h) => h.descriptorName),
			types,
		};
	}

	/* ---------- Crossref ---------- */
	async byCrossref(doi) {
		const mail = this.settings.email ? `?mailto=${encodeURIComponent(this.settings.email)}` : "";
		const json = await http(`https://api.crossref.org/works/${encodeURIComponent(doi)}${mail}`, { json: true });
		const w = json && json.message;
		if (!w) throw new Error(`DOI ${doi} not found`);
		const parts = ((w.issued || w.published || w["published-online"] || w.created || {})["date-parts"] || [[]])[0] || [];
		const authors = asArray(w.author).map((a) => ({
			last: a.family || "",
			first: a.given || "",
			initials: (a.given || "")
				.split(/[\s.-]+/)
				.filter(Boolean)
				.map((x) => x[0].toUpperCase())
				.join(""),
			collective: !a.family ? a.name || "" : "",
		}));
		const typeMap = { "posted-content": "Preprint", "journal-article": "Journal Article", "proceedings-article": "Conference Paper", "book-chapter": "Book Chapter" };
		return {
			source: "Crossref",
			title: stripTrailingDot(htmlToText([asArray(w.title)[0], asArray(w.subtitle)[0]].filter(Boolean).join(": "))),
			authors,
			journal: htmlToText(asArray(w["container-title"])[0] || (w.institution && asArray(w.institution)[0] && asArray(w.institution)[0].name) || (w.type === "posted-content" ? w.publisher : "") || ""),
			journalAbbr: clean(asArray(w["short-container-title"])[0] || ""),
			year: parts[0] ? String(parts[0]) : "",
			date: isoDate(parts[0], parts[1], parts[2]),
			volume: w.volume || "",
			issue: w.issue || "",
			pages: w.page || "",
			doi: w.DOI || doi,
			publisher: w.publisher || "",
			abstract: htmlToText(w.abstract),
			keywords: asArray(w.subject),
			types: [typeMap[w.type] || ""].filter(Boolean),
			landing: w.resource && w.resource.primary && w.resource.primary.URL,
		};
	}

	/* ---------- arXiv ---------- */
	async byArxiv(id) {
		const xml = await http(`https://export.arxiv.org/api/query?id_list=${encodeURIComponent(id)}`);
		const doc = parseXml(xml);
		const entry = doc.getElementsByTagNameNS("*", "entry")[0];
		const get = (el, name) => {
			const n = el && el.getElementsByTagNameNS("*", name)[0];
			return n ? clean(n.textContent) : "";
		};
		if (!entry || !get(entry, "title") || /^error$/i.test(get(entry, "title"))) throw new Error(`arXiv ${id} not found`);
		const published = get(entry, "published");
		const authors = Array.from(entry.getElementsByTagNameNS("*", "author")).map((a) => {
			const name = get(a, "name");
			const bits = name.split(" ");
			const last = bits.pop();
			return { last, first: bits.join(" "), initials: bits.map((b) => b[0]).join("").toUpperCase(), collective: "" };
		});
		const cat = entry.getElementsByTagNameNS("*", "primary_category")[0];
		const p = {
			source: "arXiv",
			title: get(entry, "title"),
			authors,
			journal: get(entry, "journal_ref") || "arXiv",
			year: published.slice(0, 4),
			date: published.slice(0, 10),
			arxiv: id,
			doi: get(entry, "doi"),
			abstract: get(entry, "summary"),
			keywords: cat ? [cat.getAttribute("term")] : [],
			types: ["Preprint"],
		};
		// If the preprint has been published, prefer its DOI for PMID lookup
		if (p.doi) {
			try {
				const pub = await this.byEuropePmc(`DOI:"${p.doi}"`, false, p.doi);
				if (pub) return Object.assign({}, pub, { arxiv: id });
			} catch (e) {
				/* ignore */
			}
		}
		return p;
	}

	/* ---------- Generic article page (citation_* / Dublin Core / OpenGraph meta tags) ---------- */
	async scrape(url) {
		const html = await http(url, {
			timeout: 12000,
			headers: { Accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8" },
		});
		const doc = parseHtml(html);
		const meta = {};
		for (const el of Array.from(doc.querySelectorAll("meta"))) {
			const key = (el.getAttribute("name") || el.getAttribute("property") || "").toLowerCase().trim();
			const val = el.getAttribute("content");
			if (!key || val == null || !clean(val)) continue;
			(meta[key] = meta[key] || []).push(clean(val));
		}
		const one = (...keys) => {
			for (const k of keys) if (meta[k] && meta[k][0]) return meta[k][0];
			return "";
		};
		const canonicalEl = doc.querySelector('link[rel="canonical"]');
		const canonical = (canonicalEl && canonicalEl.getAttribute("href")) || one("og:url") || url;
		let image = one("og:image", "og:image:url", "og:image:secure_url", "twitter:image", "twitter:image:src");
		if (image) {
			try {
				image = new URL(image, url).href;
			} catch (e) {
				image = "";
			}
			if (/logo|favicon|default[-_]?(image|og|share)|placeholder/i.test(image)) image = "";
		}
		let doi = one("citation_doi", "prism.doi", "dc.identifier", "dc.identifier.doi", "bepress_citation_doi");
		doi = doi && (doi.match(DOI_IN_TEXT) || [])[1];
		const title = one("citation_title", "dc.title", "og:title", "twitter:title") || clean(doc.title);
		const first = one("citation_firstpage");
		const last = one("citation_lastpage");
		const date = one("citation_publication_date", "citation_date", "citation_online_date", "dc.date", "prism.publicationdate", "article:published_time");
		const yearMatch = date.match(/\d{4}/);
		return {
			doi: doi ? cleanDoi(doi) : "",
			pmid: one("citation_pmid"),
			arxiv: one("citation_arxiv_id"),
			image,
			host: hostOf(canonical) || hostOf(url),
			paper: {
				source: "Web page",
				title: stripTrailingDot(title),
				authors: (meta["citation_author"] || meta["dc.creator"] || []).map((n) => {
					const [lastName, firstName] = n.includes(",") ? n.split(",").map(clean) : [n.split(" ").pop(), n.split(" ").slice(0, -1).join(" ")];
					return {
						last: lastName,
						first: firstName || "",
						initials: (firstName || "").split(/[\s.-]+/).filter(Boolean).map((x) => x[0].toUpperCase()).join(""),
						collective: "",
					};
				}),
				journal: one("citation_journal_title", "prism.publicationname", "citation_conference_title", "og:site_name"),
				journalAbbr: one("citation_journal_abbrev"),
				year: yearMatch ? yearMatch[0] : "",
				date: date.replace(/\//g, "-").slice(0, 10),
				volume: one("citation_volume", "prism.volume"),
				issue: one("citation_issue", "prism.number"),
				pages: first ? (last && last !== first ? `${first}-${last}` : first) : "",
				publisher: one("citation_publisher", "dc.publisher"),
				abstract: htmlToText(one("citation_abstract", "dc.description", "og:description", "description")),
				keywords: (meta["citation_keywords"] || []).flatMap((k) => k.split(/[;,]/)).map(clean),
				image,
			},
		};
	}

	/**
	 * URL of the first figure of a PMC article, or "". Uses NCBI's PMC Open Access dataset on AWS
	 * (https://registry.opendata.aws/ncbi-pmc/), which serves figures directly, unlike the PMC and
	 * PubMed web pages. Covers open-access articles and author manuscripts.
	 */
	async pmcFigure(pmcid) {
		const bucket = "https://pmc-oa-opendata.s3.amazonaws.com/";
		const listing = parseXml(await http(`${bucket}?list-type=2&max-keys=1000&prefix=${pmcid}.`, { timeout: 10000 }));
		const keys = Array.from(listing.getElementsByTagNameNS("*", "Key")).map((k) => k.textContent);
		const version = Math.max(0, ...keys.map((k) => Number((k.match(/^PMC\d+\.(\d+)\//) || [])[1] || 0)));
		if (!version) return "";
		const files = keys.filter((k) => k.startsWith(`${pmcid}.${version}/`)).map((k) => k.slice(k.indexOf("/") + 1));
		const images = files.filter((f) => /\.(jpe?g|png|gif|webp)$/i.test(f));
		if (!images.length) return "";
		// the article XML says which graphic belongs to the first figure (skips equations, logos…)
		const jats = parseXml(await http(`${bucket}${pmcid}.${version}/${pmcid}.${version}.xml`, { timeout: 15000 }));
		const graphic = jats.querySelector("fig graphic");
		const href = graphic && (graphic.getAttribute("xlink:href") || graphic.getAttribute("href"));
		if (!href) return "";
		const base = href.replace(/\.(jpe?g|png|gif|tiff?|webp)$/i, "");
		const file = images.find((f) => f === href) || images.find((f) => f.replace(/\.[^.]+$/, "") === base);
		return file ? `${bucket}${pmcid}.${version}/${encodeURIComponent(file)}` : "";
	}

	async byUrl(url) {
		const page = await this.scrape(url);
		let paper = null;
		try {
			if (page.pmid) paper = await this.byPmid(page.pmid);
			else if (page.doi) paper = await this.byDoi(page.doi);
			else if (page.arxiv) paper = await this.byArxiv(page.arxiv);
		} catch (e) {
			console.warn("[scientific-article-card] structured lookup failed, using page metadata", e);
		}
		if (!paper) {
			paper = page.paper;
			if (!paper.title) throw new Error("No article metadata found on this page");
			paper.doi = page.doi;
		}
		paper.image = paper.image || page.image;
		paper.landingHost = page.host;
		return paper;
	}

	/* ---------- final assembly ---------- */
	async finalize(p, ident) {
		const s = this.settings;
		p = Object.assign({ authors: [], keywords: [], mesh: [], types: [] }, p);
		if (p.doi) p.doi = cleanDoi(p.doi);
		if (ident.type === "arxiv" && !p.arxiv) p.arxiv = ident.id;

		const links = {
			input: ident.url || "",
			doi: p.doi ? `https://doi.org/${p.doi}` : "",
			pubmed: p.pmid ? `https://pubmed.ncbi.nlm.nih.gov/${p.pmid}/` : "",
			arxiv: p.arxiv ? `https://arxiv.org/abs/${p.arxiv}` : "",
			pmc: p.pmcid ? `https://pmc.ncbi.nlm.nih.gov/articles/${p.pmcid}/` : "",
		};
		let order;
		if (s.linkTarget === "doi") order = ["doi", "input", "pubmed", "arxiv", "pmc"];
		else if (s.linkTarget === "pubmed") order = ["pubmed", "input", "doi", "arxiv", "pmc"];
		else {
			// "input": keep what the user pasted; for a bare PMID link to PubMed, for a bare DOI to doi.org …
			const natural = { pmid: "pubmed", pmcid: "pmc", doi: "doi", arxiv: "arxiv" }[ident.type];
			order = ["input", natural, "doi", "pubmed", "arxiv", "pmc"].filter(Boolean);
		}
		p.url = order.map((k) => links[k]).find(Boolean) || "";

		// Preview image: the first figure from PMC when the article is there (reliable, no publisher
		// bot walls), otherwise the publisher landing page's og:image.
		if (s.fetchImage && !p.image && p.pmcid) {
			try {
				p.image = await this.pmcFigure(p.pmcid);
			} catch (e) {
				console.debug("[scientific-article-card] no PMC figure", p.pmcid, e.message);
			}
		}
		if (s.fetchImage && !p.image) {
			const landing =
				(ident.url && !/(ncbi\.nlm\.nih\.gov|europepmc\.org|arxiv\.org|doi\.org)$/.test(hostOf(ident.url)) && ident.url) ||
				(p.doi ? `https://doi.org/${p.doi}` : "");
			if (landing) {
				try {
					const page = await this.scrape(landing);
					p.image = page.image || "";
					p.landingHost = p.landingHost || page.host;
				} catch (e) {
					console.debug("[scientific-article-card] could not fetch landing page", landing, e.message);
				}
			}
		}

		if (!p.landingHost && p.landing) p.landingHost = hostOf(p.landing);
		let host = hostOf(p.url);
		if ((host === "doi.org" || !host) && p.landingHost && p.landingHost !== "doi.org") host = p.landingHost;
		p.host = host;
		p.favicon = host ? `https://www.google.com/s2/favicons?domain=${host}&sz=64` : "";

		const ignore = /^(journal article|research support|comparative study|english abstract|research-article|article|introductory journal article)/i;
		const types = (p.types || []).filter(Boolean);
		p.type = types.find((t) => !ignore.test(t)) || (types.length ? "Journal Article" : "");
		if (/^review-article$/i.test(p.type)) p.type = "Review";

		let kw = s.includeKeywords ? p.keywords || [] : [];
		if (s.includeMesh) kw = kw.concat(p.mesh || []);
		p.keywordList = uniq(kw.map(clean)).slice(0, 15);
		return p;
	}
}

/* ------------------------------------------------------------------ */
/* Formatting                                                          */
/* ------------------------------------------------------------------ */

function formatAuthor(a, style) {
	if (a.collective && !a.last) return a.collective;
	if (style === "full") return clean(`${a.first} ${a.last}`);
	return clean(`${a.last} ${a.initials || (a.first || "").split(/\s+/).map((x) => x[0] || "").join("")}`);
}

function formatAuthors(authors, style, max) {
	const names = (authors || []).map((a) => formatAuthor(a, style)).filter(Boolean);
	if (max > 0 && names.length > max) return names.slice(0, max).join(", ") + ", et al.";
	return names.join(", ");
}

function volIssuePages(p) {
	let s = p.volume ? String(p.volume) : "";
	if (p.issue) s += `(${p.issue})`;
	if (p.pages) s += (s ? ":" : "") + p.pages;
	return s;
}

function citationLine(p) {
	const tail = [p.year, volIssuePages(p)].filter(Boolean).join(";");
	return [p.journal, tail].filter(Boolean).join(". ");
}

function idLinks(p) {
	const out = [];
	if (p.doi) out.push(`DOI: [${p.doi}](https://doi.org/${encodeURI(p.doi)})`);
	if (p.pmid) out.push(`PMID: [${p.pmid}](https://pubmed.ncbi.nlm.nih.gov/${p.pmid}/)`);
	if (p.pmcid) out.push(`PMCID: [${p.pmcid}](https://pmc.ncbi.nlm.nih.gov/articles/${p.pmcid}/)`);
	if (p.arxiv) out.push(`arXiv: [${p.arxiv}](https://arxiv.org/abs/${p.arxiv})`);
	return out.join(" · ");
}

/** Flat string fields for the code block / template. */
function toFields(p, s) {
	return {
		title: p.title || "",
		authors: formatAuthors(p.authors, s.authorFormat, Number(s.maxAuthors) || 0),
		firstAuthor: p.authors && p.authors[0] ? formatAuthor(p.authors[0], s.authorFormat) : "",
		journal: p.journal || "",
		journalAbbr: p.journalAbbr || "",
		year: p.year || "",
		date: p.date || "",
		volume: p.volume || "",
		issue: p.issue || "",
		pages: p.pages || "",
		doi: p.doi || "",
		pmid: p.pmid || "",
		pmcid: p.pmcid || "",
		arxiv: p.arxiv || "",
		url: p.url || "",
		host: p.host || "",
		favicon: p.favicon || "",
		image: p.image || "",
		type: p.type || "",
		publisher: p.publisher || "",
		keywords: (p.keywordList || []).join("; "),
		abstract: s.includeAbstract ? p.abstract || "" : "",
		citation: citationLine(p),
		ids: idLinks(p),
	};
}

const BLOCK_KEYS = ["url", "title", "authors", "journal", "year", "date", "volume", "issue", "pages", "doi", "pmid", "pmcid", "arxiv", "type", "host", "favicon", "image", "keywords", "abstract"];

function toCodeBlock(f) {
	const lines = BLOCK_KEYS.filter((k) => f[k]).map((k) => `${k}: ${JSON.stringify(String(f[k]))}`);
	return "```" + CODE_BLOCK_LANG + "\n" + lines.join("\n") + "\n```\n";
}

function escapeMdLinkText(s) {
	return String(s).replace(/([\[\]])/g, "\\$1");
}

function fillTemplate(template, f) {
	const vals = Object.assign({}, f, { title: escapeMdLinkText(f.title) });
	// {{#key}} … {{/key}} sections render only when key is non-empty
	let out = template.replace(/\{\{#(\w+)\}\}([\s\S]*?)\{\{\/\1\}\}/g, (_, k, inner) => (vals[k] ? inner : ""));
	// keep callout / blockquote prefixes on multi-line values
	out = out
		.split("\n")
		.map((line) => {
			const prefix = (line.match(/^(\s*(?:>\s?)+)/) || [""])[0];
			return line.replace(/\{\{(\w+)\}\}/g, (m, k) => {
				if (!(k in vals)) return m;
				const v = String(vals[k] == null ? "" : vals[k]);
				return prefix ? v.replace(/\n/g, "\n" + prefix) : v;
			});
		})
		.join("\n");
	return out.replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}

/* ------------------------------------------------------------------ */
/* Card rendering (```paper code block)                                */
/* ------------------------------------------------------------------ */

function externalLink(parent, text, href, cls) {
	const a = parent.createEl("a", { text, href, cls: ["external-link", cls].filter(Boolean).join(" ") });
	a.setAttr("target", "_blank");
	a.setAttr("rel", "noopener");
	return a;
}

function renderCard(source, el, settings) {
	let d;
	try {
		d = parseYaml(source) || {};
	} catch (e) {
		el.createDiv({ cls: "scientific-article-card-error", text: `Scientific Article Card: invalid YAML — ${e.message}` });
		return;
	}
	for (const k of Object.keys(d)) d[k] = d[k] == null ? "" : String(d[k]);
	if (!d.title && !d.url) {
		el.createDiv({ cls: "scientific-article-card-error", text: "Scientific Article Card: a `title` or `url` is required." });
		return;
	}

	const card = el.createDiv({ cls: "scientific-article-card" });
	const main = card.createDiv({ cls: "scientific-article-card-main" });
	const body = main.createDiv({ cls: "scientific-article-card-body" });

	const header = body.createDiv({ cls: "scientific-article-card-header" });
	if (d.favicon) {
		const fav = header.createEl("img", { cls: "scientific-article-card-favicon", attr: { src: d.favicon, alt: "", loading: "lazy" } });
		fav.onerror = () => fav.remove();
	}
	if (d.host) header.createSpan({ cls: "scientific-article-card-host", text: d.host });
	if (d.type) header.createSpan({ cls: "scientific-article-card-badge", text: d.type });

	if (d.url) externalLink(body, d.title || d.url, d.url, "scientific-article-card-title");
	else body.createDiv({ cls: "scientific-article-card-title", text: d.title });

	if (d.authors) body.createDiv({ cls: "scientific-article-card-authors", text: d.authors, attr: { title: d.authors } });

	const cite = body.createDiv({ cls: "scientific-article-card-citation" });
	if (d.journal) cite.createEl("em", { text: d.journal });
	const tail = [d.year, volIssuePages(d)].filter(Boolean).join(";");
	if (tail) cite.appendText((d.journal ? " · " : "") + tail);

	const ids = body.createDiv({ cls: "scientific-article-card-ids" });
	const chip = (label, value, href) => {
		const c = ids.createSpan({ cls: "scientific-article-card-id" });
		c.createSpan({ cls: "scientific-article-card-id-label", text: label });
		externalLink(c, value, href);
	};
	if (d.doi) chip("DOI", d.doi, `https://doi.org/${encodeURI(d.doi)}`);
	if (d.pmid) chip("PMID", d.pmid, `https://pubmed.ncbi.nlm.nih.gov/${d.pmid}/`);
	if (d.pmcid) chip("PMC", d.pmcid, `https://pmc.ncbi.nlm.nih.gov/articles/${d.pmcid}/`);
	if (d.arxiv) chip("arXiv", d.arxiv, `https://arxiv.org/abs/${d.arxiv}`);
	if (!ids.childElementCount) ids.remove();

	if (d.image) {
		const thumb = main.createDiv({ cls: "scientific-article-card-thumb" });
		const img = thumb.createEl("img", { attr: { src: d.image, alt: "", loading: "lazy", referrerpolicy: "no-referrer" } });
		img.onerror = () => thumb.remove();
	}

	if (d.keywords) {
		const kw = card.createDiv({ cls: "scientific-article-card-keywords" });
		for (const k of d.keywords.split(/\s*;\s*/).filter(Boolean)) kw.createSpan({ cls: "scientific-article-card-keyword", text: k });
	}

	if (d.abstract) {
		const det = card.createEl("details", { cls: "scientific-article-card-abstract" });
		if (settings.abstractOpen) det.setAttr("open", "");
		det.createEl("summary", { text: "Abstract" });
		for (const para of d.abstract.split(/\n{2,}/)) {
			const pEl = det.createEl("p");
			const m = para.match(/^([A-Z][\w ,/&-]{1,40}):\s+([\s\S]*)$/);
			if (m) {
				pEl.createEl("strong", { text: m[1] + ": " });
				pEl.appendText(m[2]);
			} else pEl.setText(para);
		}
	}
}

/* ------------------------------------------------------------------ */
/* UI: identifier prompt                                               */
/* ------------------------------------------------------------------ */

class IdentifierModal extends Modal {
	constructor(app, onSubmit) {
		super(app);
		this.onSubmit = onSubmit;
	}
	onOpen() {
		const { contentEl } = this;
		this.titleEl.setText("Insert article card");
		contentEl.createEl("p", {
			cls: "setting-item-description",
			text: "PMID, PMCID, DOI, arXiv ID or article URL. Separate several with spaces, commas or new lines.",
		});
		const input = contentEl.createEl("textarea", { cls: "scientific-article-card-modal-input", attr: { rows: 3, placeholder: "34265844\n10.1038/s41586-021-03819-2" } });
		const submit = () => {
			const v = input.value.trim();
			this.close();
			if (v) this.onSubmit(v);
		};
		input.addEventListener("keydown", (e) => {
			if (e.key === "Enter" && !e.shiftKey) {
				e.preventDefault();
				submit();
			}
		});
		new Setting(contentEl).addButton((b) => b.setButtonText("Insert").setCta().onClick(submit));
		setTimeout(() => input.focus(), 0);
	}
	onClose() {
		this.contentEl.empty();
	}
}

/* ------------------------------------------------------------------ */
/* Plugin                                                              */
/* ------------------------------------------------------------------ */

class ScientificArticleCardPlugin extends Plugin {
	async onload() {
		await this.loadSettings();

		this.registerMarkdownCodeBlockProcessor(CODE_BLOCK_LANG, (source, el) => renderCard(source, el, this.settings));

		this.addCommand({
			id: "convert-selection-to-scientific-article-card",
			name: "Convert selection (or identifier under cursor) to article card",
			icon: "book-open",
			editorCallback: (editor) => this.convertSelection(editor),
		});
		this.addCommand({
			id: "insert-scientific-article-card",
			name: "Insert article card from PMID / DOI / URL…",
			icon: "file-plus",
			editorCallback: (editor) => new IdentifierModal(this.app, (v) => this.convertTokens(editor, v, null)).open(),
		});

		// Paste detection reads nothing but the note itself: "editor-paste" only marks that a paste
		// is happening, and the pasted text is picked up from the document once Obsidian has inserted it.
		this.pendingPaste = null;
		this.registerEvent(
			this.app.workspace.on("editor-paste", (evt, editor) => {
				// already handled by another plugin (e.g. Auto Card Link)
				this.pendingPaste = evt.defaultPrevented ? null : { editor, at: Date.now() };
			})
		);
		this.registerEditorExtension(EditorView.updateListener.of((update) => this.onEditorUpdate(update)));

		this.registerEvent(
			this.app.workspace.on("editor-menu", (menu, editor) => {
				if (!this.settings.showInMenu) return;
				menu.addItem((item) =>
					item.setTitle("Convert to article card").setIcon("book-open").onClick(() => this.convertSelection(editor))
				);
			})
		);

		this.addSettingTab(new ScientificArticleCardSettingTab(this.app, this));
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}
	async saveSettings() {
		await this.saveData(this.settings);
	}

	domains() {
		return this.settings.pasteDomains.split(/[\s,]+/).filter(Boolean);
	}

	parse(text, allowBare) {
		return parseIdentifier(text, { allowBare, domains: this.domains() });
	}

	onEditorUpdate(update) {
		if (!this.settings.enhancePaste || !update.docChanged) return;
		const info = update.state.field(editorInfoField, false);
		const editor = info && info.editor;
		if (!editor) return;
		const pending = this.pendingPaste;
		const signalled =
			!!pending && Date.now() - pending.at < 1000 && (pending.editor === editor || pending.editor.cm === update.view);
		const txs = update.transactions;
		for (let i = 0; i < txs.length; i++) {
			const tr = txs[i];
			if (!tr.docChanged || !(signalled || tr.isUserEvent("input.paste"))) continue;
			let hit = null;
			tr.changes.iterChanges((fromA, toA, fromB, toB, inserted) => {
				// only a paste at the cursor: pasting a URL over a selection makes a [selection](url) link
				if (!hit && fromA === toA) hit = { from: fromB, to: toB, text: inserted.toString() };
			});
			if (!hit) continue;
			for (const later of txs.slice(i + 1)) {
				hit.from = later.changes.mapPos(hit.from, 1);
				hit.to = later.changes.mapPos(hit.to, -1);
			}
			this.pendingPaste = null;
			this.onPastedText(editor, hit);
			return;
		}
	}

	onPastedText(editor, hit) {
		const text = hit.text.trim();
		// ignore multi-line pastes and Auto Card Link's own "[Fetching Data#…](url)" placeholder
		if (!text || /\n/.test(text) || /^\[Fetching Data#/.test(text)) return;
		const ident = this.parse(text, this.settings.pasteBarePmid);
		if (!ident || (ident.type === "url" && !ident.scholarly)) return;
		if (!navigator.onLine) return;
		// the editor can't be changed from inside an update listener
		window.setTimeout(() => {
			const from = editor.offsetToPos(hit.from);
			const to = editor.offsetToPos(hit.to);
			if (editor.getRange(from, to) !== hit.text) return; // note changed in the meantime
			this.convertIdentifiers(editor, [ident], { from, to });
		}, 0);
	}

	convertSelection(editor) {
		if (editor.somethingSelected()) {
			this.convertTokens(editor, editor.getSelection(), { from: editor.getCursor("from"), to: editor.getCursor("to") });
			return;
		}
		// token under cursor
		const cur = editor.getCursor();
		const line = editor.getLine(cur.line);
		let a = cur.ch;
		let b = cur.ch;
		while (a > 0 && !/\s/.test(line[a - 1])) a--;
		while (b < line.length && !/\s/.test(line[b])) b++;
		const token = line.slice(a, b);
		if (!token) {
			new Notice("Scientific Article Card: select or place the cursor on a PMID, DOI or URL");
			return;
		}
		this.convertTokens(editor, token, { from: { line: cur.line, ch: a }, to: { line: cur.line, ch: b } });
	}

	/** text → identifiers → cards. `range` is replaced; null = insert at cursor/selection. */
	convertTokens(editor, text, range) {
		const tokens = String(text)
			.split(/[\s,;]+/)
			.map((t) => t.trim())
			.filter(Boolean);
		// markdown links contain no spaces in URL but may in their text – rescue them
		const mdLinks = String(text).match(/\[[^\]]*\]\([^)\s]+\)/g);
		const candidates = mdLinks && mdLinks.length ? mdLinks.concat(tokens.filter((t) => !/[\[\]()]/.test(t))) : tokens;
		const idents = candidates.map((t) => this.parse(t, true)).filter(Boolean);
		if (!idents.length) {
			new Notice("Scientific Article Card: no PMID, PMCID, DOI, arXiv ID or URL found");
			return;
		}
		this.convertIdentifiers(editor, idents, range);
	}

	async convertIdentifiers(editor, idents, range) {
		const stamp = Date.now().toString(36);
		const placeholders = idents.map((id, i) => `⏳ Fetching paper metadata for ${id.raw} …#${stamp}${i}`);
		let insert = placeholders.join("\n\n");

		const from = range ? range.from : editor.getCursor("from");
		const lineBefore = editor.getLine(from.line).slice(0, from.ch);
		if (this.settings.outputFormat === "card" && lineBefore.trim()) insert = "\n" + insert;
		if (range) editor.replaceRange(insert, range.from, range.to);
		else editor.replaceSelection(insert);

		const resolver = new Resolver(this.settings);
		let failures = 0;
		// sequential: stays well under NCBI's 3 requests/second without an API key
		for (let i = 0; i < idents.length; i++) {
			let replacement;
			try {
				const paper = await resolver.resolve(idents[i]);
				const f = toFields(paper, this.settings);
				replacement = this.settings.outputFormat === "template" ? fillTemplate(this.settings.template, f) : toCodeBlock(f);
			} catch (e) {
				failures++;
				console.error("[scientific-article-card]", idents[i], e);
				new Notice(`Scientific Article Card: ${idents[i].raw} — ${e.message || e}`, 8000);
				replacement = idents[i].raw;
			}
			this.replacePlaceholder(editor, placeholders[i], replacement);
		}
		if (idents.length > 1) new Notice(`Scientific Article Card: ${idents.length - failures}/${idents.length} papers inserted`);
	}

	replacePlaceholder(editor, placeholder, replacement) {
		const content = editor.getValue();
		const idx = content.indexOf(placeholder);
		if (idx < 0) return; // user deleted it meanwhile
		let end = idx + placeholder.length;
		// avoid piling up blank lines after a code block
		if (replacement.endsWith("\n") && content[end] === "\n") replacement = replacement.slice(0, -1);
		editor.replaceRange(replacement, editor.offsetToPos(idx), editor.offsetToPos(end));
	}
}

/* ------------------------------------------------------------------ */
/* Settings tab                                                        */
/* ------------------------------------------------------------------ */

class ScientificArticleCardSettingTab extends PluginSettingTab {
	constructor(app, plugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display() {
		const { containerEl } = this;
		const s = this.plugin.settings;
		const save = () => this.plugin.saveSettings();
		containerEl.empty();

		new Setting(containerEl).setName("Output").setHeading();

		new Setting(containerEl)
			.setName("Output format")
			.setDesc("Card: a ```paper code block rendered as a rich card by this plugin. Template: plain Markdown built from the template below (readable without the plugin).")
			.addDropdown((d) =>
				d
					.addOption("card", "Card (code block)")
					.addOption("template", "Markdown template")
					.setValue(s.outputFormat)
					.onChange(async (v) => {
						s.outputFormat = v;
						await save();
						this.display();
					})
			);

		if (s.outputFormat === "template") {
			new Setting(containerEl)
				.setName("Template")
				.setDesc(
					"Placeholders: {{title}} {{authors}} {{firstAuthor}} {{journal}} {{journalAbbr}} {{year}} {{date}} {{volume}} {{issue}} {{pages}} {{citation}} {{doi}} {{pmid}} {{pmcid}} {{arxiv}} {{ids}} {{url}} {{host}} {{image}} {{type}} {{publisher}} {{keywords}} {{abstract}}. Wrap text in {{#key}}…{{/key}} to show it only when key is non-empty."
				)
				.addTextArea((t) => {
					t.setValue(s.template).onChange(async (v) => {
						s.template = v;
						await save();
					});
					t.inputEl.rows = 12;
					t.inputEl.addClass("scientific-article-card-template-input");
				})
				.addExtraButton((b) =>
					b
						.setIcon("rotate-ccw")
						.setTooltip("Restore default template")
						.onClick(async () => {
							s.template = DEFAULT_TEMPLATE;
							await save();
							this.display();
						})
				);
		}

		new Setting(containerEl)
			.setName("Main link")
			.setDesc("Which URL the title links to.")
			.addDropdown((d) =>
				d
					.addOption("input", "What I pasted (PMID → PubMed, DOI → doi.org, URL → URL)")
					.addOption("doi", "Prefer doi.org")
					.addOption("pubmed", "Prefer PubMed")
					.setValue(s.linkTarget)
					.onChange(async (v) => {
						s.linkTarget = v;
						await save();
					})
			);

		new Setting(containerEl)
			.setName("Author format")
			.addDropdown((d) =>
				d
					.addOption("short", "Smith JA")
					.addOption("full", "John A. Smith")
					.setValue(s.authorFormat)
					.onChange(async (v) => {
						s.authorFormat = v;
						await save();
					})
			);

		new Setting(containerEl)
			.setName("Maximum authors")
			.setDesc("Truncate with “et al.” after this many authors (0 = all).")
			.addText((t) =>
				t.setValue(String(s.maxAuthors)).onChange(async (v) => {
					const n = parseInt(v, 10);
					s.maxAuthors = isNaN(n) || n < 0 ? 0 : n;
					await save();
				})
			);

		const toggle = (name, desc, key) =>
			new Setting(containerEl)
				.setName(name)
				.setDesc(desc)
				.addToggle((t) =>
					t.setValue(!!s[key]).onChange(async (v) => {
						s[key] = v;
						await save();
					})
				);

		toggle("Include abstract", "", "includeAbstract");
		toggle("Include keywords", "Author keywords (PubMed / Europe PMC / Crossref subjects).", "includeKeywords");
		toggle("Include MeSH terms", "Add MeSH descriptors to the keywords.", "includeMesh");
		toggle("Fetch preview image", "Load the publisher page to grab its og:image. Some publishers block this; it is skipped silently.", "fetchImage");
		toggle("Expand abstract by default", "For the card view.", "abstractOpen");

		new Setting(containerEl).setName("Paste").setHeading();
		toggle("Enhance default paste", "Pasting a PubMed/PMC/DOI/arXiv link, a DOI, “PMID: …” or a URL from the domains below turns into an article card once it lands in the note. Other URLs are left alone.", "enhancePaste");
		toggle("Treat pasted bare numbers as PMIDs", "Pasting just “34265844” creates a card. Off by default to avoid surprises.", "pasteBarePmid");
		new Setting(containerEl)
			.setName("Publisher domains")
			.setDesc("Pasted URLs from these domains (one per line) are scraped for citation metadata even when the URL contains no DOI.")
			.addTextArea((t) => {
				t.setValue(s.pasteDomains).onChange(async (v) => {
					s.pasteDomains = v;
					await save();
				});
				t.inputEl.rows = 6;
			});
		toggle("Show in context menu", "Add “Convert to article card” to the editor right-click menu.", "showInMenu");

		new Setting(containerEl).setName("APIs").setHeading();
		new Setting(containerEl)
			.setName("Contact email")
			.setDesc("Optional. Sent to NCBI and Crossref as recommended by their usage policies (Crossref “polite pool”).")
			.addText((t) =>
				t.setPlaceholder("you@example.org").setValue(s.email).onChange(async (v) => {
					s.email = v.trim();
					await save();
				})
			);
		new Setting(containerEl)
			.setName("NCBI API key")
			.setDesc("Optional. Raises the PubMed rate limit from 3 to 10 requests/second.")
			.addText((t) =>
				t.setValue(s.ncbiApiKey).onChange(async (v) => {
					s.ncbiApiKey = v.trim();
					await save();
				})
			);
	}
}

module.exports = ScientificArticleCardPlugin;
module.exports.default = ScientificArticleCardPlugin;
// exposed for testing
module.exports._internals = { toScript, parseIdentifier, cleanDoi, htmlToText, Resolver, toFields, toCodeBlock, fillTemplate, DEFAULT_SETTINGS };
