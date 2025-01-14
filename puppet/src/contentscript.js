// matrix-puppeteer-line - A very hacky Matrix-LINE bridge based on running LINE's Chrome extension in Puppeteer
// Copyright (C) 2020-2022 Tulir Asokan, Andrew Ferrazzutti
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

// Definitions and docs for methods that the Puppeteer script exposes for the content script
/**
 * @param {string} text - The date string to parse
 * @param {?Date} ref   - Reference date to parse relative times
 * @param {?{forwardDate: boolean}} option - Extra options for parser
 * @return {Promise<Date>}
 */
window.__chronoParseDate = function (text, ref, option) {}
/**
 * @param {...string} text - The objects to log.
 * @return {Promise<void>}
 */
window.__mautrixLog = function (...text) {}
/**
 * @param {...string} text - The objects to log.
 * @return {Promise<void>}
 */
window.__mautrixError = function (...text) {}
/**
 * @param {ChatListInfo[]} changes - The chats that changed.
 * @return {Promise<void>}
 */
window.__mautrixReceiveChanges = function (changes) {}
/**
 * @param {string} messages - The ID of the chat receiving messages.
 * @param {MessageData[]} messages - The messages added to a chat.
 * @return {Promise<void>}
 */
window.__mautrixReceiveMessages = function (chatID, messages) {}
/**
 * @param {string} chatID - The ID of the chat whose receipts are being processed.
 * @param {string} receipt_id - The ID of the most recently-read message for the current chat.
 * @return {Promise<void>}
 */
window.__mautrixReceiveReceiptDirectLatest = function (chatID, receiptID) {}
/**
 * @param {string} chatID - The ID of the chat whose receipts are being processed.
 * @param {Receipt[]} receipts - All newly-seen receipts for the current chat.
 * @return {Promise<void>}
 */
window.__mautrixReceiveReceiptMulti = function (chatID, receipts) {}
/**
 * @param {string} url - The URL for the QR code.
 * @return {Promise<void>}
 */
window.__mautrixReceiveQR = function (url) {}
/**
 * @return {Promise<void>}
 */
window.__mautrixSendEmailCredentials = function () {}
/**
 * @param {string} pin - The login PIN.
 * @return {Promise<void>}
 */
window.__mautrixReceivePIN = function (pin) {}
/**
 * @param {Element} button - The button to click when a QR code or PIN expires.
 * @return {Promise<void>}
 */
window.__mautrixExpiry = function (button) {}
/**
 * @param {string} message - The message of the most recent dialog that appeared on screen.
 * @return {void}
 */
window.__mautrixLoggedOut = function(message) {}

/**
 * typedef ChatTypeEnum
 */
const ChatTypeEnum = Object.freeze({
	DIRECT: 1,
	GROUP: 2,
	ROOM: 3,
})

const MSG_DECRYPTING = "ⓘ Decrypting..."

// TODO add more common selectors
const SEL_PARTICIPANTS_LIST = "#_chat_detail_area > .mdRGT02Info ul.mdRGT13Ul"

class MautrixController {
	constructor() {
		this.chatListObserver = null
		this.msgListObserver = null
		this.receiptObserver = null

		this.qrChangeObserver = null
		this.qrAppearObserver = null
		this.emailAppearObserver = null
		this.pinAppearObserver = null
		this.ownID = null

		this.ownMsgPromise = Promise.resolve(-1)
		this._promiseOwnMsgReset()
	}

	setOwnID(ownID) {
		this.ownID = ownID
	}

	// TODO Commonize with Node context
	getChatType(id) {
		switch (id.charAt(0)) {
		case "u":
			return ChatTypeEnum.DIRECT
		case "c":
			return ChatTypeEnum.GROUP
		case "r":
			return ChatTypeEnum.ROOM
		default:
			throw `Invalid chat ID: ${id}`
		}
	}

	getCurrentChatID() {
		const chatListElement = document.querySelector("#_chat_list_body > .ExSelected > .chatList")
		return chatListElement ? this.getChatListItemID(chatListElement) : null
	}

	/**
	 * Parse a date string.
	 *
	 * @param {string} text - The string to parse
	 * @param {?Date} ref   - Reference date to parse relative times
	 * @param {?{forwardDate: boolean}} option - Extra options for parser
	 * @return {Promise<?Date>} - The date, or null if parsing failed.
	 * @private
	 */
	async _tryParseDate(text, ref, option) {
		const parsed = await window.__chronoParseDate(text, ref, option)
		return parsed ? new Date(parsed) : null
	}

	/**
	 * Parse a date separator.
	 *
	 * @param {string} text - The text in the date saparator.
	 * @return {Promise<?Date>} - The value of the date separator.
	 * @private
	 */
	async _tryParseDateSeparator(text) {
		if (!text) {
			return null
		}
		// Must prefix with midnight to prevent getting noon
		text = "00:00 " + text.replace(/\. /, "/")
		const now = new Date()
		let newDate = await this._tryParseDate(text)
		if (!newDate || newDate > now) {
			const lastWeek = new Date()
			lastWeek.setDate(lastWeek.getDate() - 7)
			newDate = await this._tryParseDate(text, lastWeek, { forwardDate: true })
		}
		return newDate && newDate <= now ? newDate : null
	}

	/**
	 * @typedef MessageData
	 * @type {object}
	 * @property {number}  id          - The ID of the message. Seems to be sequential.
	 * @property {?number} timestamp   - The unix timestamp of the message. Accurate to the minute.
	 * @property {boolean} is_outgoing - Whether or not this user sent the message.
	 * @property {?Participant} sender - Full data of the participant who sent the message, if needed and available.
	 * @property {?string} html        - The HTML format of the message, if necessary.
	 * @property {?ImageInfo} image    - Information of the image in the message, if it's an image-only message.
	 * @property {?MemberInfo} member_info - Change to the membership status of a participant.
	 * @property {?number} receipt_count  - The number of users who have read the message.
	 */

	/**
	 * @typedef MemberInfo
	 * @type {object}
	 * @property {boolean} invited
	 * @property {boolean} joined
	 * @property {boolean} left
	 * TODO Any more? How about kicked?
	 */

	/**
	 * @typedef ImageInfo
	 * @type {object}
	 * @property {string} url - The URL of the image's location.
	 * @property {boolean} is_sticker - Whether the sent image is a sticker.
	 * @property {boolean} animated   - Whether the sent image is animated. Only used for stickers (for now...?).
	 */

	/**
	 * Return whether a URL points to a loaded image or not.
	 *
	 * @param {string} src
	 * @return {boolean}
	 * @private
	 */
	_isLoadedImageURL(src) {
		return src && (
			src.startsWith(`blob:`) ||
			src.startsWith(`${document.location.origin}/res/`) && !src.startsWith(`${document.location.origin}/res/img/noimg/`))
	}

	/**
	 * Strip dimension values from an image URL, if needed.
	 *
	 * @param {string} src
	 * @return {string}
	 */
	_getComparableImageURL(src) {
		return this._isLoadedImageURL(src) ? src : src.replace(/\d+x\d+/, "-x-")
	}

