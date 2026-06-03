(() => {
  class TextLayoutEngine {
    #ctx;
    baselineRatio = 0.88;

    constructor() {
      const canvas = document.createElement("canvas");
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        throw new Error("Failed to get canvas context");
      }
      this.#ctx = ctx;
    }

    #getFontFor(fontSize) {
      return `${fontSize}px sans-serif`;
    }

    #measure(fontSize, text) {
      this.#ctx.font = this.#getFontFor(fontSize);
      return this.#ctx.measureText(text);
    }

    #wrapText(text, fontSize, width) {
      const lines = [];
      const line = { text: "", width: 0 };
      for (let pos = 0, len = text.length; pos < len; pos++) {
        const char = text[pos];
        const metrics = this.#measure(fontSize, line.text + char);
        if (metrics.width > width) {
          lines.push({ ...line });
          line.text = char;
          line.width = metrics.width - line.width; // Might be slightly off due to kerning
        } else {
          line.text += char;
          line.width = metrics.width;
        }
      }
      if (line.text) {
        lines.push(line);
      }
      return lines;
    }

    #fitText(text, width, height, maxWrap) {
      let minFontSize = Math.floor(height / maxWrap);
      let maxFontSize = height;
      while (minFontSize <= maxFontSize) {
        const fontSize = Math.floor((minFontSize + maxFontSize) / 2);

        const lines = this.#wrapText(text, fontSize, width);
        const numOfLines = lines.length;
        const hasOverflow =
          numOfLines > maxWrap || fontSize * numOfLines > height;

        if (maxFontSize - minFontSize <= 1) {
          return { fontSize, lines };
        } else if (hasOverflow) {
          maxFontSize = fontSize - 1;
        } else {
          minFontSize = fontSize;
        }
      }
    }

    calcLayout(text, width, height, maxWrap) {
      const { fontSize, lines } = this.#fitText(text, width, height, maxWrap);

      // Discard overflowed lines;
      // Add ellipsis to the last line if needed
      const hasOverflow = lines.length > maxWrap;
      if (hasOverflow) {
        lines.length = maxWrap;
        lines.at(-1).text += "…";
      }

      // Calculate coordinates
      const offsetY = (height - fontSize * lines.length) / 2;
      for (let i = 0, len = lines.length; i < len; i++) {
        const line = lines[i];
        line.x = (width - line.width) / 2;
        line.y = offsetY + fontSize * (i + this.baselineRatio);
      }

      return {
        font: this.#getFontFor(fontSize),
        lines,
      };
    }
  }

  function runLoop(callback, fps) {
    let timerId = -1;
    let rafId = -1;

    const loop = () => {
      timerId = window.setTimeout(() => {
        callback();
        rafId = window.requestAnimationFrame(loop);
      }, 1000 / fps);
    };
    loop();

    return () => {
      window.clearTimeout(timerId);
      window.cancelAnimationFrame(rafId);
    };
  }

  const getUserMedia = navigator.mediaDevices.getUserMedia.bind(
    navigator.mediaDevices,
  );

  const MessageMode = {
    Overlay: "overlay",
    "Text Only": "text",
  };

  const configKeys = {
    enabled: "com.creasty.message-streamer/enabled",
    messageMode: "com.creasty.message-streamer/message-mode",
  };

  class MessageStreamer {
    text = "";
    #textLayoutEngine = new TextLayoutEngine();
    #pipeline = null;
    #pipelineKey = null;

    async getModifiedUserMedia(constraints) {
      if (!constraints?.video) {
        return getUserMedia(constraints);
      }
      if (
        typeof constraints.video === "object" &&
        constraints.video.mandatory?.chromeMediaSource === "desktop"
      ) {
        return getUserMedia(constraints);
      }

      try {
        const pipeline = await this.#ensurePipeline(constraints);

        // Return clones so that the consumer (Meet) stopping the returned
        // tracks (e.g. camera off) does NOT stop the underlying pipeline.
        // The canvas keeps drawing and the camera keeps capturing, so the
        // next getUserMedia call can hand out fresh clones immediately.
        const videoTracks = pipeline.canvasStream
          .getVideoTracks()
          .map((t) => t.clone());
        const audioTracks = pipeline.deviceStream
          .getAudioTracks()
          .map((t) => t.clone());

        return new MediaStream([...videoTracks, ...audioTracks]);
      } catch (e) {
        console.error(e);
        throw e;
      }
    }

    async #ensurePipeline(constraints) {
      const key = JSON.stringify(constraints);
      if (this.#pipeline && this.#pipelineKey === key) {
        return this.#pipeline;
      }
      // Constraints changed (or first call) — rebuild from scratch
      this.#disposePipeline();

      const deviceStream = await getUserMedia(constraints);
      const video = await this.#createVideo(deviceStream);
      const { canvasStream, stop: stopLoop } =
        await this.#createCanvasStream(video);

      this.#pipeline = { deviceStream, video, canvasStream, stopLoop };
      this.#pipelineKey = key;
      return this.#pipeline;
    }

    #disposePipeline() {
      const pipeline = this.#pipeline;
      if (!pipeline) return;
      this.#pipeline = null;
      this.#pipelineKey = null;
      try {
        pipeline.stopLoop();
      } catch (err) {
        console.error(err);
      }
      try {
        pipeline.video.pause();
        pipeline.video.srcObject = null;
      } catch (err) {
        console.error(err);
      }
      for (const track of pipeline.deviceStream.getTracks()) {
        try {
          track.stop();
        } catch (err) {
          console.error(err);
        }
      }
      for (const track of pipeline.canvasStream.getTracks()) {
        try {
          track.stop();
        } catch (err) {
          console.error(err);
        }
      }
    }

    #hijackUserMedia() {
      window.__hijackUserMedia = this;
      navigator.mediaDevices.getUserMedia =
        this.getModifiedUserMedia.bind(this);
    }

    #restoreUserMedia() {
      navigator.mediaDevices.getUserMedia = getUserMedia;
    }

    #isStarted = false;
    get isStarted() {
      return this.#isStarted;
    }

    start() {
      if (this.#isStarted) return;
      this.#isStarted = true;
      this.#hijackUserMedia();
    }

    stop() {
      if (!this.#isStarted) return;
      this.#restoreUserMedia();
      this.#disposePipeline();
      this.#isStarted = false;
    }

    async #createVideo(deviceStream) {
      const video = document.createElement("video");
      video.muted = true;
      video.srcObject = deviceStream;

      try {
        await video.play();
      } catch (err) {
        console.error(err);
      }

      return video;
    }

    async #createCanvasStream(video) {
      const canvas = document.createElement("canvas");

      const canvasCtx = canvas.getContext("2d");
      if (!canvasCtx) {
        throw new Error("Failed to get canvas context");
      }

      const canvasStream = canvas.captureStream();
      if (!canvasStream) {
        throw new Error("Failed to capture stream from canvas");
      }

      const stop = runLoop(() => {
        if (!canvasStream.active) return;
        try {
          this.#updateCanvas(canvas, canvasCtx, video);
        } catch (err) {
          console.error(err);
          throw err;
        }
      }, 24);

      return { canvasStream, stop };
    }

    #updateCanvasCache = {};
    #updateCanvas(dom, ctx, video) {
      const cache = this.#updateCanvasCache;

      // Resize canvas
      const { videoWidth, videoHeight } = video;
      if (cache.videoWidth != videoWidth || cache.videoHeight != videoHeight) {
        dom.width = videoWidth;
        dom.height = videoHeight;
        cache.videoWidth = videoWidth;
        cache.videoHeight = videoHeight;
      }

      // Fallback
      if (!this.text) {
        ctx.drawImage(video, 0, 0);
        return;
      }

      // Background
      if (this.mode == MessageMode["Overlay"]) {
        ctx.drawImage(video, 0, 0);
        ctx.fillStyle = "rgba(0,0,0,0.5)";
        ctx.fillRect(0, 0, videoWidth, videoHeight);
      } else {
        ctx.fillStyle = "#fff";
        ctx.fillRect(0, 0, videoWidth, videoHeight);
      }

      // Message
      const textLayout = this.#calcTextLayout(
        videoWidth,
        videoHeight,
        this.text,
      );
      ctx.font = textLayout.font;
      if (this.mode == MessageMode["Overlay"]) {
        ctx.fillStyle = "#fff";
      } else {
        ctx.fillStyle = "#999";
      }
      for (const line of textLayout.lines) {
        ctx.fillText(line.text, line.x, line.y);
      }
    }

    #calcTextLayoutCache = {};
    #calcTextLayout(width, height, text) {
      const cache = this.#calcTextLayoutCache;

      if (
        cache.width == width &&
        cache.height == height &&
        cache.text == text
      ) {
        return cache.result;
      }

      // Add paddings
      const maxWidth = Math.floor(
        Math.min(width * 0.8, (height * 0.9 * 4) / 3),
      );
      const maxHeight = Math.floor(height * 0.8);

      const compactText = text.replace(/\s+/g, " ").trim();
      const result = this.#textLayoutEngine.calcLayout(
        compactText,
        maxWidth,
        maxHeight,
        3,
      );

      // Adjust the position to the original frame
      const offsetX = (width - maxWidth) / 2;
      const offsetY = (height - maxHeight) / 2;
      for (const line of result.lines) {
        line.x += offsetX;
        line.y += offsetY;
      }

      cache.width = width;
      cache.height = height;
      cache.text = text;
      cache.result = result;
      return result;
    }

    createController() {
      const container = document.createElement("div");
      container.style.position = "fixed";
      container.style.top = "0";
      container.style.left = "0";
      container.style.zIndex = 10000;
      container.style.display = "flex";

      const input = document.createElement("input");
      input.placeholder = "Enter message";
      input.addEventListener("input", (e) => {
        this.text = e.currentTarget.value;
      });
      input.addEventListener("focus", (e) => {
        e.currentTarget.select();
      });
      container.append(input);

      const select = document.createElement("select");
      select.addEventListener("change", (e) => {
        this.mode = e.currentTarget.value;
      });
      container.append(select);

      for (const [label, value] of Object.entries(MessageMode)) {
        const option = document.createElement("option");
        option.value = value;
        option.innerText = label;
        option.selected = this.mode === value;
        select.append(option);
      }

      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.checked = this.enabled;
      checkbox.addEventListener("change", (e) => {
        this.enabled = e.currentTarget.checked;
        if (window.confirm("Reload the page to apply the changes?")) {
          window.location.reload();
        }
      });
      container.append(checkbox);

      return container;
    }

    #modeCache = null;
    get mode() {
      if (this.#modeCache) return this.#modeCache;

      let value = window.localStorage.getItem(configKeys.messageMode);
      if (!Object.values(MessageMode).includes(value)) {
        value = MessageMode["Overlay"];
      }
      this.#modeCache = value;
      return value;
    }
    set mode(value) {
      if (!Object.values(MessageMode).includes(value)) {
        throw new Error(`Invalid message mode: ${value}`);
      }
      this.#modeCache = value;
      window.localStorage.setItem(configKeys.messageMode, value);
    }

    get enabled() {
      return window.localStorage.getItem(configKeys.enabled) !== "false";
    }
    set enabled(value) {
      window.localStorage.setItem(configKeys.enabled, String(Boolean(value)));
    }
  }

  const messageStreamer = new MessageStreamer();
  if (messageStreamer.enabled) {
    messageStreamer.start();
  }

  document.addEventListener("DOMContentLoaded", () => {
    const ctrl = messageStreamer.createController();
    document.body.append(ctrl);
  });
})();
