import { Injectable } from '@angular/core'
import { ConfigService } from 'tabby-core'
import { XTermFrontend } from 'tabby-terminal'

/**
 * Result of command extraction
 */
export interface ExtractionResult {
    /** The extracted command text */
    command: string
    /** Whether this is a multi-line command */
    isMultiLine: boolean
    /** Starting line in the buffer */
    startLine: number
    /** Ending line in the buffer */
    endLine: number
}

/**
 * Cursor position in the terminal buffer
 */
interface CursorPosition {
    x: number
    /** Absolute Y position (baseY + cursorY) */
    y: number
}

/**
 * Command boundaries detected by readline probing
 */
interface CommandBoundaries {
    start: CursorPosition
    end: CursorPosition
}

/**
 * Service for extracting commands from the terminal buffer using readline shortcuts.
 * Uses Ctrl+A/Ctrl+E to detect command boundaries - works with any prompt style.
 */
@Injectable()
export class CommandExtractionService {
    /** Timeout for readline probe in milliseconds (increased for SSH latency) */
    private readonly PROBE_TIMEOUT = 500

    /** Interval between cursor position checks */
    private readonly CHECK_INTERVAL = 25

    /** Number of stable readings required before accepting position */
    private readonly STABLE_READINGS = 3

    /** Maximum lines to scan backward for multi-line commands */
    private readonly MAX_SCAN_LINES = 50

    constructor(private config: ConfigService) { }

    /**
     * Extract the current command from the terminal buffer.
     * Uses Ctrl+A and Ctrl+E to find command boundaries via readline.
     */
    async extractCommand(
        frontend: XTermFrontend,
        sendInput: (data: string) => void,
    ): Promise<ExtractionResult | null> {
        const xterm = frontend.xterm
        const buffer = xterm.buffer.active

        // Check if we're in alternate screen (vim, less, etc.)
        if (frontend.isAlternateScreenActive()) {
            console.log('[CommandExtraction] Alternate screen active, skipping')
            return null
        }

        // Get original cursor position
        const originalPos = this.getCursorPosition(buffer)
        console.log('[CommandExtraction] Original cursor:', originalPos)

        // Probe command boundaries using readline shortcuts
        const boundaries = await this.probeCommandBoundaries(frontend, sendInput, originalPos)

        if (!boundaries) {
            console.log('[CommandExtraction] Failed to detect command boundaries')
            return null
        }

        console.log('[CommandExtraction] Initial boundaries:', boundaries)

        // Expand boundaries backward to include multi-line command continuations
        const expandedBoundaries = this.expandForMultiLine(buffer, boundaries)
        console.log('[CommandExtraction] Expanded boundaries:', expandedBoundaries)

        // Validate boundaries
        if (expandedBoundaries.start.y > expandedBoundaries.end.y ||
            (expandedBoundaries.start.y === expandedBoundaries.end.y &&
                expandedBoundaries.start.x >= expandedBoundaries.end.x)) {
            console.log('[CommandExtraction] No command (empty boundaries)')
            return null
        }

        // Extract command text from buffer
        const result = this.extractFromBoundaries(buffer, expandedBoundaries)
        console.log('[CommandExtraction] Result:', result)

        return result
    }

    /**
     * Probe command boundaries using Ctrl+A (start) and Ctrl+E (end).
     * Falls back to line scanning if readline probes fail.
     */
    private async probeCommandBoundaries(
        frontend: XTermFrontend,
        sendInput: (data: string) => void,
        originalPos: CursorPosition,
    ): Promise<CommandBoundaries | null> {
        const buffer = frontend.xterm.buffer.active

        // Step 1: Send Ctrl+A to move to command start
        const startPos = await this.probeCursorMove(
            buffer,
            sendInput,
            '\x01', // Ctrl+A
            originalPos,
        )

        if (!startPos) {
            console.log('[CommandExtraction] Ctrl+A probe failed, trying line scan fallback')
            // Fallback: scan current line for prompt pattern
            return this.fallbackLineScan(buffer, originalPos)
        }

        const commandStart = startPos

        // Step 2: Send Ctrl+E to move to command end
        const endPos = await this.probeCursorMove(
            buffer,
            sendInput,
            '\x05', // Ctrl+E
            commandStart,
        )

        if (!endPos) {
            console.log('[CommandExtraction] Ctrl+E probe failed')
        }

        const commandEnd = endPos || this.getCursorPosition(buffer)

        return {
            start: commandStart,
            end: commandEnd,
        }
    }

