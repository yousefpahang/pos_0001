// Copyright (c) 2026, pos_0001 contributors
// License: AGPL-3.0. See license.txt
//
// Raw printing through QZ Tray (SPEC F9). Reuses POS Next's QZ connection, certificate
// and signing (`utils/qzTray.js`, `pos_next.api.qz`, key files in the site's private
// folder; DECISIONS.md item 7). Only adds raw (ESC/POS bytes) jobs and network printers.

import { toBase64 } from "@/plus/core/escpos"
import { connect, getSavedPrinterName, qzConnected } from "@/utils/qzTray"
import qz from "qz-tray"

export { qzConnected }

export class PrinterUnavailableError extends Error {
	/** @param {string} message @param {string} code */
	constructor(message, code) {
		super(message)
		this.name = "PrinterUnavailableError"
		this.code = code
	}
}

/** @returns {Promise<boolean>} */
export async function ensureQz() {
	if (qz.websocket.isActive()) {
		qzConnected.value = true
		return true
	}
	return connect()
}

/**
 * QZ printer target of a printer profile: a local printer name or `{host, port}`.
 * @param {import("@/plus/core/receipt").PrinterProfile} printer
 * @returns {string|{host: string, port: number}}
 */
export function qzTarget(printer) {
	if (printer.connection === "Network") {
		return {
			host: printer.network_host,
			port: Number(printer.network_port) || 9100,
		}
	}
	return printer.qz_printer || getSavedPrinterName()
}

/**
 * Send ESC/POS bytes to the printer.
 * @param {Uint8Array} bytes
 * @param {import("@/plus/core/receipt").PrinterProfile} printer
 */
export async function sendRaw(bytes, printer) {
	if (!(await ensureQz())) {
		throw new PrinterUnavailableError(
			__("QZ Tray is not running on this computer."),
			"qz_not_connected",
		)
	}
	const target = qzTarget(printer)
	if (!target) {
		throw new PrinterUnavailableError(
			__(
				"No printer chosen. Set the QZ printer name on the printer profile or pick a printer in POS Settings.",
			),
			"no_printer",
		)
	}
	const config = qz.configs.create(target)
	await qz.print(config, [
		{ type: "raw", format: "command", flavor: "base64", data: toBase64(bytes) },
	])
}
