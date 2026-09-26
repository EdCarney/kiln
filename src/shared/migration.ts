// The words about the move from Kiln (#60), kept out of the rename, which must never touch the old name.

/** After the move from Kiln: what needs entering again. */
export interface MigrationNoticeView {
  apiKey: boolean
  /** MCP servers whose environment values need entering again, by name. */
  servers: string[]
}

export const NOTICE_TITLE = 'Kiln is now Ollmost.'
export const NOTICE_BODY = 'Your chats, projects, files and settings came along.'
export const NOTICE_API_KEY = "Your ollama.com API key didn't: it was locked to Kiln in your keychain. Enter it again in Settings."
export const noticeServers = (names: string[]): string =>
  `${names.length === 1 ? '1 MCP server needs its' : `${names.length} MCP servers need their`} environment values again: ${names.join(', ')}.`
