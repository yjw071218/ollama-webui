/* A picture of the screen, or from the camera, as an attachment.
 *
 * "What is this error?" used to mean: take a screenshot with another program,
 * find the file, drag it in. The vision models already read screenshots well;
 * the missing part was getting one into the composer in one step.
 *
 * Both paths end in a File handed to the composer's ordinary `addFiles`, so a
 * captured frame is exactly an attached picture -- same chip, same preview,
 * same vision check -- and nothing downstream needs to know where it came from.
 *
 * Frames are scaled down and saved as JPEG. A 4K screen as PNG is several
 * megabytes, and a chat stores its pictures inline: that is how one install's
 * database reached a gigabyte (see server/recordHistory.js). 1920 on the long
 * edge still leaves screen text legible to the model. */

export const MAX_EDGE = 1920;
export const JPEG_QUALITY = 0.86;

/** The size to draw a `w`x`h` frame at so its long edge is at most `max`. */
export const fitWithin = (w, h, max = MAX_EDGE) => {
  if (!w || !h) return { width: 0, height: 0 };
  const scale = Math.min(1, max / Math.max(w, h));
  return { width: Math.round(w * scale), height: Math.round(h * scale) };
};

export const canCaptureScreen = () =>
  (typeof window !== 'undefined' && typeof window.ollamaNative?.captureScreen === 'function') ||
  (typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getDisplayMedia);

export const canUseCamera = () =>
  typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia;

const stamp = () => new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');

/** Draw the current frame of a playing <video> to a JPEG File. */
export const frameToFile = async (video, name) => {
  const { width, height } = fitWithin(video.videoWidth, video.videoHeight);
  if (!width) throw new Error('The video has no frame yet.');
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  canvas.getContext('2d').drawImage(video, 0, 0, width, height);
  const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', JPEG_QUALITY));
  if (!blob) throw new Error('Could not encode the frame.');
  return new File([blob], name, { type: 'image/jpeg' });
};

/** Play a stream in an off-screen <video> until it has a frame to draw. */
export const videoFor = async (stream) => {
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.srcObject = stream;
  await video.play();
  if (!video.videoWidth) {
    await new Promise((resolve) => {
      video.addEventListener('loadedmetadata', resolve, { once: true });
      setTimeout(resolve, 1500);
    });
  }
  // One more frame: the first one delivered is often black on Windows.
  await new Promise(resolve => (video.requestVideoFrameCallback
    ? video.requestVideoFrameCallback(() => resolve())
    : setTimeout(resolve, 120)));
  return video;
};

/**
 * Ask which screen, window or tab to share, take one frame, and stop sharing.
 *
 * Sharing stops immediately: the red "sharing your screen" bar staying up
 * after the picture was taken is the thing that would make anyone distrust
 * this button. Returns `null` if the picker was cancelled.
 */
export const captureScreen = async () => {
  // Android WebView does not implement getDisplayMedia; the app uses OS consent.
  if (typeof window !== 'undefined' && window.ollamaNative?.captureScreen) return window.ollamaNative.captureScreen();
  let stream;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: 5 },
      audio: false,
      // Chrome: offer the current tab last rather than first -- the app
      // itself is rarely what anyone wants to ask about.
      selfBrowserSurface: 'exclude',
      preferCurrentTab: false,
    });
  } catch (e) {
    if (e?.name === 'NotAllowedError' || e?.name === 'AbortError') return null;
    throw e;
  }
  try {
    const video = await videoFor(stream);
    return await frameToFile(video, `screen-${stamp()}.jpg`);
  } finally {
    stream.getTracks().forEach(track => track.stop());
  }
};

export const cameraFileName = () => `camera-${stamp()}.jpg`;
