import type { ChatCompletionAssistantMessageParam, ChatCompletionSystemMessageParam, ChatCompletionUserMessageParam } from "openai/resources/index.mjs";
import { Recorder } from "./Recorder";
import { Component } from "aframe";

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
	speakerName?: string,
};

AFRAME.registerComponent<{
	history: Chat,
	audioMessage: string,
	isListening: boolean,
	recording: boolean,
	recorder: Recorder,
	output: Component | undefined,
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
	log: (...messages: unknown[]) => void,
}>('openai-chat', {

	schema: {
		actionEvent: { type: 'string' },
		cancelEvent: { type: 'string' },
		systemPrompt: { type: 'string', default: 'You are a helpful assistant. You are embodied in a virtual reality, and receive queries from other inhabitants. Keep your answers short, suitable for a spoken conversation.' },
		name: { type: 'string', default: 'openai-chat' },
		voice: { type: 'string', default: defaultVoice },
		senderName: { type: 'string', default: 'user' },
		historyContainer: { type: 'selector' },
		isMuted: { type: 'boolean', default: false },
		startListeningEvent: { type: 'string' },
		stopListeningEvent: { type: 'string' },
		endpoint: { type: 'string', default: 'http://localhost:8001/voice' },
		sttModel: { type: 'string', default: 'whisper-1' },
		chatModel: { type: 'string', default: 'gpt-3.5-turbo' },
		ttsModel: { type: 'string', default: 'tts-1' },
		debug: { type: 'boolean', default: false },
	},

	history: [],

	audioMessage: '',

	isListening: false,

	recording: false,

	recorder: new Recorder(),

	output: undefined,

	init() {

		if (this.data.historyContainer) {
			this.data.historyContainer.openAiChatHistory ??= [];
			this.history = this.data.historyContainer.openAiChatHistory;
		}

		if (!this.history.length) {
			this.history.push({ role: 'system', content: this.data.systemPrompt });
		}

		if (!this.data.isMuted) {
			this.el.addEventListener('sound-loaded', () => {
				this.log('sound loaded');
				(this.el.components.sound as any).playSound();
				this.el.emit('start-response-audio', undefined, true);
			})
		}

		this.el.addEventListener(this.data.startListeningEvent, () => {
			this.el.emit('start-listening');
			this.isListening = true;
		});
		this.el.addEventListener(this.data.stopListeningEvent, () => {
			this.el.emit('stop-listening');
			this.isListening = false;
		});

		this.actionListener = this.actionListener.bind(this);
		this.el.addEventListener(this.data.actionEvent, this.actionListener);
		this.el.addEventListener('click', this.actionListener);

		this.cancelListener = this.cancelListener.bind(this);
		this.el.addEventListener(this.data.cancelEvent, this.cancelListener);
	},

	async actionListener(): Promise<void> {

		this.log('action button clicked');
		if (this.recording) {
			const blob = await this.recorder.stop();
			this.recording = false;
			this.el.emit('stop-recording', undefined, true);
			this.audioMessage = await this.toBase64(blob);
			this.send();
			this.el.emit('send-message');
			return;
		}

		if (!this.isListening) {
			return;
		}

		this.log('start recording');
		await this.recorder.start();
		this.recording = true;
		this.el.emit('start-recording', undefined, true);
	},

	async cancelListener(): Promise<void> {
		this.log('cancel button clicked');
		if (!this.recording) {
			return;
		}
		await this.recorder.stop();
		this.recording = false;
		this.el.emit('stop-recording', undefined, true);
		this.el.emit('cancel-recording');
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
				this.el.emit('assistant-message', assistantMessage);
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
								this.el.emit('user-message', userMessage);
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
								const file = new File([new Uint8Array(chunkPart)], 'response.opus', { type: 'audio/opus' });
								const url = URL.createObjectURL(file);
								this.el.emit('assistant-audio-part', url);
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

			if (this.data.isMuted) {
				return;
			}

			this.el.removeEventListener('sound-ended', queueAudioFile);
			const url = responseAudioFileUrls.shift();
			if (!url) {
				if (!isQueueComplete) {
					setTimeout(queueAudioFile, 50);
					return;
				}
				this.el.emit('stop-response-audio', undefined, true);
				return;
			}

			this.log('setting audio file');
			this.el.setAttribute('sound', { src: url });
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