	/**
	 * Try to match a Participant against an entry in the friends list,
	 * and set any unset properties of the Participant based on the matched item.
	 * Match on name first (since it's always available), then on avatar and ID (since there
	 * may be multiple matching names).
	 *
	 * @param {Participant} participant - The Participant to find a match for, and set properties of.
	 * @return {boolean} - Whether or not a match was found.
	 * @private
	 */
	_updateSenderFromFriendsList(participant) {
		let targetElement
		const elements = document.querySelectorAll(`#contact_wrap_friends > ul > li[title='${participant.name}']`)
		if (elements.length == 0) {
			return false
		} else if (elements.length == 1) {
			targetElement = elements[0]
		} else if (participant.avatar) {
			const url = this._getComparableImageURL(participant.avatar.url)
			// Look for multiple matching avatars, just in case.
			// Could reasonably happen with "noimg" placeholder avatars.
			const filteredElements = elements.filter(element => {
				const pathImg = this.getFriendsListItemAvatar(element)
				return pathImg && this._getComparableImageURL(pathImg.url) == url
			})
			if (filteredElements.length == 1) {
				targetElement = filteredElements[0]
			} else if (filteredElements.length != 0) {
				elements = filteredElements
			}
		}
		if (!targetElement && participant.id) {
			const idElement = elements.find(element => this.getFriendsListItemID(element) == participant.id)
			if (idElement) {
				targetElement = idElement
			}
		}

		if (!targetElement) {
			targetElement = elements[0]
			console.warn(`Multiple matching friends found for "${participant.name}", so using first match`)
		}
		if (!participant.avatar) {
			participant.avatar = this.getFriendsListItemAvatar(targetElement)
		}
		if (!participant.id) {
			participant.id = this.getFriendsListItemID(targetElement)
		}
		return true
	}

	/**
	 * Try to match a Participant against an entry in the current chat's participant list,
	 * and set any unset properties of the Participant based on the matched item.
	 * Match on name first (since it's always available), then on avatar and ID (since there
	 * may be multiple matching names).
	 *
	 * @param {Participant} participant - The Participant to find a match for, and set properties of.
	 * @return {boolean} - Whether or not a match was found.
	 * @private
	 */
	_updateSenderFromParticipantList(participant) {
		let targetElement
		const participantsList = document.querySelector(SEL_PARTICIPANTS_LIST)
		// Groups use a participant's name as the alt text of their avatar image,
		// but rooms do not...ARGH! But they both use a dedicated element for it.
		const elements =
			Array.from(participantsList.querySelectorAll(".mdRGT13Ttl"))
			.filter(e => e.innerText == participant.name)
			.map(e => e.parentElement)
		if (elements.length == 0) {
			return false
		} else if (elements.length == 1) {
			targetElement = elements[0]
		} else if (participant.avatar) {
			const url = this._getComparableImageURL(participant.avatar.url)
			// Look for multiple matching avatars, just in case.
			// Could reasonably happen with "noimg" placeholder avatars.
			const filteredElements = elements.filter(element => {
				const pathImg = this.getParticipantListItemAvatar(element)
				return pathImg && this._getComparableImageURL(pathImg.url) == url
			})
			if (filteredElements.length == 1) {
				targetElement = filteredElements[0]
			} else if (filteredElements.length != 0) {
				elements = filteredElements
			}
		}
		if (!targetElement && participant.id) {
			// This won't work for rooms, where participant list items don't have IDs,
			// but keep this around in case they ever do...
			const idElement = elements.find(element => this.getParticipantListItemID(element) == participant.id)
			if (idElement) {
				targetElement = idElement
			}
		}
		// TODO Look at the list of invited participants if no match found

		if (!targetElement) {
			targetElement = elements[0]
			console.warn(`Multiple matching participants found for "${participant.name}", so using first match`)
		}
		if (!participant.avatar) {
			participant.avatar = this.getParticipantListItemAvatar(targetElement)
		}
		if (!participant.id) {
			participant.id = this.getParticipantListItemID(targetElement)
		}
		return true
	}

	/**
	 * Use the friends/participant list to update a Participant's information.
	 * Try the friends list first since the particpant list for rooms doesn't have user IDs...
	 *
	 * @param {Participant} participant - The participant whose information should be updated.
	 * @private
	 */
	_updateSenderFromMatch(participant) {
		if (!this._updateSenderFromFriendsList(participant)) {
			if (!this._updateSenderFromParticipantList(participant)) {
				console.warn(`No matching item found for "${participant.name}"`)
			}
		}
	}


	/**
	 * Parse a message element.
	 *
	 * @param {Element} element - The message element.
	 * @param {number} chatType - What kind of chat this message is part of.
	 * @param {Date} refDate    - The most recent date indicator. If undefined, do not retrieve the timestamp of this message.
	 * @return {Promise<MessageData>}
	 * @private
	 */
	async _parseMessage(element, chatType, refDate) {
		const is_outgoing = element.classList.contains("mdRGT07Own")
		let sender

		const receipt = element.querySelector(".mdRGT07Own .mdRGT07Read:not(.MdNonDisp)")
		let receipt_count

		// Don't need sender ID for direct chats, since the portal will have it already.
		if (chatType == ChatTypeEnum.DIRECT) {
			sender = null
			receipt_count = is_outgoing ? (receipt ? 1 : 0) : null
		} else if (!is_outgoing) {
			sender = {
				name: element.querySelector(".mdRGT07Body > .mdRGT07Ttl").innerText,
				avatar: this._getPathImage(element.querySelector(".mdRGT07Img > img"))
			}
			this._updateSenderFromMatch(sender)
			receipt_count = null
		} else {
			// TODO Get own ID and store it somewhere appropriate.
			//      Unable to get own ID from a room chat...
			// if (chatType == ChatTypeEnum.GROUP) {
			// 	const participantsList = document.querySelector("#_chat_detail_area > .mdRGT02Info ul.mdRGT13Ul")
			// 	// TODO The first member is always yourself, right?
			// 	// TODO Cache this so own ID can be used later
			// 	sender = participantsList.children[0].getAttribute("data-mid")
			// }
			const participantsList = document.querySelector(SEL_PARTICIPANTS_LIST)
			sender = {
				name: this.getParticipantListItemName(participantsList.children[0]),
				avatar: this.getParticipantListItemAvatar(participantsList.children[0]),
				id: this.ownID
			}
			receipt_count = receipt ? this._getReceiptCount(receipt) : null
		}

		const messageData = {
			id: +element.getAttribute("data-local-id"),
			timestamp:
				refDate !== undefined
				? (await this._tryParseDate(element.querySelector("time")?.innerText, refDate))?.getTime()
				: null,
			is_outgoing: is_outgoing,
			sender: sender,
			receipt_count: receipt_count,
		}

		const messageElement = element.querySelector(".mdRGT07Body > .mdRGT07Msg")
		const is_sticker = messageElement.classList.contains("mdRGT07Sticker")
		if (messageElement.classList.contains("mdRGT07Text")) {
			let msgSpan = messageElement.querySelector(".mdRGT07MsgTextInner")
			try {
				if (msgSpan.innerHTML == MSG_DECRYPTING) {
					msgSpan = await this._waitForDecryptedMessage(element, msgSpan, 5000)
				}
				messageData.html = await this._parseMessageHTML(msgSpan)
			} catch {
				// Throw to reject, but return what was parsed so far
				throw messageData
			}
		} else if (is_sticker || messageElement.classList.contains("mdRGT07Image")) {
			// TODO Animated non-sticker images require clicking its img element, which is just a thumbnail
			// Real image: "#wrap_single_image img"
			// Close button: "#wrap_single_image button"
			// Viewer is open/closed based on "#wrap_single_image.MdNonDisp" / "#wrap_single_image:not(.MdNonDisp)"
			let img = messageElement.querySelector(".mdRGT07MsgImg > img")
			if (!this._isLoadedImageURL(img.src)) {
				try {
					img = await this._waitForLoadedImage(img, 10000)
				} catch {
					// Throw to reject, but return what was parsed so far
					throw messageData
				}
			}
			messageData.image = {
				url: img.src,
				is_sticker: is_sticker,
				is_animated: is_sticker && img.parentElement.classList.contains("animationSticker"),
			}
		}
		return messageData
	}

