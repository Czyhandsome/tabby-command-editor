import { ConfigProvider, Platform } from 'tabby-core'

export class CommandEditorConfigProvider extends ConfigProvider {
    defaults = {
        commandEditor: {
            executeImmediately: true,
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
