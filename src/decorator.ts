import { Injectable } from '@angular/core'
import { Subscription } from 'rxjs'
import { NgbModal } from '@ng-bootstrap/ng-bootstrap'
import { ConfigService, HotkeysService, NotificationsService, TranslateService } from 'tabby-core'
import { TerminalDecorator, BaseTerminalTabComponent, XTermFrontend } from 'tabby-terminal'
import { CommandExtractionService, ExtractionResult } from './services/commandExtraction.service'
import { CommandEditorModalComponent } from './components/commandEditorModal.component'

@Injectable()
export class CommandEditorDecorator extends TerminalDecorator {
    private hotkeySubscription: Subscription | null = null
    private activeTab: BaseTerminalTabComponent<any> | null = null

    constructor(
        private hotkeys: HotkeysService,
        private ngbModal: NgbModal,
        private notifications: NotificationsService,
        private translate: TranslateService,
        private config: ConfigService,
        private commandExtraction: CommandExtractionService,
    ) {
        super()
    }

    attach(tab: BaseTerminalTabComponent<any>): void {
        if (!(tab.frontend instanceof XTermFrontend)) {
            return
        }

        this.activeTab = tab

        // Subscribe to hotkeys
        this.subscribeUntilDetached(tab, this.hotkeys.hotkey$.subscribe(async hotkey => {
            if (hotkey !== 'open-command-editor') {
                return
            }

            // Only handle if this tab's frontend is active
            if (!tab.frontend || tab.frontend.isAlternateScreenActive()) {
                return
            }

            await this.openCommandEditor(tab)
        }))
    }

    private async openCommandEditor(tab: BaseTerminalTabComponent<any>): Promise<void> {
        if (!tab.session) {
            return
        }

        // Ensure we have an XTerm frontend
        if (!(tab.frontend instanceof XTermFrontend)) {
            return
        }

        // Extract current command using keyboard-based detection
        const extractionResult = await this.commandExtraction.extractCommand(
            tab.frontend,
            (data: string) => tab.sendInput(data),
        )

        if (!extractionResult || !extractionResult.command.trim()) {
            // Nothing to edit - show a notification
            this.notifications.info(this.translate.instant('No command to edit'))
            return
        }

        // Store original command for potential restoration
        const originalCommand = extractionResult.command

        // Clear command from terminal BEFORE opening modal
        await this.clearCurrentCommand(tab, extractionResult)

        // Open modal
        const modal = this.ngbModal.open(CommandEditorModalComponent, {
            size: 'lg',
            backdrop: 'static',
            scrollable: false,
        })

        // Pass initial data
        modal.componentInstance.initialCommand = originalCommand
        modal.componentInstance.terminalTheme = this.getTerminalTheme()

        // Wait for result
        try {
            const editedCommand = await modal.result
            // User saved - insert the edited command
            this.insertCommand(tab, editedCommand)

            // Execute immediately if configured
            if (this.config.store.commandEditor?.executeImmediately) {
                tab.sendInput('\r')
            }
        } catch {
            // User cancelled - restore the original command
            this.insertCommand(tab, originalCommand)
        }
    }

    /**
     * Insert a command into the terminal
     */
    private insertCommand(tab: BaseTerminalTabComponent<any>, command: string): void {
        const hasNewlines = command.includes('\n')

        if (hasNewlines && tab.frontend?.supportsBracketedPaste()) {
            // Use bracketed paste mode for multi-line commands
            // This inserts the command without executing it
            const bracketedCommand = `\x1b[200~${command}\x1b[201~`
            tab.sendInput(bracketedCommand)
        } else if (hasNewlines) {
            // Fallback: convert newlines to spaces if bracketed paste not supported
            const singleLine = command.replace(/\n+/g, ' ')
            tab.sendInput(singleLine)
        } else {
            // Single-line command - send as-is
            tab.sendInput(command)
        }
    }

    /**
     * Determine terminal theme (dark/light)
     */
    private getTerminalTheme(): 'dark' | 'light' {
        const scheme = this.config.store.terminal?.colorScheme

        // Simple heuristic: check if background is dark
        if (scheme?.background) {
            const bg = scheme.background
            if (bg.startsWith('#')) {
                const r = parseInt(bg.slice(1, 3), 16)
                const g = parseInt(bg.slice(3, 5), 16)
                const b = parseInt(bg.slice(5, 7), 16)
                const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255
                return luminance < 0.5 ? 'dark' : 'light'
            }
        }

        return 'dark' // Default
    }

    /**
     * Small delay helper
     */
    private delay(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms))
    }

    /**
     * Clear the current command from the terminal.
     * For multiline commands, uses ANSI escape sequences to clean up visually.
     */
    private async clearCurrentCommand(tab: BaseTerminalTabComponent<any>, extractionResult: ExtractionResult): Promise<void> {
        if (!(tab.frontend instanceof XTermFrontend)) {
            return
        }

        if (extractionResult.isMultiLine) {
            // Send Ctrl+C to cancel multiline command
            tab.sendInput('\x03')
            await this.delay(50)

            // Calculate lines to clear
            const linesToClear = extractionResult.endLine - extractionResult.startLine + 1

            // Visual cleanup using ANSI escape sequences
            let cleanupSequence = ''
            cleanupSequence += '\r\x1b[2K'  // Clear current line (^C)

            for (let i = 0; i < linesToClear - 1; i++) {
                cleanupSequence += '\x1b[A'   // Cursor up
                cleanupSequence += '\x1b[2K'  // Clear line
            }

            await tab.frontend.write(cleanupSequence)
        } else {
            // Single-line: use Ctrl+U (cleaner)
            tab.sendInput('\x15')
            await this.delay(30)
        }
    }
}
