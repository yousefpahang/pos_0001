// Copyright (c) 2026, pos_0001 contributors
// License: AGPL-3.0. See license.txt
//
// Small QR code encoder (ISO/IEC 18004): byte mode, error correction level M,
// versions 1-10 (up to 213 bytes). Used to draw the receipt barcode into raster
// receipts when the value is too long for a readable Code128 (offline receipt ids).
// Plain JavaScript, no dependencies.

// Per version (index 1-10), level M: [ecCodewordsPerBlock, [blocks, dataCodewords], ...groups]
const M_BLOCKS = [
	null,
	[10, [1, 16]],
	[16, [1, 28]],
	[26, [1, 44]],
	[18, [2, 32]],
	[24, [2, 43]],
	[16, [4, 27]],
	[18, [4, 31]],
	[22, [2, 38], [2, 39]],
	[22, [3, 36], [2, 37]],
	[26, [4, 43], [1, 44]],
]

const ALIGNMENT = [
	null,
	[],
	[6, 18],
	[6, 22],
	[6, 26],
	[6, 30],
	[6, 34],
	[6, 22, 38],
	[6, 24, 42],
	[6, 26, 46],
	[6, 28, 50],
]

export const MAX_VERSION = 10

// --- GF(256) arithmetic, polynomial 0x11d ---
const EXP = new Uint8Array(512)
const LOG = new Uint8Array(256)
{
	let x = 1
	for (let i = 0; i < 255; i++) {
		EXP[i] = x
		LOG[x] = i
		x <<= 1
		if (x & 0x100) x ^= 0x11d
	}
	for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255]
}

/** @param {number} a @param {number} b */
function gfMul(a, b) {
	if (a === 0 || b === 0) return 0
	return EXP[LOG[a] + LOG[b]]
}

/** @param {number} degree */
function generatorPoly(degree) {
	let poly = [1]
	for (let i = 0; i < degree; i++) {
		const next = new Array(poly.length + 1).fill(0)
		for (let j = 0; j < poly.length; j++) {
			next[j] ^= poly[j]
			next[j + 1] ^= gfMul(poly[j], EXP[i])
		}
		poly = next
	}
	return poly
}

/**
 * Reed-Solomon error correction codewords.
 * @param {number[]} data
 * @param {number} ecCount
 * @returns {number[]}
 */
export function reedSolomon(data, ecCount) {
	const gen = generatorPoly(ecCount)
	const res = new Array(ecCount).fill(0)
	for (const d of data) {
		const factor = d ^ res[0]
		res.shift()
		res.push(0)
		for (let i = 0; i < ecCount; i++) res[i] ^= gfMul(gen[i + 1], factor)
	}
	return res
}

/** @param {number} version */
function dataCapacity(version) {
	const [, ...groups] = M_BLOCKS[version]
	return groups.reduce((n, [blocks, words]) => n + blocks * words, 0)
}

/** @param {number} version */
function countBits(version) {
	return version < 10 ? 8 : 16
}

/**
 * Smallest version that holds the bytes at level M.
 * @param {number} byteLength
 */
export function chooseVersion(byteLength) {
	for (let v = 1; v <= MAX_VERSION; v++) {
		const bits = 4 + countBits(v) + 8 * byteLength
		if (bits <= dataCapacity(v) * 8) return v
	}
	throw new Error("QR value too long")
}

/** @param {string} text */
function utf8(text) {
	return Array.from(new TextEncoder().encode(String(text ?? "")))
}

/**
 * Data + error correction codewords, interleaved.
 * @param {number[]} bytes
 * @param {number} version
 */
function codewords(bytes, version) {
	const capacity = dataCapacity(version)
	/** @type {number[]} */
	const bits = []
	const put = (value, length) => {
		for (let i = length - 1; i >= 0; i--) bits.push((value >>> i) & 1)
	}
	put(0b0100, 4)
	put(bytes.length, countBits(version))
	for (const b of bytes) put(b, 8)
	put(0, Math.min(4, capacity * 8 - bits.length))
	while (bits.length % 8) bits.push(0)
	/** @type {number[]} */
	const data = []
	for (let i = 0; i < bits.length; i += 8) {
		let v = 0
		for (let j = 0; j < 8; j++) v = (v << 1) | bits[i + j]
		data.push(v)
	}
	for (let pad = 0xec; data.length < capacity; pad = pad === 0xec ? 0x11 : 0xec)
		data.push(pad)

	const [ecCount, ...groups] = M_BLOCKS[version]
	/** @type {number[][]} */
	const dataBlocks = []
	/** @type {number[][]} */
	const ecBlocks = []
	let offset = 0
	for (const [blocks, words] of groups) {
		for (let b = 0; b < blocks; b++) {
			const block = data.slice(offset, offset + words)
			offset += words
			dataBlocks.push(block)
			ecBlocks.push(reedSolomon(block, ecCount))
		}
	}
	/** @type {number[]} */
	const out = []
	const maxWords = Math.max(...dataBlocks.map((b) => b.length))
	for (let i = 0; i < maxWords; i++) {
		for (const block of dataBlocks) if (i < block.length) out.push(block[i])
	}
	for (let i = 0; i < ecCount; i++) {
		for (const block of ecBlocks) out.push(block[i])
	}
	return out
}

