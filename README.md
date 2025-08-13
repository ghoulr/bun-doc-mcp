# <img src="https://bun.com/logo.svg" height="20"> Bun Documentation MCP

A MCP server that provides [Bun](https://bun.com) documentation to AI assistants. This enables your AI to access up-to-date Bun documentation and provide accurate guidance on Bun APIs.

## ✨ Features

- **Version-matched documentation**: uses your local `node_modules/bun-types/docs/`, or syncs from GitHub based on your Bun version
- **Search functionality**: includes a grep tool with JavaScript regex support for searching documentation
- **Built with Bun**: for Bun
- **AI-friendly**: structured to provide relevant context to AI assistants

## 🚀 Quick Start

If you're already in a Bun project, you can try this prompt from bun project template first:
> Read the Bun API docs in `node_modules/bun-types/docs/**.md`.

For more reliable access and search capabilities, install this MCP server:

### 📦 Installation

**Claude Code:**
```bash
# Standard installation (uses your local Bun docs)
claude mcp add bun-doc-mcp bunx -- bun-doc-mcp

# GitHub-only mode (always fetch from upstream)
claude mcp add bun-doc-mcp bunx -- bun-doc-mcp --github-only
```

**Manual configuration:**
```json
{
  "mcpServers": {
    "bun-doc-mcp": {
      "type": "stdio",
      "command": "bunx",
      "args": ["bun-doc-mcp"], // or ["bun-doc-mcp", "--github-only"] if you want
      "env": {}
    }
  }
}
```

🎉 You're Ready! Happy coding with Bun! 🚀

### 🔧 Usage

Once installed, your AI assistant can:
- Access comprehensive Bun documentation
- Suggest appropriate Bun APIs over Node.js alternatives  
- Help with Bun-specific features and best practices
- Provide accurate answers based on current documentation
