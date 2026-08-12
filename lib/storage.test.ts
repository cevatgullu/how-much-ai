import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { loadSettings, saveSettings, type Settings } from "./storage.ts";

type StorageStub = Pick<Storage, "getItem" | "setItem">;

const originalWindow = globalThis.window;

function installStorage(storage: StorageStub): void {
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { localStorage: storage },
    writable: true,
  });
}

function removeWindow(): void {
  Reflect.deleteProperty(globalThis, "window");
}

afterEach(() => {
  if (originalWindow === undefined) removeWindow();
  else {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: originalWindow,
      writable: true,
    });
  }
});

test("settings default safely when browser storage is unavailable", () => {
  removeWindow();
  assert.deepEqual(loadSettings(), {
    autoRefresh: true,
    sortMode: "source",
    localNotifications: { remainingWarnings: true, resetNotifications: true },
  });
  assert.equal(saveSettings({
    autoRefresh: false,
    sortMode: "weekly-usage",
    localNotifications: { remainingWarnings: false, resetNotifications: true },
  }), true);

  installStorage({
    getItem() {
      throw new Error("storage denied");
    },
    setItem() {
      throw new Error("storage denied");
    },
  });
  assert.deepEqual(loadSettings(), {
    autoRefresh: true,
    sortMode: "source",
    localNotifications: { remainingWarnings: true, resetNotifications: true },
  });
  let saveResult: boolean | undefined;
  assert.doesNotThrow(() => {
    saveResult = saveSettings({
      autoRefresh: false,
      sortMode: "weekly-reset",
      localNotifications: { remainingWarnings: true, resetNotifications: false },
    });
  });
  assert.equal(saveResult, false);
});

test("loadSettings migrates missing sort mode and accepts only exact settings values", () => {
  let stored: string | null = null;
  installStorage({
    getItem: () => stored,
    setItem: (_key, value) => {
      stored = value;
    },
  });

  for (const value of [true, false]) {
    stored = JSON.stringify({ autoRefresh: value, ignored: "field" });
    assert.deepEqual(loadSettings(), {
      autoRefresh: value,
      sortMode: "source",
      localNotifications: { remainingWarnings: true, resetNotifications: true },
    });
  }

  for (const sortMode of ["source", "weekly-usage", "weekly-reset"]) {
    stored = JSON.stringify({
      autoRefresh: false,
      sortMode,
      localNotifications: { remainingWarnings: false, resetNotifications: true, ignored: false },
    });
    assert.deepEqual(loadSettings(), {
      autoRefresh: false,
      sortMode,
      localNotifications: { remainingWarnings: false, resetNotifications: true },
    });
  }

  for (const sortMode of ["weekly-provider", "future", "", 1, null, {}]) {
    stored = JSON.stringify({
      autoRefresh: false,
      sortMode,
      localNotifications: { remainingWarnings: false, resetNotifications: true },
    });
    assert.deepEqual(loadSettings(), {
      autoRefresh: false,
      sortMode: "source",
      localNotifications: { remainingWarnings: false, resetNotifications: true },
    });
  }

  stored = JSON.stringify({
    autoRefresh: true,
    localNotifications: { remainingWarnings: "false", resetNotifications: 0 },
  });
  assert.deepEqual(loadSettings(), {
    autoRefresh: true,
    sortMode: "source",
    localNotifications: { remainingWarnings: true, resetNotifications: true },
  });

  for (const invalid of [
    null,
    false,
    [],
    {},
    { autoRefresh: "false" },
    { autoRefresh: 0 },
    { autoRefresh: null },
  ]) {
    stored = JSON.stringify(invalid);
    assert.deepEqual(loadSettings(), {
      autoRefresh: true,
      sortMode: "source",
      localNotifications: { remainingWarnings: true, resetNotifications: true },
    });
  }
});

test("corrupt and oversized settings fall back without throwing", () => {
  let stored = "{not-json";
  installStorage({
    getItem: () => stored,
    setItem() {},
  });

  assert.doesNotThrow(() => loadSettings());
  assert.deepEqual(loadSettings(), {
    autoRefresh: true,
    sortMode: "source",
    localNotifications: { remainingWarnings: true, resetNotifications: true },
  });

  stored = JSON.stringify({ autoRefresh: false, padding: "x".repeat(4_097) });
  assert.deepEqual(loadSettings(), {
    autoRefresh: true,
    sortMode: "source",
    localNotifications: { remainingWarnings: true, resetNotifications: true },
  });
});

test("saveSettings writes the canonical payload and reports failures without throwing", () => {
  let write: { key: string; value: string } | null = null;
  installStorage({
    getItem: () => null,
    setItem: (key, value) => {
      write = { key, value };
    },
  });

  assert.equal(saveSettings({
    autoRefresh: false,
    sortMode: "weekly-reset",
    localNotifications: { remainingWarnings: true, resetNotifications: false },
  }), true);
  assert.deepEqual(write, {
    key: "usage.settings.v1",
    value: '{"autoRefresh":false,"sortMode":"weekly-reset","localNotifications":{"remainingWarnings":true,"resetNotifications":false}}',
  });
  assert.equal(write.value.includes("accountId"), false);
  assert.equal(write.value.includes("email"), false);
  assert.equal(write.value.includes("snapshot"), false);
  assert.equal(write.value.includes("history"), false);

  assert.equal(saveSettings({
    autoRefresh: true,
    sortMode: "future" as unknown as Settings["sortMode"],
    localNotifications: { remainingWarnings: true, resetNotifications: true },
  }), false);

  installStorage({
    getItem: () => null,
    setItem() {
      throw new Error("quota exceeded");
    },
  });
  let failureResult: boolean | undefined;
  assert.doesNotThrow(() => {
    failureResult = saveSettings({
      autoRefresh: true,
      sortMode: "source",
      localNotifications: { remainingWarnings: true, resetNotifications: true },
    });
  });
  assert.equal(failureResult, false);
});
