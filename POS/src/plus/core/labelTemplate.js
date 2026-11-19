// Copyright (c) 2026, pos_0001 contributors
// License: AGPL-3.0. See license.txt
//
// Label template renderer (SPEC F4). A POS Label Template body is Jinja; the server renders
// it with Jinja (trim_blocks, lstrip_blocks), the POS renders it here so labels print
// offline. Only a small part of Jinja is allowed, and both sides check the same rules
// (pos_next/pos_0001/labels.py `validate_body`):
//
//   {{ name }}                    value, escaped for the label language
//   {{ helper(arg, ...) }}        draw_barcode / draw_arabic / fit; args: numbers,
//                                 'strings' or value names
//   {% if name %} {% if not name %} {% elif name %} {% else %} {% endif %}
//
// Whitespace follows Jinja: one trailing newline of the body is dropped, block tags eat
// the newline after them, and spaces before a block tag at the start of a line go.

export const VARIABLES = Object.freeze([
	"item_code",
	"item_name",
	"item_name_ar",
	"barcode",
	"barcode_type",
	"uom",
	"price",
	"price_label",
	"currency",
	"company",
	"date",
	"weight",
	"qty",
	"width_mm",
	"height_mm",
	"width_dots",
	"height_dots",
	"gap_mm",
	"gap_dots",
	"dpi",
])
export const FUNCTIONS = Object.freeze(["draw_barcode", "draw_arabic", "fit"])

