import type { Terminal as XTerminal } from "@xterm/xterm";
import { WriteSSH } from "../../../wailsjs/go/ssh/SSH";
import { bytesToBase64 } from "@/lib/terminalEncode";

const KITTY_ESCAPE = "\x1b_G";
const STRING_TERMINATOR = "\x1b\\";
const DCS_PREFIX = "\x1bP";
const KITTY_PLACEHOLDER = "\u{10EEEE}";
const ENABLED_SGR_PREFIX = "38;2;";
const DEFAULT_PLACEHOLDER_DIACRITIC = "\u0305";
const CSI_PREFIX = "\x1b[";
const OSC_PREFIX = "\x1b]";
const BEL = "\x07";
const DA1_RESPONSE = "\x1b[?62;c";
const CSI_GT_Q_RESPONSE = "\x1bP>|kitty 0.99.0\x1b\\";
const DCS_CURSOR_SHAPE_QUERY = "$q q";
const DCS_CURSOR_SHAPE_RESPONSE = "\x1bP1$r0\x1b\\";
const CSI_CURSOR_BLINK_RESPONSE = "\x1b[?12;1$y";
const CSI_CSI_U_RESPONSE = "\x1b[?0u";

interface KittyCommand {
  data: string;
  params: Map<string, string>;
}

interface PendingTransfer {
  chunks: string[];
  format: number;
  height: number;
  id: number;
  inlinePlaceholder: boolean;
  width: number;
}

interface TerminalImagePlacement {
  bufferLine: number;
  columns: number;
  generation: number;
  imageId: number;
  rows: number;
  x: number;
}

interface TerminalImageResource {
  bytes: Uint8Array;
  format: number;
  generation: number;
  height: number;
  id: number;
  objectUrl?: string;
  objectUrlPromise?: Promise<string | undefined>;
  width: number;
}

interface ParserCursorState {
  column: number;
  currentImageId?: number;
  row: number;
}

function parseKittyCommand(raw: string): KittyCommand {
  const separatorIndex = raw.indexOf(";");
  const control = separatorIndex >= 0 ? raw.slice(0, separatorIndex) : raw;
  const data = separatorIndex >= 0 ? raw.slice(separatorIndex + 1) : "";
  const params = new Map<string, string>();

  for (const part of control.split(",")) {
    if (!part) continue;
    const eqIndex = part.indexOf("=");
    if (eqIndex < 0) {
      params.set(part, "1");
      continue;
    }
    params.set(part.slice(0, eqIndex), part.slice(eqIndex + 1));
  }
  return { data, params };
}

