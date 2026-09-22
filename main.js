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
	setIcon,
	TFile,
	MarkdownRenderChild,
	normalizePath,
} = obsidian;
const { EditorView } = require("@codemirror/view");

const CODE_BLOCK_LANG = "paper";
const PAPER_NOTE_LANG = "paper-note";
const COLORS = ["blue", "cyan", "teal", "green", "lime", "yellow", "orange", "red", "pink", "grape", "violet", "indigo", "gray", "accent"];
const EUTILS = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils";
const EUROPEPMC = "https://www.ebi.ac.uk/europepmc/webservices/rest/search";
const PUBMED_IMAGE = "https://cdn.ncbi.nlm.nih.gov/pubmed/persistent/pubmed-meta-image-v2.jpg";

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
	syncTags: true,
	paperNoteLocation: "project", // "project" (next to the note with the card) | "folder"
	paperNoteSubfolder: "",
	paperNoteFolder: "",
	cardStyle: "mantine", // "mantine" | "obsidian"
	typeColor: "blue",
	keywordColor: "violet",
	tagColor: "teal",
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
		// Default for PubMed-indexed articles without a figure: PubMed's own preview image.
		if (s.fetchImage && !p.image && p.pmid) p.image = PUBMED_IMAGE;

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
		// MeSH terms: always with "Include MeSH terms", otherwise when there are no author keywords
		if (s.includeMesh || (s.includeKeywords && !kw.length)) kw = kw.concat(p.mesh || []);
		p.keywordList = uniq(kw.map(clean)).slice(0, 15);
		return p;
	}
}

/* ------------------------------------------------------------------ */
/* Formatting                                                          */
/* ------------------------------------------------------------------ */