    /**
     * Fallback line scanning when readline probes fail.
     * Scans the current line for common prompt patterns and extracts command.
     */
    private fallbackLineScan(
        buffer: any,
        cursorPos: CursorPosition,
    ): CommandBoundaries | null {
        const lineText = this.getLineText(buffer, cursorPos.y)
        console.log('[CommandExtraction] Fallback scan line:', JSON.stringify(lineText))

        // Try to find prompt end using pattern matching
        const promptEnd = this.findPromptEnd(lineText)

        if (promptEnd !== null && promptEnd < cursorPos.x) {
            console.log('[CommandExtraction] Fallback found prompt end at x=' + promptEnd)
            return {
                start: { x: promptEnd, y: cursorPos.y },
                end: { x: lineText.trimEnd().length, y: cursorPos.y },
            }
        }

        // Last resort: look for common prompt characters anywhere in line
        const promptChars = ['❯', '›', '➜', '➤', '⟩', '»', '$', '#', '%', '>']
        for (let i = lineText.length - 1; i >= 0; i--) {
            const char = lineText[i]
            if (promptChars.includes(char)) {
                // Found a potential prompt character
                // Check if there's a space after it
                const nextChar = lineText[i + 1]
                if (nextChar === ' ' || nextChar === undefined) {
                    const startX = i + (nextChar === ' ' ? 2 : 1)
                    if (startX < cursorPos.x) {
                        console.log('[CommandExtraction] Fallback found prompt char at x=' + i)
                        return {
                            start: { x: startX, y: cursorPos.y },
                            end: { x: lineText.trimEnd().length, y: cursorPos.y },
                        }
                    }
                }
            }
        }

        console.log('[CommandExtraction] Fallback: no prompt found')
        return null
    }

    /**
     * Expand boundaries backward to include multi-line command continuations.
     * Looks for lines ending with \ (line continuation character).
     */
    private expandForMultiLine(buffer: any, boundaries: CommandBoundaries): CommandBoundaries {
        let startY = boundaries.start.y
        let startX = boundaries.start.x

        // Scan backward from the start line to find continuation lines
        for (let y = boundaries.start.y - 1; y >= Math.max(0, boundaries.start.y - this.MAX_SCAN_LINES); y--) {
            const lineText = this.getLineText(buffer, y)
            const trimmedLine = lineText.trimEnd()

            // Check if this line ends with \ (line continuation)
            if (trimmedLine.endsWith('\\')) {
                console.log(`[CommandExtraction] Found continuation at y=${y}: "${trimmedLine.substring(0, 50)}"`)

                // Find the start of the command on this line
                // Look for prompt indicators (❯, $, %, >, etc.) at the start
                const promptMatch = this.findPromptEnd(lineText)
                if (promptMatch !== null) {
                    startY = y
                    startX = promptMatch
                    console.log(`[CommandExtraction] Command starts at y=${y}, x=${startX}`)
                } else {
                    // No prompt found, assume it's a continuation line starting at 0
                    startY = y
                    startX = 0
                }
            } else {
                // Line doesn't end with \, stop scanning
                break
            }
        }

        return {
            start: { x: startX, y: startY },
            end: boundaries.end,
        }
    }

