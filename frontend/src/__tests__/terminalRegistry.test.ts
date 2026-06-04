import { describe, it, expect, vi, beforeEach } from "vitest";

const hoisted = vi.hoisted(() => {
  const eventHandlers = new Map<string, (...args: unknown[]) => void>();
  const writeSpy = vi.fn();
  const disposeSpy = vi.fn();
  const reconnectBySessionMock = vi.fn();
  const terminalCtor = vi.fn();
  const bridgeDisposeSpy = vi.fn();
  const webglAddonCtor = vi.fn();
  const webglAddonDisposeSpy = vi.fn();
  const webglContextLossDisposeSpy = vi.fn();
  const webglClearTextureAtlasSpy = vi.fn();
  const setWebglEnabledSpy = vi.fn();
  const reportWebglFailureSpy = vi.fn();
  const disposeOrder: string[] = [];
  const state: { capturedOnKey: ((e: { key: string }) => void) | null } = {
    capturedOnKey: null,
  };
  return {
    eventHandlers,
    writeSpy,
    disposeSpy,
    reconnectBySessionMock,
    terminalCtor,
    bridgeDisposeSpy,
    webglAddonCtor,
    webglAddonDisposeSpy,
    webglContextLossDisposeSpy,
    webglClearTextureAtlasSpy,
    setWebglEnabledSpy,
    reportWebglFailureSpy,
    disposeOrder,
    state,
  };
});

vi.mock("../../wailsjs/runtime/runtime", () => ({
  EventsOn: (event: string, handler: (...args: unknown[]) => void) => {
    hoisted.eventHandlers.set(event, handler);
  },
  EventsOff: (event: string) => {
    hoisted.eventHandlers.delete(event);
  },
}));

vi.mock("../../wailsjs/go/ssh/SSH", () => ({
  WriteSSH: vi.fn().mockResolvedValue(undefined),
  ResizeSSH: vi.fn().mockResolvedValue(undefined),
  ConnectSSHAsync: vi.fn().mockResolvedValue("conn-ssh"),
  DisconnectSSH: vi.fn(),
  SplitSSH: vi.fn().mockResolvedValue("split-ssh"),
}));

vi.mock("../../wailsjs/go/serial/Serial", () => ({
  WriteSerial: vi.fn().mockResolvedValue(undefined),
  ResizeSerialTerminal: vi.fn().mockResolvedValue(undefined),
  ConnectSerialAsync: vi.fn().mockResolvedValue("conn-serial"),
  DisconnectSerial: vi.fn(),
}));

vi.mock("../../wailsjs/go/local/Local", () => ({
  WriteLocal: vi.fn().mockResolvedValue(undefined),
  ResizeLocalTerminal: vi.fn().mockResolvedValue(undefined),
  ConnectLocalAsync: vi.fn().mockResolvedValue("conn-local"),
  DisconnectLocal: vi.fn(),
  SplitLocal: vi.fn().mockResolvedValue("split-local"),
}));

vi.mock("@xterm/xterm", () => {
  class MockTerminal {
    loadAddon = vi.fn();
    open = vi.fn();
    write = hoisted.writeSpy;
    onData = vi.fn(() => ({ dispose: vi.fn() }));
    onKey = vi.fn((handler: (e: { key: string }) => void) => {
      hoisted.state.capturedOnKey = handler;
      return { dispose: vi.fn() };
    });
    onWriteParsed = vi.fn(() => ({ dispose: vi.fn() }));
    onRender = vi.fn(() => ({ dispose: vi.fn() }));
    attachCustomKeyEventHandler = vi.fn();
    textarea = { addEventListener: vi.fn(), removeEventListener: vi.fn() } as unknown as HTMLTextAreaElement;
    options = { screenReaderMode: false };
    dispose = vi.fn(() => {
      hoisted.disposeOrder.push("term");
      hoisted.disposeSpy();
    });
    constructor() {
      hoisted.terminalCtor();
    }
  }
  return { Terminal: MockTerminal };
});