function parseIntParam(params: Map<string, string>, key: string, fallback: number): number {
  const value = params.get(key);
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function isCombiningChar(char: string | undefined): boolean {
  if (!char) return false;
  return /\p{Mark}/u.test(char);
}

async function createObjectUrl(resource: TerminalImageResource): Promise<string | undefined> {
  if (resource.objectUrl) return resource.objectUrl;

  let blob: Blob | null | undefined;
  if (resource.format === 100) {
    blob = new Blob([new Uint8Array(resource.bytes)], { type: "image/png" });
  } else if (resource.format === 24 || resource.format === 32) {
    const canvas = document.createElement("canvas");
    canvas.width = resource.width;
    canvas.height = resource.height;

    const context = canvas.getContext("2d");
    if (!context) return undefined;

    const rgba = new Uint8ClampedArray(resource.width * resource.height * 4);
    if (resource.format === 24) {
      for (let src = 0, dst = 0; src < resource.bytes.length; src += 3, dst += 4) {
        rgba[dst] = resource.bytes[src];
        rgba[dst + 1] = resource.bytes[src + 1];
        rgba[dst + 2] = resource.bytes[src + 2];
        rgba[dst + 3] = 255;
      }
    } else {
      rgba.set(resource.bytes);
    }

    context.putImageData(new ImageData(rgba, resource.width, resource.height), 0, 0);
    blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
    if (!blob) return undefined;
  }

  if (!blob) return undefined;
  resource.objectUrl = URL.createObjectURL(blob);
  return resource.objectUrl;
}

function getWrapperPadding(wrapper: HTMLElement): { left: number; top: number } {
  const styles = window.getComputedStyle(wrapper);
  return {
    left: Number.parseFloat(styles.paddingLeft || "0") || 0,
    top: Number.parseFloat(styles.paddingTop || "0") || 0,
  };
}

function getCellDimensions(term: XTerminal): { height: number; width: number } | undefined {
  const dimensions = (term as unknown as { _core?: { _renderService?: { dimensions?: { css?: { cell?: { height: number; width: number } } } } } })
    ?._core?._renderService?.dimensions?.css?.cell;
  if (!dimensions?.width || !dimensions?.height) return undefined;
  return dimensions;
}

function normalizeHexColor(color: string): string | undefined {
  const trimmed = color.trim();
  if (!trimmed.startsWith("#")) return undefined;

  const hex = trimmed.slice(1);
  if (hex.length === 3) {
    const [r, g, b] = hex.split("");
    return `${r}${r}${g}${g}${b}${b}`.toLowerCase();
  }
  if (hex.length === 6) {
    return hex.toLowerCase();
  }
  return undefined;
}

function parseRgbComponent(component: string): number | undefined {
  const value = Number.parseFloat(component.trim());
  if (!Number.isFinite(value)) return undefined;
  return Math.max(0, Math.min(255, Math.round(value)));
}

function normalizeRgbColor(color: string): string | undefined {
  const match = color.match(/^rgba?\(([^)]+)\)$/i);
  if (!match) return undefined;

  const parts = match[1].split(",");
  if (parts.length < 3) return undefined;

  const r = parseRgbComponent(parts[0]);
  const g = parseRgbComponent(parts[1]);
  const b = parseRgbComponent(parts[2]);
  if ([r, g, b].some((value) => value === undefined)) return undefined;

  return [r, g, b]
    .map((value) => value!.toString(16).padStart(2, "0"))
    .join("");
}

function colorToOscRgb(color: string | undefined): string | undefined {
  if (!color) return undefined;

  const normalized = normalizeHexColor(color) || normalizeRgbColor(color);
  if (!normalized || normalized.length !== 6) return undefined;

  return `rgb:${normalized.slice(0, 2)}${normalized.slice(0, 2)}/${normalized.slice(2, 4)}${normalized.slice(2, 4)}/${normalized.slice(4, 6)}${normalized.slice(4, 6)}`;
}

export class TerminalImageController {
  private readonly decoder = new TextDecoder();
  private readonly cursor: ParserCursorState = { column: 1, row: 1 };
  private carry = "";
  private disposed = false;
  private enabled = true;
  private loggedActivation = false;
  private overlay?: HTMLDivElement;
  private pendingTransfer?: PendingTransfer;
  private renderFrame = 0;
  private resources = new Map<number, TerminalImageResource>();
  private responseBuffer = "";
  private placements = new Map<number, TerminalImagePlacement>();
  private scrollElement?: HTMLElement;
  private readonly scrollListener = () => this.requestRender();
  private wrapper?: HTMLDivElement;

  constructor(
    private readonly sessionId: string,
    private readonly term: XTerminal,
    private readonly respond: (payload: string) => void = (payload) => {
      WriteSSH(sessionId, bytesToBase64(new TextEncoder().encode(payload))).catch(console.error);
    }
  ) {}

