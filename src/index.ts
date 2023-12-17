import OpenAI from "openai";
import { ChatCompletionStream } from "openai/lib/ChatCompletionStream.mjs";
import { ChatCompletionAssistantMessageParam, ChatCompletionSystemMessageParam, ChatCompletionUserMessageParam } from "openai/resources/index.mjs";

type Chat = Array<
	| ChatCompletionSystemMessageParam
	| ChatCompletionUserMessageParam
	| ChatCompletionAssistantMessageParam
>;

AFRAME.registerComponent<{
	history: Chat,
	response: string | undefined,
	openai: OpenAI | undefined,
	stream: ChatCompletionStream | undefined,
	send: () => void,
	stop: () => void,
	abort: () => Promise<void>,
}>('openai-chat', {

	history: [],

	response: undefined,

	openai: undefined,

	stream: undefined,

	schema: {
		model: { type: 'string', default: 'gpt-3.5-turbo' },
		systemPrompt: { type: 'string', default: 'You are a helpful assistant. You are embodied in a virtual reality, and receive queries from other inhabitants.' },
		name: { type: 'string', default: 'OpenAI Chat' },
		sender: { type: 'string', default: 'user' },
		message: { type: 'string' },
		apiKeyInput: { type: 'selector', default: '#api-key' },
	},

	init() {
		const apiKeyInput: HTMLInputElement = document.documentElement.querySelector(this.data.apiKeyInput);
		if (!apiKeyInput) throw new Error(`Could not find element with selector ${this.data.apiKeyInput}`);
		this.history.push({ role: 'system', content: this.data.systemPrompt });
		this.openai = new OpenAI({ apiKey: apiKeyInput.value });
	},

	async send() {

		if (this.stream) {
			await this.abort();
		}

		const chat = this.history;
		chat.push({ role: 'user', content: this.data.message, name: this.data.sender });
		const stream = this.openai?.beta.chat.completions.stream({
			model: this.data.model,
			messages: chat,
			stream: true,
		});

		if (!stream) throw new Error('Could not create stream');

		stream.on('content', (delta, snapshot) => {
			this.response ??= '';
			this.response += delta;
			this.el.emit('content', { delta, snapshot });
		});

		stream.on('finalContent', () => {
			this.el.emit('finalContent', { snapshot: this.response });
			this.history.push({ role: 'assistant', content: this.response });
			this.stream = undefined;
			this.response = undefined;
		});

		stream.on('error', (error) => {
			this.el.emit('error', { error });
			this.stream = undefined;
			this.response = undefined;
		});

		this.stream = stream;
	},

	stop() {
		this.stream?.controller.abort();
	},

	abort() {
		return new Promise<void>((resolve) => {
			if (!this.stream) {
				resolve();
				return;
			};

			this.stream.on('abort', () => {
				this.history.push({ role: 'assistant', content: this.response });
				this.el.emit('finalContent', { snapshot: this.response });
				this.stream = undefined;
				this.response = undefined;
				resolve();
			});

			this.stream.controller.abort();
		});
	}
});
