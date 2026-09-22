"use strict";
/* Paste detection reads the text inserted into the note (no clipboard access). */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { EditorState } = require("@codemirror/state");
const env = require("./helpers/env");
const { createApp } = require("./helpers/fake-app");

async function setup() {
	const { app } = createApp();
	const plugin = await env.loadPlugin(app);
	const calls = [];
	plugin.convertIdentifiers = (editor, idents, range) => calls.push({ id: idents[0].type + ":" + (idents[0].id || idents[0].url), range: [range.from.off, range.to.off] });
	return { plugin, calls };
}

function update(plugin, steps, { pending = false } = {}) {
	const editor = {};
	let state = EditorState.create({ doc: "Notes: \n", extensions: [env.editorInfoField.init(() => ({ editor }))] });
	const transactions = [];
	for (const s of steps) {
		const tr = state.update(s);
		transactions.push(tr);
		state = tr.state;
	}
	editor.offsetToPos = (off) => ({ off });
	editor.getRange = (a, b) => state.doc.sliceString(a.off, b.off);
	plugin.pendingPaste = pending ? { editor, at: Date.now() } : null;
	plugin.onEditorUpdate({ docChanged: true, state, view: {}, transactions });
	return new Promise((r) => setTimeout(r, 5));
}

const paste = (text, extra = {}) => ({ changes: { from: 7, insert: text }, userEvent: "input.paste", ...extra });

test("pasted identifiers become cards", async () => {
	const { plugin, calls } = await setup();
	await update(plugin, [paste("PMID: 34265844")]);
	await update(plugin, [paste("https://doi.org/10.1038/s41586-021-03819-2")]);
	await update(plugin, [paste("PMC8371605")]);
	assert.deepEqual(calls, [
		{ id: "pmid:34265844", range: [7, 21] },
		{ id: "doi:10.1038/s41586-021-03819-2", range: [7, 49] },
		{ id: "pmcid:PMC8371605", range: [7, 17] },
	]);
});

test("pastes that are left alone", async () => {
	const { plugin, calls } = await setup();
	await update(plugin, [paste("https://github.com/foo")]); // not scholarly
	await update(plugin, [paste("34265844")]); // bare number (setting off)
	await update(plugin, [paste("PMID: 1\nPMID: 2")]); // multi-line
	await update(plugin, [{ changes: { from: 0, to: 5, insert: "[Notes](https://pubmed.ncbi.nlm.nih.gov/1/)" }, userEvent: "input.paste" }]); // over a selection
	await update(plugin, [{ changes: { from: 7, insert: "10.1038/x" }, userEvent: "input.type" }]); // typing
	await update(plugin, [{ changes: { from: 7, insert: "[Fetching Data#abc](https://pubmed.ncbi.nlm.nih.gov/1/)" } }], { pending: true }); // Auto Card Link placeholder
	assert.deepEqual(calls, []);
});

test("Obsidian-inserted pastes (no input.paste event) are caught through editor-paste", async () => {
	const { plugin, calls } = await setup();
	await update(plugin, [{ changes: { from: 7, insert: "PMC8371605" } }], { pending: true });
	assert.deepEqual(calls, [{ id: "pmcid:PMC8371605", range: [7, 17] }]);
});

test("positions are mapped through later edits", async () => {
	const { plugin, calls } = await setup();
	await update(plugin, [paste("arXiv:1706.03762"), { changes: { from: 0, insert: ">> " } }]);
	assert.deepEqual(calls, [{ id: "arxiv:1706.03762", range: [10, 26] }]);
});

test("settings: paste enhancement off, bare PMIDs on", async () => {
	const { plugin, calls } = await setup();
	plugin.settings.enhancePaste = false;
	await update(plugin, [paste("PMID: 34265844")]);
	plugin.settings.enhancePaste = true;
	plugin.settings.pasteBarePmid = true;
	await update(plugin, [paste("34265844")]);
	assert.deepEqual(calls, [{ id: "pmid:34265844", range: [7, 15] }]);
});

test("the plugin never lists the whole vault (community review: vault enumeration)", () => {
	const src = fs.readFileSync(path.join(__dirname, "..", "main.js"), "utf8");
	assert.doesNotMatch(src, /getMarkdownFiles|getFiles\(|getAllLoadedFiles/);
});

test("the plugin never touches the system clipboard", () => {
	const src = fs.readFileSync(path.join(__dirname, "..", "main.js"), "utf8");
	assert.doesNotMatch(src, /clipboard/i);
});