    /**
     * Find where the prompt ends on a line.
     * Returns the character position after the prompt, or null if no prompt found.
     */
    private findPromptEnd(line: string): number | null {
        // Common prompt patterns - look for the prompt character followed by space
        const promptPatterns = [
            /^.*?[❯›➜➤⟩»$#%>]\s+/,  // Common prompt terminators
            /^.*?[λ∴⊙⟡❮❭]\s+/,       // Starship/pure symbols
        ]

        for (const pattern of promptPatterns) {
            const match = line.match(pattern)
            if (match) {
                return match[0].length
            }
        }

        return null
    }

    /**
     * Simple delay helper.
     */
    private delay(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms))
    }

    /**
     * Send a control character and wait for cursor to move.
     * Returns the new position, or null if cursor didn't move.
     */
    private async probeCursorMove(
        buffer: any,
        sendInput: (data: string) => void,
        controlChar: string,
        currentPos: CursorPosition,
    ): Promise<CursorPosition | null> {
        return new Promise<CursorPosition | null>(resolve => {
            let resolved = false
            let stableCount = 0
            let lastPos: CursorPosition | null = null

            const timeout = setTimeout(() => {
                if (!resolved) {
                    resolved = true
                    // Return current position if different from start, else null
                    const finalPos = this.getCursorPosition(buffer)
                    if (finalPos.x !== currentPos.x || finalPos.y !== currentPos.y) {
                        resolve(finalPos)
                    } else {
                        resolve(null)
                    }
                }
            }, this.PROBE_TIMEOUT)

            const checkCursor = () => {
                if (resolved) return

                const newPos = this.getCursorPosition(buffer)

                // Check if position is stable (same as last reading)
                if (lastPos && newPos.x === lastPos.x && newPos.y === lastPos.y) {
                    stableCount++
                    if (stableCount >= this.STABLE_READINGS) {
                        // Position is stable
                        clearTimeout(timeout)
                        resolved = true
                        if (newPos.x !== currentPos.x || newPos.y !== currentPos.y) {
                            resolve(newPos)
                        } else {
                            resolve(null) // Didn't move
                        }
                        return
                    }
                } else {
                    stableCount = 0
                }

                lastPos = newPos
                setTimeout(checkCursor, this.CHECK_INTERVAL)
            }

            // Send the control character
            sendInput(controlChar)
            setTimeout(checkCursor, this.CHECK_INTERVAL)
        })
    }

    /**
     * Get current cursor position (with absolute Y).
     */
    private getCursorPosition(buffer: any): CursorPosition {
        return {
            x: buffer.cursorX,
            y: buffer.baseY + buffer.cursorY,
        }
    }

    /**
     * Extract command text from the given boundaries.
     */
    private extractFromBoundaries(
        buffer: any,
        boundaries: CommandBoundaries,
    ): ExtractionResult | null {
        const { start, end } = boundaries
        const commandLines: string[] = []
        const fullLines: string[] = []  // For debug logging

        for (let y = start.y; y <= end.y; y++) {
            const lineText = this.getLineText(buffer, y)
            fullLines.push(lineText)  // Store full line for debug

            if (y === start.y && y === end.y) {
                // Single line: from startX to endX
                commandLines.push(lineText.substring(start.x, end.x))
            } else if (y === start.y) {
                // First line: from startX to end of line
                const content = lineText.substring(start.x).trimEnd()
                if (content) {
                    commandLines.push(content)
                }
            } else if (y === end.y) {
                // Last line: strip continuation prompt, then take to endX
                const stripped = this.stripContinuationPrompt(lineText)
                const offset = lineText.length - stripped.length
                const adjustedEndX = Math.max(0, end.x - offset)
                const content = stripped.substring(0, adjustedEndX).trimEnd()
                if (content) {
                    commandLines.push(content)
                }
            } else {
                // Middle line: strip continuation prompt and take full line
                const content = this.stripContinuationPrompt(lineText).trimEnd()
                if (content) {
                    commandLines.push(content)
                }
            }
        }

        // Join lines, handling line continuations
        let command = ''
        for (let i = 0; i < commandLines.length; i++) {
            const line = commandLines[i]
            if (i > 0) {
                // Check if previous line ended with \ (already trimmed, so check original)
                const prevLine = commandLines[i - 1]
                if (prevLine.endsWith('\\')) {
                    // Line continuation - join with newline for display
                    command += '\n' + line
                } else {
                    command += '\n' + line
                }
            } else {
                command = line
            }
        }

        command = command.trim()

        // Debug logging - show full text vs extracted command
        const fullText = fullLines.join('\n')
        console.log('[CommandExtraction] ========== DEBUG ==========')
        console.log('[CommandExtraction] Full text fetched by xterm.js API (with prompt):')
        console.log(fullText)
        console.log('[CommandExtraction] Extracted command with prompt stripped:')
        console.log(command)
        console.log('[CommandExtraction] Boundaries: start=(' + start.x + ',' + start.y + ') end=(' + end.x + ',' + end.y + ')')
        console.log('[CommandExtraction] ============================')

        if (!command) {
            return null
        }

        return {
            command,
            isMultiLine: commandLines.length > 1,
            startLine: start.y,
            endLine: end.y,
        }
    }

    /**
     * Strip common shell continuation prompts from a line.
     * These appear in multi-line commands (heredocs, line continuations, etc.)
     */
    private stripContinuationPrompt(line: string): string {
        // Common continuation prompt patterns:
        // > (bash heredoc, generic continuation)
        // >> (PowerShell)
        // ... (fish)
        // dquote>, quote>, etc. (zsh)
        const patterns = [
            /^>\s*/,                    // > prompt
            /^>>\s*/,                   // >> prompt
            /^\.\.\.\s*/,               // ... prompt
            /^(dquote|quote|bquote|pipe|cmdsubst|heredoc)>\s*/i,  // zsh prompts
        ]

        for (const pattern of patterns) {
            const match = line.match(pattern)
            if (match) {
                return line.substring(match[0].length)
            }
        }
        return line
    }

    /**
     * Get text content of a buffer line.
     */
    private getLineText(buffer: any, lineY: number): string {
        const line = buffer.getLine(lineY)
        if (!line) {
            return ''
        }
        return line.translateToString(true)
    }
}
