import type {
    ExtractionStrategy,
    ExtractionContext,
    ExtractionResult,
    CursorPosition,
    CommandBoundaries,
    IBuffer,
} from './types'

/**
 * Primary extraction strategy using cursor movement probing.
 * Sends Home/End and Ctrl+A/E keys to detect command boundaries.
 */
export class CursorProbeStrategy implements ExtractionStrategy {
    name = 'cursor-probe'

    /** Timeout for cursor probe in milliseconds */
    private readonly PROBE_TIMEOUT = 500

    /** Number of stable readings required */
    private readonly STABLE_READINGS = 3

    /** Interval between cursor position checks */
    private readonly CHECK_INTERVAL = 20

    async extract(context: ExtractionContext): Promise<ExtractionResult | null> {
        const { buffer, cursorPosition, sendInput } = context

        // Remember original position
        const originalPos = { ...cursorPosition }

        console.log('[CursorProbe] Starting probe from position:', originalPos)

        // If cursor is at column 0, no command to extract
        if (originalPos.x === 0) {
            console.log('[CursorProbe] Cursor at column 0, no command')
            return null
        }

        // Try to find command start by moving cursor to beginning
        const startPos = await this.probeStart(buffer, sendInput, originalPos)

        if (!startPos) {
            console.log('[CursorProbe] All probe methods failed')
            return null
        }

        console.log('[CursorProbe] Found start position:', startPos)

        // Restore cursor to original position
        await this.restoreCursor(buffer, sendInput, originalPos)

        // Build boundaries
        const boundaries: CommandBoundaries = {
            start: startPos,
            end: originalPos,
        }

        // Validate boundaries
        if (!this.isValidBoundaries(boundaries)) {
            console.log('[CursorProbe] Invalid boundaries')
            return null
        }

        return this.extractFromBoundaries(buffer, boundaries)
    }

    /**
     * Probe for command start using multiple methods.
     */
    private async probeStart(
        buffer: IBuffer,
        sendInput: (data: string) => void,
        currentPos: CursorPosition,
    ): Promise<CursorPosition | null> {
        // Try each method in order of universality
        const methods = [
            { name: 'Home', sequence: '\x1b[H' },        // CSI H - Home key
            { name: 'Ctrl+A', sequence: '\x01' },        // Readline beginning-of-line
            { name: 'Home-alt', sequence: '\x1b[1~' },   // Home key (alternate)
            { name: 'Home-app', sequence: '\x1bOH' },    // Home key (application mode)
        ]

        for (const method of methods) {
            console.log(`[CursorProbe] Trying ${method.name}...`)
            const result = await this.tryCursorMove(buffer, sendInput, method.sequence, currentPos)

            if (result && (result.x !== currentPos.x || result.y !== currentPos.y)) {
                console.log(`[CursorProbe] ${method.name} worked: moved to (${result.x}, ${result.y})`)
                return result
            }
        }

        return null
    }

    /**
     * Try to move cursor and detect new position.
     */
    private async tryCursorMove(
        buffer: IBuffer,
        sendInput: (data: string) => void,
        sequence: string,
        currentPos: CursorPosition,
    ): Promise<CursorPosition | null> {
        return new Promise((resolve) => {
            let stableCount = 0
            let lastPos: CursorPosition | null = null
            let resolved = false

            const timeout = setTimeout(() => {
                if (!resolved) {
                    resolved = true
                    const finalPos = this.getCursorPosition(buffer)
                    // Return position if it moved, null otherwise
                    resolve(finalPos.x !== currentPos.x || finalPos.y !== currentPos.y
                        ? finalPos : null)
                }
            }, this.PROBE_TIMEOUT)

            const checkCursor = () => {
                if (resolved) return

                const pos = this.getCursorPosition(buffer)

                // Check stability (same position for multiple readings)
                if (lastPos && pos.x === lastPos.x && pos.y === lastPos.y) {
                    stableCount++
                    if (stableCount >= this.STABLE_READINGS) {
                        clearTimeout(timeout)
                        resolved = true
                        // Return position if it moved
                        resolve(pos.x !== currentPos.x || pos.y !== currentPos.y
                            ? pos : null)
                        return
                    }
                } else {
                    stableCount = 0
                }

                lastPos = pos
                setTimeout(checkCursor, this.CHECK_INTERVAL)
            }

            // Send the key sequence
            sendInput(sequence)
            setTimeout(checkCursor, this.CHECK_INTERVAL)
        })
    }

    /**
     * Restore cursor to original position.
     */
    private async restoreCursor(
        buffer: IBuffer,
        sendInput: (data: string) => void,
        targetPos: CursorPosition,
    ): Promise<void> {
        // Try End key sequences to go back to end of line
        const methods = [
            '\x1b[F',     // CSI F - End key
            '\x05',       // Ctrl+E - Readline end-of-line
            '\x1b[4~',    // End key (alternate)
            '\x1bOF',     // End key (application mode)
        ]

        for (const seq of methods) {
            const before = this.getCursorPosition(buffer)
            await this.tryCursorMove(buffer, sendInput, seq, before)
            const after = this.getCursorPosition(buffer)

            // If we're at or past target X, we're done
            if (after.x >= targetPos.x && after.y === targetPos.y) {
                break
            }
        }
    }

    /**
     * Get current cursor position from buffer.
     */
    private getCursorPosition(buffer: IBuffer): CursorPosition {
        return {
            x: buffer.cursorX,
            y: buffer.baseY + buffer.cursorY,
        }
    }

    /**
     * Validate that boundaries make sense.
     */
    private isValidBoundaries(b: CommandBoundaries): boolean {
        if (b.start.y > b.end.y) return false
        if (b.start.y === b.end.y && b.start.x >= b.end.x) return false
        return true
    }

    /**
     * Extract command text from boundaries.
     */
    private extractFromBoundaries(buffer: IBuffer, boundaries: CommandBoundaries): ExtractionResult {
        const { start, end } = boundaries
        const segments: string[] = []
        let isMultiLine = false

        for (let y = start.y; y <= end.y; y++) {
            const line = buffer.getLine(y)
            if (!line) continue

            const startX = y === start.y ? start.x : 0
            const endX = y === end.y ? end.x : undefined

            let text = line.translateToString(true, startX, endX)

            // Handle line joining
            if (y > start.y) {
                if (line.isWrapped) {
                    // Wrapped line: join directly (no newline)
                    segments.push(text)
                } else {
                    // Real multi-line command
                    isMultiLine = true
                    // Strip continuation prompts
                    text = this.stripContinuationPrompt(text)
                    segments.push('\n' + text)
                }
            } else {
                segments.push(text)
            }
        }

        const command = segments.join('').trim()

        console.log('[CursorProbe] Extracted command:', command.substring(0, 50) + (command.length > 50 ? '...' : ''))

        return {
            command,
            isMultiLine,
            startLine: start.y,
            endLine: end.y,
            confidence: 'high',
        }
    }

    /**
     * Strip shell continuation prompts from a line.
     */
    private stripContinuationPrompt(text: string): string {
        const patterns = [
            /^>\s*/,                    // > prompt
            /^>>\s*/,                   // >> prompt (PowerShell)
            /^\.\.\.\s*/,               // ... (fish)
            /^(dquote|quote|bquote|pipe|cmdsubst|heredoc)>\s*/i,  // zsh prompts
        ]

        for (const pattern of patterns) {
            if (pattern.test(text)) {
                return text.replace(pattern, '')
            }
        }
        return text
    }
}