/** BCH remainder of value (already shifted) by generator. */
function bch(value, generator) {
	const genLen = Math.floor(Math.log2(generator))
	let v = value
	while (v >= 1 << genLen) {
		v ^= generator << (Math.floor(Math.log2(v)) - genLen)
	}
	return v
}

/** 15-bit format information for level M and a mask. @param {number} mask */
export function formatBits(mask) {
	const data = (0b00 << 3) | mask // level M = 00
	return ((data << 10) | bch(data << 10, 0x537)) ^ 0x5412
}

/** @param {number} version */
function versionBits(version) {
	return (version << 12) | bch(version << 12, 0x1f25)
}

const MASKS = [
	(r, c) => (r + c) % 2 === 0,
	(r) => r % 2 === 0,
	(_r, c) => c % 3 === 0,
	(r, c) => (r + c) % 3 === 0,
	(r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
	(r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
	(r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
	(r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
]

/**
 * @param {number} version
 */
function baseMatrix(version) {
	const size = version * 4 + 17
	/** @type {number[][]} 0/1 module colour */
	const m = Array.from({ length: size }, () => new Array(size).fill(0))
	/** @type {boolean[][]} true where a function pattern sits */
	const fixed = Array.from({ length: size }, () => new Array(size).fill(false))
	const set = (r, c, dark) => {
		m[r][c] = dark ? 1 : 0
		fixed[r][c] = true
	}
	const finder = (row, col) => {
		for (let r = -1; r <= 7; r++) {
			for (let c = -1; c <= 7; c++) {
				const rr = row + r
				const cc = col + c
				if (rr < 0 || cc < 0 || rr >= size || cc >= size) continue
				const ring = Math.max(Math.abs(r - 3), Math.abs(c - 3))
				set(rr, cc, ring !== 2 && ring !== 4)
			}
		}
	}
	for (let i = 0; i < size; i++) {
		set(6, i, i % 2 === 0)
		set(i, 6, i % 2 === 0)
	}
	finder(0, 0)
	finder(0, size - 7)
	finder(size - 7, 0)
	const align = ALIGNMENT[version]
	const last = align.length - 1
	for (let ai = 0; ai < align.length; ai++) {
		for (let aj = 0; aj < align.length; aj++) {
			// The three corners hold finder patterns.
			if (
				(ai === 0 && aj === 0) ||
				(ai === 0 && aj === last) ||
				(ai === last && aj === 0)
			)
				continue
			const r = align[ai]
			const c = align[aj]
			for (let dr = -2; dr <= 2; dr++) {
				for (let dc = -2; dc <= 2; dc++) {
					set(r + dr, c + dc, Math.max(Math.abs(dr), Math.abs(dc)) !== 1)
				}
			}
		}
	}
	// Dark module and reserved format areas.
	set(size - 8, 8, true)
	for (let i = 0; i < 9; i++) {
		if (!fixed[8][i]) set(8, i, false)
		if (!fixed[i][8]) set(i, 8, false)
	}
	for (let i = 0; i < 8; i++) {
		set(8, size - 1 - i, false)
		if (!fixed[size - 1 - i][8]) set(size - 1 - i, 8, false)
	}
	if (version >= 7) {
		const bits = versionBits(version)
		for (let i = 0; i < 18; i++) {
			const dark = ((bits >> i) & 1) === 1
			const a = Math.floor(i / 3)
			const b = (i % 3) + size - 11
			set(a, b, dark)
			set(b, a, dark)
		}
	}
	return { size, m, fixed }
}

/**
 * @param {number[][]} m
 * @param {number} size
 * @param {number} mask
 */
function placeFormat(m, size, mask) {
	// Same placement as Nayuki's reference implementation (m[row][col]).
	const bits = formatBits(mask)
	const bit = (i) => (bits >> i) & 1
	for (let i = 0; i <= 5; i++) m[i][8] = bit(i)
	m[7][8] = bit(6)
	m[8][8] = bit(7)
	m[8][7] = bit(8)
	for (let i = 9; i < 15; i++) m[8][14 - i] = bit(i)
	for (let i = 0; i < 8; i++) m[8][size - 1 - i] = bit(i)
	for (let i = 8; i < 15; i++) m[size - 15 + i][8] = bit(i)
	m[size - 8][8] = 1
}

/**
 * @param {number[][]} m
 * @param {boolean[][]} fixed
 * @param {number} size
 * @param {number[]} words
 */
function placeData(m, fixed, size, words) {
	let bitIndex = 0
	const total = words.length * 8
	let upward = true
	for (let col = size - 1; col > 0; col -= 2) {
		if (col === 6) col = 5
		for (let i = 0; i < size; i++) {
			const row = upward ? size - 1 - i : i
			for (let k = 0; k < 2; k++) {
				const c = col - k
				if (fixed[row][c]) continue
				let dark = 0
				if (bitIndex < total) {
					dark = (words[bitIndex >> 3] >> (7 - (bitIndex & 7))) & 1
				}
				m[row][c] = dark
				bitIndex++
			}
		}
		upward = !upward
	}
}

/** Penalty score (rules N1-N4). @param {number[][]} m */
export function penalty(m) {
	const size = m.length
	let score = 0
	// N1: runs of 5+ same colour in rows and columns.
	for (let pass = 0; pass < 2; pass++) {
		for (let a = 0; a < size; a++) {
			let run = 1
			for (let b = 1; b < size; b++) {
				const prev = pass === 0 ? m[a][b - 1] : m[b - 1][a]
				const cur = pass === 0 ? m[a][b] : m[b][a]
				if (cur === prev) {
					run++
					if (run === 5) score += 3
					else if (run > 5) score += 1
				} else run = 1
			}
		}
	}
	// N2: 2x2 blocks.
	for (let r = 0; r < size - 1; r++) {
		for (let c = 0; c < size - 1; c++) {
			const v = m[r][c]
			if (v === m[r][c + 1] && v === m[r + 1][c] && v === m[r + 1][c + 1])
				score += 3
		}
	}
	// N3: finder-like 1011101 with 4 light modules on one side.
	const patA = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0]
	const patB = [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1]
	for (let a = 0; a < size; a++) {
		for (let b = 0; b <= size - 11; b++) {
			let rowA = true
			let rowB = true
			let colA = true
			let colB = true
			for (let k = 0; k < 11; k++) {
				const rv = m[a][b + k]
				const cv = m[b + k][a]
				if (rv !== patA[k]) rowA = false
				if (rv !== patB[k]) rowB = false
				if (cv !== patA[k]) colA = false
				if (cv !== patB[k]) colB = false
			}
			score += 40 * (Number(rowA) + Number(rowB) + Number(colA) + Number(colB))
		}
	}
	// N4: dark module balance.
	let dark = 0
	for (const row of m) for (const v of row) dark += v
	const percent = (dark * 100) / (size * size)
	score += Math.floor(Math.abs(percent - 50) / 5) * 10
	return score
}

/**
 * Encode text as a QR matrix (rows of 0/1, 1 = dark), without quiet zone.
 * @param {string} text
 * @param {{ mask?: number }} [options] force a mask (0-7); default picks the lowest penalty
 * @returns {{ version: number, mask: number, size: number, modules: number[][] }}
 */
export function encodeQr(text, { mask } = {}) {
	const bytes = utf8(text)
	const version = chooseVersion(bytes.length)
	const words = codewords(bytes, version)
	const { size, m, fixed } = baseMatrix(version)
	placeData(m, fixed, size, words)

	const tryMask = (k) => {
		const out = m.map((row) => row.slice())
		const fn = MASKS[k]
		for (let r = 0; r < size; r++) {
			for (let c = 0; c < size; c++) {
				if (!fixed[r][c] && fn(r, c)) out[r][c] ^= 1
			}
		}
		placeFormat(out, size, k)
		return out
	}

	if (mask !== undefined) {
		return { version, mask, size, modules: tryMask(mask) }
	}
	let best = null
	for (let k = 0; k < 8; k++) {
		const candidate = tryMask(k)
		const score = penalty(candidate)
		if (!best || score < best.score)
			best = { score, mask: k, modules: candidate }
	}
	return { version, mask: best.mask, size, modules: best.modules }
}