	/**
	 * @param {Element} msgSpan
	 * @return {Promise<DOMString>}
	 * @private
	 */
	async _parseMessageHTML(msgSpan) {
		const msgSpanImgs = msgSpan.getElementsByTagName("img")
		if (msgSpanImgs.length == 0) {
			return msgSpan.innerHTML
		} else {
			const unloadedImgs = Array.from(msgSpanImgs).filter(img => !this._isLoadedImageURL(img.src))
			if (unloadedImgs.length > 0) {
				// NOTE Use allSettled to not throw if any images time out
				await Promise.allSettled(
					unloadedImgs.map(img => this._waitForLoadedImage(img, 2000))
				)
			}

			// Hack to put sticon dimensions in HTML (which are excluded by default)
			// in such a way that doesn't alter the elements that are in the DOM
			const msgSpanCopy = msgSpan.cloneNode(true)
			const msgSpanCopyImgs = msgSpanCopy.getElementsByTagName("img")
			for (let i = 0, n = msgSpanImgs.length; i < n; i++) {
				msgSpanCopyImgs[i].height = msgSpanImgs[i].height
				msgSpanCopyImgs[i].width  = msgSpanImgs[i].width
			}
			return msgSpanCopy.innerHTML
		}
	}

	/**
	 * @param {Element} element
	 * @param {Element} msgSpan
	 * @param {number} timeoutLimitMillis
	 * @return {Promise<Element>}
	 * @private
	 */
	_waitForDecryptedMessage(element, msgSpan, timeoutLimitMillis) {
		console.debug("Wait for message element to finish decrypting")
		console.debug(element)
		return new Promise((resolve, reject) => {
			let observer = new MutationObserver(changes => {
				for (const change of changes) {
					const isTextUpdate = change.type == "characterData"
					const target = isTextUpdate ? msgSpan : element.querySelector(".mdRGT07MsgTextInner")
					if (target && target.innerHTML != MSG_DECRYPTING) {
						if (isTextUpdate) {
							console.debug("UNLIKELY(?) EVENT -- Found decrypted message from text update")
						} else {
							// TODO Looks like it's div.mdRGT07Body that gets always replaced. If so, watch only for that
							console.debug("Found decrypted message from element replacement")
							console.debug(target)
							console.debug("Added:")
							for (const change of changes) {
								console.debug(change.removedNodes)
							}
							console.debug("Removed:")
							for (const change of changes) {
								console.debug(change.addedNodes)
							}
						}
						observer.disconnect()
						observer = null
						resolve(target)
						return
					}
					if (target && target != msgSpan) {
						console.debug("UNLIKELY EVENT -- Somehow added a new \"decrypting\" span, it's the one to watch now")
						console.debug(target)
						msgSpan = target
						observer.observe(msgSpan, { characterData: true })
					}
				}
			})
			// Either the span element or one of its ancestors is replaced,
			// or the span element's content is updated.
			// Not exactly sure which of these happens, or if the same kind
			// of mutation always happens, so just look for them all...
			observer.observe(element, { childList: true, subtree: true })
			observer.observe(msgSpan, { characterData: true })
			setTimeout(() => {
				if (observer) {
					observer.disconnect()
					// Don't print log message, as this may be a safe timeout
					reject()
				}
			}, timeoutLimitMillis)
		})
	}

	/**
	 * @param {Element} img
	 * @param {number} timeoutLimitMillis
	 * @return {Promise<Element>}
	 * @private
	 */
	_waitForLoadedImage(img, timeoutLimitMillis) {
		console.debug("Wait for image element to finish loading")
		console.debug(img)
		// TODO Should reject on "#_chat_message_image_failure"
		return new Promise((resolve, reject) => {
			let observer = new MutationObserver(changes => {
				for (const change of changes) {
					if (this._isLoadedImageURL(change.target.src)) {
						console.debug("Image element finished loading")
						console.debug(change.target)
						observer.disconnect()
						observer = null
						resolve(change.target)
						return
					}
				}
			})
			observer.observe(img, { attributes: true, attributeFilter: ["src"] })
			setTimeout(() => {
				if (observer) {
					observer.disconnect()
					// Don't print log message, as this may be a safe timeout
					reject()
				}
			}, timeoutLimitMillis)
		})
	}

	/**
	 * Find the number in the "Read #" receipt message.
	 * Don't look for "Read" specifically, to support multiple languages.
	 *
	 * @param {Element} receipt - The element containing the receipt message.
	 * @return {number}
	 * @private
	 */
	_getReceiptCount(receipt) {
		const match = receipt.innerText.match(/\d+/)
		return Number.parseInt(match ? match[0] : 0) || null
	}


	/**
	 * Parse a member event element.
	 *
	 * @param {Element} element - The message element.
	 * @return {?MessageData}   - A valid MessageData with member_info set, or null if no membership info is found.
	 * @private
	 */
	_tryParseMemberEvent(element) {
		const memberMatch = element.querySelector("time.preline")?.innerText?.match(/(.*) (joined|left)/)
		if (memberMatch) {
			const sender = {name: memberMatch[1]}
			this._updateSenderFromMatch(sender)
			return {
				id: +element.getAttribute("data-local-id"),
				is_outgoing: false,
				sender: sender,
				member_info: {
					invited: false, // TODO Handle invites. Its puppet must not auto-join, though!
					joined: memberMatch[2] == "joined",
					left: memberMatch[2] == "left",
					// TODO Any more? How about kicked?
				}
			}
		} else {
			return null
		}
	}


	/**
	 * Create and store a promise that resolves when a message written
	 * by the user finishes getting sent.
	 * Accepts selectors for elements that become visible once the message
	 * has succeeded or failed to be sent.
	 *
	 * @param {number} timeoutLimitMillis - The maximum amount of time to wait for the message to be sent.
	 * @param {string} successSelector - The selector for the element that indicates the message was sent.
	 * @param {?string} failureSelector - The selector for the element that indicates the message failed to be sent.
	 */
	promiseOwnMessage(timeoutLimitMillis, successSelector, failureSelector=null) {
		this.promiseOwnMsgSuccessSelector = successSelector
		this.promiseOwnMsgFailureSelector = failureSelector

		this.ownMsgPromise = new Promise((resolve, reject) => {
			this.promiseOwnMsgResolve = resolve
			this.promiseOwnMsgReject = reject
		})
		this.promiseOwnMsgTimeoutID = setTimeout(() => {
			if (this.promiseOwnMsgReject) {
				console.error("Timed out waiting for own message to be sent")
				this._rejectOwnMessage()
			}
		}, timeoutLimitMillis)
	}

