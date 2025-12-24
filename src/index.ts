import { NgModule } from '@angular/core'
import { CommonModule } from '@angular/common'
import { NgbModule } from '@ng-bootstrap/ng-bootstrap'
import { ToastrModule } from 'ngx-toastr'
import { ConfigProvider, HotkeyProvider } from 'tabby-core'
import { TerminalDecorator } from 'tabby-terminal'

import { CommandEditorConfigProvider } from './config'
import { CommandEditorHotkeyProvider } from './hotkeys'
import { CommandEditorDecorator } from './decorator'
import { PowerExtractionService } from './services/powerExtraction.service'
import { CommandEditorModalComponent } from './components/commandEditorModal.component'

@NgModule({
    imports: [
        CommonModule,
        NgbModule,
        ToastrModule,
    ],
    providers: [
        PowerExtractionService,
        { provide: ConfigProvider, useClass: CommandEditorConfigProvider, multi: true },
        { provide: HotkeyProvider, useClass: CommandEditorHotkeyProvider, multi: true },
        { provide: TerminalDecorator, useClass: CommandEditorDecorator, multi: true },
    ],
    declarations: [
        CommandEditorModalComponent,
    ],
})
export default class CommandEditorModule { }

export { PowerExtractionService, PowerExtractionResult } from './services/powerExtraction.service'
export { CommandEditorModalComponent }

