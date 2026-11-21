// One-shot microphone capture, shared by every "Record" entry point.
//
// Each caller keeps its own `recording` flag for the status light; this module
// only turns the MediaRecorder stream into a promise of audio. Tracks are
// stopped when the capture ends so the mic light in the OS tray goes out.
export interface MicCapture {
  /** Resolves with the full recording once `stop()` is called. */
  done: Promise<Blob>;
  /** Finish and resolve. */
  stop: () => void;
  /** Throw the recording away; `done` rejects. */
  cancel: () => void;
}

export function captureMic(onStream?: (stream: MediaStream) => void): MicCapture {
  let recorder: MediaRecorder | null = null;
  let stream: MediaStream | null = null;
  let settled = false;
  const chunks: Blob[] = [];

  let resolve: (blob: Blob) => void = () => {};
  let reject: (error: Error) => void = () => {};
  const done = new Promise<Blob>((res, rej) => {
    resolve = res;
    reject = rej;
  });

  const release = () => {
    stream?.getTracks().forEach((track) => track.stop());
    stream = null;
  };

  void (async () => {
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      onStream?.(stream);
    } catch {
      reject(new Error('Could not open the microphone. Check the browser permission and that a mic is plugged in.'));
      return;
    }

    try {
      recorder = new MediaRecorder(stream);
    } catch {
      release();
      reject(new Error('This machine could not start a recording.'));
      return;
    }

    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) chunks.push(event.data);
    };
    recorder.onstop = () => {
      release();
      if (!settled) {
        settled = true;
        resolve(new Blob(chunks, { type: recorder?.mimeType || 'audio/webm' }));
      }
    };
    recorder.onerror = () => {
      release();
      if (!settled) {
        settled = true;
        reject(new Error('The recording failed partway through.'));
      }
    };
    recorder.start();
  })();

  return {
    done,
    stop: () => {
      if (recorder && recorder.state !== 'inactive') recorder.stop();
      else {
        release();
        if (!settled) {
          settled = true;
          reject(new Error('The recording never started.'));
        }
      }
    },
    cancel: () => {
      release();
      if (!settled) {
        settled = true;
        reject(new Error('Recording cancelled.'));
      }
      if (recorder && recorder.state !== 'inactive') {
        try {
          recorder.stop();
        } catch {
          /* already stopped */
        }
      }
    },
  };
}
