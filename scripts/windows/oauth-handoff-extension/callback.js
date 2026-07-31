(() => {
  "use strict";

  const providerOrigin = "https://platform.claude.com";
  const providerPath = "/oauth/code/callback";
  const localCallback = "http://127.0.0.1:37645/oauth/callback";
  const maximumCodeLength = 4 * 1024;
  const statePattern = /^[A-Za-z0-9_-]{43}$/;

  function validCode(value) {
    return (
      value.length > 0 &&
      value.length <= maximumCodeLength &&
      !/[\u0000-\u0020\u007f]/.test(value) &&
      !value.includes("#")
    );
  }

  function parseBody(raw) {
    const trimmed = raw.trim();
    const separator = trimmed.indexOf("#");
    if (separator <= 0 || separator !== trimmed.lastIndexOf("#")) return null;
    const code = trimmed.slice(0, separator);
    const state = trimmed.slice(separator + 1);
    return validCode(code) && statePattern.test(state) ? { code, state } : null;
  }

  function parseUrl(url) {
    if (
      url.origin !== providerOrigin ||
      url.pathname !== providerPath ||
      url.username !== "" ||
      url.password !== ""
    ) {
      return null;
    }

    const keys = [...url.searchParams.keys()];
    if (
      keys.some((key) => key !== "code" && key !== "state") ||
      url.searchParams.getAll("code").length !== 1 ||
      url.searchParams.getAll("state").length > 1
    ) {
      return null;
    }

    const code = url.searchParams.get("code") ?? "";
    const queryStates = url.searchParams.getAll("state");
    if (!validCode(code)) return null;

    let state;
    if (queryStates.length === 1) {
      if (url.hash !== "") return null;
      state = queryStates[0];
    } else {
      if (!url.hash.startsWith("#")) return null;
      state = url.hash.slice(1);
    }
    return statePattern.test(state) ? { code, state } : null;
  }

  let currentUrl;
  try {
    currentUrl = new URL(location.href);
  } catch {
    return;
  }
  if (
    currentUrl.origin !== providerOrigin ||
    currentUrl.pathname !== providerPath ||
    currentUrl.username !== "" ||
    currentUrl.password !== ""
  ) {
    return;
  }

  let callback;
  if (currentUrl.search !== "" || currentUrl.hash !== "") {
    callback = parseUrl(currentUrl);
  } else {
    if (location.href !== `${providerOrigin}${providerPath}`) return;
    const visibleBody = document.body?.innerText;
    callback = typeof visibleBody === "string" ? parseBody(visibleBody) : null;
  }
  if (!callback) return;

  location.replace(
    `${localCallback}#code=${encodeURIComponent(callback.code)}&state=${encodeURIComponent(callback.state)}`,
  );
})();
