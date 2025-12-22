import { Component, Input, ViewChild, ElementRef, AfterViewInit, OnDestroy } from '@angular/core'
import { NgbActiveModal } from '@ng-bootstrap/ng-bootstrap'
import { HotkeysService, PlatformService } from 'tabby-core'
// @ts-ignore - monaco-editor types
import * as monaco from 'monaco-editor'

@Component({
    selector: 'command-editor-modal',
    templateUrl: './commandEditorModal.component.pug',
    styleUrls: ['./commandEditorModal.component.scss'],
})
export class CommandEditorModalComponent implements AfterViewInit, OnDestroy {
    @Input() initialCommand = ''
    @Input() terminalTheme: 'dark' | 'light' = 'dark'

    @ViewChild('editorContainer', { read: ElementRef }) editorContainer: ElementRef<HTMLElement>

    private editor: monaco.editor.IStandaloneCodeEditor

    constructor (
        private modalInstance: NgbActiveModal,
        private hotkeys: HotkeysService,
        private platform: PlatformService,
    ) {}

    ngAfterViewInit (): void {
        // Disable global hotkeys while modal is open (allows Cmd+V paste to work)
        this.hotkeys.disable()
        this.initMonaco()
    }

    private initMonaco (): void {
        this.editor = monaco.editor.create(this.editorContainer.nativeElement, {
            value: this.initialCommand,
            language: 'shell',
            theme: this.terminalTheme === 'dark' ? 'vs-dark' : 'vs',

            // Layout options
            minimap: { enabled: false },
            scrollBeyondLastLine: false,
            automaticLayout: true,
            overviewRulerLanes: 0,

            // Editing options
            wordWrap: 'on',
            lineNumbers: 'on',
            fontSize: 14,
            fontFamily: 'monospace',
            tabSize: 2,
            insertSpaces: true,

            // Behavior
            quickSuggestions: false,
            contextmenu: true,
            selectOnLineNumbers: true,
            renderWhitespace: 'boundary',
            renderLineHighlight: 'all',
        })

        // Keyboard shortcuts
        this.editor.addCommand(
            monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter,
            () => this.saveCommand(),
        )

        this.editor.addCommand(
            monaco.KeyCode.Escape,
            () => this.cancel(),
        )

        // Handle paste manually using Electron's native clipboard
        // (Monaco's built-in paste fails with "Document is not focused" in Electron)
        this.editor.addCommand(
            monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyV,
            () => this.pasteFromClipboard(),
        )

        // Focus editor and position cursor at end
        this.editor.focus()
        const model = this.editor.getModel()
        if (model) {
            const lastLine = model.getLineCount()
            const lastColumn = model.getLineMaxColumn(lastLine)
            this.editor.setPosition({ lineNumber: lastLine, column: lastColumn })
        }
    }

    saveCommand (): void {
        const editedCommand = this.editor.getValue()
        this.modalInstance.close(editedCommand)
    }

    cancel (): void {
        this.modalInstance.dismiss()
    }

    private pasteFromClipboard (): void {
        const clipboardText = this.platform.readClipboard()
        if (clipboardText) {
            // Insert text at current cursor position
            const selection = this.editor.getSelection()
            if (selection) {
                this.editor.executeEdits('paste', [{
                    range: selection,
                    text: clipboardText,
                    forceMoveMarkers: true,
                }])
            }
        }
    }

    ngOnDestroy (): void {
        // Re-enable global hotkeys
        this.hotkeys.enable()
        this.editor?.dispose()
    }
}