	/**
	 * Check if we're waiting for a Matrix-sent message to resolve.
	 * @return {boolean}
	 * @private
	 */
	_isWaitingForOwnMessage() {
		return !!this.promiseOwnMsgResolve
	}

	/**
	 * Wait for a user-sent message to finish getting sent.
	 *
	 * @return {Promise<number>} - The ID of the sent message.
	 */
	async waitForOwnMessage() {
		return await this.ownMsgPromise
	}

	/**
	 * @typedef ChatEvents
	 * @type {object}
	 * @property {MessageData[]} messages - All synced messages, which include receipts for them (if any).
	 * @property {ReceiptData[]} receipts - All synced receipts for messages already present.
	 */

	/**
	 * Find the reference date indicator nearest to the given element in the timeline.
	 * @param {Element} fromElement
	 * @return {Promise<?Date>} - The value of the nearest date separator.
	 * @private
	 */
	async _getNearestRefDate(fromElement) {
		let element = fromElement.previousElementSibling
		while (element && !element.classList.contains("mdRGT10Date")) {
			element = element.previousElementSibling
		}
		return element ? await this._tryParseDateSeparator(element.firstElementChild.innerText) : null
	}

	/**
	 * Parse the message list of whatever the currently-viewed chat is.
	 *
	 * @param {?number} minID - The minimum message ID to consider.
	 * @return {Promise<MessageData[]>} - A list of messages.
	 */
	async parseMessageList(minID = 0) {
		console.debug(`minID for full refresh: ${minID}`)
		const msgList =
			Array.from(document.querySelectorAll("#_chat_room_msg_list > div[data-local-id]"))
			.filter(msg => msg.getAttribute("data-local-id") > minID)
		if (msgList.length == 0) {
			return []
		}
		const messagePromises = []
		const chatType = this.getChatType(this.getCurrentChatID())
		let refDate

		for (const child of msgList) {
			if (child.classList.contains("mdRGT10Date")) {
				refDate = await this._tryParseDateSeparator(child.firstElementChild.innerText)
			} else if (child.classList.contains("MdRGT07Cont")) {
				if (refDate === undefined) {
					refDate = this._getNearestRefDate(child)
				}
				messagePromises.push(this._parseMessage(child, chatType, refDate))
			} else if (child.classList.contains("MdRGT10Notice")) {
				const memberEventMessage = this._tryParseMemberEvent(child)
				if (memberEventMessage) {
					// If a member event is the first message to be discovered,
					// scan backwards for the nearest message before it, and use
					// that message's timestamp as the timestamp of this event.
					if (messagePromises.length == 0) {
						let element = child.previousElementSibling
						let timeElement
						while (element && (!element.getAttribute("data-local-id") || !(timeElement = element.querySelector("time")))) {
							element = element.previousElementSibling
						}
						if (element) {
							if (refDate === undefined) {
								refDate = this._tryFindNearestRefDate(child)
							}
							memberEventMessage.timestamp = (await this._tryParseDate(timeElement.innerText, refDate))?.getTime()
						}
					}
					messagePromises.push(Promise.resolve(memberEventMessage))
				}
			}
		}
		// NOTE No message should ever time out, but use allSettled to not throw if any do
		const messages = (await Promise.allSettled(messagePromises))
		.filter(value => value.status == "fulfilled")
		.map(value => value.value)

		// Set the timestamps of each member event to that of the message preceding it,
		// as a best-guess of its timestamp, since member events have no timestamps.
		// Do this after having resolved messages.
		for (let i = 1, n = messages.length; i < n; i++) {
			if (messages[i].member_info) {
				messages[i].timestamp = messages[i-1].timestamp
			}
		}

		return messages
	}

	/**
	 * Parse receipts of whatever the currently-viewed chat is.
	 * Should only be used for already-processed messages that
	 * get skipped by parseMessageList.
	 *
	 * @param {?Object} rctIDs - The minimum receipt ID to consider for each "read by" count.
	 *                           It's an Object because Puppeteer can't send a Map.
	 * @return {ReceiptData[]} - A list of receipts.
	 */
	parseReceiptList(rctIDs = {}) {
		console.debug(`rctIDs for full refresh: ${rctIDs}`)

		const isDirect = this.getChatType(this.getCurrentChatID()) == ChatTypeEnum.DIRECT
		const numOthers = isDirect ? 1 : document.querySelector(SEL_PARTICIPANTS_LIST).childElementCount - 1

		const idGetter = e => +e.closest("[data-local-id]").getAttribute("data-local-id")

		const receipts =
			Array.from(document.querySelectorAll("#_chat_room_msg_list .mdRGT07Read:not(.MdNonDisp)"))
			.map(isDirect
				? e => {
					return {
						id: idGetter(e),
						count: 1
					}
				}
				: e => {
					return {
						id: idGetter(e),
						count: this._getReceiptCount(e)
					}
				}
				// Using two lambdas to not branch on isDirect for every element
			)

		const newReceipts = []
		const prevFullyReadID = rctIDs[`${numOthers}`] || 0
		let minCountToFind = 1
		for (let i = receipts.length-1; i >= 0; i--) {
			const receipt = receipts[i]
			if (receipt.count >= minCountToFind && receipt.id > (rctIDs[`${receipt.count}`] || 0)) {
				newReceipts.push(receipt)
				if (receipt.count < numOthers) {
					minCountToFind = receipt.count+1
				} else {
					break
				}
			} else if (receipt.id <= prevFullyReadID) {
				break
			}
		}

		return newReceipts
	}

	/**
	 * @typedef PathImage
	 * @type object
	 * @property {?string} path - The virtual path of the image (behaves like an ID). Optional.
	 * @property {string} url   - The URL of the image. Mandatory.
	 */

	/**
	 * @param {Element} img - The image element to get the URL and path of.
	 * @return {?PathImage} - The image URL and its path, if found.
	 * @private
	 */
	_getPathImage(img) {
		if (img && img.src.startsWith("blob:")) {
			// NOTE Having a blob but no path means the image exists,
			// 		but in a form that cannot be uniquely identified.
			// 		If instead there is no blob, the image is blank.
			return {
				path: img.getAttribute("data-picture-path"),
				url: img.src,
			}
		} else {
			return null
		}
	}

	/**
	 * @typedef Participant
	 * @type object
	 * @property {string} id         - The member ID for the participant
	 * @property {?PathImage} avatar - The path and blob URL of the participant's avatar
	 * @property {string} name       - The contact list name of the participant
	 */

	getParticipantListItemName(element) {
		return element.querySelector(".mdRGT13Ttl").innerText
	}

	getParticipantListItemAvatar(element) {
		// Has data-picture-path for rooms, but not groups
		return this._getPathImage(element.querySelector(".mdRGT13Img > img[src]"))
	}

	getParticipantListItemID(element) {
		// Exists for groups, but not rooms
		return element.getAttribute("data-mid")
	}

	getFriendsListItemName(element) {
		return element.title
	}

	getFriendsListItemAvatar(element) {
		// Never has data-picture-path, but still find a PathImage in case it ever does
		return this._getPathImage(element.querySelector(".mdCMN04Img > img[src]"))
	}

	getFriendsListItemID(element) {
		return element.getAttribute("data-mid")
	}

