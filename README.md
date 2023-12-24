# Aframe OpenAI Chat Component

This is a basic chat component for A-Frame, the 3D / AR / VR framework, that, given an appropriate backend, can be used to chat with any of OpenAI's models through an A-Frame entity.

A [live demonstration](https://www.youtube.com/watch?v=h9M0Rm1HoMc) has been uploaded to YouTube.


## Requirements

- At this point you need to include this component as an NPM package.
- A suitable backend that can be used to communicate with OpenAI's API. Please see [pieterjanv/openai-streaming-voice-chat](https://github.com/pieterjanv/openai-streaming-voice-chat) for a prototype.
- An OpenAI API key.


## Usage

1. Clone the backend server from [pieterjanv/openai-streaming-voice-chat](https://github.com/pieterjanv/openai-streaming-voice-chat) and follow the instructions there to get it running.
2. Create a new A-Frame project and install this component as an NPM package by running `npm install git+https://github.com/pieterjanv/aframe-openai-chat.git`.
3. Build your project using your favorite tool and include the resulting JavaScript file in your HTML file.
3. Add the component to an entity in your scene. See the examples directory for an example, and the API section below for a description of the component's properties.
4. Serve your project using a local webserver. Testing on a headset is not required, as you can interact with the AI using the mouse. Click once on a listening entity to start recording, click again to send the recording to the backend.


## Demo

1. Clone the backend server from [pieterjanv/openai-streaming-voice-chat](https://github.com/pieterjanv/openai-streaming-voice-chat) and follow the instructions there to get it running.
2. Clone this project.
3. `npm install`
4. `npm run example`
5. Open the link in your browser and click on the cube to start recording. Click again to send the recording to the backend. The cube is at a height of around 1.7m, so you might need to look up to see it.


## API


### Schema

| Property | Description | Default Value |
| -------- | ----------- | ------------- |
| actionEvent | The name of the event to listen for to start or stop recording. | none |
| cancelEvent | The name of the event that is fired to cancel recording. | none |
| startListeningEvent | When this event is fired, the component is put in a state where firing the action event will make the component start recording. If the component is already recording, this event has no effect. | none |
| stopListeningEvent | When this event is fired, the component is put in a state where starting a recording has no effect on it. | none |
| systemPrompt | The prompt that is sent to the AI to start the conversation. | `'You are a helpful assistant. You are embodied in a virtual reality, and receive queries from other inhabitants. Keep your answers short, suitable for a spoken conversation.'` |
| name | The name to give to the assistant. ChatGPT will know of this information. | `'assistant'` |
| voice | The voice to use for the assistant. | `'nova'` |
| senderName | The name to give to the user. ChatGPT will know of this information. | `'user'` |
| historyContainer | The selector of the element that will contain the chat history. This is useful for a shared history between multiple chatbots. Omitting this option will use a history local to the entity. | none |
| endpoint | The endpoint to send the audio to. | `'http://localhost:8000/voice'` |
| sttModel | The model to use for speech-to-text. | `'whisper-1'` |
| chatModel | The model to use for chat. | `'gpt-3.5-turbo'` |
| ttsModel | The model to use for text-to-speech. | `'tts-1'` |
| debug | Whether to log debug information to the console. | `false` |


### Events

All events bubble up to the scene element.

| Name | Description | Event detail |
| ---- | ----------- | ------------ |
| `start-listening` | Fired when the component starts listening, which means the next action event will trigger a recording. | `ChatEventDetail` |
| `stop-listening` | Fired when the component stops listening, which means the next action event will have no effect. | `ChatEventDetail` |
| `start-recording` | Fired when the component starts recording. | `ChatEventDetail` |
| `stop-recording` | Fired when the component stops recording. | `ChatEventDetail` |
| `cancel-recording` | Fired when the component cancels recording. | `ChatEventDetail` |
| `start-response-audio` | Fired when the response audio starts playing. | `ChatEventDetail` |
| `stop-response-audio` | Fired when the response audio stops playing. | `ChatEventDetail` |
| `send-query` | Fired when the component sends a message to the backend. | `ChatEventDetail` |
| `query-text` | Fired when the query text is received. | `ChatEventDetail & { query: string }` |
| `response-text` | Fired when the response text is received. | `ChatEventDetail & { response: string }` |
| `response-audio-part` | Fired when a part of the response audio is received. The event detail is an object url to the audio file. | `ChatEventDetail & { audio: string }` |
| `parsing-complete` | Fired when the response is fully received and parsed. | `ChatEventDetail` |


#### ChatEventDetail

| Property | Description |
| -------- | ----------- |
| `id` | The id of the entity element that fired the event. |


## Notes

This component sets the `src` of a sound component called `sound__openai-chat` to play the audio returned by the backend. By registering this sound component yourself you can configure it to your liking.
