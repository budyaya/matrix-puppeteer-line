// matrix-puppeteer-line - A very hacky Matrix-LINE bridge based on running LINE's Chrome extension in Puppeteer
// Copyright (C) 2020-2021 Tulir Asokan, Andrew Ferrazzutti
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU Affero General Public License for more details.
//
// You should have received a copy of the GNU Affero General Public License
// along with this program.  If not, see <https://www.gnu.org/licenses/>.
import MessagesPuppeteer from "./puppet.js"
import {emitLines, promisify} from "./util.js"
import logger from "loglevel";

export default class Client {
	/**
	 * @param {PuppetAPI} manager
	 * @param {import("net").Socket} socket
	 * @param {number} connID
	 * @param {?string} [userID]
	 * @param {?MessagesPuppeteer} [puppet]
	 */
	constructor(manager, socket, connID, userID = null, puppet = null) {
		this.manager = manager
		this.socket = socket
		this.connID = connID
		this.puppet = puppet
		this.stopped = false
		this.notificationID = 0
		this.maxCommandID = 0
		this.set_userID(userID)
		if (!this.userID) {
			this.log = logger.getLogger(`API/${this.connID}`)
			this.log.setLevel(logger.getLogger("API").getLevel())
		}
	}

	set_userID(ID) {
		this.userID = ID
		if (this.userID) {
			this.log = require("loglevel").getLogger(`API/${this.userID}/${this.connID}`)
			this.log.setLevel(logger.getLogger(`API/${this.connID}`).getLevel())
		}
	}

	start() {
		this.log.info("Received connection", this.connID)
		emitLines(this.socket)
		this.socket.on("line", line => this.handleLine(line)
			.catch(err => this.log("Error handling line:", err)))
		this.socket.on("end", this.handleEnd)

		setTimeout(() => {
			if (!this.userID && !this.stopped) {
				this.log.warn("Didn't receive register request within 3 seconds, terminating")
				this.stop("Register request timeout")
			}
		}, 3000)
	}

	async stop(error = null) {
		if (this.stopped) {
			return
		}
		this.stopped = true
		try {
			await this._write({id: --this.notificationID, command: "quit", error})
			await promisify(cb => this.socket.end(cb))
		} catch (err) {
			this.log.error("Failed to end connection:", err)
			this.socket.destroy(err)
		}
	}

	handleEnd = () => {
		this.stopped = true
		if (this.userID && this.manager.clients.get(this.userID) === this) {
			this.manager.clients.delete(this.userID)
		}
		this.log.info(`Connection closed (user: ${this.userID})`)
	}

	/**
	 * Write JSON data to the socket.
	 *
	 * @param {object} data - The data to write.
	 * @return {Promise<void>}
	 */
	_write(data) {
		return promisify(cb => this.socket.write(JSON.stringify(data) + "\n", cb))
	}

	sendMessage(message) {
		this.log.debug(`Sending message ${message.id || "with no ID"} to client`)
		return this._write({
			id: --this.notificationID,
			command: "message",
			is_sequential: true,
			message,
		})
	}

	sendReceipt(receipt) {
		this.log.debug(`Sending read receipt (${receipt.count || "DM"}) of msg ${receipt.id} for chat ${receipt.chat_id}`)
		return this._write({
			id: --this.notificationID,
			command: "receipt",
			receipt
		})
	}

	sendQRCode(url) {
		this.log.debug(`Sending QR ${url} to client`)
		return this._write({
			id: --this.notificationID,
			command: "qr",
			url,
		})
	}

	sendPIN(pin) {
		this.log.debug(`Sending PIN ${pin} to client`)
		return this._write({
			id: --this.notificationID,
			command: "pin",
			pin,
		})
	}

	sendLoginSuccess() {
		this.log.debug("Sending login success to client")
		return this._write({
			id: --this.notificationID,
			command: "login_success",
		})
	}

	sendLoginFailure(reason) {
		this.log.debug(`Sending login failure to client${reason ? `: "${reason}"` : ""}`)
		return this._write({
			id: --this.notificationID,
			command: "login_failure",
			reason,
		})
	}

	sendLoggedOut() {
		this.log.debug("Sending logout notice to client")
		return this._write({
			id: --this.notificationID,
			command: "logged_out",
		})
	}

