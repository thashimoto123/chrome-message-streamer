function injectScript(src) {
  const script = document.createElement("script");
  script.src = chrome.runtime.getURL(src);
  // Preserve insertion order for executed scripts (default for dynamic
  // scripts is async = true, which would break dependency order).
  script.async = false;
  document.documentElement.appendChild(script);
}

injectScript("emoji-data.js");
injectScript("streamer.js");