const IDENT = "[A-Za-z_][A-Za-z0-9_]*"
const ARG = `(?:-?\\d+(?:\\.\\d+)?|'[^'\\\\]*'|"[^"\\\\]*"|${IDENT})`
const EXPR_RE = new RegExp(
	`^\\s*(${IDENT})\\s*(?:\\(\\s*((?:${ARG})(?:\\s*,\\s*${ARG})*)?\\s*\\))?\\s*$`,
)
const ARG_RE = new RegExp(`\\s*(${ARG})\\s*(?:,|$)`, "g")
const COND_RE = new RegExp(`^\\s*(not\\s+)?(${IDENT})\\s*$`)
const TAG_RE = /\{\{([\s\S]*?)\}\}|\{%([\s\S]*?)%\}|\{#/g
const QTY_RE = /\bqty\b/

export class LabelTemplateError extends Error {
	/** @param {string} message */
	constructor(message) {
		super(message)
		this.name = "LabelTemplateError"
	}
}

/**
 * @typedef {{type: "text", text: string}
 *   | {type: "var", name: string}
 *   | {type: "call", name: string, args: Array<{kind: "num"|"str"|"var", value: any}>}
 *   | {type: "if", branches: Array<{neg: boolean, name: string|null, body: Node[]}>}} Node
 */

/** @param {string} raw @returns {{kind: "num"|"str"|"var", value: any}} */
function parseArg(raw) {
	if (/^-?\d/.test(raw)) return { kind: "num", value: Number(raw) }
	if (raw[0] === "'" || raw[0] === '"')
		return { kind: "str", value: raw.slice(1, -1) }
	return { kind: "var", value: raw }
}

/** @param {string} expr */
function parseExpr(expr) {
	const m = EXPR_RE.exec(expr)
	if (!m) throw new LabelTemplateError(`Unsupported expression: {{${expr}}}`)
	const name = m[1]
	if (expr.includes("(")) {
		if (!FUNCTIONS.includes(name))
			throw new LabelTemplateError(
				`Unknown helper ${name}(). Use draw_barcode(), draw_arabic() or fit().`,
			)
		const args = []
		for (const a of (m[2] || "").matchAll(ARG_RE)) {
			if (!a[1]) continue
			const arg = parseArg(a[1])
			if (arg.kind === "var" && !VARIABLES.includes(arg.value))
				throw new LabelTemplateError(`Unknown value ${arg.value} in ${name}().`)
			args.push(arg)
		}
		return /** @type {Node} */ ({ type: "call", name, args })
	}
	if (!VARIABLES.includes(name))
		throw new LabelTemplateError(`Unknown value {{ ${name} }}.`)
	return /** @type {Node} */ ({ type: "var", name })
}

/** @param {string} keyword @param {string} inner */
function parseCond(keyword, inner) {
	const m = COND_RE.exec(inner.trim().slice(keyword.length))
	if (!m)
		throw new LabelTemplateError(`Unsupported condition: {% ${inner.trim()} %}`)
	if (!VARIABLES.includes(m[2]))
		throw new LabelTemplateError(`Unknown value ${m[2]} in {% ${keyword} %}.`)
	return { neg: Boolean(m[1]), name: m[2] }
}

/**
 * Parse a body into nodes (throws LabelTemplateError outside the supported subset).
 * @param {string} body
 * @returns {Node[]}
 */
export function parseTemplate(body) {
	const lines = String(body ?? "").split(/\r\n|\r|\n/)
	if (lines.length && lines[lines.length - 1] === "") lines.pop()
	const src = lines.join("\n")
	/** @type {Node[]} */
	const root = []
	/** @type {Array<{node: any, branch: any}>} */
	const stack = []
	const current = () =>
		stack.length ? stack[stack.length - 1].branch.body : root
	let pos = 0
	let lineStarting = true
	TAG_RE.lastIndex = 0
	for (let m = TAG_RE.exec(src); m; m = TAG_RE.exec(src)) {
		if (m[0] === "{#")
			throw new LabelTemplateError(
				"Comments ({# #}) are not supported in label templates.",
			)
		const isBlock = m[2] !== undefined
		const inner = isBlock ? m[2] : m[1]
		if (/^[-+]/.test(inner) || /[-+]$/.test(inner))
			throw new LabelTemplateError(
				"Whitespace control (- or +) is not supported in label templates.",
			)
		let text = src.slice(pos, m.index)
		if (isBlock) {
			const lpos = text.lastIndexOf("\n") + 1
			if ((lpos > 0 || lineStarting) && /^\s+$/.test(text.slice(lpos)))
				text = text.slice(0, lpos)
		}
		if (text) current().push({ type: "text", text })
		pos = m.index + m[0].length
		lineStarting = false
		if (!isBlock) {
			current().push(parseExpr(inner))
			continue
		}
		if (src[pos] === "\n") {
			pos += 1
			lineStarting = true
		}
		TAG_RE.lastIndex = pos
		const words = inner.trim().split(/\s+/)
		const keyword = words[0] || ""
		if (keyword === "if") {
			const node = {
				type: "if",
				branches: [{ ...parseCond("if", inner), body: [] }],
			}
			current().push(/** @type {Node} */ (node))
			stack.push({ node, branch: node.branches[0] })
		} else if (keyword === "elif") {
			if (!stack.length)
				throw new LabelTemplateError("{% elif %} without {% if %}.")
			const top = stack[stack.length - 1]
			const branch = { ...parseCond("elif", inner), body: [] }
			top.node.branches.push(branch)
			top.branch = branch
		} else if (keyword === "else" && words.length === 1) {
			if (!stack.length)
				throw new LabelTemplateError("{% else %} without {% if %}.")
			const top = stack[stack.length - 1]
			const branch = { neg: false, name: null, body: [] }
			top.node.branches.push(branch)
			top.branch = branch
		} else if (keyword === "endif" && words.length === 1) {
			if (!stack.length)
				throw new LabelTemplateError("{% endif %} without {% if %}.")
			stack.pop()
		} else {
			throw new LabelTemplateError(`Unsupported tag: {% ${inner.trim()} %}`)
		}
	}
	const rest = src.slice(pos)
	if (/\{\{|\{%|\}\}|%\}/.test(src.replace(TAG_RE, "")))
		throw new LabelTemplateError("Unclosed {{ or {% in the template.")
	if (stack.length)
		throw new LabelTemplateError("{% if %} without {% endif %}.")
	if (rest) current().push({ type: "text", text: rest })
	return root
}

/**
 * Check a body; returns null when fine, else the error message.
 * @param {string} body
 * @returns {string|null}
 */
export function templateError(body) {
	try {
		parseTemplate(body)
		return null
	} catch (error) {
		return String(error?.message || error)
	}
}

/**
 * Templates that print their own copies ({{ qty }}) are rendered once per row.
 * @param {string} body
 */
export function usesQty(body) {
	TAG_RE.lastIndex = 0
	for (const m of String(body ?? "").matchAll(TAG_RE)) {
		const inner = m[1] ?? m[2] ?? ""
		if (QTY_RE.test(inner)) return true
	}
	return false
}

/**
 * Render parsed nodes.
 * @param {Node[]} nodes
 * @param {Record<string, any>} ctx values
 * @param {{escape: (value: any) => string, helpers: Record<string, (...args: any[]) => string>}} env
 * @returns {string}
 */
export function renderNodes(nodes, ctx, env) {
	let out = ""
	for (const node of nodes) {
		if (node.type === "text") out += node.text
		else if (node.type === "var") out += env.escape(ctx[node.name])
		else if (node.type === "call") {
			const args = node.args.map((a) =>
				a.kind === "var" ? ctx[a.value] : a.value,
			)
			out += env.helpers[node.name](...args)
		} else if (node.type === "if") {
			for (const branch of node.branches) {
				const ok =
					branch.name === null ||
					(branch.neg ? !truthy(ctx[branch.name]) : truthy(ctx[branch.name]))
				if (ok) {
					out += renderNodes(branch.body, ctx, env)
					break
				}
			}
		}
	}
	return out
}

/** Python truthiness for the values a label uses (strings and numbers). */
function truthy(value) {
	return Boolean(value)
}