  processIncoming(bytes: Uint8Array): string {
    if (this.disposed) return "";

    const decoded = this.decoder.decode(bytes, { stream: true });
    let input = this.carry + decoded;
    this.carry = "";

    let output = "";
    let index = 0;

    while (index < input.length) {
      const char = input[index];

      if (char === "\x1b") {
        if (input.startsWith(OSC_PREFIX, index)) {
          const osc = this.extractOscSequence(input, index);
          if (!osc) {
            this.carry = input.slice(index);
            break;
          }
          if (!this.handleOsc(osc.sequence)) {
            output += osc.sequence;
          }
          index = osc.nextIndex;
          continue;
        }

        if (input.startsWith(KITTY_ESCAPE, index)) {
          const end = input.indexOf(STRING_TERMINATOR, index + KITTY_ESCAPE.length);
          if (end < 0) {
            this.carry = input.slice(index);
            break;
          }
          this.handleKittyCommand(parseKittyCommand(input.slice(index + KITTY_ESCAPE.length, end)));
          index = end + STRING_TERMINATOR.length;
          continue;
        }

        if (input.startsWith(DCS_PREFIX, index)) {
          const end = input.indexOf(STRING_TERMINATOR, index + DCS_PREFIX.length);
          if (end < 0) {
            this.carry = input.slice(index);
            break;
          }
          const sequence = input.slice(index, end + STRING_TERMINATOR.length);
          if (!this.handleDcs(sequence)) {
            output += sequence;
          }
          index = end + STRING_TERMINATOR.length;
          continue;
        }

        if (input[index + 1] === "[") {
          const csiEnd = this.findCsiEnd(input, index + 2);
          if (csiEnd < 0) {
            this.carry = input.slice(index);
            break;
          }
          const sequence = input.slice(index, csiEnd + 1);
          if (!this.handleCsi(sequence)) {
            output += sequence;
          }
          index = csiEnd + 1;
          continue;
        }

        if (input[index + 1] === "c") {
          this.clearAllImages();
          output += "\x1bc";
          index += 2;
          continue;
        }
      }

      if (input.startsWith(KITTY_PLACEHOLDER, index)) {
        const placeholderLength = KITTY_PLACEHOLDER.length;
        const markOne = input[index + placeholderLength];
        const markTwo = input[index + placeholderLength + 1];
        if (!markOne || !markTwo) {
          this.carry = input.slice(index);
          break;
        }
        if (isCombiningChar(markOne) && isCombiningChar(markTwo)) {
          this.recordPlaceholderCell();
          output += " ";
          this.cursor.column += 1;
          index += placeholderLength + markOne.length + markTwo.length;
          continue;
        }
      }

      output += char;
      if (char === "\r") {
        this.cursor.column = 1;
      } else if (char === "\n") {
        this.cursor.row += 1;
      }
      index += 1;
    }

    this.flushResponses();
    return output;
  }

  attachOverlay(overlay: HTMLDivElement, wrapper: HTMLDivElement): void {
    this.overlay = overlay;
    this.wrapper = wrapper;
    this.bindScrollListener();
    this.requestRender();
  }

