/**
 * Records the scholarly API responses used by the tests into this folder (manifest.json + files).
 * Run with `npm run record-fixtures` when an API changes format. Publisher pages are not recorded
 * (answered 404), like the many publishers that block automated requests.
 */
"use strict";
const fs = require("fs");
const path = require("path");
const env = require("../helpers/env");
const { normalise } = { normalise: (u) => u.replace(/&tool=[^&]*/g, "").replace(/&email=[^&]*/g, "").replace(/&api_key=[^&]*/g, "").replace(/\?mailto=[^&]*/g, "") };

const API = /^https:\/\/(eutils\.ncbi\.nlm\.nih\.gov|www\.ebi\.ac\.uk|api\.crossref\.org|export\.arxiv\.org|pmc-oa-opendata\.s3\.amazonaws\.com)\//;
const INPUTS = ["PMID: 34265844", "PMID: 38520562", "PMID: 33308477", "PMC8371605", "10.1371/journal.pone.0012345", "10.1101/2023.01.02.522505", "10.1145/3292500.3330701", "arXiv:1706.03762"];

/** Keep only what the plugin reads, to keep fixtures small. */
function trim(url, text) {
	if (/efetch\.fcgi/.test(url)) return text.replace(/<ReferenceList>[\s\S]*?<\/ReferenceList>/g, "");
	if (/pmc-oa-opendata.*\.xml$/.test(url)) {
		const parts = text.match(/<(fig|disp-formula|inline-formula)\b[\s\S]*?<\/\1>/g) || [];
		return '<?xml version="1.0"?>\n<article xmlns:xlink="http://www.w3.org/1999/xlink"><body>\n' + parts.join("\n") + "\n</body></article>\n";
	}
	return text;
}

(async () => {
	const manifest = {};
	let n = 0;
	env.setNetwork(async ({ url, headers }) => {
		if (!API.test(url)) return { status: 404, text: "Not found", json: null };
		const res = await fetch(url, { headers: { "User-Agent": "obsidian-scientific-article-card-tests", ...(headers || {}) } });
		let text = await res.text();
		const key = normalise(url);
		text = trim(key, text);
		const ext = /json|crossref|europepmc/.test(key) && !/\.xml$/.test(key) ? "json" : "xml";
		const file = `r${String(++n).padStart(2, "0")}.${ext}`;
		fs.writeFileSync(path.join(__dirname, file), text);
		manifest[key] = { status: res.status, file };
		return { status: res.status, text, get json() { return JSON.parse(text); } };
	});
	const { I } = env;
	for (const input of INPUTS) {
		const ident = I.parseIdentifier(input, { allowBare: true });
		try {
			const p = await new I.Resolver(I.DEFAULT_SETTINGS).resolve(ident);
			console.log("recorded", input, "→", p.title.slice(0, 50), "| image:", p.image ? p.image.split("/").pop() : "-");
		} catch (e) {
			console.log("recorded", input, "→ error:", e.message);
		}
	}
	fs.writeFileSync(path.join(__dirname, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
	console.log(Object.keys(manifest).length, "responses recorded");
})();
