/**
 * Power Extraction Service
 * 
 * Uses xterm.js internal APIs to extract command text with precision.
 * No escape sequence probing - purely buffer-based extraction.
 */

import { Injectable } from '@angular/core'
import { IDisposable } from './promptMarker.service'

// Internal xterm types (not publicly exported)
interface InternalBufferLine {
    isWrapped: boolean
    length: number
    translateToString(trimRight?: boolean, startColumn?: number, endColumn?: number): string
}

interface InternalBuffer {
    x: number           // Cursor X
    y: number           // Cursor Y (relative to ybase)
    ybase: number       // Scrollback offset
    lines: {
        length: number
        get(index: number): InternalBufferLine | undefined
    }
    getWrappedRangeForLine(y: number): { first: number, last: number }
}

interface PromptPosition {
    line: number        // Absolute line in buffer
    x: number           // Cursor X when prompt was captured
    timestamp: number
}

/**
 * Result of command extraction
 */
export interface PowerExtractionResult {
    /** The extracted command text */
    command: string
    /** Whether this is a multi-line command */
    isMultiLine: boolean
    /** Starting line in the buffer */
    startLine: number
    /** Ending line in the buffer */
    endLine: number
    /** Confidence level */
    confidence: 'high' | 'medium' | 'low'
}

@Injectable()
export class PowerExtractionService {
    /** Current prompt position per terminal */
    private promptPositions = new Map<string, PromptPosition>()

    /** Active terminal listeners */
    private listeners = new Map<string, IDisposable[]>()

    /** Delay before capturing prompt after linefeed */
    private readonly PROMPT_DETECT_DELAY = 80

    /**
     * Attach to a terminal and start tracking prompts.
     */
    attach(terminalId: string, xterm: any): IDisposable {
        const disposables: IDisposable[] = []

        // Capture initial prompt after a short delay
        setTimeout(() => {
            this.capturePromptPosition(terminalId, xterm)
        }, 200)

        // Track new prompts after command execution
        const onLineFeed = xterm.onLineFeed(() => {
            this.schedulePromptCapture(terminalId, xterm)
        })
        disposables.push(onLineFeed)

        this.listeners.set(terminalId, disposables)

        console.log(`[PowerExtraction] Attached to terminal ${terminalId}`)

        return {
            dispose: () => {
                disposables.forEach(d => d.dispose())
                this.listeners.delete(terminalId)
                this.promptPositions.delete(terminalId)
                console.log(`[PowerExtraction] Detached from terminal ${terminalId}`)
            }
        }
    }

    /**
     * Extract the current command from the terminal.
     */
    extractCommand(terminalId: string, xterm: any): PowerExtractionResult | null {
        const buffer = this.getInternalBuffer(xterm)
        if (!buffer) {
            console.log('[PowerExtraction] Failed to access internal buffer')
            return null
        }

        // Skip alternate screen
        if (xterm.buffer.active.type === 'alternate') {
            return null
        }

        const promptPos = this.promptPositions.get(terminalId)
        const cursorY = buffer.ybase + buffer.y
        const cursorX = buffer.x

        console.log(`[PowerExtraction] Cursor at (${cursorX}, ${cursorY}), prompt at`, promptPos)

        if (promptPos) {
            // Use known prompt position
            return this.extractFromPrompt(buffer, promptPos, cursorY, cursorX)
        } else {
            // Fallback: try to detect prompt on current line
            return this.extractWithHeuristic(buffer, cursorY, cursorX)
        }
    }

    /**
     * Get prompt position for a terminal.
     */
    getPromptPosition(terminalId: string): PromptPosition | null {
        return this.promptPositions.get(terminalId) ?? null
    }

    /**
     * Manually capture prompt position (call after known command execution).
     */
    capturePromptPosition(terminalId: string, xterm: any): void {
        const buffer = this.getInternalBuffer(xterm)
        if (!buffer) return

        const cursorY = buffer.ybase + buffer.y
        const cursorX = buffer.x

        // Validate this looks like a prompt position
        if (cursorX > 100) {
            console.log('[PowerExtraction] Cursor too far right for prompt, skipping')
            return
        }

        const line = buffer.lines.get(cursorY)
        if (!line) return

        const text = line.translateToString(true, 0, cursorX)
        if (this.looksLikePrompt(text)) {
            const pos: PromptPosition = {
                line: cursorY,
                x: cursorX,
                timestamp: Date.now()
            }
            this.promptPositions.set(terminalId, pos)
            console.log(`[PowerExtraction] Captured prompt at (${cursorX}, ${cursorY}): "${text}"`)
        }
    }

    // --- Private Methods ---

