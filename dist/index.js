"use strict";
(() => {
  // src/Recorder.ts
  var Recorder = class {
    constructor() {
      this.stream = void 0;
      this.mediaRecorder = void 0;
    }
    async start() {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      this.stream = stream;
      this.mediaRecorder = new MediaRecorder(stream, {
        audioBitsPerSecond: 12800,
        mimeType: "audio/webm"
      });
      this.mediaRecorder.start();
    }
    toggle() {
      if (!this.mediaRecorder) {
        return;
      }
      if (this.mediaRecorder.state === "paused") {
        this.mediaRecorder.resume();
      } else if (this.mediaRecorder.state === "recording") {
        this.mediaRecorder.pause();
      }
    }
    async stop() {
      return new Promise((resolve) => {
        const captureBlob = (e) => {
          this.mediaRecorder?.removeEventListener(
            "dataavailable",
            captureBlob
          );
          resolve(e.data);
        };
        if (this.mediaRecorder) {
          this.mediaRecorder.addEventListener("dataavailable", captureBlob);
          this.mediaRecorder.stop();
          this.mediaRecorder = void 0;
          if (!this.stream) {
            return;
          }
          this.stream.getAudioTracks().forEach((track) => {
            track.stop();
          });
          this.stream = void 0;
        } else {
          resolve(new Blob());
        }
      });
    }
  };

  // src/index.ts
  var defaultVoice = "nova" /* nova */;
  AFRAME.registerComponent("openai-chat", {
    schema: {
      actionEvent: { type: "string" },
      cancelEvent: { type: "string" },
      startListeningEvent: { type: "string" },
      stopListeningEvent: { type: "string" },
      systemPrompt: { type: "string", default: "You are a helpful assistant. You are embodied in a virtual reality, and receive queries from other inhabitants. Keep your answers short, suitable for a spoken conversation." },
      name: { type: "string", default: "assistant" },
      voice: { type: "string", default: defaultVoice },
      senderName: { type: "string", default: "user" },
      historyContainer: { type: "selector" },
      endpoint: { type: "string", default: "http://localhost:8000/voice" },
      sttModel: { type: "string", default: "whisper-1" },
      chatModel: { type: "string", default: "gpt-3.5-turbo" },
      ttsModel: { type: "string", default: "tts-1" },
      debug: { type: "boolean", default: false }
    },
    history: [],
    isSomeoneResponding: false,
    isToListen: false,
    isListening: false,
    isSomeoneListening: false,
    audioMessage: "",
    isRecording: false,
    recorder: new Recorder(),
    soundComponentId: "openai-chat",
    mouseDownPosition: { x: 0, y: 0 },
    init() {
      if (!this.data.actionEvent || !this.data.cancelEvent || !this.data.startListeningEvent || !this.data.stopListeningEvent) {
        throw new Error("Missing event name");
      }
      if (this.data.historyContainer) {
        this.data.historyContainer.openAiChatHistory ??= [];
        this.history = this.data.historyContainer.openAiChatHistory;
      }
      if (!this.history.length) {
        this.history.push({ role: "system", content: this.data.systemPrompt });
      }
      this.el.addEventListener("sound-loaded", (e) => {
        if (e.detail.id !== this.soundComponentId) {
          return;
        }
        this.log("sound loaded");
        this.el.components[`sound__${this.soundComponentId}`].playSound();
        this.el.emit("start-response-audio", this.createEventDetail({}), true);
      });
      this.el.sceneEl.addEventListener("stop-recording", () => {
        this.isSomeoneResponding = true;
      });
      this.el.sceneEl.addEventListener("cancel-recording", () => {
        this.isSomeoneResponding = false;
      });
      this.el.sceneEl.addEventListener("stop-response-audio", () => {
        this.isSomeoneResponding = false;
      });
      this.el.sceneEl.addEventListener("start-listening", () => {
        this.isSomeoneListening = true;
      });
      this.el.sceneEl.addEventListener("stop-listening", () => {
        this.isSomeoneListening = false;
      });
      this.el.sceneEl.addEventListener("stop-response-audio", () => {
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
        this.log("start listening");
        this.el.emit("start-listening", this.createEventDetail({}), true);
        this.isListening = true;
        this.isSomeoneListening = true;
      });
      this.el.addEventListener(this.data.stopListeningEvent, () => {
        this.isToListen = false;
        if (!this.isListening || this.isRecording) {
          return;
        }
        this.log("stop listening");
        this.el.emit("stop-listening", this.createEventDetail({}), true);
        this.isListening = false;
        this.isSomeoneListening = false;
      });
      this.actionListener = this.actionListener.bind(this);
      this.el.addEventListener(this.data.actionEvent, this.actionListener);
      this.el.sceneEl.addEventListener("mousedown", (e) => {
        if (!(e instanceof MouseEvent) || e.button !== 0) {
          return;
        }
        const mouseEvent = e;
        this.log("mouse down", e);
        this.mouseDownPosition.x = mouseEvent.clientX;
        this.mouseDownPosition.y = mouseEvent.clientY;
      });
      this.el.sceneEl.addEventListener("mouseup", (e) => {
        if (!(e instanceof MouseEvent) || e.button !== 0) {
          return;
        }
        const mouseEvent = e;
        this.log("mouse up", e);
        if ((mouseEvent.clientX - this.mouseDownPosition.x) ** 2 + (mouseEvent.clientY - this.mouseDownPosition.y) ** 2 > 9) {
          this.log("mouse dragged");
          return;
        }
        this.log("mouse clicked");
        this.actionListener();
      });
      this.cancelListener = this.cancelListener.bind(this);
      this.el.addEventListener(this.data.cancelEvent, this.cancelListener);
    },
    async actionListener() {
      this.log("action button clicked");
      if (this.isRecording) {
        this.log("stop recording");
        const blob = await this.recorder.stop();
        this.isRecording = false;
        this.el.emit("stop-recording", this.createEventDetail({}), true);
        this.el.emit(this.data.stopListeningEvent);
        this.audioMessage = await this.toBase64(blob);
        this.send();
        this.el.emit("send-query", this.createEventDetail({}), true);
        return;
      }
      if (!this.isListening) {
        return;
      }
      this.log("start recording");
      await this.recorder.start();
      this.isRecording = true;
      this.el.emit("start-recording", this.createEventDetail({}), true);
    },
    async cancelListener() {
      this.log("cancel button clicked");
      if (!this.isRecording) {
        return;
      }
      await this.recorder.stop();
      this.isRecording = false;
      this.el.emit(this.data.stopListeningEvent);
      this.el.emit("stop-recording", this.createEventDetail({}), true);
      this.el.emit("cancel-recording", this.createEventDetail({}), true);
    },
    async send() {
      const historyCopy = [];
      for (const message of this.history) {
        if (message.role === "assistant" && message.name !== this.data.name) {
          historyCopy.push({ role: "user", content: message.content ?? "", name: message.name });
          continue;
        }
        ;
        historyCopy.push(message);
      }
      historyCopy[0] = { role: "system", content: this.data.systemPrompt };
      this.log("sending adapted chat history", historyCopy);
      const body = {
        chat: historyCopy,
        input: this.audioMessage,
        chatModel: this.data.chatModel,
        sttModel: this.data.sttModel,
        ttsModel: this.data.ttsModel,
        voice: this.data.voice,
        speakerName: this.data.senderName,
        outputFormat: "aac"
      };
      const response = await fetch(this.data.endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });
      if (!(response.ok && response.body)) {
        response.json().then(console.error);
        return;
      }
      let phase = 0 /* queryLength */;
      let fragment = new ArrayBuffer(0);
      let queryLength = 0;
      let responseTextLength = 0;
      let responseAudioLength = 0;
      const responseAudioFileUrls = [];
      let isQueueReady = false;
      let isQueueComplete = false;
      let assistantMessageText = "";
      const reader = response.body.getReader();
      const read = async () => {
        const { value, done } = await reader.read();
        if (done) {
          const assistantMessage = { role: "assistant", content: assistantMessageText, name: this.data.name };
          this.history.push(assistantMessage);
          this.log("history", this.history);
          this.el.emit("response-text", this.createEventDetail({ response: assistantMessage }), true);
          this.el.emit("parsing-complete", this.createEventDetail({}), true);
          isQueueComplete = true;
          return;
        }
        let byteLength = value.buffer.byteLength;
        let bytesRead = 0;
        let query = "";
        let responseText = "";
        const start = Date.now();
        while (bytesRead < byteLength && Date.now() - start < 1e3) {
          switch (phase) {
            case 0 /* queryLength */:
              ({ fragment, phase, bytesRead } = this.processChunkPart(
                phase,
                fragment,
                value.buffer,
                bytesRead,
                4,
                (chunkPart) => {
                  queryLength = new Uint32Array(chunkPart)[0];
                }
              ));
              break;
            case 1 /* query */:
              ({ fragment, phase, bytesRead } = this.processChunkPart(
                phase,
                fragment,
                value.buffer,
                bytesRead,
                queryLength,
                (chunkPart) => {
                  query = new TextDecoder().decode(chunkPart);
                  const userMessage = { role: "user", content: query, name: this.data.senderName };
                  this.history.push(userMessage);
                  this.el.emit("query-text", this.createEventDetail({ query: userMessage }), true);
                }
              ));
              break;
            case 2 /* responseTextLength */:
              ({ fragment, phase, bytesRead } = this.processChunkPart(
                phase,
                fragment,
                value.buffer,
                bytesRead,
                4,
                (chunkPart) => {
                  responseTextLength = new Uint32Array(chunkPart)[0];
                }
              ));
              break;
            case 3 /* responseText */:
              ({ fragment, phase, bytesRead } = this.processChunkPart(
                phase,
                fragment,
                value.buffer,
                bytesRead,
                responseTextLength,
                (chunkPart) => {
                  responseText = new TextDecoder().decode(chunkPart);
                  assistantMessageText += responseText;
                }
              ));
              break;
            case 4 /* responseAudioLength */:
              ({ fragment, phase, bytesRead } = this.processChunkPart(
                phase,
                fragment,
                value.buffer,
                bytesRead,
                4,
                (chunkPart) => {
                  responseAudioLength = new Uint32Array(chunkPart)[0];
                }
              ));
              break;
            case 5 /* responseAudio */:
              ({ fragment, phase, bytesRead } = this.processChunkPart(
                phase,
                fragment,
                value.buffer,
                bytesRead,
                responseAudioLength,
                (chunkPart) => {
                  this.log("queueing audio");
                  const file = new File([new Uint8Array(chunkPart)], "response.aac", { type: "audio/aac" });
                  const url = URL.createObjectURL(file);
                  this.el.emit("response-audio-part", this.createEventDetail({ audio: url }), true);
                  responseAudioFileUrls.push(url);
                  isQueueReady = true;
                }
              ));
              break;
          }
        }
        this.log("finished on phase", phase);
        read();
      };
      const queueAudioFile = () => {
        this.el.removeEventListener("sound-ended", queueAudioFile);
        const url = responseAudioFileUrls.shift();
        if (!url) {
          if (!isQueueComplete) {
            setTimeout(queueAudioFile, 50);
            return;
          }
          this.el.emit("stop-response-audio", this.createEventDetail({}), true);
          return;
        }
        this.log("setting audio file");
        this.el.setAttribute(`sound__${this.soundComponentId}`, { src: url });
        this.el.addEventListener("sound-ended", queueAudioFile);
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
    processChunkPart(phase, fragment, buffer, offset, length, callback) {
      this.log("phase", phase);
      const { chunkPart, remainder } = this.combineFragments(fragment, buffer, offset, length);
      this.log("chunkPart length", chunkPart.byteLength);
      const bytesRead = offset + chunkPart.byteLength;
      fragment = remainder > 0 ? chunkPart : new ArrayBuffer(0);
      if (remainder > 0) {
        this.log("remainder", remainder);
        return { fragment, phase, bytesRead };
      }
      callback(chunkPart);
      phase = (phase + 1) % parseChunkPhaseLength;
      return { fragment, phase, bytesRead };
    },
    combineFragments(oldFragment, buffer, offset, length) {
      const newFragment = buffer.slice(offset, offset + length - oldFragment.byteLength);
      const chunkPart = new Uint8Array(oldFragment.byteLength + newFragment.byteLength);
      chunkPart.set(new Uint8Array(oldFragment), 0);
      chunkPart.set(new Uint8Array(newFragment), oldFragment.byteLength);
      const remainder = length - chunkPart.byteLength;
      return { chunkPart: chunkPart.buffer, remainder };
    },
    async toBase64(blob) {
      return (await this.toDataUrl(blob)).split(",")[1];
    },
    async toDataUrl(blob) {
      return new Promise((resolve) => {
        const reader = new FileReader();
        reader.onload = (e) => {
          resolve(reader.result);
        };
        reader.readAsDataURL(blob);
      });
    },
    createEventDetail(data) {
      return { id: this.el.id, ...data };
    },
    log(...messages) {
      if (this.data.debug) {
        console.log(...messages);
      }
    }
  });
  var ParseChunkPhase = /* @__PURE__ */ ((ParseChunkPhase2) => {
    ParseChunkPhase2[ParseChunkPhase2["queryLength"] = 0] = "queryLength";
    ParseChunkPhase2[ParseChunkPhase2["query"] = 1] = "query";
    ParseChunkPhase2[ParseChunkPhase2["responseTextLength"] = 2] = "responseTextLength";
    ParseChunkPhase2[ParseChunkPhase2["responseText"] = 3] = "responseText";
    ParseChunkPhase2[ParseChunkPhase2["responseAudioLength"] = 4] = "responseAudioLength";
    ParseChunkPhase2[ParseChunkPhase2["responseAudio"] = 5] = "responseAudio";
    return ParseChunkPhase2;
  })(ParseChunkPhase || {});
  var parseChunkPhaseLength = Object.values(ParseChunkPhase).reduce((a, b) => isNaN(Number(b)) ? a + 1 : a, 0);
})();
