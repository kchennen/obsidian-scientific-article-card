/**
 * In-memory stand-in for the parts of Obsidian's App the plugin uses: vault, metadata cache (frontmatter
 * parsed from the file text), file manager (processFrontMatter, links) and workspace.
 */
"use strict";
const yaml = require("yaml");
const { TFile } = require("./env");

function frontmatterOf(text) {
	const m = text.match(/^---\n([\s\S]*?)\n---\n?/);
	return m ? yaml.parse(m[1]) || {} : null;
}

function createApp(initialFiles = {}) {
	const files = new Map();
	const folders = new Set();
	const listeners = [];
	const opened = [];
	const changed = (file) => listeners.forEach((fn) => fn(file));
	const add = (p, text) => {
		const file = new TFile(p);
		files.set(p, { file, text });
		const dir = p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "";
		if (dir) folders.add(dir);
		return file;
	};
	for (const [p, text] of Object.entries(initialFiles)) add(p, text);
	/** A folder with its direct children, like Obsidian's TFolder. */
	const folder = (p) => ({
		path: p,
		get children() {
			return [...files.values()].map((f) => f.file).filter((f) => {
				const dir = f.path.includes("/") ? f.path.slice(0, f.path.lastIndexOf("/")) : "/";
				return dir === p;
			});
		},
	});

	const app = {
		vault: {
			getAbstractFileByPath: (p) => (files.has(p) ? files.get(p).file : folders.has(p) ? folder(p) : null),
			getRoot: () => folder("/"),
			// the plugin must never list the whole vault (community review "vault enumeration")
			getMarkdownFiles: () => {
				throw new Error("vault enumeration: getMarkdownFiles() called");
			},
			getFiles: () => {
				throw new Error("vault enumeration: getFiles() called");
			},
			create: async (p, text) => {
				if (files.has(p)) throw new Error("File already exists: " + p);
				const f = add(p, text);
				changed(f);
				return f;
			},
			createFolder: async (p) => {
				folders.add(p);
			},
			read: async (f) => files.get(f.path).text,
			process: async (f, fn) => {
				const e = files.get(f.path);
				e.text = fn(e.text);
				changed(f);
				return e.text;
			},
		},
		metadataCache: {
			getFileCache: (f) => (files.has(f.path) ? { frontmatter: frontmatterOf(files.get(f.path).text) || undefined } : null),
			getFirstLinkpathDest: (lp) => {
				for (const { file } of files.values()) if (file.basename === lp || file.path === lp || file.path === lp + ".md") return file;
				return null;
			},
			fileToLinktext: (f) => f.basename,
			on: (ev, fn) => {
				if (ev === "changed") listeners.push(fn);
				return {};
			},
		},
		fileManager: {
			processFrontMatter: async (f, fn) => {
				const e = files.get(f.path);
				const fm = frontmatterOf(e.text) || {};
				const body = e.text.replace(/^---\n[\s\S]*?\n---\n?/, "");
				fn(fm);
				e.text = "---\n" + yaml.stringify(fm, { lineWidth: 0 }) + "---\n" + body;
				changed(f);
			},
			generateMarkdownLink: (f) => `[[${f.basename}]]`,
		},
		workspace: {
			getLeavesOfType: () => [],
			getLeaf: () => ({ openFile: async (f) => opened.push(f.path) }),
			getActiveFile: () => app._active || null,
			getActiveViewOfType: () => null,
			on: () => ({}),
		},
	};

	return {
		app,
		files,
		opened,
		text: (p) => files.get(p).text,
		frontmatter: (p) => frontmatterOf(files.get(p).text),
		file: (p) => files.get(p).file,
		rename(oldPath, newPath) {
			const e = files.get(oldPath);
			files.delete(oldPath);
			e.file.path = newPath;
			e.file.basename = newPath.split("/").pop().replace(/\.[^.]+$/, "");
			files.set(newPath, e);
		},
		setActive(p) {
			app._active = p ? files.get(p).file : null;
		},
	};
}

module.exports = { createApp, frontmatterOf };
