// Terminal type - we use 'any' since XTermFrontend.xterm is untyped
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Terminal = any

/**
 * Cursor position in the terminal buffer
 */
export interface CursorPosition {
    /** Column (0-indexed) */
    x: number
    /** Absolute row (baseY + cursorY) */
    y: number
}

/**
 * Command boundaries detected by probing or heuristics
 */
export interface CommandBoundaries {
    start: CursorPosition
    end: CursorPosition
}

/**
 * Result of command extraction
 */
export interface ExtractionResult {
    /** The extracted command text */
    command: string
    /** Whether this is a multi-line command (heredoc, line continuation) */
    isMultiLine: boolean
    /** Starting line in the buffer */
    startLine: number
    /** Ending line in the buffer */
    endLine: number
    /** Confidence level: 'high' = cursor probing worked, 'medium' = heuristic */
    confidence: 'high' | 'medium' | 'low'
}

/**
 * A tracked prompt region in the terminal buffer
 */
export interface PromptRegion {
    /** Marker tracking the prompt line (from xterm.registerMarker) */
    marker: IMarker
    /** X position where command input starts (after prompt) */
    commandStartX: number
    /** Timestamp when this prompt was detected */
    timestamp: number
}

/**
 * Minimal marker interface (subset of xterm's IMarker)
 */
export interface IMarker {
    readonly id: number
    readonly line: number
    readonly isDisposed: boolean
    dispose(): void
}

/**
 * Context passed to extraction strategies
 */
export interface ExtractionContext {
    /** The xterm Terminal instance */
    terminal: Terminal
    /** The active buffer */
    buffer: IBuffer
    /** Current cursor position */
    cursorPosition: CursorPosition
    /** Function to send input to the terminal */
    sendInput: (data: string) => void
    /** Most recent prompt marker if available */
    currentPrompt: PromptRegion | null
}

/**
 * Minimal buffer interface (subset of xterm's IBuffer)
 */
export interface IBuffer {
    readonly type: 'normal' | 'alternate'
    readonly cursorX: number
    readonly cursorY: number
    readonly baseY: number
    readonly viewportY: number
    readonly length: number
    getLine(y: number): IBufferLine | undefined
}

/**
 * Minimal buffer line interface (subset of xterm's IBufferLine)
 */
export interface IBufferLine {
    readonly isWrapped: boolean
    readonly length: number
    translateToString(trimRight?: boolean, startColumn?: number, endColumn?: number): string
}

/**
 * Strategy interface for command extraction
 */
export interface ExtractionStrategy {
    /** Name of the strategy for logging */
    name: string
    /** Extract command from the given context */
    extract(context: ExtractionContext): Promise<ExtractionResult | null>
}
