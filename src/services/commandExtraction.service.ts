import { Injectable } from '@angular/core'
import { XTermFrontend } from 'tabby-terminal'
import {
    detectMainPrompt,
    stripContinuationPrompt,
    detectShellType,
    ShellType,
} from './promptDetector'

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
    /** Detected shell type */
    shellType: ShellType
}

/**
 * Command boundaries detected by buffer scanning
 */
interface CommandBoundaries {
    /** Y position (absolute) where command starts */
    startY: number
    /** X position where command starts (after prompt) */
    startX: number
    /** Y position (absolute) where command ends */
    endY: number
    /** X position where command ends */
    endX: number
}

/**
 * Service for extracting commands from the terminal buffer using keyboard-based detection.
 * This approach doesn't require shell integration (OSC 133) and works with SSH sessions.
 */
@Injectable()
export class CommandExtractionService {
    /** Timeout for Ctrl+A probe in milliseconds */
    private readonly PROBE_TIMEOUT = 100

    /** Maximum lines to scan backward for multi-line commands */
    private readonly MAX_SCAN_LINES = 100

    /**
     * Extract the current command from the terminal buffer.
     * Uses a universal approach: scan backward for prompt, scan forward for end.
     *
     * @param frontend The xterm frontend instance
     * @param sendInput Function to send input to the shell
     * @returns Extraction result or null if no command found
     */
    async extractCommand (
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

        // Capture current cursor position
        const cursorY = buffer.baseY + buffer.cursorY
        const cursorX = buffer.cursorX
        const currentLineText = this.getLineText(buffer, cursorY)

        console.log('[CommandExtraction] Cursor position:', { x: cursorX, y: cursorY })
        console.log('[CommandExtraction] Current line:', JSON.stringify(currentLineText))

        // Use Ctrl+A probe to find command start on current line (helps detect prompt position)
        const probeStartX = await this.probeCtrlA(frontend, sendInput, cursorX)
        console.log('[CommandExtraction] Ctrl+A probe startX:', probeStartX)

        // Find command boundaries by scanning the buffer
        const boundaries = this.findCommandBoundaries(buffer, cursorY, cursorX, probeStartX)

        if (!boundaries) {
            console.log('[CommandExtraction] No command boundaries found')
            return null
        }

        console.log('[CommandExtraction] Boundaries:', boundaries)

        // Extract command text from the boundaries
        const result = this.extractFromBoundaries(buffer, boundaries)

        console.log('[CommandExtraction] Result:', result)
        return result
    }

    /**
     * Find command boundaries by scanning backward for prompt and forward for end.
     */
    private findCommandBoundaries (
        buffer: any,
        cursorY: number,
        cursorX: number,
        probeStartX: number | null,
    ): CommandBoundaries | null {
        // Scan BACKWARD to find the line with the main prompt
        let startY = cursorY
        let startX = probeStartX ?? 0

        for (let y = cursorY; y >= Math.max(0, cursorY - this.MAX_SCAN_LINES); y--) {
            const lineText = this.getLineText(buffer, y)
            const promptMatch = detectMainPrompt(lineText)

            console.log(`[CommandExtraction] Scan y=${y}: "${lineText.substring(0, 50)}" prompt=${promptMatch ? 'YES' : 'no'}`)

            if (promptMatch) {
                // Found the prompt line
                startY = y
                startX = promptMatch.index + promptMatch.length
                console.log(`[CommandExtraction] Found prompt at y=${y}, startX=${startX}`)
                break
            }

            // Keep scanning - don't stop on empty lines as multi-line history commands
            // may have empty lines as visual separators in the terminal buffer
        }

        // Scan FORWARD to find the end of the command
        let endY = cursorY
        let endX = cursorX

        // For the current line, check if there's more content after cursor
        const currentLineText = this.getLineText(buffer, cursorY)
        if (currentLineText.length > cursorX) {
            // There's text after the cursor on current line - use end of line
            endX = currentLineText.trimEnd().length
        }

        // Scan forward for additional lines that are part of the command
        for (let y = cursorY + 1; y < buffer.length && y <= cursorY + this.MAX_SCAN_LINES; y++) {
            const lineText = this.getLineText(buffer, y)

            // Stop if we hit a line with a prompt (next command)
            if (detectMainPrompt(lineText)) {
                break
            }

            // Skip empty lines but don't stop (multi-line history has empty separators)
            if (lineText.trim() === '') {
                continue
            }

            // This line is part of the command
            endY = y
            endX = lineText.trimEnd().length
        }

        // Validate we found something
        if (startY > endY || (startY === endY && startX >= endX)) {
            return null
        }

        return { startY, startX, endY, endX }
    }