vi.mock("@/components/terminal/terminalInputBridge", () => ({
  createTerminalInputBridge: vi.fn(() => ({
    setShortcuts: vi.fn(),
    setOnFilter: vi.fn(),
    setOnCopy: vi.fn(),
    dispose: vi.fn(() => {
      hoisted.disposeOrder.push("bridge");
      hoisted.bridgeDisposeSpy();
    }),
  })),
}));

vi.mock("@xterm/addon-fit", () => ({ FitAddon: class {} }));
vi.mock("@xterm/addon-search", () => ({ SearchAddon: class {} }));
vi.mock("@xterm/addon-webgl", () => {
  class MockWebglAddon {
    constructor() {
      hoisted.webglAddonCtor();
    }
    onContextLoss = vi.fn(() => ({
      dispose: vi.fn(() => {
        hoisted.webglContextLossDisposeSpy();
      }),
    }));
    clearTextureAtlas = vi.fn(() => {
      hoisted.webglClearTextureAtlasSpy();
    });
    dispose = vi.fn(() => {
      hoisted.disposeOrder.push("webgl");
      hoisted.webglAddonDisposeSpy();
    });
  }
  return { WebglAddon: MockWebglAddon };
});
vi.mock("@xterm/xterm/css/xterm.css", () => ({}));

vi.mock("@/stores/terminalStore", async (importActual) => {
  const actual = await importActual<typeof import("@/stores/terminalStore")>();
  return {
    // 复用真实的 TRANSPORTS 表与 transport 网关函数（纯函数，无副作用），
    // useTerminalStore 仍替换为最小桩，避免拉起整个 store 的副作用。
    TRANSPORTS: actual.TRANSPORTS,
    transportForAsset: actual.transportForAsset,
    inferTransportFromSessionId: actual.inferTransportFromSessionId,
    useTerminalStore: {
      getState: () => ({
        markClosed: vi.fn(),
        reconnectBySession: hoisted.reconnectBySessionMock,
      }),
    },
  };
});

vi.mock("@/stores/terminalThemeStore", () => ({
  DEFAULT_TERMINAL_FONT_FAMILY: "monospace",
  useTerminalThemeStore: {
    getState: () => ({
      enableImagePreview: true,
      setWebglEnabled: hoisted.setWebglEnabledSpy,
      reportWebglFailure: hoisted.reportWebglFailureSpy,
    }),
  },
}));

vi.mock("@/data/terminalFonts", () => ({
  withTerminalFontFallback: (s: string) => s,
  withTerminalFontIsolation: (_id: string, s: string) => s,
}));
vi.mock("@/lib/terminalEncode", () => ({
  base64ToBytes: (_base64: string) => new Uint8Array(),
  bytesToBase64: () => "",
}));
vi.mock("@/components/terminal/terminalImageProtocol", () => ({
  TerminalImageController: class {
    processIncoming(bytes: Uint8Array) {
      return bytes;
    }
    clearAllImages() {}
    dispose() {}
    setEnabled() {}
  },
}));
vi.mock("@/i18n", () => ({
  default: { t: (key: string) => `<<${key}>>` },
}));

import { getOrCreateTerminal, disposeTerminal } from "@/components/terminal/terminalRegistry";
import { TRANSPORTS, transportForAsset, inferTransportFromSessionId } from "@/stores/terminalStore";

