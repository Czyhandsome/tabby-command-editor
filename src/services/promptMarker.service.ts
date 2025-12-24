import type { PromptRegion, IMarker } from './extraction/types'

// Terminal type - we use 'any' since XTermFrontend.xterm is untyped
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Terminal = any

/**
 * Disposable interface for cleanup
 */
export interface IDisposable {
    dispose(): void
}

/**
 * Service for tracking prompt positions using xterm markers.
 * Enables prompt history navigation without requiring shell integration.
 */
export class PromptMarkerService {
    /** Maximum prompts to track per terminal */
    private readonly MAX_PROMPTS = 100

    /** Delay after linefeed before checking for prompt (ms) */
    private readonly PROMPT_CHECK_DELAY = 50

    /** Prompt regions indexed by terminal ID */
    private prompts = new Map<string, PromptRegion[]>()

    /** Currently active (latest) prompt per terminal */
    private currentPrompt = new Map<string, PromptRegion>()

    /** Pending prompt check timers */
    private pendingChecks = new Map<string, ReturnType<typeof setTimeout>>()

    /**
     * Start tracking prompts for a terminal instance.
     * @param terminalId Unique identifier for the terminal
     * @param terminal The xterm Terminal instance
     * @returns Disposable to stop tracking
     */
    attach(terminalId: string, terminal: Terminal): IDisposable {
        const disposables: IDisposable[] = []

        // Strategy: After linefeed, if cursor position looks like a prompt,
        // register a marker for that position
        const onLineFeed = terminal.onLineFeed(() => {
            this.schedulePromptCheck(terminalId, terminal)
        })
        disposables.push(onLineFeed)

        // Clean up disposed markers when buffer changes
        const onWriteParsed = terminal.onWriteParsed(() => {
            this.cleanupDisposedMarkers(terminalId)
        })
        disposables.push(onWriteParsed)

        console.log(`[PromptMarker] Attached to terminal ${terminalId}`)

        return {
            dispose: () => {
                // Clear pending timer
                const timer = this.pendingChecks.get(terminalId)
                if (timer) {
                    clearTimeout(timer)
                    this.pendingChecks.delete(terminalId)
                }

                // Dispose all markers
                const prompts = this.prompts.get(terminalId)
                if (prompts) {
                    prompts.forEach(p => {
                        if (!p.marker.isDisposed) {
                            p.marker.dispose()
                        }
                    })
                }

                // Clean up state
                this.prompts.delete(terminalId)
                this.currentPrompt.delete(terminalId)

                // Dispose event listeners
                disposables.forEach(d => d.dispose())

                console.log(`[PromptMarker] Detached from terminal ${terminalId}`)
            },
        }
    }

    /**
     * Get the current (most recent) prompt for a terminal.
     */
    getCurrentPrompt(terminalId: string): PromptRegion | null {
        const prompt = this.currentPrompt.get(terminalId)
        if (prompt && !prompt.marker.isDisposed) {
            return prompt
        }
        return null
    }

    /**
     * Get all tracked prompts for a terminal (for navigation features).
     */
    getAllPrompts(terminalId: string): PromptRegion[] {
        const prompts = this.prompts.get(terminalId) ?? []
        return prompts.filter(p => !p.marker.isDisposed)
    }

    /**
     * Get prompt count for a terminal.
     */
    getPromptCount(terminalId: string): number {
        return this.getAllPrompts(terminalId).length
    }

    /**
     * Manually mark current cursor position as a prompt.
     * Called when we successfully detect a prompt via cursor probing.
     */
    markPromptAt(terminalId: string, terminal: Terminal, commandStartX: number): void {
        const marker = terminal.registerMarker(0) as IMarker | undefined
        if (!marker) {
            console.log('[PromptMarker] Failed to register marker')
            return
        }

        const region: PromptRegion = {
            marker,
            commandStartX,
            timestamp: Date.now(),
        }

        this.addPrompt(terminalId, region)
        console.log(`[PromptMarker] Manually marked prompt at line ${marker.line}, x=${commandStartX}`)
    }

