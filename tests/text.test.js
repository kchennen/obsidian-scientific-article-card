"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { I } = require("./helpers/env");

test("superscripts and subscripts become Unicode (no 'effort1-4')", () => {
	assert.equal(I.htmlToText("effort<sup>1-4</sup>, H<sub>2</sub>O, Ca<sup>2+</sup>, 10<sup>5</sup> cm<sup>2</sup>"), "effort¹⁻⁴, H₂O, Ca²⁺, 10⁵ cm²");
	assert.equal(I.htmlToText("x<sup>ab</sup>"), "xab"); // letters without a superscript form stay plain
	assert.equal(I.toScript("6,7", { 6: "⁶", 7: "⁷", ",": "," }), "⁶,⁷");
});

test("structured abstracts keep section labels", () => {
	const t = I.htmlToText("<h4>Background</h4><p>Foo.</p><h4>Results</h4><p>Bar.</p>");
	assert.equal(t, "Background: Foo.\n\nResults: Bar.");
});

test("JATS abstracts (Crossref) drop the 'Abstract' title and entities", () => {
	const t = I.htmlToText("<jats:title>Abstract</jats:title><jats:p>Fast &amp; accurate.</jats:p>");
	assert.equal(t, "Fast & accurate.");
	assert.equal(I.htmlToText("<h4>ABSTRACT</h4>Development of vaccines."), "Development of vaccines.");
});