	/**
	 * Parse a friends list item element.
	 *
	 * @param {Element} element - The element to parse.
	 * @param {?string} knownID - The ID of this element, if it is known.
	 * @return {Participant}    - The info in the element.
	 */
	parseFriendsListItem(element, knownID) {
		return {
			id: knownID || this.getFriendsListItemID(element),
			avatar: this.getFriendsListItemAvatar(element),
			name: this.getFriendsListItemName(element),
		}
	}

	/**
	 * Parse the friends list.
	 *
	 * @return {Participant[]}
	 */
	parseFriendsList() {
		const friends = []
		document.querySelectorAll("#contact_wrap_friends > ul > li[data-mid]")
		.forEach(e => friends.push(this.parseFriendsListItem(e)))
		return friends
	}

	/**
	 * Parse a group participants list.
	 * TODO Find what works for a *room* participants list...!
	 *
	 * @param {Element} element - The participant list element.
	 * @return {Participant[]} - The list of participants.
	 */
	parseParticipantList(element) {
		// TODO Might need to explicitly exclude own user if double-puppeting is enabled.
		// TODO The first member is always yourself, right?
		const ownParticipant = {
			// TODO Find way to make this work with multiple mxids using the bridge.
			//      One idea is to add real ID as suffix if we're in a group, and
			//      put in the puppet DB table somehow.
			id: this.ownID,
			avatar: this.getParticipantListItemAvatar(element.children[0]),
			name: this.getParticipantListItemName(element.children[0]),
		}

		return [ownParticipant].concat(Array.from(element.children).slice(1).map(child => {
			const sender = {
				name: this.getParticipantListItemName(child),
				avatar: this.getParticipantListItemAvatar(child),
			}
			sender.id = this.getParticipantListItemID(child)
			if (!sender.id) {
				this._updateSenderFromFriendsList(sender)
			}
			return sender
		}))
	}

	getGroupListItemName(element) {
		return element.title
	}

	getGroupListItemAvatar(element) {
		// Does have data-picture-path
		return this._getPathImage(element.querySelector(".mdCMN04Img > img[src]"))
	}

	getGroupListItemID(element) {
		return element.getAttribute("data-chatid")
	}

	/**
	 * Parse a group list item element.
	 *
	 * @param {Element} element - The element to parse.
	 * @param {?string} knownID - The ID of this element, if it is known.
	 * @return {Participant}    - The info in the element.
	 */
	parseGroupListItem(element, knownID) {
		return {
			id: knownID || this.getGroupListItemID(element),
			avatar: this.getGroupListItemAvatar(element),
			name: this.getGroupListItemName(element),
		}
	}

	/**
	 * Parse the group list.
	 *
	 * @param {boolean} invited - Whether to parse the list of invited groups instead of joined groups.
	 * @return {Participant[]}
	 */
	parseGroupList(invited = false) {
		const groups = []
		document.querySelectorAll(`#${invited ? "invited" : "joined"}_group_list_body > li[data-chatid="${id}"]`)
		.forEach(e => groups.push(this.parseGroupListItem(e)))
		return groups
	}

	/**
	 * @typedef ChatListInfo
	 * @type object
	 * @property {number} id      - The ID of the chat.
	 * @property {string} name    - The name of the chat.
	 * @property {PathImage} icon - The path and blob URL of the chat icon.
	 * @property {string} lastMsg - The most recent message in the chat.
	 *                              May be prefixed by sender name.
	 * @property {string} lastMsgDate - An imprecise date for the most recent message
	 *                                  (e.g. "7:16 PM", "Thu" or "Aug 4")
	 * @property {number} notificationCount - The number of unread messages in the chat,
	 *                                        signified by the number in its notification badge.
	 */

	/**
	 * @typedef ChatListInfoForCycle
	 * @type object
	 * @property {number} id      - The ID of the chat.
	 * @property {number} notificationCount - The number of unread messages in the chat,
	 *                                        signified by the number in its notification badge.
	 * @property {number} numParticipants - The number of participants in the chat,
	 *                                      signified by a count next to the chat title.
	 */

	getChatListItemID(element) {
		return element.getAttribute("data-chatid")
	}

	getChatListItemName(element) {
		return element.querySelector(".mdCMN04Ttl").innerText
	}

	getChatListItemIcon(element) {
		return this._getPathImage(element.querySelector(".mdCMN04Img > :not(.mdCMN04ImgInner) > img[src]"))
	}

	getChatListItemLastMsg(element) {
		return element.querySelector(".mdCMN04Desc").innerHTML
	}

	getChatListItemLastMsgDate(element) {
		return element.querySelector("time").innerText
	}

	getChatListItemNotificationCount(element) {
		return Number.parseInt(element.querySelector(".MdIcoBadge01:not(.MdNonDisp)")?.innerText) || 0
	}

	getChatListItemOtherParticipantCount(element) {
		const countElement = element.querySelector(".mdCMN04Count:not(.MdNonDisp)")
		const match = countElement?.innerText.match(/\d+/)
		return match ? match[0] - 1 : 1
	}

	/**
	 * Parse a conversation list item element.
	 *
	 * @param {Element} element - The element to parse.
	 * @param {?string} knownID - The ID of this element, if it is known.
	 * @return {ChatListInfo}   - The info in the element.
	 */
	parseChatListItem(element, knownID) {
		return !element.classList.contains("chatList") ? null : {
			id: knownID || this.getChatListItemID(element),
			name: this.getChatListItemName(element),
			icon: this.getChatListItemIcon(element),
			lastMsg: this.getChatListItemLastMsg(element),
			lastMsgDate: this.getChatListItemLastMsgDate(element),
			notificationCount: this.getChatListItemNotificationCount(element),
		}
	}

	/**
	 * Return the IDs of all groups that aren't in the list of recent chats.
	 *
	 * @return {string[]} - The list of group IDs.
	 */
	getJoinedNonrecentGroupIDs() {
		const ids = []
		for (const e of document.querySelectorAll("#joined_group_list_body > li[data-chatid]")) {
			const id = e.getAttribute("data-chatid")
			if (!document.querySelector(`#_chat_list_body > li > div[data-chatid="${id}"]`)) {
				ids.push(id)
			}
		}
		return ids
	}

	/**
	 * Parse the list of recent/saved chats.
	 *
	 * @return {ChatListInfo[]} - The list of chats.
	 */
	parseChatList() {
		const chatList = document.querySelector("#_chat_list_body")
		return Array.from(chatList.children).map(
			child => this.parseChatListItem(child.firstElementChild))
	}

	/**
	 * Parse a conversation list item element for cycling.
	 *
	 * @param {Element} element - The element to parse.
	 * @return {ChatListInfoForCycle} - The info in the element.
	 */
	parseChatListItemForCycle(element) {
		return {
			id: this.getChatListItemID(element),
			notificationCount: this.getChatListItemNotificationCount(element),
			otherParticipantCount: this.getChatListItemOtherParticipantCount(element),
		}
	}

	/**
	 * Parse the list of recent/saved chats, but for properties
	 * relevant to knowing which chat to cycle onto for read receipts.
	 *
	 * @return {ChatListInfoForCycle[]} - The list of chats with relevant properties.
	 */
	parseChatListForCycle() {
		const chatList = document.querySelector("#_chat_list_body")
		return Array.from(chatList.children).map(
			child => this.parseChatListItemForCycle(child.firstElementChild))
	}

