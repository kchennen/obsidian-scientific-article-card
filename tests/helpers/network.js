/**
 * Replays recorded API responses (tests/fixtures/manifest.json) so tests never touch the network.
 * Unknown URLs answer 404, which is how blocked publisher pages behave too.
 * Re-record with `npm run record-fixtures`.
 */
"use strict";
const fs = require("fs");
const path = require("path");

const DIR = path.join(__dirname, "..", "fixtures");
const manifest = JSON.parse(fs.readFileSync(path.join(DIR, "manifest.json"), "utf8"));

/** Drop parameters that don't change the answer (tool name, contact email, API key). */
function normalise(url) {
	return url.replace(/&tool=[^&]*/g, "").replace(/&email=[^&]*/g, "").replace(/&api_key=[^&]*/g, "").replace(/\?mailto=[^&]*/g, "");
}

function replay(extra = {}) {
	const requested = [];
	const handler = async ({ url }) => {
		const key = normalise(url);
		requested.push(key);
		const hit = extra[key] || manifest[key];
		if (!hit) return { status: 404, text: "Not found", json: null };
		const text = hit.body != null ? hit.body : fs.readFileSync(path.join(DIR, hit.file), "utf8");
		return {
			status: hit.status || 200,
			text,
			get json() {
				return JSON.parse(text);
			},
		};
	};
	handler.requested = requested;
	return handler;
}

module.exports = { replay, normalise, manifest };
