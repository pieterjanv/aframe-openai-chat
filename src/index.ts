import type { ChatCompletionAssistantMessageParam, ChatCompletionSystemMessageParam, ChatCompletionUserMessageParam } from "openai/resources/index.mjs";
import { Recorder } from "./Recorder";
import { Entity } from "aframe";

type Chat = Array<
	| ChatCompletionSystemMessageParam
	| ChatCompletionUserMessageParam
	| ChatCompletionAssistantMessageParam
>;

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
	speakerName?: string,
	sttModel?: string,
	chatModel?: string,
	ttsModel?: string,
	voice?: TtsVoice,
	chat: Chat,
	audio: string,
};

AFRAME.registerComponent<{
	chatStatusIndicator: Entity,
	history: Chat,
	audioMessage: string,
	hovered: boolean,
	recording: boolean,
	recorder: Recorder,
	output: Entity,
	actionListener: () => Promise<void>,
	cancelListener: () => void,
	updateStatusIndicator: () => void,
	send: () => Promise<void>,
	processChunkPart: (
		phase: ParseChunkPartPhase,
		fragment: ArrayBuffer,
		buffer: ArrayBuffer,
		offset: number,
		length: number,
		callback: (chunkPart: ArrayBuffer) => void,
	) => { fragment: ArrayBuffer, phase: ParseChunkPartPhase, bytesRead: number },
	addChunkPart: (
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
		controller: { type: 'selector' },
		camera: { type: 'selector' },
		endpoint: { type: 'string', default: 'http://localhost:8001/voice' },
		sttModel: { type: 'string', default: 'whisper-1' },
		chatModel: { type: 'string', default: 'gpt-3.5-turbo' },
		ttsModel: { type: 'string', default: 'tts-1' },
		voice: { type: 'string', default: defaultVoice },
		systemPrompt: { type: 'string', default: 'You are a helpful assistant. You are embodied in a virtual reality, and receive queries from other inhabitants. Keep your answers short, suitable for a spoken conversation.' },
		name: { type: 'string', default: 'openai-chat' },
		sender: { type: 'string', default: 'user' },
		debug: { type: 'boolean', default: false },
	},

	chatStatusIndicator: document.createElement('a-sphere'),

	history: [],

	audioMessage: '',

	hovered: false,

	recording: false,

	recorder: new Recorder(),

	output: document.createElement('a-sound'),

	init() {

		if (!this.data.controller || !this.data.camera) {
			console.error('openai-chat requires a controller and camera');
			return;
		}

		this.history.push({ role: 'system', content: this.data.systemPrompt });

		this.output.addEventListener('sound-loaded', () => {
			this.log('sound loaded');
			(this.output.components.sound as any).playSound();
		})
		this.el.appendChild(this.output);

		this.chatStatusIndicator.setAttribute('radius', .01);
		this.updateStatusIndicator();
		this.chatStatusIndicator.setAttribute('position', { x: 0, y: 0, z: -0.5 });
		this.data.camera.appendChild(this.chatStatusIndicator);
		this.el.addEventListener('mouseenter', () => {
			this.hovered = true;
			this.updateStatusIndicator();
		});
		this.el.addEventListener('mouseleave', () => {
			this.hovered = false;
			this.updateStatusIndicator();
		});

		const controllerHand = this.data.controller.components['oculus-touch-controls'].data.hand;
		const actionButton = controllerHand === 'left' ? 'xbutton' : 'abutton';
		const cancelButton = controllerHand === 'left' ? 'ybutton' : 'bbutton';

		this.actionListener = this.actionListener.bind(this);
		this.data.controller.addEventListener(`${actionButton}up`, this.actionListener);
		this.el.addEventListener('click', this.actionListener);

		this.cancelListener = this.cancelListener.bind(this);
		this.data.controller.addEventListener(`${cancelButton}up`, this.cancelListener);
	},

	async actionListener(): Promise<void> {

		this.log('action button clicked');
		if (this.recording) {
			const blob = await this.recorder.stop();
			this.recording = false;
			this.updateStatusIndicator();
			this.el.emit('stop-recording');
			this.audioMessage = await this.toBase64(blob);
			this.send();
			this.el.emit('send-message');
			return;
		}

		if (!this.hovered) {
			return;
		}

		this.log('start recording');
		await this.recorder.start();
		this.recording = true;
		this.updateStatusIndicator();
		this.el.emit('start-recording');
	},

	async cancelListener(): Promise<void> {
		this.log('cancel button clicked');
		if (this.recording) {
			await this.recorder.stop();
			this.recording = false;
			this.updateStatusIndicator();
			this.el.emit('stop-recording');
			this.el.emit('cancel-recording');
		}
	},

	updateStatusIndicator() {
		if (this.recording) {
			this.chatStatusIndicator?.setAttribute('color', 'red');
			return;
		}
		this.chatStatusIndicator?.setAttribute('color', this.hovered ? 'lightgreen' : 'white');
	},

	async send() {

		const body: Body = {
			chat: this.history,
			audio: this.audioMessage,
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

		let phase: ParseChunkPartPhase = ParseChunkPartPhase.queryLength;
		let fragment: ArrayBuffer = new ArrayBuffer(0);
		let queryLength = 0;
		let responseTextLength = 0;
		let responseAudioLength = 0;
		const responseAudioFileUrls: string[] = [];
		let isQueueReady = false;
		let isQueueComplete = false;
		const reader = response.body.getReader();

		const read = async () => {

			const { value, done } = await reader.read();

			if (done) {
				isQueueComplete = true;
				return;
			}

			const responseAudioParts: Uint8Array[] = [];
			let byteLength = value.buffer.byteLength;
			let bytesRead = 0;
			let query = '';
			let responseText = '';
			const start = Date.now();

			while (bytesRead < byteLength && Date.now() - start < 60 * 1000) {
				switch (phase) {
					case ParseChunkPartPhase.queryLength:
						({ fragment, phase, bytesRead } = this.processChunkPart(phase, fragment, value.buffer, bytesRead, 2, (chunkPart) => {
							queryLength = (new Uint16Array(chunkPart))[0];
						}));
						break;
					case ParseChunkPartPhase.query:
						({ fragment, phase, bytesRead } = this.processChunkPart(phase, fragment, value.buffer, bytesRead, queryLength, (chunkPart) => {
							query = new TextDecoder().decode(chunkPart);
						}));
						break;
					case ParseChunkPartPhase.responseTextLength:
						({ fragment, phase, bytesRead } = this.processChunkPart(phase, fragment, value.buffer, bytesRead, 2, (chunkPart) => {
							responseTextLength = (new Uint16Array(chunkPart))[0];
						}));
						break;
					case ParseChunkPartPhase.responseText:
						({ fragment, phase, bytesRead } = this.processChunkPart(phase, fragment, value.buffer, bytesRead, responseTextLength, (chunkPart) => {
							responseText = new TextDecoder().decode(chunkPart);
						}));
						break;
					case ParseChunkPartPhase.responseAudioLength:
						({ fragment, phase, bytesRead } = this.processChunkPart(phase, fragment, value.buffer, bytesRead, 4, (chunkPart) => {
							responseAudioLength = (new Uint32Array(chunkPart))[0];
						}));
						break;
					case ParseChunkPartPhase.responseAudio:
						({ fragment, phase, bytesRead } = this.processChunkPart(phase, fragment, value.buffer, bytesRead, responseAudioLength, (chunkPart) => {
							responseAudioParts.push(new Uint8Array(chunkPart));
						}));
						break;
				}
			}

			this.log('finished on phase', phase);
			if (phase === ParseChunkPartPhase.queryLength) {
				this.log('queueing audio')
				const file = new File(responseAudioParts, 'response.opus', { type: 'audio/opus' });
				responseAudioFileUrls.push(URL.createObjectURL(file));
				isQueueReady = true;
			}

			read();
		}

		const queueAudioFile = () => {
			this.output.removeEventListener('sound-ended', queueAudioFile);
			const url = responseAudioFileUrls.shift();
			if (!url) {
				if (!isQueueComplete) {
					setTimeout(queueAudioFile, 50);
				}
				return;
			}
			this.output.setAttribute('src', url);
			this.output.addEventListener('sound-ended', queueAudioFile);
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
		phase: ParseChunkPartPhase,
		fragment: ArrayBuffer,
		buffer: ArrayBuffer,
		offset: number,
		length: number,
		callback: (chunkPart: ArrayBuffer) => void,
	): { fragment: ArrayBuffer, phase: ParseChunkPartPhase, bytesRead: number } {
		this.log('phase', phase);
		const { chunkPart, remainder } = this.addChunkPart(fragment, buffer, offset, length);
		this.log('chunkPart length', chunkPart.byteLength);
		const bytesRead = offset + chunkPart.byteLength;
		fragment = remainder > 0 ? chunkPart : new ArrayBuffer(0);
		if (remainder > 0) {
			this.log('remainder', remainder);
			return { fragment, phase, bytesRead };
		}
		callback(chunkPart);
		phase = (phase + 1) % parseChunkPartPhaseLength;
		return { fragment, phase, bytesRead }
	},

	addChunkPart(oldFragment: ArrayBuffer, buffer: ArrayBuffer, offset: number, length: number) {
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

enum ParseChunkPartPhase {
	queryLength = 0,
	query = 1,
	responseTextLength = 2,
	responseText = 3,
	responseAudioLength = 4,
	responseAudio = 5,
}

const parseChunkPartPhaseLength = (Object.values(ParseChunkPartPhase).reduce((a, b) => isNaN(Number(b)) ? a + 1 : a, 0));