	/**
	 * Download an image at a given URL and return it as a data URL.
	 *
	 * @param {string} url - The URL of the image to download.
	 * @return {Promise<string>} - The data URL (containing the mime type and base64 data)
	 */
	async readImage(url) {
		const resp = await fetch(url)
		const reader = new FileReader()
		const promise = new Promise((resolve, reject) => {
			reader.onload = () => resolve(reader.result)
			reader.onerror = reject
		})
		reader.readAsDataURL(await resp.blob())
		return promise
	}

	/**
	 * Wait for updates to the active chat's message list to settle down.
	 * Wait an additional bit of time every time an update is observed.
	 * TODO Look (harder) for an explicit signal of when a chat is fully updated...
	 *
	 * @return {Promise<void>}
	 */
	waitForMessageListStability() {
		// Increase this if messages get missed on sync / chat change.
		// Decrease it if response times are too slow.
		const delayMillis = 500

		let myResolve
		const promise = new Promise(resolve => {myResolve = resolve})

		let observer
		const onTimeout = () => {
			console.log("Message list looks stable, continue")
			console.debug(`timeoutID = ${timeoutID}`)
			observer.disconnect()
			myResolve()
		}

		let timeoutID
		const startTimer = () => {
			timeoutID = setTimeout(onTimeout, delayMillis)
		}

		observer = new MutationObserver(changes => {
			clearTimeout(timeoutID)
			console.log("CHANGE to message list detected! Wait a bit longer...")
			console.debug(`timeoutID = ${timeoutID}`)
			console.debug(changes)
			startTimer()
		})
		observer.observe(
			document.querySelector("#_chat_message_area"),
			{childList: true, attributes: true, subtree: true})
		startTimer()

		return promise
	}

	/**
	 * @param {MutationRecord[]} mutations - The mutation records that occurred
	 * @private
	 */
	_observeChatListMutations(mutations) {
		// TODO Observe *added/removed* chats, not just new messages
		const changedChats = new Set()
		for (const change of mutations) {
			if (change.target.id == "_chat_list_body") {
				// TODO
				// These could be new chats, or they're
				// existing ones that just moved around.
				/*
				for (const node of change.addedNodes) {
				}
				*/
			} else if (change.target.tagName == "LI" && change.addedNodes.length == 1) {
				if (change.target.classList.contains("ExSelected")) {
					console.debug("Not using chat list mutation response for currently-active chat")
					continue
				}
				const chat = this.parseChatListItem(change.addedNodes[0])
				if (chat) {
					console.log("Added chat list item:", chat)
					changedChats.add(chat)
				} else {
					console.debug("Could not parse added node as a chat list item:", node)
				}
			}
			// change.removedNodes tells you which chats that had notifications are now read.
		}
		if (changedChats.size > 0) {
			console.debug("Dispatching chat list mutations:", changedChats)
			window.__mautrixReceiveChanges(Array.from(changedChats)).then(
				() => console.debug("Chat list mutations dispatched"),
				err => console.error("Error dispatching chat list mutations:", err))
		}
	}

	/**
	 * Add a mutation observer to the chat list.
	 */
	addChatListObserver() {
		this.removeChatListObserver()
		this.chatListObserver = new MutationObserver(async (mutations) => {
			if (this._isWaitingForOwnMessage()) {
				// Wait for pending sent messages to be resolved before responding to mutations
				try {
					await this.ownMsgPromise
				} catch (e) {}
			}

			try {
				this._observeChatListMutations(mutations)
			} catch (err) {
				console.error("Error observing chat list mutations:", err)
			}
		})
		this.chatListObserver.observe(
			document.querySelector("#_chat_list_body"),
			{ childList: true, subtree: true })
		console.log("Started chat list observer")
	}

	/**
	 * Disconnect the most recently added mutation observer.
	 */
	removeChatListObserver() {
		if (this.chatListObserver !== null) {
			this.chatListObserver.disconnect()
			this.chatListObserver = null
			console.log("Disconnected chat list observer")
		}
	}

	/**
	 * @typedef ReceiptData
	 * @type {object}
	 * @property {number}  id     - The ID of the read message.
	 * @property {?number} count  - The number of users who have read the message.
	 */

	/**
	 * @param {MutationRecord[]} mutations - The mutation records that occurred
	 * @param {string} chatID - The ID of the chat being observed.
	 * @private
	 */
	_observeReceiptsDirect(mutations, chatID) {
		let receipt_id
		for (const change of mutations) {
			if ( change.target.classList.contains("mdRGT07Read") &&
				!change.target.classList.contains("MdNonDisp")) {
				const msgElement = change.target.closest(".mdRGT07Own")
				if (msgElement) {
					const id = +msgElement.getAttribute("data-local-id")
					if (!receipt_id || receipt_id < id) {
						receipt_id = id
					}
				}
			}
		}

		if (receipt_id) {
			window.__mautrixReceiveReceiptDirectLatest(chatID, receipt_id).then(
				() => console.debug(`Receipt sent for message ${receipt_id}`),
				err => console.error(`Error sending receipt for message ${receipt_id}:`, err))
		}
	}

	/**
	 * @param {MutationRecord[]} mutations - The mutation records that occurred
	 * @param {string} chatID - The ID of the chat being observed.
	 * @private
	 */
	_observeReceiptsMulti(mutations, chatID) {
		const ids = new Set()
		const receipts = []
		for (const change of mutations) {
			const target = change.type == "characterData" ? change.target.parentElement : change.target
			if ( target.classList.contains("mdRGT07Read") &&
				!target.classList.contains("MdNonDisp"))
			{
				const msgElement = target.closest(".mdRGT07Own")
				if (msgElement) {
					const id = +msgElement.getAttribute("data-local-id")
					if (!ids.has(id)) {
						ids.add(id)
						receipts.push({
							id: id,
							count: this._getReceiptCount(target),
						})
					}
				}
			}
		}

		if (receipts.length > 0) {
			window.__mautrixReceiveReceiptMulti(chatID, receipts).then(
				() => console.debug(`Receipts sent for ${receipts.length} messages`),
				err => console.error(`Error sending receipts for ${receipts.length} messages`, err))
		}
	}

	/**
	 * @typedef PendingMessage
	 * @type object
	 *
	 * @property {Promise<MessageData>} promise
	 * @property {number} id
	 */

	/**
	 * @typedef SameIDMsgs
	 * @type object
	 *
	 * @property {number} id
	 * @property {PendingMessage[]} msgs
	 * @property {Function} resolve
	 * @property {number} numRejected
	 */

	/**
	 * Binary search for the array of messages with the provided ID.
	 *
	 * @param {SameIDMsgs[]} sortedSameIDMsgs
	 * @param {number} id
	 * @param {boolean} returnClosest - If true, return the index of the nearest result on miss instead of -1.
	 * @return {number} The index of the matched element, or -1 if not found.
	 * @private
	 */
	_findMsgsForID(
		sortedSameIDMsgs, id, returnClosest = false,
		lowerBound = 0, upperBound = sortedSameIDMsgs.length - 1)
	{
		if (lowerBound > upperBound) {
			return -1
		}
		if (returnClosest && lowerBound == upperBound) {
			// Caller must check if the result has a matching ID or not
			return sortedSameIDMsgs[lowerBound].id <= id ? lowerBound : lowerBound-1
		}
		const i = lowerBound + Math.floor((upperBound - lowerBound)/2)
		const val = sortedSameIDMsgs[i]
		if (val.id == id) {
			return i
		} else if (val.id < id) {
			return this._findMsgsForID(
				sortedSameIDMsgs, id, returnClosest,
				i+1, upperBound)
		} else {
			return this._findMsgsForID(
				sortedSameIDMsgs, id, returnClosest,
				lowerBound, i-1)
		}
	}

