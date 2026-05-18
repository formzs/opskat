import { Terminal as XTerminal, type ITheme } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { WebglAddon } from "@xterm/addon-webgl";
import "@xterm/xterm/css/xterm.css";
import { WriteSSH, WriteSerial } from "../../../wailsjs/go/app/App";
import { EventsOn, EventsOff } from "../../../wailsjs/runtime/runtime";
import { base64ToBytes, bytesToBase64 } from "@/lib/terminalEncode";
import { useTerminalStore } from "@/stores/terminalStore";
import { DEFAULT_TERMINAL_FONT_FAMILY, useTerminalThemeStore } from "@/stores/terminalThemeStore";
import { useShortcutStore } from "@/stores/shortcutStore";
import { withTerminalFontFallback } from "@/data/terminalFonts";
import i18n from "@/i18n";
import { createTerminalInputBridge, type TerminalInputBridge } from "./terminalInputBridge";
import { TerminalImageController } from "./terminalImageProtocol";
import { attachXtermRolloverGuard } from "./xtermRolloverGuard";

export interface TerminalInstance {
  term: XTerminal;
  fitAddon: FitAddon;
  searchAddon: SearchAddon;
  container: HTMLDivElement;
  imageController: TerminalImageController;
  bridge: TerminalInputBridge;
}

interface InternalInstance extends TerminalInstance {
  isClosed: boolean;
  dispose: () => void;
}

const registry = new Map<string, InternalInstance>();

export function getOrCreateTerminal(
  sessionId: string,
  init: {
    fontSize: number;
    fontFamily?: string;
    theme?: ITheme;
    scrollback: number;
    transport?: "ssh" | "serial";
    webglEnabled?: boolean;
  }
): TerminalInstance {
  const cached = registry.get(sessionId);
  if (cached) return cached;

  const container = document.createElement("div");
  container.style.height = "100%";
  container.style.width = "100%";

  const term = new XTerminal({
    cursorBlink: true,
    fontSize: init.fontSize,
    fontFamily: withTerminalFontFallback(init.fontFamily || DEFAULT_TERMINAL_FONT_FAMILY),
    theme: init.theme,
    scrollback: init.scrollback,
  });

  const fitAddon = new FitAddon();
  const searchAddon = new SearchAddon();
  term.loadAddon(fitAddon);
  term.loadAddon(searchAddon);
  term.open(container);
  const imageController = new TerminalImageController(sessionId, term);
  imageController.setEnabled(useTerminalThemeStore.getState().enableImagePreview);

  const isSerial = init.transport ? init.transport === "serial" : sessionId.startsWith("serial-");
  const writeFn = isSerial ? WriteSerial : WriteSSH;
  const eventPrefix = isSerial ? "serial" : "ssh";

  const bridge = createTerminalInputBridge({
    term,
    shortcuts: useShortcutStore.getState().shortcuts,
    onFilter: () => {},
    onCopy: () => false,
  });

  let webglAddon: WebglAddon | null = null;
  let webglContextLossSub: { dispose: () => void } | null = null;
  if (init.webglEnabled !== false) {
    try {
      const addon = new WebglAddon();
      webglContextLossSub = addon.onContextLoss(() => {
        addon.dispose();
        webglAddon = null;
        useTerminalThemeStore.getState().setWebglEnabled(false);
      });
      term.loadAddon(addon);
      webglAddon = addon;
    } catch (err) {
      console.warn("WebGL renderer unavailable, falling back to DOM renderer", err);
      useTerminalThemeStore.getState().setWebglEnabled(false);
    }
  }

  const writeData = (data: string) =>
    writeFn(sessionId, bytesToBase64(new TextEncoder().encode(data))).catch(console.error);

  const onDataDispose = term.onData(writeData);
  const rolloverGuard = attachXtermRolloverGuard(term, writeData);

  const dataEvent = `${eventPrefix}:data:${sessionId}`;
  EventsOn(dataEvent, (dataB64: string) => {
    term.write(imageController.processIncoming(base64ToBytes(dataB64)));
  });

  const closedEvent = `${eventPrefix}:closed:${sessionId}`;
  let onKeyDispose: { dispose: () => void };

  const instance: InternalInstance = {
    term,
    fitAddon,
    searchAddon,
    container,
    imageController,
    bridge,
    isClosed: false,
    dispose: () => {
      bridge.dispose();
      rolloverGuard.dispose();
      onDataDispose.dispose();
      onKeyDispose.dispose();
      EventsOff(dataEvent);
      EventsOff(closedEvent);
      webglContextLossSub?.dispose();
      webglContextLossSub = null;
      webglAddon?.dispose();
      webglAddon = null;
      imageController.dispose();
      term.dispose();
      registry.delete(sessionId);
    },
  };

  onKeyDispose = term.onKey(({ key }) => {
    if (instance.isClosed && key === "\r") {
      instance.isClosed = false;
      useTerminalStore.getState().reconnectBySession(sessionId);
    }
  });

  EventsOn(closedEvent, () => {
    imageController.clearAllImages();
    const hint = i18n.t("ssh.session.closedHint");
    term.write(`\r\n\x1b[31m${hint}\x1b[0m\r\n`);
    useTerminalStore.getState().markClosed(sessionId);
    instance.isClosed = true;
  });

  registry.set(sessionId, instance);
  return instance;
}

export function disposeTerminal(sessionId: string): void {
  const inst = registry.get(sessionId);
  if (inst) inst.dispose();
}

export function getTerminalInstance(sessionId: string): TerminalInstance | undefined {
  return registry.get(sessionId);
}