	handleStart = async (req) => {
		let started = false
		if (this.puppet === null) {
			this.log.info("Opening new puppeteer for", this.userID)
			this.puppet = new MessagesPuppeteer(this.userID, this.ownID, this.sendPlaceholders, this)
			this.manager.puppets.set(this.userID, this.puppet)
			await this.puppet.start(!!req.debug)
			started = true
		}
		return {
			started,
			is_logged_in: await this.puppet.isLoggedIn(),
			is_connected: !await this.puppet.isDisconnected(),
			is_permanently_disconnected: await this.puppet.isPermanentlyDisconnected(),
		}
	}

	handleStop = async () => {
		if (this.puppet === null) {
			return {stopped: false}
		}
		this.log.info("Closing puppeteer for", this.userID)
		this.manager.puppets.delete(this.userID)
		await this.puppet.stop()
		this.puppet = null
		return {stopped: true}
	}

	handleUnknownCommand = () => {
		throw new Error("Unknown command")
	}

	handleRegister = async (req) => {
		this.set_userID(req.user_id)
		this.ownID = req.own_id
		this.sendPlaceholders = req.ephemeral_events
		this.log.info(`Registered socket ${this.connID} -> ${this.userID}${!this.sendPlaceholders ? "" : " (with placeholder message support)"}`)
		if (this.manager.clients.has(this.userID)) {
			const oldClient = this.manager.clients.get(this.userID)
			this.manager.clients.set(this.userID, this)
			this.log.info(`Terminating previous socket ${oldClient.connID} for ${this.userID}`)
			await oldClient.stop("Socket replaced by new connection")
		} else {
			this.manager.clients.set(this.userID, this)
		}
		this.puppet = this.manager.puppets.get(this.userID) || null
		if (this.puppet) {
			this.puppet.client = this
		}
		return {client_exists: this.puppet !== null}
	}

	async handleLine(line) {
		if (this.stopped) {
			this.log.info("Ignoring line, client is stopped")
			return
		}
		let req
		try {
			req = JSON.parse(line)
		} catch (err) {
			this.log.error("Non-JSON request:", line)
			return
		}
		if (!req.command || !req.id) {
			this.log.error("Invalid request:", line)
			return
		}
		if (req.id <= this.maxCommandID) {
			this.log.warn("Ignoring old request", req.id)
			return
		}
		if (req.command != "is_connected") {
			this.log.info("Received request", req.id, "with command", req.command)
		}
		this.maxCommandID = req.id
		let handler
		if (!this.userID) {
			if (req.command !== "register") {
				this.log.info("First request wasn't a register request, terminating")
				await this.stop("Invalid first request")
				return
			} else if (!req.user_id) {
				this.log.info("Register request didn't contain user ID, terminating")
				await this.stop("Invalid register request")
				return
			}
			handler = this.handleRegister
		} else {
			handler = {
				start: this.handleStart,
				stop: this.handleStop,
				disconnect: () => this.stop(),
				login: req => this.puppet.waitForLogin(req.login_type, req.login_data),
				cancel_login: () => this.puppet.cancelLogin(),
				send: req => this.puppet.sendMessage(req.chat_id, req.text),
				send_file: req => this.puppet.sendFile(req.chat_id, req.file_path),
				set_last_message_ids: req => this.puppet.setLastMessageIDs(req.msg_ids, req.own_msg_ids, req.rct_ids),
				forget_chat: req => this.puppet.forgetChat(req.chat_id),
				pause: () => this.puppet.stopObserving(),
				resume: () => this.puppet.startObserving(),
				get_own_profile: () => this.puppet.getOwnProfile(),
				get_contacts: () => this.puppet.getContacts(),
				get_chats: () => this.puppet.getRecentChats(),
				get_chat: req => this.puppet.getChatInfo(req.chat_id, req.force_view),
				get_messages: req => this.puppet.getMessages(req.chat_id),
				read_image: req => this.puppet.readImage(req.image_url),
				is_connected: async () => ({is_connected: !await this.puppet.isDisconnected()}),
			}[req.command] || this.handleUnknownCommand
		}
		const resp = {id: req.id}
		try {
			resp.command = "response"
			resp.response = await handler(req)
		} catch (err) {
			resp.command = "error"
			resp.error = err.toString()
			this.log.error("Error handling request", req.id, err)
		}
		await this._write(resp)
	}
}
