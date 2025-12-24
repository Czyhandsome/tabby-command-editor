import type {
    ExtractionStrategy,
    ExtractionContext,
    ExtractionResult,
    CursorPosition,
    IBuffer,
    PromptRegion,
} from './types'

/**
 * Fallback extraction strategy using heuristic buffer scanning.
 * Uses isWrapped detection and prompt pattern matching.
 */
export class HeuristicStrategy implements ExtractionStrategy {
    name = 'heuristic'

    /** Maximum lines to scan backward */
    private readonly MAX_SCAN_LINES = 50

    async extract(context: ExtractionContext): Promise<ExtractionResult | null> {
        const { buffer, cursorPosition, currentPrompt } = context

        console.log('[Heuristic] Starting heuristic extraction from position:', cursorPosition)

        // If cursor is at column 0, no command
        if (cursorPosition.x === 0) {
            const line = buffer.getLine(cursorPosition.y)
            if (!line || line.translateToString(true).trim() === '') {
                console.log('[Heuristic] Empty line at cursor')
                return null
            }
        }

        // Try using prompt marker if available
        if (currentPrompt && !currentPrompt.marker.isDisposed) {
            const promptLine = currentPrompt.marker.line
            // Only use if marker is on current line or before cursor
            if (promptLine <= cursorPosition.y) {
                console.log('[Heuristic] Using prompt marker at line', promptLine)
                return this.extractFromPromptMarker(buffer, currentPrompt, cursorPosition)
            }
        }

        // Fallback: scan backward
        console.log('[Heuristic] Scanning backward for command start')
        return this.extractByScan(buffer, cursorPosition)
    }

    /**
     * Extract using a known prompt marker position.
     */
    private extractFromPromptMarker(
        buffer: IBuffer,
        prompt: PromptRegion,
        cursorPos: CursorPosition,
    ): ExtractionResult | null {
        const startY = prompt.marker.line
        const startX = prompt.commandStartX

        return this.extractRegion(buffer, startY, startX, cursorPos.y, cursorPos.x)
    }

    /**
     * Extract by scanning backward to find command start.
     */
    private extractByScan(buffer: IBuffer, cursorPos: CursorPosition): ExtractionResult | null {
        let startY = cursorPos.y
        let startX = 0

        for (let y = cursorPos.y; y >= Math.max(0, cursorPos.y - this.MAX_SCAN_LINES); y--) {
            const line = buffer.getLine(y)
            if (!line) break

            // If this line is wrapped continuation from previous, keep scanning backward
            if (line.isWrapped && y > 0) {
                console.log(`[Heuristic] Line ${y} is wrapped, continuing backward`)
                continue
            }

            const text = line.translateToString(true)

            // Check for main prompt at line start (not continuation prompt)
            const promptEnd = this.findPromptEnd(text)
            if (promptEnd !== null) {
                startY = y
                startX = promptEnd
                console.log(`[Heuristic] Found prompt at line ${y}, command starts at x=${promptEnd}`)
                break
            }

            // Check if this is a continuation prompt line
            if (this.isContinuationLine(text)) {
                console.log(`[Heuristic] Line ${y} is continuation, continuing backward`)
                continue
            }

            // Non-prompt, non-continuation, non-wrapped line = previous output
            // The command starts on the next line
            if (y < cursorPos.y) {
                startY = y + 1
                startX = 0
                console.log(`[Heuristic] Previous output at line ${y}, command starts at line ${y + 1}`)
                break
            }
        }

        return this.extractRegion(buffer, startY, startX, cursorPos.y, cursorPos.x)
    }

    /**
     * Find where the main prompt ends on a line.
     * Returns position after prompt, or null if no main prompt found.
     *
     * Main prompts: ❯ › ➜ ➤ ⟩ » $ # %
     * NOT main prompts: > (alone, used for continuation)
     */
    private findPromptEnd(line: string): number | null {
        // First, check if this is a continuation prompt
        if (this.isContinuationLine(line)) {
            return null
        }

        // Main prompt characters (excluding bare >)
        const promptChars = ['❯', '›', '➜', '➤', '⟩', '»', '$', '#', '%']

        // Search within first 100 characters for prompt char followed by space
        const searchLimit = Math.min(100, line.length)

        for (let i = searchLimit - 1; i >= 0; i--) {
            if (promptChars.includes(line[i]) && line[i + 1] === ' ') {
                return i + 2  // After prompt char and space
            }
        }

        // Special case: line starts with just content (no visible prompt)
        // This happens with some minimal prompts. If line has content and we're
        // on the cursor line, assume command starts at 0
        if (line.trim().length > 0) {
            // Check if line looks like a command (starts with common command chars or has path-like content)
            const trimmed = line.trimStart()
            const leadingSpaces = line.length - trimmed.length

            // If there are no leading spaces and it doesn't look like output, could be command start
            if (leadingSpaces < 4 && !this.looksLikeOutput(trimmed)) {
                return 0
            }
        }

        return null
    }

    /**
     * Check if a line looks like command output rather than a command.
     */
    private looksLikeOutput(text: string): boolean {
        // Common output patterns
        if (text.startsWith('total ')) return true  // ls -l output
        if (text.match(/^-?[rwxd-]{9,}/)) return true  // File permissions (ls output)
        if (text.match(/^\d+\.\d+\.\d+/)) return true  // Version numbers
        if (text.match(/^[A-Z][a-z]+:?\s/)) return true  // Labels like "Error:", "Warning:"
        return false
    }

    /**
     * Check if a line is a continuation prompt line.
     */
    private isContinuationLine(text: string): boolean {
        const trimmed = text.trimStart()
        const patterns = [
            /^>\s/,           // > followed by space (shell continuation)
            /^dquote>\s?/i,   // zsh double-quote continuation
            /^quote>\s?/i,    // zsh quote continuation
            /^pipe>\s?/i,     // zsh pipe continuation
            /^cmdsubst>\s?/i, // zsh command substitution
            /^heredoc>\s?/i,  // zsh heredoc
            /^\.\.\.\s?/,     // fish continuation
        ]
        return patterns.some(p => p.test(trimmed))
    }

    /**
     * Extract text from a region of the buffer.
     */
    private extractRegion(
        buffer: IBuffer,
        startY: number, startX: number,
        endY: number, endX: number,
    ): ExtractionResult | null {
        const segments: string[] = []
        let isMultiLine = false

        console.log(`[Heuristic] Extracting from (${startX}, ${startY}) to (${endX}, ${endY})`)

        for (let y = startY; y <= endY; y++) {
            const line = buffer.getLine(y)
            if (!line) continue

            const lineStartX = y === startY ? startX : 0
            const lineEndX = y === endY ? endX : undefined

            let text = line.translateToString(true, lineStartX, lineEndX)

            if (y > startY) {
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

        if (!command) {
            console.log('[Heuristic] No command extracted')
            return null
        }

        console.log('[Heuristic] Extracted command:', command.substring(0, 50) + (command.length > 50 ? '...' : ''))

        return {
            command,
            isMultiLine,
            startLine: startY,
            endLine: endY,
            confidence: 'medium',
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
