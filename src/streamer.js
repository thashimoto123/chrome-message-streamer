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
    textRect: "com.creasty.message-streamer/text-rect",
    overlayBackgroundScope:
      "com.creasty.message-streamer/overlay-background-scope",
  };

  const OverlayBackgroundScope = {
    Full: "full",
    "Text Area": "text",
    None: "none",
  };

  const defaultTextRect = { x: 0.1, y: 0.1, width: 0.8, height: 0.8 };

  function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
  }

  const EMOJI_DATA = window.__EMOJI_DATA || {};
  const EMOJI_KEYS = Object.keys(EMOJI_DATA).sort();
  const EMOJI_SHORTCODE_CHAR = /[a-zA-Z0-9_+-]/;

  function expandEmojiShortcodes(text) {
    return text.replace(/:([a-zA-Z0-9_+-]+):/g, (match, name) =>
      Object.prototype.hasOwnProperty.call(EMOJI_DATA, name)
        ? EMOJI_DATA[name]
        : match,
    );
  }

  function findEmojiQueryAtCursor(value, cursorPos) {
    let i = cursorPos - 1;
    while (i >= 0) {
      const ch = value[i];
      if (ch === ":") {
        const query = value.slice(i + 1, cursorPos);
        if (/^[a-zA-Z0-9_+-]*$/.test(query)) {
          return { start: i, end: cursorPos, query };
        }
        return null;
      }
      if (!EMOJI_SHORTCODE_CHAR.test(ch)) return null;
      i--;
    }
    return null;
  }

  function normalizeTextRect(value) {
    if (!value || typeof value !== "object") return { ...defaultTextRect };
    const keys = ["x", "y", "width", "height"];
    for (const key of keys) {
      if (typeof value[key] !== "number" || !isFinite(value[key])) {
        return { ...defaultTextRect };
      }
    }
    const minSize = 0.05;
    const width = clamp(value.width, minSize, 1);
    const height = clamp(value.height, minSize, 1);
    const x = clamp(value.x, 0, 1 - width);
    const y = clamp(value.y, 0, 1 - height);
    return { x, y, width, height };
  }

  class MessageStreamer {
    text = "";
    #textLayoutEngine = new TextLayoutEngine();
    #pipeline = null;
    #pipelineKey = null;
    #inputEl = null;

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
      const isOverlay = this.mode == MessageMode["Overlay"];
      const scope = this.overlayBackgroundScope;
      if (isOverlay) {
        ctx.drawImage(video, 0, 0);
        if (scope !== OverlayBackgroundScope["None"]) {
          ctx.fillStyle = "rgba(0,0,0,0.5)";
          if (scope === OverlayBackgroundScope["Text Area"]) {
            const rect = this.textRect;
            const rectX = Math.floor(videoWidth * rect.x);
            const rectY = Math.floor(videoHeight * rect.y);
            const rectW = Math.floor(videoWidth * rect.width);
            const rectH = Math.floor(videoHeight * rect.height);
            ctx.fillRect(rectX, rectY, rectW, rectH);
          } else {
            ctx.fillRect(0, 0, videoWidth, videoHeight);
          }
        }
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

      const needsShadow =
        isOverlay && scope === OverlayBackgroundScope["None"];
      if (needsShadow) {
        ctx.shadowColor = "rgba(0,0,0,0.95)";
        ctx.shadowBlur = Math.max(4, Math.floor(videoHeight * 0.012));
        ctx.shadowOffsetX = 0;
        ctx.shadowOffsetY = Math.max(1, Math.floor(videoHeight * 0.002));
      }

      ctx.fillStyle = isOverlay ? "#fff" : "#999";
      for (const line of textLayout.lines) {
        ctx.fillText(line.text, line.x, line.y);
      }

      if (needsShadow) {
        ctx.shadowColor = "transparent";
        ctx.shadowBlur = 0;
        ctx.shadowOffsetX = 0;
        ctx.shadowOffsetY = 0;
      }
    }

    #calcTextLayoutCache = {};
    #calcTextLayout(width, height, text) {
      const cache = this.#calcTextLayoutCache;
      const rect = this.textRect;

      if (
        cache.width == width &&
        cache.height == height &&
        cache.text == text &&
        cache.rectX == rect.x &&
        cache.rectY == rect.y &&
        cache.rectWidth == rect.width &&
        cache.rectHeight == rect.height
      ) {
        return cache.result;
      }

      const maxWidth = Math.max(1, Math.floor(width * rect.width));
      const maxHeight = Math.max(1, Math.floor(height * rect.height));

      const compactText = expandEmojiShortcodes(text)
        .replace(/\s+/g, " ")
        .trim();
      const result = this.#textLayoutEngine.calcLayout(
        compactText,
        maxWidth,
        maxHeight,
        3,
      );

      // Adjust the position to the original frame
      const offsetX = Math.floor(width * rect.x);
      const offsetY = Math.floor(height * rect.y);
      for (const line of result.lines) {
        line.x += offsetX;
        line.y += offsetY;
      }

      cache.width = width;
      cache.height = height;
      cache.text = text;
      cache.rectX = rect.x;
      cache.rectY = rect.y;
      cache.rectWidth = rect.width;
      cache.rectHeight = rect.height;
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
      container.style.alignItems = "flex-start";
      container.style.gap = "4px";

      container.append(this.#createMessageInput());

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

      const advancedPanel = document.createElement("div");
      advancedPanel.style.display = "none";
      advancedPanel.style.flexDirection = "column";
      advancedPanel.style.gap = "4px";
      advancedPanel.append(this.#createRectEditor());
      advancedPanel.append(this.#createOverlayScopeToggle());

      const toggleButton = document.createElement("button");
      toggleButton.type = "button";
      toggleButton.textContent = "Advanced";
      toggleButton.title = "Show advanced options";
      toggleButton.style.cursor = "pointer";
      toggleButton.addEventListener("click", () => {
        const hidden = advancedPanel.style.display === "none";
        advancedPanel.style.display = hidden ? "flex" : "none";
        toggleButton.textContent = hidden ? "Close" : "Advanced";
      });
      container.append(toggleButton);

      container.append(advancedPanel);

      return container;
    }

    #createMessageInput() {
      const wrapper = document.createElement("div");
      wrapper.style.position = "relative";
      wrapper.style.flex = "0 0 auto";

      const input = document.createElement("input");
      input.placeholder = "Enter message";
      this.#inputEl = input;
      wrapper.append(input);

      const dropdown = document.createElement("div");
      dropdown.style.position = "absolute";
      dropdown.style.top = "100%";
      dropdown.style.left = "0";
      dropdown.style.minWidth = "200px";
      dropdown.style.maxHeight = "240px";
      dropdown.style.overflowY = "auto";
      dropdown.style.background = "#fff";
      dropdown.style.color = "#000";
      dropdown.style.border = "1px solid #888";
      dropdown.style.fontSize = "12px";
      dropdown.style.zIndex = "10001";
      dropdown.style.display = "none";
      wrapper.append(dropdown);

      const state = {
        suggestions: [],
        selectedIndex: 0,
        context: null,
      };
      const MAX_SUGGESTIONS = 8;

      const renderDropdown = () => {
        dropdown.replaceChildren();
        for (let i = 0; i < state.suggestions.length; i++) {
          const name = state.suggestions[i];
          const item = document.createElement("div");
          item.style.display = "flex";
          item.style.gap = "6px";
          item.style.alignItems = "center";
          item.style.padding = "2px 6px";
          item.style.cursor = "pointer";
          if (i === state.selectedIndex) {
            item.style.background = "#cde";
          }
          const glyph = document.createElement("span");
          glyph.textContent = EMOJI_DATA[name];
          const label = document.createElement("span");
          label.textContent = `:${name}:`;
          item.append(glyph, label);
          item.addEventListener("mousedown", (e) => {
            e.preventDefault();
            state.selectedIndex = i;
            confirmSelection();
          });
          item.addEventListener("mouseenter", () => {
            state.selectedIndex = i;
            renderDropdown();
          });
          dropdown.append(item);
        }
        dropdown.style.display = state.suggestions.length ? "block" : "none";
      };

      const hideDropdown = () => {
        state.suggestions = [];
        state.context = null;
        dropdown.style.display = "none";
      };

      const updateSuggestions = () => {
        const ctx = findEmojiQueryAtCursor(input.value, input.selectionStart);
        if (!ctx || ctx.query.length === 0) {
          hideDropdown();
          return;
        }
        const q = ctx.query.toLowerCase();
        const startsWith = [];
        const contains = [];
        for (const k of EMOJI_KEYS) {
          if (k.startsWith(q)) startsWith.push(k);
          else if (k.includes(q)) contains.push(k);
          if (startsWith.length >= MAX_SUGGESTIONS) break;
        }
        const top = startsWith
          .concat(contains)
          .slice(0, MAX_SUGGESTIONS);
        if (top.length === 0) {
          hideDropdown();
          return;
        }
        state.suggestions = top;
        state.selectedIndex = 0;
        state.context = ctx;
        renderDropdown();
      };

      const confirmSelection = () => {
        if (!state.context || !state.suggestions.length) return;
        const name = state.suggestions[state.selectedIndex];
        const replacement = `:${name}:`;
        const before = input.value.slice(0, state.context.start);
        const after = input.value.slice(state.context.end);
        input.value = before + replacement + after;
        const pos = before.length + replacement.length;
        input.setSelectionRange(pos, pos);
        this.text = input.value;
        hideDropdown();
      };

      input.addEventListener("input", (e) => {
        this.text = e.currentTarget.value;
        updateSuggestions();
      });
      input.addEventListener("keydown", (e) => {
        if (dropdown.style.display === "none") return;
        if (e.key === "ArrowDown") {
          e.preventDefault();
          state.selectedIndex =
            (state.selectedIndex + 1) % state.suggestions.length;
          renderDropdown();
        } else if (e.key === "ArrowUp") {
          e.preventDefault();
          state.selectedIndex =
            (state.selectedIndex - 1 + state.suggestions.length) %
            state.suggestions.length;
          renderDropdown();
        } else if (e.key === "Enter" || e.key === "Tab") {
          e.preventDefault();
          confirmSelection();
        } else if (e.key === "Escape") {
          e.preventDefault();
          hideDropdown();
        }
      });
      input.addEventListener("focus", (e) => {
        e.currentTarget.select();
      });
      input.addEventListener("blur", () => {
        // Delay so item mousedown can fire before the dropdown disappears.
        setTimeout(hideDropdown, 150);
      });
      input.addEventListener("click", updateSuggestions);
      input.addEventListener("keyup", (e) => {
        if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
          updateSuggestions();
        }
      });

      return wrapper;
    }

    #createOverlayScopeToggle() {
      const label = document.createElement("label");
      label.style.display = "flex";
      label.style.alignItems = "center";
      label.style.gap = "4px";
      label.style.fontSize = "11px";
      label.style.color = "#000";
      label.style.background = "#fff";
      label.style.padding = "2px 4px";

      const text = document.createElement("span");
      text.textContent = "Overlay background";

      const select = document.createElement("select");
      for (const [optionLabel, value] of Object.entries(
        OverlayBackgroundScope,
      )) {
        const option = document.createElement("option");
        option.value = value;
        option.textContent = optionLabel;
        option.selected = this.overlayBackgroundScope === value;
        select.append(option);
      }
      select.addEventListener("change", (e) => {
        this.overlayBackgroundScope = e.currentTarget.value;
      });

      label.append(text, select);
      return label;
    }

    #createRectEditor() {
      // 16:9 preview frame
      const frame = document.createElement("div");
      frame.title = "Drag to move, drag the corner to resize";
      frame.style.position = "relative";
      frame.style.width = "160px";
      frame.style.height = "90px";
      frame.style.background = "rgba(0,0,0,0.6)";
      frame.style.border = "1px solid #888";
      frame.style.boxSizing = "border-box";
      frame.style.flex = "0 0 auto";
      frame.style.userSelect = "none";

      const box = document.createElement("div");
      box.style.position = "absolute";
      box.style.background = "rgba(255,255,255,0.35)";
      box.style.border = "1px solid #fff";
      box.style.boxSizing = "border-box";
      box.style.cursor = "move";
      frame.append(box);

      const handle = document.createElement("div");
      handle.style.position = "absolute";
      handle.style.right = "-5px";
      handle.style.bottom = "-5px";
      handle.style.width = "10px";
      handle.style.height = "10px";
      handle.style.background = "#fff";
      handle.style.border = "1px solid #333";
      handle.style.cursor = "nwse-resize";
      box.append(handle);

      const applyRectToBox = () => {
        const rect = this.textRect;
        box.style.left = `${rect.x * 100}%`;
        box.style.top = `${rect.y * 100}%`;
        box.style.width = `${rect.width * 100}%`;
        box.style.height = `${rect.height * 100}%`;
      };
      applyRectToBox();

      const startDrag = (e, mode) => {
        e.preventDefault();
        e.stopPropagation();
        const frameRect = frame.getBoundingClientRect();
        const startX = e.clientX;
        const startY = e.clientY;
        const startRect = { ...this.textRect };

        const onMove = (ev) => {
          const dxRatio = (ev.clientX - startX) / frameRect.width;
          const dyRatio = (ev.clientY - startY) / frameRect.height;
          let next;
          if (mode === "move") {
            next = {
              x: startRect.x + dxRatio,
              y: startRect.y + dyRatio,
              width: startRect.width,
              height: startRect.height,
            };
          } else {
            next = {
              x: startRect.x,
              y: startRect.y,
              width: startRect.width + dxRatio,
              height: startRect.height + dyRatio,
            };
          }
          this.textRect = next;
          applyRectToBox();
        };
        const onUp = () => {
          window.removeEventListener("mousemove", onMove);
          window.removeEventListener("mouseup", onUp);
        };
        window.addEventListener("mousemove", onMove);
        window.addEventListener("mouseup", onUp);
      };

      box.addEventListener("mousedown", (e) => startDrag(e, "move"));
      handle.addEventListener("mousedown", (e) => startDrag(e, "resize"));

      const resetButton = document.createElement("button");
      resetButton.type = "button";
      resetButton.textContent = "Reset";
      resetButton.title = "Reset to default size and position";
      resetButton.style.position = "absolute";
      resetButton.style.top = "2px";
      resetButton.style.right = "2px";
      resetButton.style.fontSize = "10px";
      resetButton.style.padding = "1px 4px";
      resetButton.style.cursor = "pointer";
      resetButton.addEventListener("mousedown", (e) => {
        e.stopPropagation();
      });
      resetButton.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.textRect = { ...defaultTextRect };
        applyRectToBox();
      });
      frame.append(resetButton);

      return frame;
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

    #overlayBackgroundScopeCache = null;
    get overlayBackgroundScope() {
      if (this.#overlayBackgroundScopeCache)
        return this.#overlayBackgroundScopeCache;
      let value = window.localStorage.getItem(
        configKeys.overlayBackgroundScope,
      );
      if (!Object.values(OverlayBackgroundScope).includes(value)) {
        value = OverlayBackgroundScope["Full"];
      }
      this.#overlayBackgroundScopeCache = value;
      return value;
    }
    set overlayBackgroundScope(value) {
      if (!Object.values(OverlayBackgroundScope).includes(value)) {
        throw new Error(`Invalid overlay background scope: ${value}`);
      }
      this.#overlayBackgroundScopeCache = value;
      window.localStorage.setItem(
        configKeys.overlayBackgroundScope,
        value,
      );
    }

    #textRectCache = null;
    get textRect() {
      if (this.#textRectCache) return this.#textRectCache;
      let value;
      try {
        value = JSON.parse(
          window.localStorage.getItem(configKeys.textRect),
        );
      } catch {
        value = null;
      }
      this.#textRectCache = normalizeTextRect(value);
      return this.#textRectCache;
    }
    set textRect(value) {
      const normalized = normalizeTextRect(value);
      this.#textRectCache = normalized;
      window.localStorage.setItem(
        configKeys.textRect,
        JSON.stringify(normalized),
      );
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
