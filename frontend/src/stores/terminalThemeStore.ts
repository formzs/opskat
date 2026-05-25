import { create } from "zustand";
import { persist } from "zustand/middleware";
import { TerminalTheme, builtinThemes } from "@/data/terminalThemes";

export const SCROLLBACK_MIN = 100;
export const SCROLLBACK_MAX = 1000000;
export const SCROLLBACK_DEFAULT = 25000;
export const DEFAULT_TERMINAL_FONT_PRESET_ID = "sauce-code-pro-nerd";
export const TERMINAL_FONT_PRESETS = [
  {
    id: DEFAULT_TERMINAL_FONT_PRESET_ID,
    label: "Source Code Pro",
    family: "'SauceCodePro Nerd Font Mono', 'Source Code Pro', 'Symbols Nerd Font Mono', monospace",
  },
  {
    id: "jetbrains-mono-nerd",
    label: "JetBrains Mono",
    family: "'JetBrainsMono Nerd Font Mono', 'JetBrains Mono', 'Symbols Nerd Font Mono', monospace",
  },
  {
    id: "cascadia-code-nerd",
    label: "Cascadia Code",
    family: "'CaskaydiaCove Nerd Font Mono', 'Cascadia Code', 'Symbols Nerd Font Mono', monospace",
  },
  {
    id: "fira-code-nerd",
    label: "Fira Code",
    family: "'FiraCode Nerd Font Mono', 'Fira Code', 'Symbols Nerd Font Mono', monospace",
  },
  {
    id: "hack-nerd",
    label: "Hack",
    family: "'Hack Nerd Font Mono', 'Hack', 'Symbols Nerd Font Mono', monospace",
  },
  {
    id: "ibm-plex-mono-nerd",
    label: "IBM Plex Mono",
    family: "'BlexMono Nerd Font Mono', 'IBM Plex Mono', 'Symbols Nerd Font Mono', monospace",
  },
  {
    id: "inconsolata-nerd",
    label: "Inconsolata",
    family: "'Inconsolata Nerd Font Mono', 'Inconsolata', 'Symbols Nerd Font Mono', monospace",
  },
  {
    id: "iosevka-nerd",
    label: "Iosevka",
    family: "'Iosevka Nerd Font Mono', 'Iosevka', 'Symbols Nerd Font Mono', monospace",
  },
  {
    id: "monoid-nerd",
    label: "Monoid",
    family: "'Monoid Nerd Font Mono', 'Monoid', 'Symbols Nerd Font Mono', monospace",
  },
  {
    id: "ubuntu-mono-nerd",
    label: "Ubuntu Mono",
    family: "'UbuntuMono Nerd Font Mono', 'Ubuntu Mono', 'Symbols Nerd Font Mono', monospace",
  },
  {
    id: "droid-sans-mono-nerd",
    label: "Droid Sans Mono",
    family: "'DroidSansM Nerd Font Mono', 'Droid Sans Mono', 'Symbols Nerd Font Mono', monospace",
  },
  {
    id: "anonymous-pro",
    label: "Anonymous Pro",
    family: "'AnonymicePro Nerd Font Mono', 'Anonymous Pro', 'Symbols Nerd Font Mono', monospace",
  },
] as const;
export const DEFAULT_TERMINAL_FONT_FAMILY = TERMINAL_FONT_PRESETS[0].family;

function resolveFontPreset(presetId?: string) {
  return TERMINAL_FONT_PRESETS.find((item) => item.id === presetId) || TERMINAL_FONT_PRESETS[0];
}

function normalizeFontPresetState(state: Partial<TerminalThemeState> | undefined) {
  const preset = resolveFontPreset(state?.fontPresetId);
  return {
    ...state,
    fontPresetId: preset.id,
    fontFamily: preset.family,
  };
}

export type WebglFailureCause = "init-threw" | "context-loss";

export interface WebglFailure {
  cause: WebglFailureCause;
  name?: string;
  message: string;
  at: number;
}

interface TerminalThemeState {
  selectedThemeId: string;
  customThemes: TerminalTheme[];
  fontSize: number;
  fontPresetId: string;
  fontFamily: string;
  scrollback: number;
  enableImagePreview: boolean;
  webglEnabled: boolean;
  // 最近一次 WebGL 自动关闭的原因。setWebglEnabled(true) 会把它清掉，所以只在
  // GPU 加速被系统自动关掉后到下一次用户主动开启之间存在。
  webglError: WebglFailure | null;