    private getInternalBuffer(xterm: any): InternalBuffer | null {
        try {
            // Access internal buffer (not the public IBuffer)
            // The internal Buffer class has methods like getWrappedRangeForLine
            const buffer = xterm.buffer?.active
            if (!buffer) return null

            // Check if we have internal access
            const internalBuffer = (xterm as any)._core?.buffer?.active
            if (internalBuffer?.lines?.get) {
                return internalBuffer as InternalBuffer
            }

            // Fallback: try direct buffer access
            const directBuffer = (xterm as any).buffer
            if (directBuffer?.lines?.get) {
                return directBuffer as InternalBuffer
            }

            // Use public API with wrapper
            return this.wrapPublicBuffer(buffer)
        } catch (e) {
            console.error('[PowerExtraction] Failed to access buffer:', e)
            return null
        }
    }

    private wrapPublicBuffer(publicBuffer: any): InternalBuffer {
        return {
            x: publicBuffer.cursorX,
            y: publicBuffer.cursorY,
            ybase: publicBuffer.baseY,
            lines: {
                length: publicBuffer.length,
                get: (y: number) => publicBuffer.getLine(y)
            },
            getWrappedRangeForLine: (y: number) => {
                // Manual implementation using isWrapped
                let first = y
                let last = y
                while (first > 0) {
                    const line = publicBuffer.getLine(first)
                    if (!line?.isWrapped) break
                    first--
                }
                while (last + 1 < publicBuffer.length) {
                    const nextLine = publicBuffer.getLine(last + 1)
                    if (!nextLine?.isWrapped) break
                    last++
                }
                return { first, last }
            }
        }
    }

    private extractFromPrompt(
        buffer: InternalBuffer,
        promptPos: PromptPosition,
        cursorY: number,
        cursorX: number
    ): PowerExtractionResult | null {
        const startY = promptPos.line
        const startX = promptPos.x

        // Validate prompt is before or at cursor
        if (startY > cursorY || (startY === cursorY && startX > cursorX)) {
            console.log('[PowerExtraction] Prompt is after cursor, invalid')
            return null
        }

        const segments: string[] = []
        let isMultiLine = false

        for (let y = startY; y <= cursorY; y++) {
            const line = buffer.lines.get(y)
            if (!line) continue

            const colStart = (y === startY) ? startX : 0
            const colEnd = (y === cursorY) ? cursorX : undefined

            let text = line.translateToString(true, colStart, colEnd)

            if (y > startY) {
                if (line.isWrapped) {
                    // Terminal wrapped - just concatenate
                    segments.push(text)
                } else {
                    // Real newline (heredoc, continuation, etc.)
                    segments.push('\n' + text)
                    isMultiLine = true
                }
            } else {
                segments.push(text)
            }
        }

        const command = segments.join('').trim()

        if (!command) {
            return null
        }

        console.log(`[PowerExtraction] Extracted: "${command.substring(0, 50)}${command.length > 50 ? '...' : ''}"`)

        return {
            command,
            isMultiLine,
            startLine: startY,
            endLine: cursorY,
            confidence: 'high'
        }
    }

    private extractWithHeuristic(
        buffer: InternalBuffer,
        cursorY: number,
        cursorX: number
    ): PowerExtractionResult | null {
        // Find prompt on current line
        const line = buffer.lines.get(cursorY)
        if (!line) return null

        const fullText = line.translateToString(true)
        const promptEndX = this.findPromptEnd(fullText)

        if (promptEndX >= cursorX) {
            // Cursor is within prompt
            return null
        }

        const command = fullText.substring(promptEndX, cursorX).trim()

        if (!command) {
            return null
        }

        return {
            command,
            isMultiLine: false,
            startLine: cursorY,
            endLine: cursorY,
            confidence: 'medium'
        }
    }

    private schedulePromptCapture(terminalId: string, xterm: any): void {
        setTimeout(() => {
            const buffer = this.getInternalBuffer(xterm)
            if (!buffer) return

            // Only capture if cursor is at reasonable position
            if (buffer.x < 100) {
                this.capturePromptPosition(terminalId, xterm)
            }
        }, this.PROMPT_DETECT_DELAY)
    }

    private looksLikePrompt(text: string): boolean {
        const promptChars = ['❯', '›', '➜', '➤', '⟩', '»', '$', '#', '%', '>']
        const trimmed = text.trimEnd()
        if (trimmed.length === 0) return false
        return promptChars.some(c => trimmed.includes(c))
    }

    private findPromptEnd(text: string): number {
        const promptChars = ['❯', '›', '➜', '➤', '⟩', '»', '$', '#', '%', '>']

        let lastPromptPos = -1
        for (const char of promptChars) {
            const pos = text.lastIndexOf(char)
            if (pos > lastPromptPos) {
                lastPromptPos = pos
            }
        }

        if (lastPromptPos === -1) {
            return 0
        }

        // Skip space after prompt char
        let endPos = lastPromptPos + 1
        while (endPos < text.length && text[endPos] === ' ') {
            endPos++
        }

        return endPos
    }
}