    /**
     * Schedule a prompt check after linefeed.
     */
    private schedulePromptCheck(terminalId: string, terminal: Terminal): void {
        // Cancel any pending check
        const existing = this.pendingChecks.get(terminalId)
        if (existing) {
            clearTimeout(existing)
        }

        // Schedule new check
        const timer = setTimeout(() => {
            this.pendingChecks.delete(terminalId)
            this.checkForPrompt(terminalId, terminal)
        }, this.PROMPT_CHECK_DELAY)

        this.pendingChecks.set(terminalId, timer)
    }

    /**
     * Check if current cursor position looks like a prompt.
     */
    private checkForPrompt(terminalId: string, terminal: Terminal): void {
        const buffer = terminal.buffer.active

        // Skip alternate screen (vim, less, etc.)
        if (buffer.type === 'alternate') {
            return
        }

        // Prompt heuristic: cursor should be within reasonable position after prompt
        // Most prompts are < 100 characters
        if (buffer.cursorX > 100) {
            return
        }

        // Get current line text
        const line = buffer.getLine(buffer.baseY + buffer.cursorY)
        if (!line) {
            return
        }

        const text = line.translateToString(true)

        // Check if line looks like a prompt
        if (this.looksLikePrompt(text, buffer.cursorX)) {
            const marker = terminal.registerMarker(0) as IMarker | undefined
            if (marker) {
                const commandStartX = buffer.cursorX
                this.addPrompt(terminalId, {
                    marker,
                    commandStartX,
                    timestamp: Date.now(),
                })
                console.log(`[PromptMarker] Auto-detected prompt at line ${marker.line}, x=${commandStartX}`)
            }
        }
    }

    /**
     * Heuristic to check if text looks like a prompt.
     */
    private looksLikePrompt(text: string, cursorX: number): boolean {
        // Common prompt terminator characters
        const promptChars = ['❯', '›', '➜', '➤', '⟩', '»', '$', '#', '%', '>']

        // Check if there's a prompt character before the cursor position
        const beforeCursor = text.substring(0, cursorX)

        // Should have at least one prompt character
        const hasPromptChar = promptChars.some(char => beforeCursor.includes(char))
        if (!hasPromptChar) {
            return false
        }

        // The last non-space character before cursor should be near a prompt char
        const trimmedBefore = beforeCursor.trimEnd()
        if (trimmedBefore.length === 0) {
            return false
        }

        // Check if it ends with prompt char + optional space
        const lastChar = trimmedBefore[trimmedBefore.length - 1]
        const secondLastChar = trimmedBefore.length > 1 ? trimmedBefore[trimmedBefore.length - 2] : ''

        return promptChars.includes(lastChar) || promptChars.includes(secondLastChar)
    }

    /**
     * Add a prompt region to tracking.
     */
    private addPrompt(terminalId: string, region: PromptRegion): void {
        if (!this.prompts.has(terminalId)) {
            this.prompts.set(terminalId, [])
        }

        const prompts = this.prompts.get(terminalId)!

        // Check for duplicate (same line)
        const existing = prompts.find(p => !p.marker.isDisposed && p.marker.line === region.marker.line)
        if (existing) {
            // Update existing instead of adding duplicate
            existing.commandStartX = region.commandStartX
            existing.timestamp = region.timestamp
            region.marker.dispose()  // Don't need the new marker
            return
        }

        prompts.push(region)

        // Limit size
        while (prompts.length > this.MAX_PROMPTS) {
            const old = prompts.shift()
            if (old && !old.marker.isDisposed) {
                old.marker.dispose()
            }
        }

        this.currentPrompt.set(terminalId, region)
    }

    /**
     * Clean up disposed markers from tracking.
     */
    private cleanupDisposedMarkers(terminalId: string): void {
        const prompts = this.prompts.get(terminalId)
        if (!prompts) return

        const valid = prompts.filter(p => !p.marker.isDisposed)

        if (valid.length !== prompts.length) {
            console.log(`[PromptMarker] Cleaned up ${prompts.length - valid.length} disposed markers`)
            this.prompts.set(terminalId, valid)
        }

        // Update current prompt if disposed
        const current = this.currentPrompt.get(terminalId)
        if (current?.marker.isDisposed) {
            const newCurrent = valid[valid.length - 1]
            if (newCurrent) {
                this.currentPrompt.set(terminalId, newCurrent)
            } else {
                this.currentPrompt.delete(terminalId)
            }
        }
    }
}
