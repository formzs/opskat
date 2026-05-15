import { describe, it, expect, beforeEach } from "vitest";
import {
  DEFAULT_TERMINAL_FONT_FAMILY,
  DEFAULT_TERMINAL_FONT_PRESET_ID,
  TERMINAL_FONT_PRESETS,
  useTerminalThemeStore,
  SCROLLBACK_DEFAULT,
} from "../stores/terminalThemeStore";
import { builtinThemes, type TerminalTheme } from "../data/terminalThemes";

function makeCustomTheme(id: string, name: string): TerminalTheme {
  return {
    id,
    name,
    background: "#000",
    foreground: "#fff",
    cursor: "#fff",
    black: "#000",
    red: "#f00",
    green: "#0f0",
    yellow: "#ff0",
    blue: "#00f",
    magenta: "#f0f",
    cyan: "#0ff",
    white: "#fff",
    brightBlack: "#888",
    brightRed: "#f88",
    brightGreen: "#8f8",
    brightYellow: "#ff8",
    brightBlue: "#88f",
    brightMagenta: "#f8f",
    brightCyan: "#8ff",
    brightWhite: "#fff",
  };
}

describe("terminalThemeStore", () => {
  beforeEach(() => {
    localStorage.clear();
    useTerminalThemeStore.setState({
      selectedThemeId: "default",
      customThemes: [],
      fontSize: 14,
      fontPresetId: DEFAULT_TERMINAL_FONT_PRESET_ID,
      fontFamily: DEFAULT_TERMINAL_FONT_FAMILY,
      scrollback: SCROLLBACK_DEFAULT,
      enableImagePreview: true,
      webglEnabled: true,
    });
  });

  it("changes the selected theme", () => {
    useTerminalThemeStore.getState().setSelectedThemeId("dracula");
    expect(useTerminalThemeStore.getState().selectedThemeId).toBe("dracula");
  });

  it("sets font size within bounds", () => {
    useTerminalThemeStore.getState().setFontSize(20);
    expect(useTerminalThemeStore.getState().fontSize).toBe(20);
  });

  it("clamps font size to bounds", () => {
    useTerminalThemeStore.getState().setFontSize(2);
    expect(useTerminalThemeStore.getState().fontSize).toBe(8);
    useTerminalThemeStore.getState().setFontSize(100);
    expect(useTerminalThemeStore.getState().fontSize).toBe(32);
  });

  it("switches to bundled preset font family", () => {
    useTerminalThemeStore.getState().setFontPresetId("hack-nerd");
    expect(useTerminalThemeStore.getState().fontPresetId).toBe("hack-nerd");
    expect(useTerminalThemeStore.getState().fontFamily).toContain("Hack Nerd Font Mono");
  });

  it("falls back to default preset for unknown value", () => {
    useTerminalThemeStore.getState().setFontPresetId("menlo");
    expect(useTerminalThemeStore.getState().fontPresetId).toBe(DEFAULT_TERMINAL_FONT_PRESET_ID);
    expect(useTerminalThemeStore.getState().fontFamily).toBe(DEFAULT_TERMINAL_FONT_FAMILY);
  });

  it("keeps the preset list aligned with bundled font count", () => {
    expect(TERMINAL_FONT_PRESETS).toHaveLength(12);
  });

  it("rehydrates with the default preset for removed values", async () => {
    localStorage.setItem(
      "terminal_theme",
      JSON.stringify({
        state: {
          selectedThemeId: "default",
          customThemes: [],
          fontSize: 14,
          fontPresetId: "consolas",
          fontFamily: "'Consolas', monospace",
          scrollback: SCROLLBACK_DEFAULT,
          enableImagePreview: false,
          webglEnabled: false,
        },
        version: 4,
      })
    );

    useTerminalThemeStore.persist.rehydrate();
    await Promise.resolve();

    expect(useTerminalThemeStore.getState().fontPresetId).toBe(DEFAULT_TERMINAL_FONT_PRESET_ID);
    expect(useTerminalThemeStore.getState().fontFamily).toBe(DEFAULT_TERMINAL_FONT_FAMILY);
    expect(useTerminalThemeStore.getState().enableImagePreview).toBe(false);
    expect(useTerminalThemeStore.getState().webglEnabled).toBe(false);
  });

  it("toggles image preview", () => {
    useTerminalThemeStore.getState().setEnableImagePreview(false);
    expect(useTerminalThemeStore.getState().enableImagePreview).toBe(false);
  });

  it("toggles webgl", () => {
    useTerminalThemeStore.getState().setWebglEnabled(false);
    expect(useTerminalThemeStore.getState().webglEnabled).toBe(false);
  });

  it("defaults scrollback to 25000 and clamps values", () => {
    expect(useTerminalThemeStore.getState().scrollback).toBe(25000);
    expect(SCROLLBACK_DEFAULT).toBe(25000);
    useTerminalThemeStore.getState().setScrollback(10);
    expect(useTerminalThemeStore.getState().scrollback).toBe(100);
    useTerminalThemeStore.getState().setScrollback(99_999_999);
    expect(useTerminalThemeStore.getState().scrollback).toBe(1_000_000);
  });

  it("adds, updates and removes custom themes", () => {
    const theme = makeCustomTheme("c1", "My Theme");
    useTerminalThemeStore.getState().addCustomTheme(theme);
    expect(useTerminalThemeStore.getState().customThemes).toHaveLength(1);

    const updated = { ...theme, name: "Renamed Theme" };
    useTerminalThemeStore.getState().updateCustomTheme(updated);
    expect(useTerminalThemeStore.getState().customThemes[0].name).toBe("Renamed Theme");

    useTerminalThemeStore.getState().removeCustomTheme("c1");
    expect(useTerminalThemeStore.getState().customThemes).toHaveLength(0);
  });

  it("returns active builtin/custom theme or default fallback", () => {
    useTerminalThemeStore.getState().setSelectedThemeId("default");
    expect(useTerminalThemeStore.getState().getActiveTheme()).toEqual(builtinThemes[0]);

    useTerminalThemeStore.getState().setSelectedThemeId("dracula");
    expect(useTerminalThemeStore.getState().getActiveTheme().id).toBe("dracula");

    const theme = makeCustomTheme("c1", "My Theme");
    useTerminalThemeStore.getState().addCustomTheme(theme);
    useTerminalThemeStore.getState().setSelectedThemeId("c1");
    expect(useTerminalThemeStore.getState().getActiveTheme().id).toBe("c1");

    useTerminalThemeStore.getState().setSelectedThemeId("nonexistent");
    expect(useTerminalThemeStore.getState().getActiveTheme()).toEqual(builtinThemes[0]);
  });
});