  setSelectedThemeId: (id: string) => void;
  setFontSize: (size: number) => void;
  setFontPresetId: (presetId: string) => void;
  setScrollback: (lines: number) => void;
  setEnableImagePreview: (enabled: boolean) => void;
  setWebglEnabled: (enabled: boolean) => void;
  reportWebglFailure: (failure: WebglFailure) => void;
  addCustomTheme: (theme: TerminalTheme) => void;
  updateCustomTheme: (theme: TerminalTheme) => void;
  removeCustomTheme: (id: string) => void;
  getActiveTheme: () => TerminalTheme;
}

export const useTerminalThemeStore = create<TerminalThemeState>()(
  persist(
    (set, get) => ({
      selectedThemeId: "default",
      customThemes: [],
      fontSize: 14,
      fontPresetId: DEFAULT_TERMINAL_FONT_PRESET_ID,
      fontFamily: DEFAULT_TERMINAL_FONT_FAMILY,
      scrollback: SCROLLBACK_DEFAULT,
      enableImagePreview: true,
      webglEnabled: true,
      webglError: null,

      setSelectedThemeId: (id) => set({ selectedThemeId: id }),
      setWebglEnabled: (enabled) => set(enabled ? { webglEnabled: true, webglError: null } : { webglEnabled: false }),
      reportWebglFailure: (failure) => set({ webglError: failure }),
      setFontSize: (size) => set({ fontSize: Math.max(8, Math.min(32, size)) }),
      setFontPresetId: (presetId) => {
        const preset = resolveFontPreset(presetId);
        set({ fontPresetId: preset.id, fontFamily: preset.family });
      },
      setScrollback: (lines) => {
        const n = Number.isFinite(lines) ? Math.floor(lines) : SCROLLBACK_DEFAULT;
        set({ scrollback: Math.max(SCROLLBACK_MIN, Math.min(SCROLLBACK_MAX, n)) });
      },
      setEnableImagePreview: (enabled) => set({ enableImagePreview: enabled }),
      addCustomTheme: (theme) =>
        set((state) => ({
          customThemes: [...state.customThemes, theme],
        })),
      updateCustomTheme: (theme) =>
        set((state) => ({
          customThemes: state.customThemes.map((t) => (t.id === theme.id ? theme : t)),
        })),
      removeCustomTheme: (id) =>
        set((state) => ({
          customThemes: state.customThemes.filter((t) => t.id !== id),
          selectedThemeId: state.selectedThemeId === id ? "default" : state.selectedThemeId,
        })),
      getActiveTheme: () => {
        const { selectedThemeId, customThemes } = get();
        return (
          builtinThemes.find((t) => t.id === selectedThemeId) ||
          customThemes.find((t) => t.id === selectedThemeId) ||
          builtinThemes[0]
        );
      },
    }),
    {
      name: "terminal_theme",
      version: 4,
      migrate: (persistedState: unknown) => {
        const state = normalizeFontPresetState((persistedState as Partial<TerminalThemeState> | undefined) || {});
        return {
          webglEnabled: true,
          enableImagePreview: true,
          ...state,
        };
      },
      merge: (persistedState, currentState) => {
        return {
          ...currentState,
          webglEnabled: true,
          enableImagePreview: true,
          webglError: null,
          ...normalizeFontPresetState((persistedState as Partial<TerminalThemeState> | undefined) || {}),
        };
      },
    }
  )
);

/** 将 TerminalTheme 转换为 xterm.js ITheme 对象 */
export function toXtermTheme(theme: TerminalTheme) {
  return {
    background: theme.background,
    foreground: theme.foreground,
    cursor: theme.cursor,
    cursorAccent: theme.cursorAccent,
    selectionBackground: theme.selectionBackground,
    selectionForeground: theme.selectionForeground,
    selectionInactiveBackground: theme.selectionInactiveBackground,
    black: theme.black,
    red: theme.red,
    green: theme.green,
    yellow: theme.yellow,
    blue: theme.blue,
    magenta: theme.magenta,
    cyan: theme.cyan,
    white: theme.white,
    brightBlack: theme.brightBlack,
    brightRed: theme.brightRed,
    brightGreen: theme.brightGreen,
    brightYellow: theme.brightYellow,
    brightBlue: theme.brightBlue,
    brightMagenta: theme.brightMagenta,
    brightCyan: theme.brightCyan,
    brightWhite: theme.brightWhite,
  };
}