  detachOverlay(overlay: HTMLDivElement): void {
    if (this.overlay !== overlay) return;
    this.unbindScrollListener();
    overlay.replaceChildren();
    this.overlay = undefined;
    this.wrapper = undefined;
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled) {
      this.clearAllImages();
      return;
    }
    this.requestRender();
  }

  requestRender(): void {
    if (this.disposed) return;
    if (this.renderFrame) cancelAnimationFrame(this.renderFrame);
    this.renderFrame = requestAnimationFrame(() => {
      this.renderFrame = 0;
      this.renderOverlay();
    });
  }

  clearAllImages(): void {
    for (const resource of this.resources.values()) {
      if (resource.objectUrl) URL.revokeObjectURL(resource.objectUrl);
    }
    this.resources.clear();
    this.placements.clear();
    this.cursor.currentImageId = undefined;
    if (this.overlay) this.overlay.replaceChildren();
  }

  dispose(): void {
    this.disposed = true;
    if (this.renderFrame) cancelAnimationFrame(this.renderFrame);
    this.unbindScrollListener();
    this.clearAllImages();
    this.decoder.decode();
  }

  getDebugState(): { placements: TerminalImagePlacement[]; resources: Array<Pick<TerminalImageResource, "format" | "generation" | "height" | "id" | "width">> } {
    return {
      placements: [...this.placements.values()],
      resources: [...this.resources.values()].map(({ format, generation, height, id, width }) => ({
        format,
        generation,
        height,
        id,
        width,
      })),
    };
  }

  private bindScrollListener(): void {
    const nextScrollElement = this.term.element?.querySelector(".xterm-viewport") as HTMLElement | null;
    if (!nextScrollElement || this.scrollElement === nextScrollElement) return;
    this.unbindScrollListener();
    this.scrollElement = nextScrollElement;
    this.scrollElement.addEventListener("scroll", this.scrollListener);
  }

  private unbindScrollListener(): void {
    if (!this.scrollElement) return;
    this.scrollElement.removeEventListener("scroll", this.scrollListener);
    this.scrollElement = undefined;
  }

  private findCsiEnd(input: string, start: number): number {
    for (let index = start; index < input.length; index += 1) {
      const code = input.charCodeAt(index);
      if (code >= 0x40 && code <= 0x7e) return index;
    }
    return -1;
  }

  private extractOscSequence(input: string, start: number): { nextIndex: number; sequence: string } | undefined {
    for (let index = start + OSC_PREFIX.length; index < input.length; index += 1) {
      const char = input[index];
      if (char === BEL) {
        return {
          nextIndex: index + 1,
          sequence: input.slice(start, index + 1),
        };
      }
      if (char === "\x1b" && input[index + 1] === "\\") {
        return {
          nextIndex: index + 2,
          sequence: input.slice(start, index + 2),
        };
      }
    }
    return undefined;
  }

  private handleCsi(sequence: string): boolean {
    const body = sequence.slice(2, -1);
    const finalByte = sequence[sequence.length - 1];

    if (finalByte === "H" || finalByte === "f") {
      const [rowRaw = "1", columnRaw = "1"] = body.split(";");
      this.cursor.row = Number.parseInt(rowRaw || "1", 10) || 1;
      this.cursor.column = Number.parseInt(columnRaw || "1", 10) || 1;
      return false;
    }

    if (finalByte === "A" || finalByte === "B" || finalByte === "C" || finalByte === "D") {
      const step = Number.parseInt(body || "1", 10) || 1;
      if (finalByte === "A") this.cursor.row = Math.max(1, this.cursor.row - step);
      if (finalByte === "B") this.cursor.row += step;
      if (finalByte === "C") this.cursor.column += step;
      if (finalByte === "D") this.cursor.column = Math.max(1, this.cursor.column - step);
      return false;
    }

    if (finalByte === "G") {
      const column = Number.parseInt(body || "1", 10) || 1;
      this.cursor.column = Math.max(1, column);
      return false;
    }

    if (finalByte === "m") {
      this.updateCurrentImageIdFromSgr(body);
      return false;
    }

    // Yazi currently positions Kitty placeholders with absolute cursor moves.
    // Keep relative cursor tracking here so future control-sequence changes
    // do not silently desync image placement from xterm's cursor state.

    if (finalByte === "J") {
      if (body === "" || body === "2" || body === "3") {
        this.clearAllImages();
      }
      return false;
    }

    if ((finalByte === "h" || finalByte === "l") && body.startsWith("?")) {
      const privateMode = body.slice(1);
      if (privateMode === "1047" || privateMode === "1048" || privateMode === "1049") {
        this.clearAllImages();
      }
      return false;
    }

    if (finalByte === "c" && body === "0") {
      this.queueResponse(DA1_RESPONSE);
      return true;
    }

    if (finalByte === "t" && body === "16") {
      this.queueResponse(this.buildCsi16tResponse());
      return true;
    }

    if (finalByte === "q" && body === ">") {
      this.queueResponse(CSI_GT_Q_RESPONSE);
      return true;
    }

    if (finalByte === "p" && body === "?12$") {
      this.queueResponse(CSI_CURSOR_BLINK_RESPONSE);
      return true;
    }

    if (finalByte === "u" && body === "?") {
      this.queueResponse(CSI_CSI_U_RESPONSE);
      return true;
    }

    return false;
  }

  private handleDcs(sequence: string): boolean {
    const body = sequence.slice(2, -2);
    if (body.trim() !== DCS_CURSOR_SHAPE_QUERY) return false;

    this.queueResponse(DCS_CURSOR_SHAPE_RESPONSE);
    return true;
  }

  private handleOsc(sequence: string): boolean {
    const body = sequence.endsWith(BEL) ? sequence.slice(2, -1) : sequence.slice(2, -2);
    const separatorIndex = body.indexOf(";");
    const code = separatorIndex >= 0 ? body.slice(0, separatorIndex) : body;
    const data = separatorIndex >= 0 ? body.slice(separatorIndex + 1) : "";

    if (data !== "?") return false;

    const color = this.resolveOscQueryColor(code);
    if (!color) return false;

    this.queueResponse(`${OSC_PREFIX}${code};${color}${STRING_TERMINATOR}`);
    return true;
  }

  private buildCsi16tResponse(): string {
    const cell = getCellDimensions(this.term);
    const width = Math.max(1, Math.round(cell?.width || 9));
    const height = Math.max(1, Math.round(cell?.height || 18));
    return `${CSI_PREFIX}6;${height};${width}t`;
  }

  private resolveOscQueryColor(code: string): string | undefined {
    const theme = this.term.options.theme;
    if (code === "10") return colorToOscRgb(theme?.foreground);
    if (code === "11") return colorToOscRgb(theme?.background);
    if (code === "12") return colorToOscRgb(theme?.cursor || theme?.foreground);
    return undefined;
  }

  private updateCurrentImageIdFromSgr(body: string): void {
    if (!body || body === "0" || body === "39") {
      this.cursor.currentImageId = undefined;
      return;
    }

    const tokens = body.split(";");
    for (let index = 0; index < tokens.length; index += 1) {
      if (tokens[index] !== "38" || tokens[index + 1] !== "2") continue;
      const r = Number.parseInt(tokens[index + 2] || "", 10);
      const g = Number.parseInt(tokens[index + 3] || "", 10);
      const b = Number.parseInt(tokens[index + 4] || "", 10);
      if ([r, g, b].every(Number.isFinite)) {
        this.cursor.currentImageId = (r << 16) | (g << 8) | b;
      }
      return;
    }
  }

  private handleKittyCommand(command: KittyCommand): void {
    const action = command.params.get("a");
    const more = command.params.get("m") === "1";

    if (action === "d") {
      this.handleDeleteCommand(command.params);
      return;
    }

    if (action === "q") {
      this.queueResponse(`\x1b_Gi=${parseIntParam(command.params, "i", 0)};OK\x1b\\`);
      return;
    }

    if (action === "T") {
      this.pendingTransfer = {
        chunks: command.data ? [command.data] : [],
        format: parseIntParam(command.params, "f", 100),
        height: parseIntParam(command.params, "v", 0),
        id: parseIntParam(command.params, "i", 0),
        inlinePlaceholder: command.params.get("U") === "1",
        width: parseIntParam(command.params, "s", 0),
      };
      if (!more) this.finalizeTransfer();
      return;
    }

    if (this.pendingTransfer) {
      if (command.data) this.pendingTransfer.chunks.push(command.data);
      if (!more) this.finalizeTransfer();
    }
  }

  private handleDeleteCommand(params: Map<string, string>): void {
    const scope = params.get("d") || "a";
    if (scope === "A" || scope === "a") {
      this.clearAllImages();
      return;
    }

    const id = parseIntParam(params, "i", 0);
    if (!id) return;

    const resource = this.resources.get(id);
    if (resource?.objectUrl) URL.revokeObjectURL(resource.objectUrl);
    this.resources.delete(id);
    this.placements.delete(id);
    this.requestRender();
  }

  private finalizeTransfer(): void {
    const pending = this.pendingTransfer;
    this.pendingTransfer = undefined;
    if (!pending?.id || !pending.inlinePlaceholder || !pending.width || !pending.height) return;

    const resource = this.resources.get(pending.id);
    if (resource?.objectUrl) URL.revokeObjectURL(resource.objectUrl);

    const nextGeneration = (resource?.generation || 0) + 1;
    const bytes = Uint8Array.from(atob(pending.chunks.join("")), (char) => char.charCodeAt(0));
    const nextResource: TerminalImageResource = {
      bytes,
      format: pending.format,
      generation: nextGeneration,
      height: pending.height,
      id: pending.id,
      width: pending.width,
    };
    nextResource.objectUrlPromise = createObjectUrl(nextResource)
      .then((url) => {
        if (!url) return undefined;

        const current = this.resources.get(nextResource.id);
        if (this.disposed || current?.generation !== nextGeneration) {
          URL.revokeObjectURL(url);
          return undefined;
        }

        nextResource.objectUrl = url;
        this.requestRender();
        return url;
      })
      .catch((error) => {
        console.error(`[terminal-image] failed to create object URL for ${this.sessionId}`, error);
        return undefined;
      });

    this.resources.set(pending.id, nextResource);
    if (!this.loggedActivation) {
      this.loggedActivation = true;
      console.debug(`[terminal-image] kitty preview activated for session ${this.sessionId}`);
    }
  }

  private recordPlaceholderCell(): void {
    const imageId = this.cursor.currentImageId;
    if (!imageId) return;

    const resource = this.resources.get(imageId);
    if (!resource) return;

    const bufferLine = (this.term as unknown as { buffer: { active: { baseY: number } } }).buffer.active.baseY + this.cursor.row - 1;
    const current = this.placements.get(imageId);
    if (!current || current.generation !== resource.generation) {
      this.placements.set(imageId, {
        bufferLine,
        columns: 1,
        generation: resource.generation,
        imageId,
        rows: 1,
        x: this.cursor.column,
      });
      this.requestRender();
      return;
    }

    const top = Math.min(current.bufferLine, bufferLine);
    const left = Math.min(current.x, this.cursor.column);
    const bottom = Math.max(current.bufferLine + current.rows - 1, bufferLine);
    const right = Math.max(current.x + current.columns - 1, this.cursor.column);

    current.bufferLine = top;
    current.columns = right - left + 1;
    current.rows = bottom - top + 1;
    current.x = left;
    this.requestRender();
  }

  private renderOverlay(): void {
    if (!this.overlay) return;
    this.overlay.replaceChildren();
    if (!this.enabled || !this.wrapper) return;

    this.bindScrollListener();

    const cell = getCellDimensions(this.term);
    if (!cell) return;

    const { left: paddingLeft, top: paddingTop } = getWrapperPadding(this.wrapper);
    const scrollTop = this.scrollElement?.scrollTop || 0;
    const wrapperHeight = this.wrapper.clientHeight;

    const placements = [...this.placements.values()].sort((left, right) => left.bufferLine - right.bufferLine);
    for (const placement of placements) {
      const src = this.resources.get(placement.imageId)?.objectUrl;
      if (!src) continue;

      const top = paddingTop + placement.bufferLine * cell.height - scrollTop;
      const left = paddingLeft + (placement.x - 1) * cell.width;
      const width = placement.columns * cell.width;
      const height = placement.rows * cell.height;
      if (top + height <= 0 || top >= wrapperHeight) continue;

      const image = document.createElement("img");
      image.src = src;
      image.alt = "";
      image.draggable = false;
      image.style.position = "absolute";
      image.style.left = `${left}px`;
      image.style.top = `${top}px`;
      image.style.width = `${width}px`;
      image.style.height = `${height}px`;
      image.style.objectFit = "contain";
      image.style.pointerEvents = "none";
      image.style.userSelect = "none";
      this.overlay.appendChild(image);
    }
  }

  private queueResponse(payload: string): void {
    this.responseBuffer += payload;
  }

  private flushResponses(): void {
    if (!this.responseBuffer) return;
    const payload = this.responseBuffer;
    this.responseBuffer = "";
    this.respond(payload);
  }
}

export const __terminalImageProtocolTestUtils = {
  DEFAULT_PLACEHOLDER_DIACRITIC,
  ENABLED_SGR_PREFIX,
  KITTY_PLACEHOLDER,
};