    /**
     * Extract command text from the given boundaries.
     */
    private extractFromBoundaries (
        buffer: any,
        boundaries: CommandBoundaries,
    ): ExtractionResult | null {
        const { startY, startX, endY, endX } = boundaries
        const commandLines: string[] = []

        for (let y = startY; y <= endY; y++) {
            const lineText = this.getLineText(buffer, y)

            // Skip empty lines (visual separators in multi-line history commands)
            if (lineText.trim() === '' && y !== startY && y !== endY) {
                continue
            }

            if (y === startY && y === endY) {
                // Single line: from startX to endX
                commandLines.push(lineText.substring(startX, endX))
            } else if (y === startY) {
                // First line: from startX to end
                const content = lineText.substring(startX).trimEnd()
                if (content) {
                    commandLines.push(content)
                }
            } else if (y === endY) {
                // Last line: from start to endX
                const stripped = stripContinuationPrompt(lineText)
                const content = stripped.substring(0, Math.min(endX, stripped.length)).trimEnd()
                if (content) {
                    commandLines.push(content)
                }
            } else {
                // Middle line: strip continuation prompt and take full line
                const content = stripContinuationPrompt(lineText).trimEnd()
                if (content) {
                    commandLines.push(content)
                }
            }
        }

        const command = commandLines.join('\n').trim()

        if (!command) {
            return null
        }

        return {
            command,
            isMultiLine: commandLines.length > 1,
            startLine: startY,
            endLine: endY,
            shellType: detectShellType(this.getLineText(buffer, startY)),
        }
    }

    /**
     * Probe using Ctrl+A to find command start position on current line.
     * Returns the X position after Ctrl+A, or null if probe failed.
     */
    private async probeCtrlA (
        frontend: XTermFrontend,
        sendInput: (data: string) => void,
        originalX: number,
    ): Promise<number | null> {
        const buffer = frontend.xterm.buffer.active
        const originalY = buffer.cursorY

        return new Promise<number | null>(resolve => {
            let resolved = false
            let checkCount = 0
            const maxChecks = 10

            const timeout = setTimeout(() => {
                if (!resolved) {
                    resolved = true
                    resolve(null)
                }
            }, this.PROBE_TIMEOUT)

            const checkCursor = () => {
                if (resolved) {
                    return
                }

                const newX = buffer.cursorX
                const newY = buffer.cursorY

                // Check if cursor moved on the same line
                if (newY === originalY && newX !== originalX) {
                    clearTimeout(timeout)
                    resolved = true
                    // Restore cursor position with Ctrl+E
                    sendInput('\x05')
                    resolve(newX)
                } else if (newY !== originalY) {
                    // Cursor moved to different line (multi-line command)
                    clearTimeout(timeout)
                    resolved = true
                    // Restore cursor position with Ctrl+E
                    sendInput('\x05')
                    // Return 0 since we're on a different line now
                    resolve(0)
                } else if (checkCount < maxChecks) {
                    checkCount++
                    setTimeout(checkCursor, 10)
                }
            }

            // Send Ctrl+A
            sendInput('\x01')
            setTimeout(checkCursor, 10)
        })
    }

    /**
     * Get text content of a buffer line.
     */
    private getLineText (buffer: any, lineY: number): string {
        const line = buffer.getLine(lineY)
        if (!line) {
            return ''
        }
        return line.translateToString(true)
    }

}
