import { beforeEach, describe, expect, it, vi } from "vitest";
import { TerminalImageController, __terminalImageProtocolTestUtils } from "../components/terminal/terminalImageProtocol";
import { builtinThemes } from "../data/terminalThemes";

const { DEFAULT_PLACEHOLDER_DIACRITIC, KITTY_PLACEHOLDER } = __terminalImageProtocolTestUtils;

function encodeBase64(text: string): string {
  return btoa(text);
}

function createTermStub() {
  const draculaTheme = builtinThemes.find((theme) => theme.id === "dracula");
  const viewport = document.createElement("div");
  viewport.className = "xterm-viewport";
  Object.defineProperty(viewport, "scrollTop", { configurable: true, value: 0, writable: true });

  const element = document.createElement("div");
  element.appendChild(viewport);

  return {
    options: {
      theme: draculaTheme,
    },
    buffer: {
      active: {
        baseY: 0,
        viewportY: 0,
      },
    },
    element,
    _core: {
      _renderService: {
        dimensions: {
          css: {
            cell: {
              height: 18,
              width: 9,
            },
          },
        },
      },
    },
  };
}

function flushAnimationFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

describe("terminalImageProtocol", () => {
  let createObjectURL: ReturnType<typeof vi.fn>;
  let revokeObjectURL: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    createObjectURL = vi.fn(() => "blob:test");
    revokeObjectURL = vi.fn();
    vi.stubGlobal(
      "URL",
      Object.assign(URL, {
        createObjectURL,
        revokeObjectURL,
      })
    );
  });

  it("parses kitty image transfers and converts placeholders into spaces", async () => {
    const term = createTermStub();
    const controller = new TerminalImageController("session-1", term as never);

    const pngBase64 =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO2WlpwAAAAASUVORK5CYII=";
    const payload =
      `\x1b_Ga=T,U=1,f=100,s=1,v=1,i=66051,m=0;${pngBase64}\x1b\\` +
      "\x1b[38;2;1;2;3m" +
      "\x1b[2;4H" +
      `${KITTY_PLACEHOLDER}${DEFAULT_PLACEHOLDER_DIACRITIC}${DEFAULT_PLACEHOLDER_DIACRITIC}`;

    const output = controller.processIncoming(new TextEncoder().encode(payload));
    expect(output).toContain("\x1b[2;4H ");

    await Promise.resolve();
    const debug = controller.getDebugState();
    expect(debug.resources).toEqual([{ format: 100, generation: 1, height: 1, id: 66051, width: 1 }]);
    expect(debug.placements).toEqual([{ bufferLine: 1, columns: 1, generation: 1, imageId: 66051, rows: 1, x: 4 }]);
  });

  it("concatenates chunked kitty transfers before rendering", async () => {
    const term = createTermStub();
    const controller = new TerminalImageController("session-chunked", term as never);
    const source = btoa("chunked-payload");
    const middle = Math.floor(source.length / 2);
    const first = source.slice(0, middle);
    const second = source.slice(middle);
    const payload =
      `\x1b_Ga=T,U=1,f=100,s=1,v=1,i=66051,m=1;${first}\x1b\\` +
      `\x1b_Gm=0;${second}\x1b\\` +
      "\x1b[38;2;1;2;3m" +
      "\x1b[2;4H" +
      `${KITTY_PLACEHOLDER}${DEFAULT_PLACEHOLDER_DIACRITIC}${DEFAULT_PLACEHOLDER_DIACRITIC}`;

    controller.processIncoming(new TextEncoder().encode(payload));
    await Promise.resolve();

    expect(controller.getDebugState().resources).toEqual([{ format: 100, generation: 1, height: 1, id: 66051, width: 1 }]);
    expect(createObjectURL).toHaveBeenCalledTimes(1);
  });

  it("clears tracked images on delete and clear-screen commands", async () => {
    const term = createTermStub();
    const controller = new TerminalImageController("session-2", term as never);

    const payload =
      `\x1b_Ga=T,U=1,f=100,s=1,v=1,i=5,m=0;${encodeBase64("png")}\x1b\\` +
      "\x1b[38;2;0;0;5m" +
      "\x1b[1;1H" +
      `${KITTY_PLACEHOLDER}${DEFAULT_PLACEHOLDER_DIACRITIC}${DEFAULT_PLACEHOLDER_DIACRITIC}`;

    controller.processIncoming(new TextEncoder().encode(payload));
    await Promise.resolve();
    expect(controller.getDebugState().resources).toHaveLength(1);

    controller.processIncoming(new TextEncoder().encode("\x1b_Ga=d,d=A\x1b\\"));
    expect(controller.getDebugState().resources).toHaveLength(0);

    controller.processIncoming(new TextEncoder().encode(payload));
    await Promise.resolve();
    controller.processIncoming(new TextEncoder().encode("\x1b[2J"));
    expect(controller.getDebugState().placements).toHaveLength(0);
  });

  it("responds to kitty graphics and terminal capability probes", () => {
    const term = createTermStub();
    const responses: string[] = [];
    const controller = new TerminalImageController("session-3", term as never, (payload) => responses.push(payload));

    controller.processIncoming(new TextEncoder().encode("\x1b_Gi=31,s=1,v=1,a=q,t=d,f=24;AAAA\x1b\\"));
    controller.processIncoming(new TextEncoder().encode("\x1b[>q"));
    controller.processIncoming(new TextEncoder().encode("\x1bP$q q\x1b\\"));
    controller.processIncoming(new TextEncoder().encode("\x1b[?12$p"));
    controller.processIncoming(new TextEncoder().encode("\x1b[?u"));
    controller.processIncoming(new TextEncoder().encode("\x1b[16t"));
    controller.processIncoming(new TextEncoder().encode("\x1b[0c"));

    expect(responses).toContain("\x1b_Gi=31;OK\x1b\\");
    expect(responses).toContain("\x1bP>|kitty 0.99.0\x1b\\");
    expect(responses).toContain("\x1bP1$r0\x1b\\");
    expect(responses).toContain("\x1b[?12;1$y");
    expect(responses).toContain("\x1b[?0u");
    expect(responses).toContain("\x1b[6;18;9t");
    expect(responses).toContain("\x1b[?62;c");
  });

  it("consumes OSC 11 background queries and responds with the active theme color", () => {
    const term = createTermStub();
    const responses: string[] = [];
    const controller = new TerminalImageController("session-osc", term as never, (payload) => responses.push(payload));

    const output = controller.processIncoming(new TextEncoder().encode("\x1b]11;?\x07#"));

    expect(output).toBe("#");
    expect(responses).toContain("\x1b]11;rgb:2828/2a2a/3636\x1b\\");
  });

  it("preserves probe response order inside a single input batch", () => {
    const term = createTermStub();
    const responses: string[] = [];
    const controller = new TerminalImageController("session-4", term as never, (payload) => responses.push(payload));

    controller.processIncoming(
      new TextEncoder().encode("\x1b_Gi=31,s=1,v=1,a=q,t=d,f=24;AAAA\x1b\\\x1b[>q\x1bP$q q\x1b\\\x1b[?12$p\x1b[?u\x1b[16t\x1b[0c")
    );

    expect(responses).toEqual([
      "\x1b_Gi=31;OK\x1b\\\x1bP>|kitty 0.99.0\x1b\\\x1bP1$r0\x1b\\\x1b[?12;1$y\x1b[?0u\x1b[6;18;9t\x1b[?62;c",
    ]);
  });

  it("renders transferred images into the overlay layer", async () => {
    const term = createTermStub();
    const controller = new TerminalImageController("session-5", term as never);
    const wrapper = document.createElement("div");
    const overlay = document.createElement("div");
    Object.defineProperty(wrapper, "clientHeight", { configurable: true, value: 300 });
    wrapper.style.paddingLeft = "4px";
    wrapper.style.paddingTop = "4px";

    controller.attachOverlay(overlay, wrapper);

    const pngBase64 =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO2WlpwAAAAASUVORK5CYII=";
    const payload =
      `\x1b_Ga=T,U=1,f=100,s=1,v=1,i=66051,m=0;${pngBase64}\x1b\\` +
      "\x1b[38;2;1;2;3m" +
      "\x1b[2;4H" +
      `${KITTY_PLACEHOLDER}${DEFAULT_PLACEHOLDER_DIACRITIC}${DEFAULT_PLACEHOLDER_DIACRITIC}`;

    controller.processIncoming(new TextEncoder().encode(payload));
    await Promise.resolve();
    await flushAnimationFrame();

    const image = overlay.querySelector("img");
    expect(image).not.toBeNull();
    expect(image?.getAttribute("src")).toBe("blob:test");
    expect(image?.style.position).toBe("absolute");
    expect(image?.style.left).toMatch(/px$/);
    expect(image?.style.top).toMatch(/px$/);
    expect(image?.style.width).toBe("9px");
    expect(image?.style.height).toBe("18px");
  });

  it("renders RGBA transfers through the canvas conversion path", async () => {
    const term = createTermStub();
    const controller = new TerminalImageController("session-rgba", term as never);
    const originalGetContext = HTMLCanvasElement.prototype.getContext;
    const originalToBlob = HTMLCanvasElement.prototype.toBlob;
    const originalImageData = globalThis.ImageData;
    const putImageData = vi.fn();

    vi.stubGlobal(
      "ImageData",
      class {
        constructor(
          public readonly data: Uint8ClampedArray,
          public readonly width: number,
          public readonly height: number
        ) {}
      }
    );
    HTMLCanvasElement.prototype.getContext = ((contextId: string) =>
      contextId === "2d"
        ? ({
            putImageData,
          } as unknown as CanvasRenderingContext2D)
        : null) as HTMLCanvasElement["getContext"];
    HTMLCanvasElement.prototype.toBlob = ((callback: BlobCallback) => {
      callback(new Blob(["rgba"], { type: "image/png" }));
      return undefined;
    }) as HTMLCanvasElement["toBlob"];

    try {
      const rgbaBase64 = btoa(String.fromCharCode(255, 0, 0, 255));
      const payload =
        `\x1b_Ga=T,U=1,f=32,s=1,v=1,i=66051,m=0;${rgbaBase64}\x1b\\` +
        "\x1b[38;2;1;2;3m" +
        "\x1b[2;4H" +
        `${KITTY_PLACEHOLDER}${DEFAULT_PLACEHOLDER_DIACRITIC}${DEFAULT_PLACEHOLDER_DIACRITIC}`;

      controller.processIncoming(new TextEncoder().encode(payload));
      await Promise.resolve();
      await Promise.resolve();

      expect(putImageData).toHaveBeenCalled();
      expect(createObjectURL).toHaveBeenCalled();
      expect(controller.getDebugState().resources).toEqual([{ format: 32, generation: 1, height: 1, id: 66051, width: 1 }]);
    } finally {
      HTMLCanvasElement.prototype.getContext = originalGetContext;
      HTMLCanvasElement.prototype.toBlob = originalToBlob;
      vi.stubGlobal("ImageData", originalImageData);
    }
  });

  it("tracks relative cursor movement before placeholder placement", async () => {
    const term = createTermStub();
    const controller = new TerminalImageController("session-cursor", term as never);
    const pngBase64 =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO2WlpwAAAAASUVORK5CYII=";
    const payload =
      `\x1b_Ga=T,U=1,f=100,s=1,v=1,i=66051,m=0;${pngBase64}\x1b\\` +
      "\x1b[38;2;1;2;3m" +
      "\x1b[2;4H" +
      "\x1b[3C" +
      "\x1b[1B" +
      `${KITTY_PLACEHOLDER}${DEFAULT_PLACEHOLDER_DIACRITIC}${DEFAULT_PLACEHOLDER_DIACRITIC}`;

    controller.processIncoming(new TextEncoder().encode(payload));
    await Promise.resolve();

    expect(controller.getDebugState().placements).toEqual([{ bufferLine: 2, columns: 1, generation: 1, imageId: 66051, rows: 1, x: 7 }]);
  });

  it("releases tracked resources when preview is disabled", async () => {
    const term = createTermStub();
    const controller = new TerminalImageController("session-6", term as never);

    const pngBase64 =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO2WlpwAAAAASUVORK5CYII=";
    const payload =
      `\x1b_Ga=T,U=1,f=100,s=1,v=1,i=66051,m=0;${pngBase64}\x1b\\` +
      "\x1b[38;2;1;2;3m" +
      "\x1b[2;4H" +
      `${KITTY_PLACEHOLDER}${DEFAULT_PLACEHOLDER_DIACRITIC}${DEFAULT_PLACEHOLDER_DIACRITIC}`;

    controller.processIncoming(new TextEncoder().encode(payload));
    await Promise.resolve();
    expect(controller.getDebugState().resources).toHaveLength(1);

    controller.setEnabled(false);

    expect(controller.getDebugState().resources).toHaveLength(0);
    expect(controller.getDebugState().placements).toHaveLength(0);
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:test");
  });

  it("revokes late object URLs after dispose", async () => {
    const term = createTermStub();
    const controller = new TerminalImageController("session-7", term as never);
    const originalGetContext = HTMLCanvasElement.prototype.getContext;
    const originalToBlob = HTMLCanvasElement.prototype.toBlob;
    const originalImageData = globalThis.ImageData;
    let resolveBlob: ((blob: Blob | null) => void) | undefined;

    createObjectURL.mockReturnValue("blob:late");
    vi.stubGlobal(
      "ImageData",
      class {
        constructor(
          public readonly data: Uint8ClampedArray,
          public readonly width: number,
          public readonly height: number
        ) {}
      }
    );
    HTMLCanvasElement.prototype.getContext = ((contextId: string) =>
      contextId === "2d"
        ? ({
            putImageData: vi.fn(),
          } as unknown as CanvasRenderingContext2D)
        : null) as HTMLCanvasElement["getContext"];
    HTMLCanvasElement.prototype.toBlob = ((callback: BlobCallback) => {
      resolveBlob = callback;
      return undefined;
    }) as HTMLCanvasElement["toBlob"];

    try {
      const rawRgbBase64 = btoa(String.fromCharCode(255, 0, 0));
      controller.processIncoming(new TextEncoder().encode(`\x1b_Ga=T,U=1,f=24,s=1,v=1,i=7,m=0;${rawRgbBase64}\x1b\\`));
      controller.dispose();

      resolveBlob?.(new Blob(["rgb"], { type: "image/png" }));
      await Promise.resolve();
      await Promise.resolve();

      expect(createObjectURL).toHaveBeenCalled();
      expect(revokeObjectURL).toHaveBeenCalledWith("blob:late");
    } finally {
      HTMLCanvasElement.prototype.getContext = originalGetContext;
      HTMLCanvasElement.prototype.toBlob = originalToBlob;
      vi.stubGlobal("ImageData", originalImageData);
    }
  });
});
