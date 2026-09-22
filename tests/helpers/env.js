/**
 * Test environment: a DOM (jsdom) with Obsidian's element helpers, a stand-in for the "obsidian"
 * module, and the plugin loaded through it. Requiring this file once per test process is enough.
 */
"use strict";
const Module = require("module");
const path = require("path");
const { JSDOM } = require("jsdom");
const yaml = require("js-yaml");
const { StateField } = require("@codemirror/state");

const dom = new JSDOM("<!doctype html><body></body>");
const w = dom.window;
global.window = w;
global.document = w.document;
global.DOMParser = w.DOMParser;
global.HTMLElement = w.HTMLElement;
global.navigator = { onLine: true };

// Obsidian's HTMLElement helpers
const H = w.HTMLElement.prototype;
H.createEl = function (tag, o = {}) {
	const e = w.document.createElement(tag);
	if (o.cls) e.className = [].concat(o.cls).join(" ");
	if (o.text) e.textContent = o.text;
	if (o.href) e.href = o.href;
	for (const [k, v] of Object.entries(o.attr || {})) e.setAttribute(k, v);
	this.appendChild(e);
	return e;
};
H.createDiv = function (o) {
	return this.createEl("div", o);
};
H.createSpan = function (o) {
	return this.createEl("span", o);
};
H.setAttr = function (k, v) {
	this.setAttribute(k, v);
};
H.appendText = function (t) {
	this.append(t);
};
H.setText = function (t) {
	this.textContent = t;
};
H.empty = function () {
	this.innerHTML = "";
};

const notices = [];
let lastModal = null;
let network = async () => {
	throw new Error("network not configured");
};

class Component {
	constructor() {
		this._loaded = false;
	}
	load() {
		this._loaded = true;
		if (this.onload) this.onload();
	}
	registerEvent() {}
	registerDomEvent() {}
}

class Plugin extends Component {
	constructor() {
		super();
		this.processors = {};
		this.commands = {};
		this.extensions = [];
		this.savedData = null;
	}
	registerMarkdownCodeBlockProcessor(lang, fn) {
		this.processors[lang] = fn;
	}
	addCommand(c) {
		this.commands[c.id] = c;
	}
	registerEditorExtension(e) {
		this.extensions.push(e);
	}
	addSettingTab() {}
	async loadData() {
		return this.savedData;
	}
	async saveData(d) {
		this.savedData = d;
	}
}

class MarkdownRenderChild extends Component {
	constructor(el) {
		super();
		this.containerEl = el;
	}
}

class Modal {
	constructor(app) {
		this.app = app;
	}
	open() {
		lastModal = this;
	}
	close() {}
}

class TFile {
	constructor(p) {
		this.path = p;
		this.extension = p.split(".").pop();
		this.basename = p.split("/").pop().replace(/\.[^.]+$/, "");
	}
}

const editorInfoField = StateField.define({ create: () => null, update: (v) => v });

const obsidianStub = {
	Plugin,
	PluginSettingTab: class {},
	Setting: class {},
	Notice: class {
		constructor(m) {
			notices.push(String(m));
		}
	},
	Modal,
	MarkdownView: class {},
	MarkdownRenderChild,
	TFile,
	editorInfoField,
	parseYaml: (s) => yaml.load(s),
	normalizePath: (p) => {
		const n = String(p).replace(/ /g, " ").replace(/[\\/]+/g, "/").replace(/^\/|\/$/g, "");
		return n || "/";
	},
	setIcon: (el, name) => el.setAttribute("data-icon", name),
	requestUrl: (req) => network(req),
};

const originalLoad = Module._load;
Module._load = function (request, ...rest) {
	if (request === "obsidian") return obsidianStub;
	return originalLoad.call(this, request, ...rest);
};

const Plugin_ = require(path.join(__dirname, "..", "..", "main.js"));
const I = Plugin_._internals;

module.exports = {
	window: w,
	document: w.document,
	yaml,
	obsidian: obsidianStub,
	PluginClass: Plugin_,
	I,
	TFile,
	editorInfoField,
	notices,
	lastModal: () => lastModal,
	setNetwork(fn) {
		network = fn;
	},
	/** Plugin with default settings, loaded (commands and processors registered) on `app`. */
	async loadPlugin(app, settings = {}) {
		const plugin = new Plugin_();
		plugin.app = app;
		plugin.savedData = settings;
		await plugin.onload();
		return plugin;
	},
	/** A detached element attached to the document (so isConnected is true). */
	mount() {
		const el = w.document.createElement("div");
		w.document.body.appendChild(el);
		return el;
	},
};
