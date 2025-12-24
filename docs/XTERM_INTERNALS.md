# xterm.js Internal API Analysis

> This document captures our deep-dive analysis of xterm.js v5.4.0 for the tabby-command-editor plugin.
> Use this as a reference when working with xterm internals.

## Version Info

- **xterm.js version**: `^5.4.0` (used by Tabby via `@xterm/xterm`)
- **Source cloned to**: `/Users/caoziyu/projects/github/xterm.js-5.4.0`

---

## Key Source Files

| File | Size | Purpose |
|------|------|---------|
| `src/common/buffer/Buffer.ts` | 24KB | Buffer state, cursor, markers, line access |
| `src/common/buffer/BufferLine.ts` | 20KB | Cell data, `isWrapped`, `translateToString()` |
| `src/common/InputHandler.ts` | 147KB | All escape sequence handlers (CSI, OSC, DCS) |
| `src/common/parser/EscapeSequenceParser.ts` | 36KB | Core parser with handler registration |
| `src/browser/Terminal.ts` | 52KB | Browser Terminal class (extends CoreTerminal) |

---

## Accessing Internals

```typescript
const xterm = frontend.xterm;

// PUBLIC API (IBuffer interface)
const publicBuffer = xterm.buffer.active;
publicBuffer.cursorX;          // Cursor column
publicBuffer.cursorY;          // Cursor row (relative to baseY)
publicBuffer.baseY;            // Scrollback offset
publicBuffer.getLine(y);       // Get IBufferLine

// INTERNAL ACCESS (via monkey-patch)
const internalBuffer = (xterm as any).buffer;
internalBuffer.lines;                          // CircularList<BufferLine>
internalBuffer.getWrappedRangeForLine(y);     // { first, last }
internalBuffer.translateBufferLineToString(); // Direct extraction
```

---

## Key Internal Methods

### `Buffer.getWrappedRangeForLine(y: number)`
Returns the range of lines that form a single wrapped logical line.

```typescript
// Source: src/common/buffer/Buffer.ts:535-547
public getWrappedRangeForLine(y: number): { first: number, last: number } {
  let first = y;
  let last = y;
  while (first > 0 && this.lines.get(first)!.isWrapped) {
    first--;
  }
  while (last + 1 < this.lines.length && this.lines.get(last + 1)!.isWrapped) {
    last++;
  }
  return { first, last };
}
```

### `BufferLine.translateToString(trimRight?, startCol?, endCol?)`
Extracts text from a line with column precision.

```typescript
// Public API - available on IBufferLine
line.translateToString(true);           // Full line, trimmed
line.translateToString(true, 2);        // From column 2 to end
line.translateToString(true, 2, 10);    // Columns 2-10
```

### `BufferLine.isWrapped`
Boolean indicating if this line is a continuation of the previous line (terminal-wrapped).

---

## Public Events (Useful for Prompt Detection)

```typescript
xterm.onLineFeed              // After line feed
xterm.onCursorMove            // Cursor moved
xterm.onWriteParsed           // After data parsed
xterm.registerMarker(offset)  // Create persistent position marker
```

---

## Parser Hooks (For Shell Integration)

```typescript
// OSC 133 (FinalTerm shell integration)
xterm.parser.registerOscHandler(133, (data) => {
  // data: 'A' = PromptStart, 'B' = CommandStart, 'C' = Executed, 'D' = Finished
  return false; // Don't consume
});

// OSC 633 (VS Code shell integration)
xterm.parser.registerOscHandler(633, (data) => {
  // Same as 133 with extensions (E=CommandLine, P=Property, etc.)
  return false;
});
```

---

## Architecture Diagram

```
┌──────────────────────────────────────────────────────────┐
│                    Terminal (browser)                     │
│                         extends                           │
│                      CoreTerminal                         │
├──────────────────────────────────────────────────────────┤
│  buffer ─────────┬──► Buffer (normal)                    │
│                  └──► Buffer (alternate)                  │
│                           │                               │
│                           ▼                               │
│                   CircularList<BufferLine>                │
│                           │                               │
│              ┌────────────┼────────────┐                 │
│              ▼            ▼            ▼                 │
│         BufferLine   BufferLine   BufferLine             │
│         [cells...]   [cells...]   [cells...]             │
│         isWrapped    isWrapped    isWrapped              │
└──────────────────────────────────────────────────────────┘
```

---

## Usage in tabby-command-editor

### Power Extraction Pattern
```typescript
getCommandText(promptY: number, promptEndX: number): string {
  const buffer = (xterm as any).buffer;
  const cursorY = buffer.y + buffer.ybase;
  const cursorX = buffer.x;

  const segments: string[] = [];
  for (let y = promptY; y <= cursorY; y++) {
    const line = buffer.lines.get(y);
    const startX = (y === promptY) ? promptEndX : 0;
    const endX = (y === cursorY) ? cursorX : undefined;
    
    let text = line.translateToString(true, startX, endX);
    if (y > promptY && !line.isWrapped) {
      text = '\n' + text;  // Real newline
    }
    segments.push(text);
  }
  return segments.join('').trim();
}
```

---

## References

- xterm.js GitHub: https://github.com/xtermjs/xterm.js
- Terminal control sequences: https://invisible-island.net/xterm/ctlseqs/ctlseqs.html
- OSC 133 (FinalTerm): https://gitlab.freedesktop.org/Per_Bothner/specifications/blob/master/proposals/semantic-prompts.md
