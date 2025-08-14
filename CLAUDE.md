# Bun Documentation MCP Server

This is a Model Context Protocol (MCP) server that provides access to Bun documentation through a file system-like interface.

## Project Overview

This MCP server downloads Bun documentation from GitHub and provides access through a file system-like interface. It automatically caches documentation locally and allows AI assistants to browse and read Bun documentation progressively, reducing unnecessary information transfer.

## Technical Decisions

### Project Structure

- Single `index.ts` implementation
- Minimal dependencies: `@modelcontextprotocol/sdk` and `zod`

### URI Format

- Uses creative scheme name: `buncument://` (bun + document)
- Files keep their extensions: `buncument://quickstart.md`
- Directories have no special markers: `buncument://api`
- Follows standard file system conventions

### Documentation Source

- Downloads from GitHub using git sparse checkout for efficiency
- Automatically caches in `$HOME/.cache/bun-doc-mcp/{version}/docs`
- Uses `docs/nav.ts` to determine available pages and structure

### MIME Types

- Root directory: `application/json` with page listing
- Documentation files: `text/markdown`
- Error responses: `text/plain`

## Development Guidelines

### Code Style

- Keep responses concise - this is a CLI tool
- No unnecessary comments in code
- Follow existing patterns in the codebase

## Testing Guidelines

### MCP Server Testing

After making code changes that affect MCP functionality:

1. **User must restart MCP server** - ask user to restart
2. **Wait for restart confirmation** - Don't proceed until user confirms restart
3. **Test core functionality** using MCP tools:
   - Test search
   - Test resource reading
   - Test directory browsing

### Command-line Testing

Since the bash tool doesn't have TTY, use JSON-RPC protocol for testing:

```bash
# Test resource listing
echo '{"jsonrpc":"2.0","method":"resources/list","params":{},"id":1}' | bun run index.ts 2>/dev/null | jq '.result.resources | length'

# Test search functionality
echo '{"jsonrpc":"2.0","method":"tools/call","params":{"name":"grep_bun_docs","arguments":{"pattern":"WebSocket"}},"id":1}' | bun run index.ts 2>/dev/null | jq '.result.content[0].text'

# Test search with path filter
echo '{"jsonrpc":"2.0","method":"tools/call","params":{"name":"grep_bun_docs","arguments":{"pattern":"WebSocket","path":"api/"}},"id":1}' | bun run index.ts 2>/dev/null | jq '.result.content[0].text'

# Test resource reading
echo '{"jsonrpc":"2.0","method":"resources/read","params":{"uri":"buncument://api/websockets"},"id":1}' | bun run index.ts 2>/dev/null | jq -r '.result.contents[0].text' | head -20

# Check initialization output (use timeout to avoid hanging)
timeout 1s bun run index.ts 2>&1 | grep -E "\\[Indexing\\]|\\[Warning\\]"
```

## Important Notes

- Always consult Bun documentation before making modifications
- Use pure Bun APIs whenever possible to complete tasks
- **MUST** use `bun run` instead of `npm run`
