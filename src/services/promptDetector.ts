/**
 * Prompt detection utilities for keyboard-based command extraction.
 * These patterns help identify where the prompt ends and the command begins.
 */

/**
 * Patterns for main shell prompts (typically at the end of the prompt line)
 */
export const MAIN_PROMPT_PATTERNS: RegExp[] = [
    // Standard bash/zsh prompts: $, #, %
    /[$#%]\s*$/,
    // Fish and starship prompts (at end of line)
    /[❯›>]\s*$/,
    // PowerShell prompt
    />\s*$/,
    // Common custom prompt terminators
    /[➜➤⟩»]\s*$/,
    // Multi-line prompts: prompt character at START of line (starship, powerlevel10k, etc.)
    /^[❯›➜➤⟩»]\s+/,
    /^[$#%]\s+/,
]

/**
 * Patterns for continuation prompts (at the start of continuation lines)
 */
export const CONTINUATION_PATTERNS: RegExp[] = [
    // Bash heredoc and line continuation
    /^>\s*/,
    // Zsh continuation prompts
    /^(dquote|quote|bquote|pipe|cmdsubst|heredoc)>\s*/i,
    // Fish continuation
    /^\.\.\.\s*/,
    // PowerShell continuation
    /^>>\s*/,
    // Generic pipe/subshell continuation
    /^[|>]\s*/,
]

export interface PromptMatch {
    /** Index where the prompt terminator starts */
    index: number
    /** Length of the prompt terminator (including trailing space) */
    length: number
    /** The matched prompt string */
    match: string
}

/**
 * Detect the main prompt in a line of text.
 * Returns the position where the command would start (after the prompt).
 *
 * @param line The line text to analyze
 * @returns PromptMatch if a prompt is found, null otherwise
 */
export function detectMainPrompt (line: string): PromptMatch | null {
    for (const pattern of MAIN_PROMPT_PATTERNS) {
        const match = line.match(pattern)
        if (match && match.index !== undefined) {
            return {
                index: match.index,
                length: match[0].length,
                match: match[0],
            }
        }
    }
    return null
}

/**
 * Check if a line starts with a continuation prompt.
 *
 * @param line The line text to analyze
 * @returns true if this appears to be a continuation line
 */
export function isContinuationLine (line: string): boolean {
    const trimmed = line.trimStart()
    return CONTINUATION_PATTERNS.some(pattern => pattern.test(trimmed))
}

/**
 * Strip the continuation prompt from a line.
 *
 * @param line The line text to process
 * @returns The line without the continuation prompt prefix
 */
export function stripContinuationPrompt (line: string): string {
    for (const pattern of CONTINUATION_PATTERNS) {
        const match = line.match(pattern)
        if (match) {
            return line.substring(match[0].length)
        }
    }
    return line
}

/**
 * Get the length of the continuation prompt in a line.
 *
 * @param line The line text to analyze
 * @returns The length of the continuation prompt, or 0 if none found
 */
export function getContinuationPromptLength (line: string): number {
    for (const pattern of CONTINUATION_PATTERNS) {
        const match = line.match(pattern)
        if (match) {
            return match[0].length
        }
    }
    return 0
}

/**
 * Detect shell type from prompt pattern.
 */
export type ShellType = 'bash' | 'zsh' | 'fish' | 'powershell' | 'unknown'

/**
 * Try to detect the shell type from the prompt line.
 *
 * @param promptLine The line containing the prompt
 * @returns Detected shell type
 */
export function detectShellType (promptLine: string): ShellType {
    // Fish uses > or ❯
    if (/[❯›]/.test(promptLine)) {
        return 'fish'
    }

    // PowerShell typically has PS or >
    if (/^PS\s/.test(promptLine) || />\s*$/.test(promptLine)) {
        return 'powershell'
    }

    // Zsh often uses %
    if (/%\s*$/.test(promptLine)) {
        return 'zsh'
    }

    // Bash typically uses $
    if (/\$\s*$/.test(promptLine)) {
        return 'bash'
    }

    return 'unknown'
}
