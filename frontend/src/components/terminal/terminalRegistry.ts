import { Terminal as XTerminal, type ITheme } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import "@xterm/xterm/css/xterm.css";
import { WriteSSH } from "../../../wailsjs/go/app/App";
import { EventsOn, EventsOff } from "../../../wailsjs/runtime/runtime";
import { base64ToBytes, bytesToBase64 } from "@/lib/terminalEncode";
import { useTerminalStore } from "@/stores/terminalStore";
import { DEFAULT_TERMINAL_FONT_FAMILY, useTerminalThemeStore } from "@/stores/terminalThemeStore";
import { TerminalImageController } from "./terminalImageProtocol";

export interface TerminalInstance {
  term: XTerminal;
  fitAddon: FitAddon;
  searchAddon: SearchAddon;
  container: HTMLDivElement;
  imageController: TerminalImageController;
}

interface InternalInstance extends TerminalInstance {
  dispose: () => void;
}

// Persistent xterm instances keyed by sessionId. Lifted out of React so split-pane
// re-renders don't unmount/dispose the terminal and lose scrollback.
const registry = new Map<string, InternalInstance>();

export function getOrCreateTerminal(
  sessionId: string,
  init: { fontSize: number; fontFamily?: string; theme?: ITheme; scrollback: number }
): TerminalInstance {
  const cached = registry.get(sessionId);
  if (cached) return cached;

  const container = document.createElement("div");
  container.style.height = "100%";
  container.style.width = "100%";

  const term = new XTerminal({
    cursorBlink: true,
    fontSize: init.fontSize,
    fontFamily: init.fontFamily || DEFAULT_TERMINAL_FONT_FAMILY,
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

  const onDataDispose = term.onData((data) => {
    WriteSSH(sessionId, bytesToBase64(new TextEncoder().encode(data))).catch(console.error);
  });

  const dataEvent = "ssh:data:" + sessionId;
  EventsOn(dataEvent, (dataB64: string) => {
    term.write(imageController.processIncoming(base64ToBytes(dataB64)));
  });

  const closedEvent = "ssh:closed:" + sessionId;
  EventsOn(closedEvent, () => {
    imageController.clearAllImages();
    term.write("\r\n\x1b[31m[Connection closed]\x1b[0m\r\n");
    useTerminalStore.getState().markClosed(sessionId);
  });

  const instance: InternalInstance = {
    term,
    fitAddon,
    searchAddon,
    container,
    imageController,
    dispose: () => {
      onDataDispose.dispose();
      EventsOff(dataEvent);
      EventsOff(closedEvent);
      imageController.dispose();
      term.dispose();
      registry.delete(sessionId);
    },
  };

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
