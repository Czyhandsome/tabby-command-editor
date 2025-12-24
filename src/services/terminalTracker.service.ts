import { Injectable } from '@angular/core'
import { ConfigService } from 'tabby-core'

// Terminal type - we use 'any' since XTermFrontend.xterm is untyped
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Terminal = any

import { PromptMarkerService, IDisposable } from './promptMarker.service'
import {
    CursorProbeStrategy,
    HeuristicStrategy,
    ExtractionResult,
    ExtractionContext,
    CursorPosition,
    PromptRegion,
} from './extraction'

/**
 * Main service for terminal tracking and command extraction.
 * Orchestrates cursor probing and heuristic fallback strategies.
 */
@Injectable()
export class TerminalTrackerService {
    /** Primary extraction strategy */
    private cursorProbe = new CursorProbeStrategy()

    /** Fallback extraction strategy */
    private heuristic = new HeuristicStrategy()

    /** Prompt marker service for tracking */
    private promptMarker = new PromptMarkerService()

    /** Active terminal tracking disposables */
    private attachments = new Map<string, IDisposable>()

    constructor(private config: ConfigService) { }

    /**
     * Attach to a terminal tab and start tracking prompts.
     * @param terminalId Unique identifier for the terminal
     * @param terminal The xterm Terminal instance
     * @returns Disposable to stop tracking
     */
    attach(terminalId: string, terminal: Terminal): IDisposable {
        // Clean up any existing attachment
        this.detach(terminalId)

        // Start prompt tracking
        const markerDisposable = this.promptMarker.attach(terminalId, terminal)

        const disposable: IDisposable = {
            dispose: () => {
                markerDisposable.dispose()
                this.attachments.delete(terminalId)
                console.log(`[TerminalTracker] Detached from terminal ${terminalId}`)
            },
        }

        this.attachments.set(terminalId, disposable)
        console.log(`[TerminalTracker] Attached to terminal ${terminalId}`)

        return disposable
    }

    /**
     * Detach from a terminal.
     */
    detach(terminalId: string): void {
        const existing = this.attachments.get(terminalId)
        if (existing) {
            existing.dispose()
        }
    }

    /**
     * Check if a terminal is attached.
     */
    isAttached(terminalId: string): boolean {
        return this.attachments.has(terminalId)
    }

    /**
     * Extract the current command from the terminal.
     * Tries cursor probing first, then falls back to heuristic scanning.
     *
     * @param terminalId Unique identifier for the terminal
     * @param terminal The xterm Terminal instance
     * @param sendInput Function to send input to the terminal
     * @returns Extraction result or null if no command
     */
    async extractCommand(
        terminalId: string,
        terminal: Terminal,
        sendInput: (data: string) => void,
    ): Promise<ExtractionResult | null> {
        const buffer = terminal.buffer.active

        // Skip alternate screen (vim, less, etc.)
        if (buffer.type === 'alternate') {
            console.log('[TerminalTracker] Alternate screen active, skipping')
            return null
        }

        // Get cursor position
        const cursorPosition: CursorPosition = {
            x: buffer.cursorX,
            y: buffer.baseY + buffer.cursorY,
        }

        console.log('[TerminalTracker] Extracting command from position:', cursorPosition)

        // Get current prompt marker if available
        const currentPrompt = this.promptMarker.getCurrentPrompt(terminalId)

        // Build extraction context
        const context: ExtractionContext = {
            terminal,
            buffer: {
                type: buffer.type,
                cursorX: buffer.cursorX,
                cursorY: buffer.cursorY,
                baseY: buffer.baseY,
                viewportY: buffer.viewportY,
                length: buffer.length,
                getLine: (y: number) => buffer.getLine(y),
            },
            cursorPosition,
            sendInput,
            currentPrompt,
        }

        // Try primary strategy (cursor probing)
        console.log('[TerminalTracker] Trying cursor probe strategy...')
        let result = await this.cursorProbe.extract(context)

        if (result) {
            console.log('[TerminalTracker] Cursor probe succeeded')
            // Mark this position as a prompt for future reference
            if (result.startLine === cursorPosition.y) {
                // Command is on cursor line, mark the start position
                this.promptMarker.markPromptAt(
                    terminalId,
                    terminal,
                    currentPrompt?.commandStartX ?? 0,
                )
            }
            return result
        }

        // Fallback to heuristic
        console.log('[TerminalTracker] Cursor probe failed, trying heuristic...')
        result = await this.heuristic.extract(context)

        if (result) {
            console.log('[TerminalTracker] Heuristic extraction succeeded')
        } else {
            console.log('[TerminalTracker] All extraction methods failed')
        }

        return result
    }

    /**
     * Get all tracked prompts for a terminal (for navigation features).
     */
    getPromptHistory(terminalId: string): PromptRegion[] {
        return this.promptMarker.getAllPrompts(terminalId)
    }

    /**
     * Get prompt count for a terminal.
     */
    getPromptCount(terminalId: string): number {
        return this.promptMarker.getPromptCount(terminalId)
    }

    /**
     * Manually mark current cursor position as a prompt.
     */
    markCurrentPrompt(terminalId: string, terminal: Terminal): void {
        const buffer = terminal.buffer.active
        this.promptMarker.markPromptAt(terminalId, terminal, buffer.cursorX)
    }
}

// Re-export types for convenience
export { ExtractionResult, PromptRegion } from './extraction'