describe("TRANSPORTS", () => {
  it("TRANSPORTS 覆盖 ssh/serial/local 且字段齐全", () => {
    for (const key of ["ssh", "serial", "local"] as const) {
      const t = TRANSPORTS[key];
      expect(t.eventPrefix).toBe(key);
      expect(typeof t.write).toBe("function");
      expect(typeof t.resize).toBe("function");
      expect(typeof t.connectAsync).toBe("function");
      expect(typeof t.disconnect).toBe("function");
      expect(typeof t.canSplit).toBe("boolean");
      // canSplit 与 split 必须一致:可分屏的 transport 必须提供 split 实现,反之不提供。
      expect(typeof t.split === "function").toBe(t.canSplit);
    }
    // ssh 复用连接、local 再起一个同 shell 的 PTY,二者均可分屏;serial 物理端口不可复用。
    expect(TRANSPORTS.ssh.canSplit).toBe(true);
    expect(TRANSPORTS.serial.canSplit).toBe(false);
    expect(TRANSPORTS.local.canSplit).toBe(true);
    // 只有 ssh 同步 cwd / 暴露 SFTP，serial/local 没有目录能力。
    expect(TRANSPORTS.ssh.hasDirectorySync).toBe(true);
    expect(TRANSPORTS.serial.hasDirectorySync).toBe(false);
    expect(TRANSPORTS.local.hasDirectorySync).toBe(false);
  });

  it("transportForAsset maps asset type → transport", () => {
    expect(transportForAsset("serial")).toBe("serial");
    expect(transportForAsset("local")).toBe("local");
    expect(transportForAsset("ssh")).toBe("ssh");
    expect(transportForAsset("k8s")).toBe("ssh"); // unknown → ssh default
  });

  it("inferTransportFromSessionId maps session id prefix → transport", () => {
    expect(inferTransportFromSessionId("serial-1")).toBe("serial");
    expect(inferTransportFromSessionId("local-2")).toBe("local");
    expect(inferTransportFromSessionId("abc-3")).toBe("ssh");
  });
});

describe("terminalRegistry", () => {
  beforeEach(() => {
    hoisted.eventHandlers.clear();
    hoisted.state.capturedOnKey = null;
    hoisted.writeSpy.mockClear();
    hoisted.disposeSpy.mockClear();
    hoisted.reconnectBySessionMock.mockClear();
    hoisted.terminalCtor.mockClear();
    hoisted.bridgeDisposeSpy.mockClear();
    hoisted.webglAddonCtor.mockClear();
    hoisted.webglAddonDisposeSpy.mockClear();
    hoisted.webglContextLossDisposeSpy.mockClear();
    hoisted.webglClearTextureAtlasSpy.mockClear();
    hoisted.setWebglEnabledSpy.mockClear();
    hoisted.reportWebglFailureSpy.mockClear();
    hoisted.disposeOrder.length = 0;
  });

  it("writes the i18n closed hint and marks closed when ssh:closed fires", () => {
    getOrCreateTerminal("sess-1", { fontSize: 14, fontFamily: "mono", scrollback: 1000 });
    const handler = hoisted.eventHandlers.get("ssh:closed:sess-1");
    expect(handler).toBeDefined();
    handler?.();
    const written = hoisted.writeSpy.mock.calls.map((c) => c[0]).join("");
    expect(written).toContain("<<ssh.session.closedHint>>");
    disposeTerminal("sess-1");
  });

  it("triggers reconnectBySession on Enter after close", () => {
    getOrCreateTerminal("sess-2", { fontSize: 14, fontFamily: "mono", scrollback: 1000 });
    hoisted.eventHandlers.get("ssh:closed:sess-2")?.();
    hoisted.state.capturedOnKey?.({ key: "\r" });
    expect(hoisted.reconnectBySessionMock).toHaveBeenCalledWith("sess-2");
    disposeTerminal("sess-2");
  });

  it("disposes bridge and webgl before term", () => {
    getOrCreateTerminal("sess-order", { fontSize: 14, fontFamily: "mono", scrollback: 1000 });
    disposeTerminal("sess-order");
    expect(hoisted.disposeOrder).toEqual(["bridge", "webgl", "term"]);
  });

  it("skips WebGL when webglEnabled is false", () => {
    getOrCreateTerminal("sess-no-webgl", {
      fontSize: 14,
      fontFamily: "mono",
      scrollback: 1000,
      webglEnabled: false,
    });
    expect(hoisted.webglAddonCtor).not.toHaveBeenCalled();
    disposeTerminal("sess-no-webgl");
  });
});
