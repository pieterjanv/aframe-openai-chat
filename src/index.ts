import type { ChatCompletionAssistantMessageParam, ChatCompletionSystemMessageParam, ChatCompletionUserMessageParam } from "openai/resources/index.mjs";
import { Recorder } from "./Recorder";
import { DetailEvent } from "aframe";

type ChatMessage =
	| ChatCompletionSystemMessageParam
	| ChatCompletionUserMessageParam
	| ChatCompletionAssistantMessageParam;

type Chat = Array<ChatMessage>;

enum TtsVoice {
	alloy = 'alloy',
	echo = 'echo',
	fable = 'fable',
	onyx = 'onyx',
	nova = 'nova',
	shimmer = 'shimmer',
}

const defaultVoice = TtsVoice.nova;

type Body = {
	sttModel?: string,
	chatModel?: string,
	ttsModel?: string,
	voice?: TtsVoice,
	chat: Chat,
	input: string,
	inputFromat?: 'string',
	speakerName?: string,
	outputFormat?: 'opus' | 'mp3' | 'aac' | 'flac',
};

AFRAME.registerComponent<{
	history: Chat,
	isSomeoneResponding: boolean,
	isToListen: boolean,
	isListening: boolean,
	isSomeoneListening: boolean,
	audioMessage: string,
	isRecording: boolean,
	recorder: Recorder,
	soundComponentId: string,
	mouseDownPosition: { x: number, y: number },
	actionListener: () => Promise<void>,
	cancelListener: () => void,
	send: () => Promise<void>,
	processChunkPart: (
		phase: ParseChunkPhase,
		fragment: ArrayBuffer,
		buffer: ArrayBuffer,
		offset: number,
		length: number,
		callback: (chunkPart: ArrayBuffer) => void,
	) => { fragment: ArrayBuffer, phase: ParseChunkPhase, bytesRead: number },
	combineFragments: (
		oldFragment: ArrayBuffer,
		buffer: ArrayBuffer,
		offset: number,
		length: number,
	) => { chunkPart: ArrayBuffer, remainder: number },
	toBase64: (blob: Blob) => Promise<string>,
	toDataUrl: (blob: Blob) => Promise<string>,
	createEventDetail: <T extends Record<string, unknown>>(data: T) => { id: string } & T,
	log: (...messages: unknown[]) => void,
}>('openai-chat', {

	schema: {
		actionEvent: { type: 'string' },
		cancelEvent: { type: 'string' },
		startListeningEvent: { type: 'string' },
		stopListeningEvent: { type: 'string' },
		systemPrompt: { type: 'string', default: 'You are a helpful assistant. You are embodied in a virtual reality, and receive queries from other inhabitants. Keep your answers short, suitable for a spoken conversation.' },
		name: { type: 'string', default: 'assistant' },
		voice: { type: 'string', default: defaultVoice },
		senderName: { type: 'string', default: 'user' },
		historyContainer: { type: 'selector' },
		endpoint: { type: 'string', default: 'http://localhost:8000/voice' },
		sttModel: { type: 'string', default: 'whisper-1' },
		chatModel: { type: 'string', default: 'gpt-3.5-turbo' },
		ttsModel: { type: 'string', default: 'tts-1' },
		debug: { type: 'boolean', default: false },
	},

	history: [],

	isSomeoneResponding: false,

	isToListen: false,

	isListening: false,

	isSomeoneListening: false,

	audioMessage: '',

	isRecording: false,

	recorder: new Recorder(),

	soundComponentId: 'openai-chat',

	mouseDownPosition: { x: 0, y: 0 },

	init() {

		if (!this.data.actionEvent || !this.data.cancelEvent || !this.data.startListeningEvent || !this.data.stopListeningEvent) {
			throw new Error('Missing event name');
		}

		if (this.data.historyContainer) {
			this.data.historyContainer.openAiChatHistory ??= [];
			this.history = this.data.historyContainer.openAiChatHistory;
		}

		if (!this.history.length) {
			this.history.push({ role: 'system', content: this.data.systemPrompt });
		}

		this.el.addEventListener('sound-loaded', (e) => {
			if ((e as DetailEvent<{ id: string }>).detail.id !== this.soundComponentId) {
				return;
			}
			this.log('sound loaded');
			(this.el.components[`sound__${this.soundComponentId}`] as any).playSound();
			this.el.emit('start-response-audio', this.createEventDetail({}), true);
		});

		this.el.sceneEl!.addEventListener('stop-recording', () => {
			this.isSomeoneResponding = true;
		});

		this.el.sceneEl!.addEventListener('cancel-recording', () => {
			this.isSomeoneResponding = false;
		});

		this.el.sceneEl!.addEventListener('stop-response-audio', () => {
			this.isSomeoneResponding = false;
		});

		this.el.sceneEl!.addEventListener('start-listening', () => {
			this.isSomeoneListening = true;
		});

		this.el.sceneEl!.addEventListener('stop-listening', () => {
			this.isSomeoneListening = false;
		});

		this.el.sceneEl!.addEventListener('stop-response-audio', () => {
			if (!this.isToListen) {
				return;
			}
			this.el.emit(this.data.startListeningEvent);
		});

		this.el.addEventListener(this.data.startListeningEvent, () => {
			this.isToListen = true;
			if (this.isSomeoneListening) {
				return;
			}
			this.log('start listening');
			this.el.emit('start-listening', this.createEventDetail({}), true);
			this.isListening = true;
			this.isSomeoneListening = true;
		});
		this.el.addEventListener(this.data.stopListeningEvent, () => {
			this.isToListen = false;
			if (!this.isListening || this.isRecording) {
				return;
			}
			this.log('stop listening');
			this.el.emit('stop-listening', this.createEventDetail({}), true);
			this.isListening = false;
			this.isSomeoneListening = false;
		});

		this.actionListener = this.actionListener.bind(this);
		this.el.addEventListener(this.data.actionEvent, this.actionListener);
		this.el.sceneEl!.addEventListener('mousedown', (e) => {
			if (!(e instanceof MouseEvent) || e.button !== 0) {
				return;
			}
			const mouseEvent = e;
			this.log('mouse down', e);
			this.mouseDownPosition.x = mouseEvent.clientX;
			this.mouseDownPosition.y = mouseEvent.clientY;
		});
		this.el.sceneEl!.addEventListener('mouseup', (e) => {
			if (!(e instanceof MouseEvent) || e.button !== 0) {
				return;
			}
			const mouseEvent = e;
			this.log('mouse up', e);
			if ((
				(mouseEvent.clientX - this.mouseDownPosition.x) ** 2 +
				(mouseEvent.clientY - this.mouseDownPosition.y) ** 2
			) > 9) {
				this.log('mouse dragged');
				return;
			}
			this.log('mouse clicked');
			this.actionListener();
		});

		this.cancelListener = this.cancelListener.bind(this);
		this.el.addEventListener(this.data.cancelEvent, this.cancelListener);
	},

	async actionListener(): Promise<void> {
		this.log('action button clicked');
		if (this.isRecording) {
			this.log('stop recording');
			const blob = await this.recorder.stop();
			this.isRecording = false;
			this.el.emit('stop-recording', this.createEventDetail({}), true);
			this.el.emit(this.data.stopListeningEvent);
			this.audioMessage = await this.toBase64(blob);
			this.send();
			this.el.emit('send-query', this.createEventDetail({}), true);
			return;
		}

		if (!this.isListening) {
			return;
		}

		this.log('start recording');
		await this.recorder.start();
		this.isRecording = true;
		this.el.emit('start-recording', this.createEventDetail({}), true);
	},

	async cancelListener(): Promise<void> {
		this.log('cancel button clicked');
		if (!this.isRecording) {
			return;
		}
		await this.recorder.stop();
		this.isRecording = false;
		this.el.emit(this.data.stopListeningEvent);
		this.el.emit('stop-recording', this.createEventDetail({}), true);
		this.el.emit('cancel-recording', this.createEventDetail({}), true);
	},

	async send() {

		const historyCopy: Chat = [];
		for (const message of this.history) {
			if (message.role === 'assistant' && message.name !== this.data.name) {
				historyCopy.push({ role: 'user' as const, content: message.content ?? '', name: message.name });
				continue;
			};
			historyCopy.push(message);
		}
		historyCopy[0] = { role: 'system', content: this.data.systemPrompt };
		this.log('sending adapted chat history', historyCopy);

		const body: Body = {
			chat: historyCopy,
			input: this.audioMessage,
			chatModel: this.data.chatModel,
			sttModel: this.data.sttModel,
			ttsModel: this.data.ttsModel,
			voice: this.data.voice,
			speakerName: this.data.senderName,
			outputFormat: 'aac',
		};

		const response = await fetch(this.data.endpoint, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(body),
		});
		if (!(response.ok && response.body)) {
			response.json().then(console.error);
			return;
		}

		let phase: ParseChunkPhase = ParseChunkPhase.queryLength;
		let fragment: ArrayBuffer = new ArrayBuffer(0);
		let queryLength = 0;
		let responseTextLength = 0;
		let responseAudioLength = 0;
		const responseAudioFileUrls: string[] = [];
		let isQueueReady = false;
		let isQueueComplete = false;
		let assistantMessageText = '';
		const reader = response.body.getReader();

		const read = async () => {

			const { value, done } = await reader.read();

			if (done) {
				const assistantMessage = { role: 'assistant' as const, content: assistantMessageText, name: this.data.name };
				this.history.push(assistantMessage);
				this.log('history', this.history);
				this.el.emit('response-text', this.createEventDetail({ response: assistantMessage }), true);
				this.el.emit('parsing-complete', this.createEventDetail({}), true);
				isQueueComplete = true;
				return;
			}

			let byteLength = value.buffer.byteLength;
			let bytesRead = 0;
			let query = '';
			let responseText = '';
			const start = Date.now();

			while (bytesRead < byteLength && Date.now() - start < 1000) {
				switch (phase) {
					case ParseChunkPhase.queryLength:
						({ fragment, phase, bytesRead } = this.processChunkPart(
							phase,
							fragment,
							value.buffer,
							bytesRead,
							4,
							(chunkPart) => {
								queryLength = (new Uint32Array(chunkPart))[0];
							},
						));
						break;
					case ParseChunkPhase.query:
						({ fragment, phase, bytesRead } = this.processChunkPart(
							phase,
							fragment,
							value.buffer,
							bytesRead,
							queryLength,
							(chunkPart) => {
								query = new TextDecoder().decode(chunkPart);
								const userMessage = { role: 'user' as const, content: query, name: this.data.senderName };
								this.history.push(userMessage);
								this.el.emit('query-text', this.createEventDetail({ query: userMessage }), true);
							},
						));
						break;
					case ParseChunkPhase.responseTextLength:
						({ fragment, phase, bytesRead } = this.processChunkPart(
							phase,
							fragment,
							value.buffer,
							bytesRead,
							4,
							(chunkPart) => {
								responseTextLength = (new Uint32Array(chunkPart))[0];
							},
						));
						break;
					case ParseChunkPhase.responseText:
						({ fragment, phase, bytesRead } = this.processChunkPart(
							phase,
							fragment,
							value.buffer,
							bytesRead,
							responseTextLength,
							(chunkPart) => {
								responseText = new TextDecoder().decode(chunkPart);
								assistantMessageText += responseText;
							},
						));
						break;
					case ParseChunkPhase.responseAudioLength:
						({ fragment, phase, bytesRead } = this.processChunkPart(
							phase,
							fragment,
							value.buffer,
							bytesRead,
							4,
							(chunkPart) => {
								responseAudioLength = (new Uint32Array(chunkPart))[0];
							},
						));
						break;
					case ParseChunkPhase.responseAudio:
						({ fragment, phase, bytesRead } = this.processChunkPart(
							phase,
							fragment,
							value.buffer,
							bytesRead,
							responseAudioLength,
							(chunkPart) => {
								this.log('queueing audio')
								const file = new File([new Uint8Array(chunkPart)], 'response.aac', { type: 'audio/aac' });
								const url = URL.createObjectURL(file);
								this.el.emit('response-audio-part', this.createEventDetail({ audio: url }), true);
								responseAudioFileUrls.push(url);
								isQueueReady = true;
							},
						));
						break;
				}
			}

			this.log('finished on phase', phase);

			read();
		}

		const queueAudioFile = () => {

			this.el.removeEventListener('sound-ended', queueAudioFile);
			const url = responseAudioFileUrls.shift();
			if (!url) {
				if (!isQueueComplete) {
					setTimeout(queueAudioFile, 50);
					return;
				}
				this.el.emit('stop-response-audio', this.createEventDetail({}), true);
				return;
			}

			this.log('setting audio file');
			this.el.setAttribute(`sound__${this.soundComponentId}`, { src: url });
			this.el.addEventListener('sound-ended', queueAudioFile);
		};

		const startQueue = setInterval(() => {
			if (!isQueueReady) {
				return;
			}
			clearInterval(startQueue);
			isQueueReady = false;
			queueAudioFile();
		}, 50);

		await read();
	},

	processChunkPart(
		phase: ParseChunkPhase,
		fragment: ArrayBuffer,
		buffer: ArrayBuffer,
		offset: number,
		length: number,
		callback: (chunkPart: ArrayBuffer) => void,
	): { fragment: ArrayBuffer, phase: ParseChunkPhase, bytesRead: number } {
		this.log('phase', phase);
		const { chunkPart, remainder } = this.combineFragments(fragment, buffer, offset, length);
		this.log('chunkPart length', chunkPart.byteLength);
		const bytesRead = offset + chunkPart.byteLength;
		fragment = remainder > 0 ? chunkPart : new ArrayBuffer(0);
		if (remainder > 0) {
			this.log('remainder', remainder);
			return { fragment, phase, bytesRead };
		}
		callback(chunkPart);
		phase = (phase + 1) % parseChunkPhaseLength;
		return { fragment, phase, bytesRead }
	},

	combineFragments(oldFragment: ArrayBuffer, buffer: ArrayBuffer, offset: number, length: number) {
		const newFragment = buffer.slice(offset, offset + length - oldFragment.byteLength);
		const chunkPart = new Uint8Array(oldFragment.byteLength + newFragment.byteLength);
		chunkPart.set(new Uint8Array(oldFragment), 0);
		chunkPart.set(new Uint8Array(newFragment), oldFragment.byteLength);
		const remainder = length - chunkPart.byteLength;
		return { chunkPart: chunkPart.buffer, remainder };
	},

	async toBase64(blob: Blob) {
		return (await this.toDataUrl(blob)).split(',')[1];
	},

	async toDataUrl(blob: Blob): Promise<string> {
		return new Promise(resolve => {
			const reader = new FileReader;
			reader.onload = e => {
				resolve(reader.result as string);
			};
			reader.readAsDataURL(blob);
		});
	},

	createEventDetail<T extends Record<string, unknown>>(data: T) {
		return { id: this.el.id, ...data };
	},

	log(...messages: unknown[]) {
		if (this.data.debug) {
			console.log(...messages);
		}
	},
});

enum ParseChunkPhase {
	queryLength = 0,
	query = 1,
	responseTextLength = 2,
	responseText = 3,
	responseAudioLength = 4,
	responseAudio = 5,
}

const parseChunkPhaseLength = (Object.values(ParseChunkPhase).reduce((a, b) => isNaN(Number(b)) ? a + 1 : a, 0));