	/**
	 * Insert the given message to the proper inner array.
	 * In no inner array exists, insert a new one, preserving sort order.
	 * Return the wrapper of which inner array was added to or created.
	 *
	 * @param {SameIDMsgs[]} sortedSameIDMsgs
	 * @param {PendingMessage} msg
	 * @return {SameIDMsgs}
	 * @private
	 */
	_insertMsgByID(sortedSameIDMsgs, msg) {
		let i = this._findMsgsForID(sortedSameIDMsgs, msg.id, true)
		if (i != -1 && sortedSameIDMsgs[i].id == msg.id) {
			sortedSameIDMsgs[i].msgs.push(msg)
			console.debug("UNLIKELY(?) EVENT -- Found two new message elements with the same ID, so tracking both of them")
		} else {
			sortedSameIDMsgs.splice(++i, 0, {
				id: msg.id,
				msgs: [msg],
				numRejected: 0,
				resolve: null,
			})
		}
		return sortedSameIDMsgs[i]
	}

	/**
	 * Add a mutation observer to the message list of the current chat.
	 * Used for observing new messages & read receipts.
	 *
	 * @param {?number} minID - The minimum message ID to consider.
	 */
	addMsgListObserver(minID = 0) {
		const chat_room_msg_list = document.querySelector("#_chat_room_msg_list")
		if (!chat_room_msg_list) {
			console.debug("Could not start msg list observer: no msg list available!")
			return
		}
		this.removeMsgListObserver()

		const chatID = this.getCurrentChatID()
		const chatType = this.getChatType(chatID)

		// NEED TO HANDLE:
		// * message elements arriving in any order
		// * messages being potentially pending (i.e. decrypting or loading),
		//   and resolving in a potentially different order than they arrived in
		// * pending messages potentially having multiple elements associated with
		//   them, where only one of them resolves
		// * message elements being added/removed any number of times, which may
		//   or may not ever resolve
		// * outgoing messages (i.e. sent by the bridge)
		// And must send resolved messages to the bridge *in order*!
		// BUT: Assuming that incoming messages will never be younger than a resolved one.

		const sortedSameIDMsgs = []
		const pendingMsgElements = new Set()

		this.msgListObserver = new MutationObserver(changes => {
			console.debug(`MESSAGE LIST CHANGES: check since ${minID}`)
			const remoteMsgs = []
			for (const change of changes) {
				console.debug("---new change set---")
				for (const child of change.addedNodes) {
					if (!pendingMsgElements.has(child) &&
						child.tagName == "DIV" &&
						child.hasAttribute("data-local-id") &&
						// Skip timestamps, as these are always current
						child.classList.contains("MdRGT07Cont"))
					{
						const msgID = +child.getAttribute("data-local-id")
						if (msgID > minID) {
							pendingMsgElements.add(child)

							// TODO Maybe handle own messages somewhere else...?
							const ownMsg = this._observeOwnMessage(child)
							if (ownMsg) {
								console.log("Found own bridge-sent message, will wait for it to resolve")
								console.debug(child)
								this.ownMsgPromise
								.then(msgID => {
									console.log("Resolved own bridge-sent message")
									console.debug(ownMsg)
									pendingMsgElements.delete(ownMsg)
									if (minID < msgID) {
										minID = msgID
									}
								})
								.catch(() => {
									console.log("Rejected own bridge-sent message")
									console.debug(ownMsg)
									pendingMsgElements.delete(ownMsg)
								})
							} else {
								console.log("Found remote message")
								console.debug(child)
								remoteMsgs.push({
									id: msgID,
									element: child
								})
							}
						}
					}
				}
				// NOTE Ignoring removedNodes because an element can always be added back.
				//      Will simply let permanently-removed nodes time out.
			}
			if (remoteMsgs.length == 0) {
				console.debug("Found no new remote messages")
				return
			}

			// No need to sort remoteMsgs, because sortedSameIDMsgs is enough
			for (const msg of remoteMsgs) {
				const messageElement = msg.element
				const pendingMessage = {
					id: msg.id,
					promise: this._parseMessage(messageElement, chatType)
				}
				const sameIDMsgs = this._insertMsgByID(sortedSameIDMsgs, pendingMessage)

				const handleMessage = async (messageData) => {
					minID = messageData.id
					sortedSameIDMsgs.shift()
					await window.__mautrixReceiveMessages(chatID, [messageData])
					if (sortedSameIDMsgs.length > 0 && sortedSameIDMsgs[0].resolve) {
						console.debug("Allowing queued resolved message to be sent")
						console.debug(sortedSameIDMsgs[0])
						sortedSameIDMsgs[0].resolve()
					}
				}

				pendingMessage.promise.then(
				async (messageData) => {
					const i = this._findMsgsForID(sortedSameIDMsgs, messageData.id)
					if (i == -1) {
						console.debug(`Got resolved message for already-handled ID ${messageData.id}, ignore it`)
						pendingMsgElements.delete(messageElement)
						return
					}
					if (i != 0) {
						console.debug(`Got resolved message for later ID ${messageData.id}, wait for earlier messages`)
						await new Promise(resolve => sameIDMsgs.resolve = resolve)
						console.debug(`Message before ID ${messageData.id} finished, can now send this one`)
					} else {
						console.debug(`Got resolved message for earliest ID ${messageData.id}, send it`)
					}
					console.debug(messageElement)
					pendingMsgElements.delete(messageElement)
					handleMessage(messageData)
				},
				// error case
				async (messageData) => {
					console.debug("Message element rejected")
					console.debug(messageElement)
					pendingMsgElements.delete(messageElement)
					if (++sameIDMsgs.numRejected == sameIDMsgs.msgs.length) {
						// Note that if another message element with this ID somehow comes later, it'll be ignored.
						console.debug(`All messages for ID ${sameIDMsgs.id} rejected, abandoning this ID and sending dummy message`)
						// Choice of which message to send should be arbitrary
						handleMessage(messageData)
					}
				})
			}
		})
		this.msgListObserver.observe(
			chat_room_msg_list,
			{ childList: true })

		console.debug(`Started msg list observer with minID = ${minID}`)


		const observeReadReceipts = (
			chatType == ChatTypeEnum.DIRECT ?
			this._observeReceiptsDirect :
			this._observeReceiptsMulti
			).bind(this)

		this.receiptObserver = new MutationObserver(changes => {
			try {
				observeReadReceipts(changes, chatID)
			} catch (err) {
				console.error("Error observing msg list mutations:", err)
			}
		})
		this.receiptObserver.observe(
			chat_room_msg_list, {
				subtree: true,
				attributes: true,
				attributeFilter: ["class"],
				characterData: chatType != ChatTypeEnum.DIRECT,
			})

		console.debug("Started receipt observer")
	}

