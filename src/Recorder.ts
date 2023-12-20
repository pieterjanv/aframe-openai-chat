export class Recorder {

	private stream: MediaStream | undefined = undefined;
	private mediaRecorder: MediaRecorder | undefined = undefined;

	async start(): Promise<void> {
		navigator.mediaDevices.getUserMedia({ audio: true })
			.then(stream => {
				this.stream = stream;
				const options = {
					audioBitsPerSecond: 12800,
					mimeType: 'audio/webm',
				};
				this.mediaRecorder = new MediaRecorder(stream, options);
				this.mediaRecorder.start();
			});
	}

	toggle(): void {

		if (!this.mediaRecorder) {
			return;
		}

		if (this.mediaRecorder.state === 'paused') {
			this.mediaRecorder.resume();
		}
		else if (this.mediaRecorder.state === "recording") {
			this.mediaRecorder.pause();
		}
	}

	async stop(): Promise<Blob> {

		return new Promise(resolve => {

			const captureBlob = (e: Event & { data: Blob }) => {
				this.mediaRecorder?.removeEventListener(
					'dataavailable',
					captureBlob,
				);
				resolve(e.data);
			};

			if (this.mediaRecorder) {
				this.mediaRecorder.addEventListener('dataavailable', captureBlob);
				this.mediaRecorder.stop();
				this.mediaRecorder = undefined;
				if (!this.stream) {
					return;
				}
				this.stream.getAudioTracks().forEach(track => {
					track.stop();
				});
				this.stream = undefined;
			}
			else {
				resolve(new Blob());
			}
		});
	}
};
