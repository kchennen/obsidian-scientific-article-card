"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { I } = require("./helpers/env");

const css = fs.readFileSync(path.join(__dirname, "..", "styles.css"), "utf8");
const block = (selector) => {
	const i = css.indexOf(selector + " {");
	assert.notEqual(i, -1, `missing rule ${selector}`);
	return css.slice(i, css.indexOf("}", i));
};

test("every --sac-* variable used is defined", () => {
	const used = new Set([...css.matchAll(/var\((--sac-[\w-]+)\)/g)].map((m) => m[1]));
	const defined = new Set([...css.matchAll(/(--sac-[\w-]+)\s*:/g)].map((m) => m[1]));
	const missing = [...used].filter((v) => !defined.has(v));
	assert.deepEqual(missing, []);
});

test("every palette color has light and dark values, and a class for each role", () => {
	const light = block(".scientific-article-card");
	const dark = block(".theme-dark .scientific-article-card");
	for (const c of I.COLORS.filter((c) => c !== "accent")) {
		assert.match(light, new RegExp(`--sac-${c}-fg:`), `${c} light`);
		assert.match(dark, new RegExp(`--sac-${c}-fg:`), `${c} dark`);
	}
	for (const role of ["type", "kw", "tag"]) for (const c of I.COLORS) assert.ok(css.includes(`.sac-${role}-${c} {`), `.sac-${role}-${c}`);
});

test("layout guarantees: image on the left, narrow cards keep it and shrink it", () => {
	assert.match(block(".scientific-article-card-thumb"), /order: -1/);
	assert.match(css, /@container scientific-article-card \(max-width: 520px\)/);
	assert.match(block(".scientific-article-card-keyword"), /--b-bg: var\(--sac-kw-bg\)/);
	assert.match(block(".scientific-article-card-badge,\n.scientific-article-card-keyword,\n.scientific-article-card-tag,\n.scientific-article-card-status"), /background: var\(--b-bg\)/);
	assert.doesNotMatch(block(".scientific-article-card-badge,\n.scientific-article-card-keyword,\n.scientific-article-card-tag,\n.scientific-article-card-status"), /text-transform/, "no uppercase unless the setting asks");
});

test("every badge option has CSS: variants, sizes, radii, uppercase modes", () => {
	for (const v of I.BADGE_VARIANTS.filter((v) => v !== "light")) assert.ok(css.includes(`.sac-badge-${v} :is(`), `variant ${v}`);
	for (const z of I.SIZES) {
		assert.ok(css.includes(`.scientific-article-card.sac-badge-size-${z} {`), `size ${z}`);
		assert.ok(css.includes(`.scientific-article-card.sac-badge-radius-${z} {`), `radius ${z}`);
	}
	assert.match(css, /\.sac-tt-type \.scientific-article-card-badge,\n\.sac-tt-all :is\(/);
	for (const c of I.COLORS.filter((c) => c !== "accent")) assert.match(block(".scientific-article-card"), new RegExp(`--sac-${c}-solid:`), `${c} solid`);
});