	_observeOwnMessage(ownMsg) {
		if (!this._isWaitingForOwnMessage()) {
			return null
		}

		const successElement =
			ownMsg.querySelector(this.promiseOwnMsgSuccessSelector)
		if (successElement) {
			if (successElement.classList.contains("MdNonDisp")) {
				console.log("Invisible success for own bridge-sent message, will wait for it to resolve")
				console.log(successElement)
			} else {
				console.debug("Already visible success, must not be it")
				console.debug(successElement)
				return null
			}
		} else {
			return null
		}

		const failureElement =
			this.promiseOwnMsgFailureSelector &&
			ownMsg.querySelector(this.promiseOwnMsgFailureSelector)
		if (failureElement) {
			if (failureElement.classList.contains("MdNonDisp")) {
				console.log("Invisible failure for own bridge-sent message, will wait for it (or success) to resolve")
				console.log(failureElement)
			} else {
				console.debug("Already visible failure, must not be it")
				console.log(failureElement)
				return null
			}
		} else if (this.promiseOwnMsgFailureSelector) {
			return null
		}

		const msgID = +ownMsg.getAttribute("data-local-id")
		this.visibleSuccessObserver = new MutationObserver(
			this._getOwnVisibleCallback(msgID))
		this.visibleSuccessObserver.observe(
			successElement,
			{ attributes: true, attributeFilter: ["class"] })

		if (this.promiseOwnMsgFailureSelector) {
			this.visibleFailureObserver = new MutationObserver(
				this._getOwnVisibleCallback())
			this.visibleFailureObserver.observe(
				failureElement,
				{ attributes: true, attributeFilter: ["class"] })
		}

		return ownMsg
	}

	_getOwnVisibleCallback(msgID=null) {
		const isSuccess = !!msgID
		return changes => {
			for (const change of changes) {
				if (!change.target.classList.contains("MdNonDisp")) {
					console.log(`Resolved ${isSuccess ? "success" : "failure"} for own bridge-sent message`)
					console.log(change.target)
					isSuccess ? this._resolveOwnMessage(msgID) : this._rejectOwnMessage(change.target)
					return
				}
			}
		}
	}

	_resolveOwnMessage(msgID) {
		if (!this.promiseOwnMsgResolve) return
		clearTimeout(this.promiseOwnMsgTimeoutID)
		const resolve = this.promiseOwnMsgResolve
		this._promiseOwnMsgReset()

		resolve(msgID)
	}

	_rejectOwnMessage(failureElement = null) {
		if (!this.promiseOwnMsgReject) return
		const reject = this.promiseOwnMsgReject
		this._promiseOwnMsgReset()

		reject(failureElement)
	}

	_promiseOwnMsgReset() {
		this.promiseOwnMsgSuccessSelector = null
		this.promiseOwnMsgFailureSelector = null
		this.promiseOwnMsgResolve = null
		this.promiseOwnMsgReject = null
		this.promiseOwnMsgTimeoutID = null

		if (this.visibleSuccessObserver) {
			this.visibleSuccessObserver.disconnect()
		}
		this.visibleSuccessObserver = null
		if (this.visibleFailureObserver) {
			this.visibleFailureObserver.disconnect()
		}
		this.visibleFailureObserver = null
	}

	removeMsgListObserver() {
		let result = false
		if (this.msgListObserver !== null) {
			this.msgListObserver.disconnect()
			this.msgListObserver = null
			console.debug("Disconnected msg list observer")
			result = true
		}
		if (this.receiptObserver !== null) {
			this.receiptObserver.disconnect()
			this.receiptObserver = null
			console.debug("Disconnected receipt observer")
			result = true
		}
		return result
	}

	addQRChangeObserver(element) {
		this.removeQRChangeObserver()
		this.qrChangeObserver = new MutationObserver(changes => {
			for (const change of changes) {
				if (change.attributeName === "title" && change.target instanceof Element) {
					window.__mautrixReceiveQR(change.target.getAttribute("title"))
				}
			}
		})
		this.qrChangeObserver.observe(element, {
			attributes: true,
			attributeFilter: ["title"],
		})
	}

	removeQRChangeObserver() {
		if (this.qrChangeObserver !== null) {
			this.qrChangeObserver.disconnect()
			this.qrChangeObserver = null
		}
	}

	addQRAppearObserver(element) {
		this.removeQRAppearObserver()
		this.qrAppearObserver = new MutationObserver(changes => {
			for (const change of changes) {
				for (const node of change.addedNodes) {
					const qrElement = node.querySelector("#login_qrcode_area div[title]")
					if (qrElement) {
						window.__mautrixReceiveQR(qrElement.title)
						window.__mautrixController.addQRChangeObserver(element)
						return
					}
				}
			}
		})
		this.qrAppearObserver.observe(element, {
			childList: true,
		})
	}

	removeQRAppearObserver() {
		if (this.qrAppearObserver !== null) {
			this.qrAppearObserver.disconnect()
			this.qrAppearObserver = null
		}
	}

	addEmailAppearObserver(element) {
		this.removeEmailAppearObserver()
		this.emailAppearObserver = new MutationObserver(changes => {
			for (const change of changes) {
				for (const node of change.addedNodes) {
					const emailArea = node.querySelector("#login_email_area")
					if (emailArea && !emailArea.classList.contains("MdNonDisp")) {
						window.__mautrixSendEmailCredentials()
						return
					}
				}
			}
		})
		this.emailAppearObserver.observe(element, {
			childList: true,
		})
	}

	removeEmailAppearObserver() {
		if (this.emailAppearObserver !== null) {
			this.emailAppearObserver.disconnect()
			this.emailAppearObserver = null
		}
	}

	addPINAppearObserver(element) {
		this.removePINAppearObserver()
		this.pinAppearObserver = new MutationObserver(changes => {
			for (const change of changes) {
				for (const node of change.addedNodes) {
					const pinElement = node.querySelector("div.mdCMN01Code")
					if (pinElement) {
						window.__mautrixReceivePIN(pinElement.innerText)
						return
					}
				}
			}
		})
		this.pinAppearObserver.observe(element, {
			childList: true,
		})
	}

	removePINAppearObserver() {
		if (this.pinAppearObserver !== null) {
			this.pinAppearObserver.disconnect()
			this.pinAppearObserver = null
		}
	}

}

window.__mautrixController = new MautrixController()

/**
 * Watch for an error dialog / PIN expiry dialog to appear, and click its "OK" button.
 * Must watch for both its parent appearing & it being added to its parent in the first place.
 * TODO Clean up dialog message promise
 */
const layer = document.querySelector("#layer_contents")
var resolveDialogMessage
var promiseDialogMessage = new Promise(resolve => {resolveDialogMessage = resolve})
new MutationObserver(async () => {
	if (!layer.classList.contains("MdNonDisp")) {
		const button = layer.querySelector("dialog button")
		if (button) {
			const dialogMessage = layer.querySelector("dialog p")?.innerText
			console.log("Popup appeared, clicking OK button to continue")
			button.click()
			resolveDialogMessage(dialogMessage)
		}
	}
}).observe(layer, {
	attributes: true,
	attributeFilter: ["class"],
	childList: true,
})

/**
 * Watch for being logged out.
 */
const mainApp = document.querySelector("#mainApp")
new MutationObserver(async () => {
	if (mainApp.classList.contains("MdNonDisp")) {
		const dialogMessage = await promiseDialogMessage
		promiseDialogMessage = new Promise(resolve => {resolveDialogMessage = resolve})
		await window.__mautrixLoggedOut(dialogMessage)
	}
}).observe(mainApp, {
	attributes: true,
	attributeFilter: ["class"],
})