function formatAuthor(a, style) {
	if (a.formatted) return a.formatted;
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

/* ------------------------------------------------------------------ */
/* Personal notes: status, rating, tags, note (stored in the card)     */
/* ------------------------------------------------------------------ */

const USER_KEYS = ["status", "rating", "tags", "note"];
const STATUSES = { "to-read": "To read", reading: "Reading", read: "Read" };

/** Obsidian tag rules: no "#", no spaces, letters/digits/_/-// only, not all digits. */
function normalizeTag(t) {
	return String(t)
		.trim()
		.replace(/^#+/, "")
		.replace(/\s+/g, "-")
		.replace(/[^\p{L}\p{N}_\-/]/gu, "");
}

function parseTags(v) {
	const list = Array.isArray(v) ? v : String(v == null ? "" : v).split(/[,\s]+/);
	return uniq(list.map(normalizeTag).filter((t) => t && /\D/.test(t)));
}

/** Replace `fields` in a card's YAML lines (null/empty removes), keeping everything else untouched. */
function setFields(lines, fields) {
	const keys = Object.keys(fields);
	const out = [];
	let skipping = false;
	for (const l of lines) {
		const m = l.match(/^([A-Za-z_][\w-]*)\s*:/);
		if (m) skipping = keys.includes(m[1]);
		else if (!/^[\s-]/.test(l)) skipping = false;
		if (!skipping) out.push(l);
	}
	while (out.length && !out[out.length - 1].trim()) out.pop();
	for (const [k, v] of Object.entries(fields)) {
		if (v == null || v === "" || v === 0 || (Array.isArray(v) && !v.length)) continue;
		out.push(`${k}: ${typeof v === "number" ? v : JSON.stringify(v)}`);
	}
	return out;
}

function setUserFields(lines, v) {
	return setFields(lines, {
		status: v.status || null,
		rating: v.rating || null,
		tags: v.tags && v.tags.length ? v.tags : null,
		note: v.note && v.note.trim() ? v.note.trim() : null,
	});
}

/** Find the ```paper block whose content is `source`, closest to `hintLine`. Returns [start, end] line indexes. */
function findBlock(lines, source, hintLine) {
	let best = null;
	for (let i = 0; i < lines.length; i++) {
		if (!new RegExp("^```" + CODE_BLOCK_LANG + "\\s*$").test(lines[i])) continue;
		let j = i + 1;
		while (j < lines.length && !/^```\s*$/.test(lines[j])) j++;
		if (j >= lines.length) break;
		if (lines.slice(i + 1, j).join("\n").trimEnd() === source.trimEnd()) {
			if (!best || Math.abs(i - hintLine) < Math.abs(best[0] - hintLine)) best = [i, j];
		}
		i = j;
	}
	return best;
}

/* ------------------------------------------------------------------ */
/* Paper notes (one note per article, metadata in properties)          */
/* ------------------------------------------------------------------ */

function asList(v) {
	if (v == null || v === "") return [];
	return Array.isArray(v) ? v.map(String) : [String(v)];
}

/** Identifier to (re)fetch a card's article. */
function identFromCard(d) {
	if (d.pmid) return { type: "pmid", id: String(d.pmid), raw: String(d.pmid) };
	if (d.doi) return { type: "doi", id: cleanDoi(d.doi), raw: String(d.doi) };
	if (d.arxiv) return { type: "arxiv", id: String(d.arxiv), raw: String(d.arxiv) };
	if (d.pmcid) return { type: "pmcid", id: String(d.pmcid), raw: String(d.pmcid) };
	if (d.url) return parseIdentifier(String(d.url), {});
	return null;
}

/** Paper-like object from a card, used when the article can't be fetched again. */
function cardToPaper(d) {
	const names = String(d.authors || "")
		.split(/,\s*/)
		.map((n) => n.trim())
		.filter((n) => n && !/^et al\.?$/i.test(n));
	return {
		title: d.title || "",
		authors: names.map((n) => ({ formatted: n, last: n.split(/\s+/)[0] })),
		journal: d.journal || "",
		journalAbbr: "",
		year: d.year ? String(d.year) : "",
		volume: d.volume || "",
		issue: d.issue || "",
		pages: d.pages || "",
		doi: d.doi || "",
		pmid: d.pmid ? String(d.pmid) : "",
		pmcid: d.pmcid || "",
		arxiv: d.arxiv || "",
		url: d.url || "",
		image: d.image || "",
		type: d.type || "",
		keywordList: String(d.keywords || "")
			.split(/\s*;\s*/)
			.filter(Boolean),
		abstract: d.abstract || "",
	};
}

/** FirstAuthor_JournalAbbrev_Year, e.g. Jumper_Nature_2021, Zucca_HumGenet_2025. */
function paperNoteBaseName(p) {
	const clean = (x) => String(x || "").normalize("NFC").replace(/[^\p{L}\p{N}]/gu, "");
	const a = p.authors && p.authors[0];
	const first = clean(a ? a.last || String(a.collective || a.formatted || "").split(/\s+/)[0] : "");
	let journal = p.journalAbbr || "";
	if (!journal && p.journal) {
		const words = p.journal.split(/\s+/);
		journal = words.length <= 2 ? p.journal : words.filter((w) => /^\p{Lu}/u.test(w)).map((w) => w[0]).join("");
	}
	return [first, clean(journal).slice(0, 20), p.year].filter(Boolean).join("_") || "Paper";
}

/** Properties of a new paper note. */
function paperProps(p, user, settings) {
	const props = {
		type: "paper",
		title: p.title,
		authors: (p.authors || []).map((a) => formatAuthor(a, settings.authorFormat)).filter(Boolean),
		journal: p.journal,
		year: /^\d{4}$/.test(String(p.year)) ? Number(p.year) : p.year,
		volume: p.volume,
		issue: p.issue,
		pages: p.pages,
		doi: p.doi,
		pmid: p.pmid ? String(p.pmid) : "",
		pmcid: p.pmcid,
		arxiv: p.arxiv,
		url: p.url,
		image: p.image,
		"publication-type": p.type,
		keywords: p.keywordList || [],
		status: user.status,
		rating: user.rating,
		tags: user.tags || [],
		created: new Date().toISOString().slice(0, 10),
	};
	for (const k of Object.keys(props)) {
		const v = props[k];
		if (v == null || v === "" || v === 0 || (Array.isArray(v) && !v.length)) delete props[k];
	}
	return props;
}

function paperNoteBody(abstract, note) {
	let body = "```" + PAPER_NOTE_LANG + "\n```\n";
	if (abstract) body += "\n## Abstract\n\n" + abstract + "\n";
	body += "\n## Notes\n\n" + (note ? note.trim() + "\n" : "");
	return body;
}

/** Card data from a paper note's properties. */
function fmToCard(fm, settings) {
	const names = asList(fm.authors);
	const max = Number(settings.maxAuthors) || 0;
	const authors = max > 0 && names.length > max ? names.slice(0, max).join(", ") + ", et al." : names.join(", ");
	const host = hostOf(fm.url || "");
	return {
		url: fm.url,
		title: fm.title,
		authors,
		journal: fm.journal,
		year: fm.year,
		volume: fm.volume,
		issue: fm.issue,
		pages: fm.pages,
		doi: fm.doi,
		pmid: fm.pmid,
		pmcid: fm.pmcid,
		arxiv: fm.arxiv,
		type: fm["publication-type"],
		host,
		favicon: host ? `https://www.google.com/s2/favicons?domain=${host}&sz=64` : "",
		image: fm.image,
		keywords: asList(fm.keywords).join("; "),
		status: fm.status,
		rating: fm.rating,
		tags: fm.tags,
	};
}

/** Properties refreshed from the article's databases (never status, rating, tags, created or others). */
const FETCHED_PROPS = ["title", "authors", "journal", "year", "volume", "issue", "pages", "doi", "pmid", "pmcid", "arxiv", "url", "image", "publication-type", "keywords"];

/** Apply fetched properties to a frontmatter object. Empty new values keep the old one. Returns changed keys. */
function refreshProps(fm, fresh) {
	const changed = [];
	for (const k of FETCHED_PROPS) {
		if (!(k in fresh)) continue;
		const v = fresh[k];
		if (JSON.stringify(fm[k]) === JSON.stringify(v)) continue;
		fm[k] = v;
		changed.push(k);
	}
	return changed;
}

/** Contents of a Papers.base listing the paper notes in `folder` ("/" = whole vault). */
function papersBase(folder) {
	const q = (x) => JSON.stringify(x);
	const filters = ['    - type == "paper"'];
	if (folder && folder !== "/") filters.push(`    - file.inFolder(${q(folder)})`);
	const columns = ["file.name", "note.title", "note.year", "note.journal", "note.status", "note.rating", "note.tags"];
	const order = columns.map((c) => `      - ${c}`).join("\n");
	return `filters:
  and:
${filters.join("\n")}
properties:
  note.title:
    displayName: Title
  note.year:
    displayName: Year
  note.journal:
    displayName: Journal
  note.status:
    displayName: Status
  note.rating:
    displayName: Rating
  note.tags:
    displayName: Tags
views:
  - type: table
    name: All papers
    order:
${order}
    sort:
      - property: note.year
        direction: DESC
  - type: table
    name: To read
    filters:
      and:
        - status == "to-read"
    order:
${order}
    sort:
      - property: note.created
        direction: ASC
  - type: table
    name: By status
    groupBy:
      property: note.status
      direction: ASC
    order:
${order}
  - type: cards
    name: Shelf
    image: note.image
    imageFit: contain
    imageAspectRatio: 0.7
    cardSize: 240
    order:
      - note.title
      - note.year
      - note.journal
      - note.status
`;
}

/** Link path from "[[Note]]", "[[Note|alias]]", "[Note](Note.md)" or a bare path. */
function linkpathFrom(v) {
	const s = String(v || "").trim();
	let m;
	if ((m = s.match(/^!?\[\[([^\]|#]+)/))) return m[1].trim();
	if ((m = s.match(/^\[[^\]]*\]\(<?([^)>]+)>?\)$/))) return safeDecode(m[1]).replace(/\.md$/, "");
	return s.replace(/\.md$/, "");
}

function colorClasses(settings) {
	const pick = (c, dflt) => (COLORS.includes(c) ? c : dflt);
	return [
		`sac-surface-${settings.cardStyle === "obsidian" ? "obsidian" : "mantine"}`,
		`sac-type-${pick(settings.typeColor, "blue")}`,
		`sac-kw-${pick(settings.keywordColor, "violet")}`,
		`sac-tag-${pick(settings.tagColor, "teal")}`,
	];
}

function applyColorClasses(card, settings) {
	for (const c of Array.from(card.classList)) if (c.startsWith("sac-")) card.classList.remove(c);
	card.classList.add(...colorClasses(settings));
}

function renderCard(source, el, settings, actions) {
	let d;
	try {
		d = parseYaml(source) || {};
	} catch (e) {
		el.createDiv({ cls: "scientific-article-card-error", text: `Scientific Article Card: invalid YAML — ${e.message}` });
		return null;
	}
	return renderCardData(d, el, settings, typeof actions === "function" ? { onEdit: actions } : actions || {});
}

/**
 * actions: { onEdit(), note: { label, icon, onClick() }, user: { status, rating, tags, note } }
 * `user` overrides the card's own notes fields (used when the card is linked to a paper note).
 */
function renderCardData(data, el, settings, actions) {
	const a = actions || {};
	const src = a.user || data;
	const userTags = parseTags(src.tags);
	const u = {
		status: src.status == null ? "" : String(src.status),
		rating: Math.max(0, Math.min(5, parseInt(src.rating, 10) || 0)),
		note: src.note == null ? "" : String(src.note),
	};
	const d = {};
	for (const k of Object.keys(data || {})) d[k] = data[k] == null ? "" : Array.isArray(data[k]) ? data[k].join(", ") : String(data[k]);
	if (!d.title && !d.url) {
		el.createDiv({ cls: "scientific-article-card-error", text: "Scientific Article Card: a `title` or `url` is required." });
		return null;
	}

	const card = el.createDiv({ cls: "scientific-article-card" });
	card.classList.add(...colorClasses(settings));
	const main = card.createDiv({ cls: "scientific-article-card-main" });
	const body = main.createDiv({ cls: "scientific-article-card-body" });

	const header = body.createDiv({ cls: "scientific-article-card-header" });
	if (d.favicon) {
		const fav = header.createEl("img", { cls: "scientific-article-card-favicon", attr: { src: d.favicon, alt: "", loading: "lazy" } });
		fav.onerror = () => fav.remove();
	}
	if (d.host) header.createSpan({ cls: "scientific-article-card-host", text: d.host });
	if (d.type) header.createSpan({ cls: "scientific-article-card-badge", text: d.type });
	const acts = header.createSpan({ cls: "scientific-article-card-actions" });
	const action = (label, icon, fn) => {
		const btn = acts.createEl("button", {
			cls: "scientific-article-card-edit clickable-icon",
			attr: { type: "button", "aria-label": label, title: label },
		});
		if (setIcon) setIcon(btn, icon);
		else btn.setText(label);
		btn.addEventListener("click", (evt) => {
			evt.preventDefault();
			evt.stopPropagation();
			fn();
		});
	};
	if (a.note) action(a.note.label, a.note.icon, a.note.onClick);
	if (a.onEdit) action("Edit notes", "pencil", a.onEdit);
	if (!acts.childElementCount) acts.remove();

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

	const rating = u.rating;
	if (u.status || rating || userTags.length || u.note) {
		const mine = card.createDiv({ cls: "scientific-article-card-mine" });
		const row = mine.createDiv({ cls: "scientific-article-card-mine-row" });
		row.createSpan({ cls: "scientific-article-card-mine-label", text: "Your notes" });
		if (u.status) {
			const known = STATUSES[u.status] ? ` is-${u.status}` : "";
			row.createSpan({ cls: "scientific-article-card-status" + known, text: STATUSES[u.status] || u.status });
		}
		if (rating) {
			row.createSpan({
				cls: "scientific-article-card-rating",
				text: "★".repeat(rating) + "☆".repeat(5 - rating),
				attr: { "aria-label": `Rated ${rating} out of 5` },
			});
		}
		for (const t of userTags) row.createSpan({ cls: "scientific-article-card-tag", text: "#" + t });
		if (u.note) {
			const note = mine.createDiv({ cls: "scientific-article-card-note" });
			for (const para of u.note.split(/\n{2,}/)) note.createEl("p", { text: para });
		}
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
	return card;
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

class NotesModal extends Modal {
	constructor(app, title, values, onSubmit, options) {
		super(app);
		this.paperTitle = title;
		this.values = values;
		this.onSubmit = onSubmit;
		this.options = Object.assign({ showNote: true, hint: "" }, options);
	}
	onOpen() {
		const { contentEl } = this;
		const v = Object.assign({}, this.values);
		this.titleEl.setText("Your notes");
		if (this.paperTitle) contentEl.createEl("p", { cls: "setting-item-description", text: this.paperTitle });
		new Setting(contentEl).setName("Status").addDropdown((dd) => {
			dd.addOption("", "None");
			for (const [k, label] of Object.entries(STATUSES)) dd.addOption(k, label);
			dd.setValue(v.status || "").onChange((x) => (v.status = x));
		});
		new Setting(contentEl).setName("Rating").addDropdown((dd) => {
			dd.addOption("0", "No rating");
			for (let i = 1; i <= 5; i++) dd.addOption(String(i), "★".repeat(i));
			dd.setValue(String(v.rating || 0)).onChange((x) => (v.rating = Number(x)));
		});
		new Setting(contentEl)
			.setName("Tags")
			.setDesc("Separated by commas or spaces, without #.")
			.addText((t) => t.setPlaceholder("impatient2, methods").setValue(v.tags.join(", ")).onChange((x) => (v.tags = parseTags(x))));
		const submit = () => {
			this.close();
			this.onSubmit(v);
		};
		if (this.options.showNote) {
			contentEl.createEl("div", { cls: "setting-item-name", text: "Note" });
			const note = contentEl.createEl("textarea", { cls: "scientific-article-card-note-input", attr: { rows: 6 } });
			note.value = v.note || "";
			note.addEventListener("input", () => (v.note = note.value));
			note.addEventListener("keydown", (e) => {
				if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
					e.preventDefault();
					submit();
				}
			});
		}
		if (this.options.hint) contentEl.createEl("p", { cls: "setting-item-description", text: this.options.hint });
		new Setting(contentEl)
			.addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()))
			.addButton((b) => b.setButtonText("Save").setCta().onClick(submit));
	}
	onClose() {
		this.contentEl.empty();
	}
}

/** Re-renders a card when the note it depends on (its paper note, or itself) changes. */
class CardRenderChild extends MarkdownRenderChild {
	constructor(el, plugin, render) {
		super(el);
		this.plugin = plugin;
		this.render = render;
		this.watchPath = null;
	}
	onload() {
		this.update();
		this.registerEvent(
			this.plugin.app.metadataCache.on("changed", (file) => {
				if (this.watchPath && file.path === this.watchPath) this.update();
			})
		);
	}
	update() {
		this.containerEl.empty();
		this.watchPath = this.render(this.containerEl) || null;
	}
}

/* ------------------------------------------------------------------ */
/* Plugin                                                              */
/* ------------------------------------------------------------------ */

class ScientificArticleCardPlugin extends Plugin {
	async onload() {
		await this.loadSettings();

		this.cards = new Set();
		this.registerMarkdownCodeBlockProcessor(CODE_BLOCK_LANG, (source, el, ctx) => {
			ctx.addChild(new CardRenderChild(el, this, (target) => this.renderPaperBlock(source, target, ctx, el)));
		});
		this.registerMarkdownCodeBlockProcessor(PAPER_NOTE_LANG, (source, el, ctx) => {
			ctx.addChild(new CardRenderChild(el, this, (target) => this.renderPaperNoteBlock(target, ctx)));
		});

		this.addCommand({
			id: "convert-selection-to-scientific-article-card",
			name: "Convert selection (or identifier under cursor) to article card",
			icon: "book-open",
			editorCallback: (editor) => this.convertSelection(editor),
		});
		this.addCommand({
			id: "create-paper-note",
			name: "Create paper note from PMID / DOI / URL…",
			icon: "file-plus",
			callback: () =>
				new IdentifierModal(this.app, (v) => {
					const ident = this.parse(v.split(/[\s,;]+/)[0], true);
					if (!ident) return new Notice("Scientific Article Card: no PMID, PMCID, DOI, arXiv ID or URL found");
					const active = this.app.workspace.getActiveFile();
					this.createPaperNote({ ident, card: null, sourcePath: active ? active.path : "", block: null });
				}).open(),
		});
		this.addCommand({
			id: "refresh-paper-metadata",
			name: "Refresh paper metadata",
			icon: "refresh-cw",
			checkCallback: (checking) => {
				const file = this.app.workspace.getActiveFile();
				const fm = file && (this.app.metadataCache.getFileCache(file) || {}).frontmatter;
				if (!fm || fm.type !== "paper") return false;
				if (!checking) this.refreshPaperNote(file);
				return true;
			},
		});
		this.addCommand({
			id: "create-papers-base",
			name: "Create Papers base (overview of paper notes)",
			icon: "table",
			callback: () => {
				const active = this.app.workspace.getActiveFile();
				this.createPapersBase(active ? active.path : "");
			},
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

	track(card) {
		if (!card) return;
		for (const c of this.cards) if (!c.isConnected) this.cards.delete(c);
		this.cards.add(card);
	}

	refreshColors() {
		for (const c of this.cards) {
			if (c.isConnected) applyColorClasses(c, this.settings);
			else this.cards.delete(c);
		}
	}

	/** A ```paper card. Returns the path of its linked paper note (watched for changes). */
	renderPaperBlock(source, target, ctx, sectionEl) {
		let d;
		try {
			d = parseYaml(source) || {};
		} catch (e) {
			target.createDiv({ cls: "scientific-article-card-error", text: `Scientific Article Card: invalid YAML — ${e.message}` });
			return null;
		}
		const linked = this.findLinkedNote(d, ctx.sourcePath);
		const block = { source, el: sectionEl, ctx };
		let actions;
		if (linked) {
			const fm = (this.app.metadataCache.getFileCache(linked) || {}).frontmatter || {};
			actions = {
				user: { status: fm.status, rating: fm.rating, tags: fm.tags, note: "" },
				note: { label: "Open note", icon: "file-text", onClick: () => this.app.workspace.getLeaf("tab").openFile(linked) },
				onEdit: () => this.editProperties(linked, d.title),
			};
		} else {
			actions = {
				note: {
					label: "Create note",
					icon: "file-plus",
					onClick: () => this.createPaperNote({ ident: identFromCard(d), card: d, sourcePath: ctx.sourcePath, block }),
				},
				onEdit: () => this.editNotes(source, sectionEl, ctx),
			};
		}
		this.track(renderCardData(d, target, this.settings, actions));
		return linked ? linked.path : null;
	}

	/** The ```paper-note card inside a paper note: drawn from the note's own properties. */
	renderPaperNoteBlock(target, ctx) {
		const file = this.app.vault.getAbstractFileByPath(ctx.sourcePath);
		const fm = file instanceof TFile ? (this.app.metadataCache.getFileCache(file) || {}).frontmatter : null;
		if (!fm || (!fm.title && !fm.url)) {
			target.createDiv({ cls: "scientific-article-card-error", text: "Scientific Article Card: this note has no paper properties (title, url…) yet." });
			return ctx.sourcePath;
		}
		this.track(
			renderCardData(fmToCard(fm, this.settings), target, this.settings, {
				note: { label: "Refresh metadata", icon: "refresh-cw", onClick: () => this.refreshPaperNote(file) },
				onEdit: () => this.editProperties(file, fm.title),
			})
		);
		return ctx.sourcePath;
	}

	/** The card's paper note: its `paper-note` link, or else a paper note with the same DOI / PMID. */
	findLinkedNote(d, sourcePath) {
		if (d["paper-note"]) {
			const f = this.app.metadataCache.getFirstLinkpathDest(linkpathFrom(d["paper-note"]), sourcePath);
			if (f) return f;
			// links inside code blocks aren't updated when a note is renamed: fall back to the identifiers
			return this.findPaperNote(d.doi, d.pmid);
		}
		return null;
	}

	findPaperNote(doi, pmid) {
		if (!doi && !pmid) return null;
		const d = doi ? String(doi).toLowerCase() : "";
		const p = pmid ? String(pmid) : "";
		for (const f of this.app.vault.getMarkdownFiles()) {
			const fm = (this.app.metadataCache.getFileCache(f) || {}).frontmatter;
			if (!fm || fm.type !== "paper") continue;
			if ((d && fm.doi && String(fm.doi).toLowerCase() === d) || (p && fm.pmid && String(fm.pmid) === p)) return f;
		}
		return null;
	}

	paperFolder(sourcePath) {
		if (this.settings.paperNoteLocation === "folder") return normalizePath(this.settings.paperNoteFolder || "/");
		const parent = sourcePath && sourcePath.includes("/") ? sourcePath.slice(0, sourcePath.lastIndexOf("/")) : "";
		return normalizePath([parent, this.settings.paperNoteSubfolder].filter(Boolean).join("/") || "/");
	}

	async ensureFolder(folder) {
		if (folder === "/" || this.app.vault.getAbstractFileByPath(folder)) return;
		try {
			await this.app.vault.createFolder(folder);
		} catch (e) {
			/* created meanwhile */
		}
	}

	/** base, then base+"a", base+"b"… for a different paper with the same author, journal and year. */
	uniquePath(folder, base) {
		const dir = folder === "/" ? "" : folder + "/";
		const letters = "abcdefghijklmnopqrstuvwxyz";
		for (let i = -1; i < letters.length; i++) {
			const path = normalizePath(`${dir}${base}${i < 0 ? "" : letters[i]}.md`);
			if (!this.app.vault.getAbstractFileByPath(path)) return path;
		}
		return normalizePath(`${dir}${base}_${Date.now()}.md`);
	}

	async createPaperNote({ ident, card, sourcePath, block }) {
		if (!ident && !card) return;
		let paper = null;
		if (ident) {
			try {
				paper = await new Resolver(this.settings).resolve(ident);
			} catch (e) {
				if (!card) return new Notice(`Scientific Article Card: ${e.message || e}`, 8000);
			}
		}
		if (!paper) paper = cardToPaper(card);
		const user = card
			? {
					status: STATUSES[card.status] ? card.status : "",
					rating: Math.max(0, Math.min(5, parseInt(card.rating, 10) || 0)),
					tags: parseTags(card.tags),
					note: card.note ? String(card.note) : "",
			  }
			: { status: "", rating: 0, tags: [], note: "" };

		let file = this.findPaperNote(paper.doi || (card && card.doi), paper.pmid || (card && card.pmid));
		if (file) {
			// already exists: merge the card's notes into it without overwriting anything
			await this.app.fileManager.processFrontMatter(file, (fm) => {
				if (!fm.status && user.status) fm.status = user.status;
				if (!fm.rating && user.rating) fm.rating = user.rating;
				const tags = parseTags(fm.tags);
				const add = user.tags.filter((t) => !tags.some((x) => x.toLowerCase() === t.toLowerCase()));
				if (add.length) fm.tags = tags.concat(add);
			});
			if (user.note.trim()) await this.app.vault.process(file, (text) => text.replace(/\s*$/, "") + "\n\n" + user.note.trim() + "\n");
		} else {
			const folder = this.paperFolder(sourcePath);
			await this.ensureFolder(folder);
			const path = this.uniquePath(folder, paperNoteBaseName(paper));
			file = await this.app.vault.create(path, paperNoteBody(paper.abstract, user.note));
			const props = paperProps(paper, user, this.settings);
			await this.app.fileManager.processFrontMatter(file, (fm) => Object.assign(fm, props));
		}

		if (block) {
			const link = this.app.fileManager.generateMarkdownLink(file, block.ctx.sourcePath);
			const ok = await this.rewriteCard(block, (lines) =>
				setFields(lines, { status: null, rating: null, tags: null, note: null, "paper-note": link })
			);
			if (!ok) new Notice(`Scientific Article Card: created ${file.basename}, but couldn't link the card to it.`);
		}
		await this.app.workspace.getLeaf("tab").openFile(file);
	}

	/** Fetch the article again and update the note's fetched properties only. */
	async refreshPaperNote(file) {
		const fm = (this.app.metadataCache.getFileCache(file) || {}).frontmatter || {};
		const ident = identFromCard(fm);
		if (!ident) return new Notice("Scientific Article Card: this note has no PMID, DOI, arXiv ID or URL to refresh from.");
		new Notice(`Scientific Article Card: refreshing ${file.basename}…`);
		let paper;
		try {
			paper = await new Resolver(this.settings).resolve(ident);
		} catch (e) {
			return new Notice(`Scientific Article Card: couldn't refresh ${file.basename} — ${e.message || e}`, 8000);
		}
		const fresh = paperProps(paper, {}, this.settings);
		let changed = [];
		await this.app.fileManager.processFrontMatter(file, (f) => {
			changed = refreshProps(f, fresh);
		});
		new Notice(
			changed.length
				? `Scientific Article Card: ${file.basename} updated (${changed.join(", ")}).`
				: `Scientific Article Card: ${file.basename} is up to date.`
		);
	}

	/** Create (or open) Papers.base in the papers folder. */
	async createPapersBase(sourcePath) {
		const folder = this.paperFolder(sourcePath);
		await this.ensureFolder(folder);
		const path = normalizePath((folder === "/" ? "" : folder + "/") + "Papers.base");
		let file = this.app.vault.getAbstractFileByPath(path);
		if (!(file instanceof TFile)) file = await this.app.vault.create(path, papersBase(folder));
		else new Notice("Scientific Article Card: opening the existing Papers base.");
		await this.app.workspace.getLeaf("tab").openFile(file);
	}

	/** Edit status, rating and tags of a paper note (its properties). */
	editProperties(file, title) {
		const fm = (this.app.metadataCache.getFileCache(file) || {}).frontmatter || {};
		const values = {
			status: STATUSES[fm.status] ? fm.status : "",
			rating: Math.max(0, Math.min(5, parseInt(fm.rating, 10) || 0)),
			tags: parseTags(fm.tags),
			note: "",
		};
		new NotesModal(
			this.app,
			title ? String(title) : file.basename,
			values,
			(v) =>
				this.app.fileManager.processFrontMatter(file, (f) => {
					if (v.status) f.status = v.status;
					else delete f.status;
					if (v.rating) f.rating = v.rating;
					else delete f.rating;
					if (v.tags.length) f.tags = v.tags;
					else delete f.tags;
				}),
			{ showNote: false, hint: `Saved as properties of ${file.basename}. Write your notes in the note itself.` }
		).open();
	}

	/** Rewrite the YAML lines of the card `block` in its note. Returns false if the card can't be found. */
	async rewriteCard(block, transform) {
		const { source, el, ctx } = block;
		const file = this.app.vault.getAbstractFileByPath(ctx.sourcePath);
		if (!(file instanceof TFile)) return false;
		const info = ctx.getSectionInfo(el);
		const hint = info ? info.lineStart : 0;
		// make sure pending edits in an open editor are on disk before rewriting the file
		for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
			if (leaf.view.file && leaf.view.file.path === file.path && typeof leaf.view.save === "function") await leaf.view.save();
		}
		let found = true;
		await this.app.vault.process(file, (text) => {
			const lines = text.split("\n");
			const found_ = findBlock(lines, source, hint);
			if (!found_) {
				found = false;
				return text;
			}
			const [start, end] = found_;
			lines.splice(start + 1, end - start - 1, ...transform(lines.slice(start + 1, end)));
			return lines.join("\n");
		});
		return found;
	}

	editNotes(source, el, ctx) {
		let d;
		try {
			d = parseYaml(source) || {};
		} catch (e) {
			new Notice("Scientific Article Card: fix the card's YAML before editing notes");
			return;
		}
		const values = {
			status: STATUSES[d.status] ? d.status : "",
			rating: Math.max(0, Math.min(5, parseInt(d.rating, 10) || 0)),
			tags: parseTags(d.tags),
			note: d.note == null ? "" : String(d.note),
		};
		new NotesModal(this.app, d.title ? String(d.title) : "", values, (v) => this.saveNotes(source, el, ctx, v)).open();
	}

	async saveNotes(source, el, ctx, v) {
		const file = this.app.vault.getAbstractFileByPath(ctx.sourcePath);
		if (!(file instanceof TFile)) return;
		const found = await this.rewriteCard({ source, el, ctx }, (lines) => setUserFields(lines, v));
		if (!found) {
			new Notice("Scientific Article Card: couldn't find this card in the note. Try again after it re-renders.");
			return;
		}
		if (this.settings.syncTags && v.tags.length) {
			// mirror card tags into the note's "tags" property so Obsidian indexes them
			await this.app.fileManager.processFrontMatter(file, (fm) => {
				const current = parseTags(fm.tags);
				const missing = v.tags.filter((t) => !current.some((c) => c.toLowerCase() === t.toLowerCase()));
				if (missing.length) fm.tags = current.concat(missing);
			});
		}
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
		toggle("Include keywords", "Author keywords (PubMed / Europe PMC / Crossref subjects). When an article has none, its MeSH terms are shown instead.", "includeKeywords");
		toggle("Include MeSH terms", "Always add MeSH terms, even when the article has author keywords.", "includeMesh");
		toggle("Fetch preview image", "Load the publisher page to grab its og:image. Some publishers block this; it is skipped silently.", "fetchImage");
		toggle("Expand abstract by default", "For the card view.", "abstractOpen");

		new Setting(containerEl).setName("Colors").setHeading();
		new Setting(containerEl)
			.setName("Card style")
			.setDesc("Mantine: white or dark card with a soft shadow. Match Obsidian theme: your theme's colors and font.")
			.addDropdown((dd) =>
				dd
					.addOption("mantine", "Mantine")
					.addOption("obsidian", "Match Obsidian theme")
					.setValue(s.cardStyle)
					.onChange(async (v) => {
						s.cardStyle = v;
						await save();
						this.plugin.refreshColors();
					})
			);
		const colorSetting = (name, key) =>
			new Setting(containerEl).setName(name).addDropdown((dd) => {
				for (const c of COLORS) dd.addOption(c, c === "accent" ? "Obsidian accent" : c.charAt(0).toUpperCase() + c.slice(1));
				dd.setValue(s[key]).onChange(async (v) => {
					s[key] = v;
					await save();
					this.plugin.refreshColors();
				});
			});
		colorSetting("Publication type color", "typeColor");
		colorSetting("Keyword color", "keywordColor");
		colorSetting("Tag and note color", "tagColor");

		new Setting(containerEl).setName("Paper notes").setHeading();
		new Setting(containerEl)
			.setName("Location")
			.setDesc("Where Create note puts the paper note. Existing paper notes (same DOI or PMID) are reused wherever they are.")
			.addDropdown((dd) =>
				dd
					.addOption("project", "Next to the note with the card")
					.addOption("folder", "In a dedicated folder")
					.setValue(s.paperNoteLocation)
					.onChange(async (v) => {
						s.paperNoteLocation = v;
						await save();
						this.display();
					})
			);
		if (s.paperNoteLocation === "folder") {
			new Setting(containerEl)
				.setName("Folder")
				.setDesc("Vault folder for all paper notes. Created if needed.")
				.addText((t) =>
					t
						.setPlaceholder("4_Resources/Papers")
						.setValue(s.paperNoteFolder)
						.onChange(async (v) => {
							s.paperNoteFolder = v.trim();
							await save();
						})
				);
		} else {
			new Setting(containerEl)
				.setName("Subfolder")
				.setDesc("Optional subfolder next to the note with the card, e.g. Papers. Leave empty for the same folder.")
				.addText((t) =>
					t
						.setPlaceholder("Papers")
						.setValue(s.paperNoteSubfolder)
						.onChange(async (v) => {
							s.paperNoteSubfolder = v.trim();
							await save();
						})
				);
		}

		new Setting(containerEl).setName("Your notes").setHeading();
		toggle(
			"Add card tags to the note's tags",
			"Tags inside a card aren't seen by Obsidian. When you save notes with tags, they are also added to the note's tags property, so the tag pane, search, Dataview and Bases find them. Removing a tag from a card doesn't remove it from the property.",
			"syncTags"
		);

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
module.exports._internals = { refreshProps, papersBase, FETCHED_PROPS, parseTags, setFields, setUserFields, findBlock, renderCard, renderCardData, paperNoteBaseName, paperProps, paperNoteBody, fmToCard, cardToPaper, identFromCard, linkpathFrom, colorClasses, toScript, parseIdentifier, cleanDoi, htmlToText, Resolver, toFields, toCodeBlock, fillTemplate, DEFAULT_SETTINGS };
