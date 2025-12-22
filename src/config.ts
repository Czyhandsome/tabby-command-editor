import { ConfigProvider, Platform } from 'tabby-core'

export class CommandEditorConfigProvider extends ConfigProvider {
    defaults = {
        commandEditor: {
            executeImmediately: true,
            // Custom prompt pattern (regex string) for users with non-standard prompts
            // Example: "❯\\s*$" or "→\\s*$"
            // Leave empty to use automatic detection
            customPromptPattern: '',
        },
        hotkeys: {
            'open-command-editor': [],
        },
    }

    platformDefaults = {
        [Platform.macOS]: {
            hotkeys: {
                'open-command-editor': ['Ctrl-E'],
            },
        },
        [Platform.Windows]: {
            hotkeys: {
                'open-command-editor': ['Ctrl-E'],
            },
        },
        [Platform.Linux]: {
            hotkeys: {
                'open-command-editor': ['Ctrl-E'],
            },
        },
    }
}
