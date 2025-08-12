# Bun Documentation MCP Server

This is a Model Context Protocol (MCP) server that provides access to Bun documentation through a file system-like interface.

## Project Overview

This MCP server acts as a file system proxy for the Bun documentation located in `node_modules/bun-types/docs/`. It allows AI assistants to browse and read Bun documentation progressively, reducing unnecessary information transfer.

## Architecture

- **Protocol**: MCP (Model Context Protocol)
- **Runtime**: Bun
- **Main file**: `index.ts`
- **Documentation source**: `node_modules/bun-types/docs/`

## Key Features

1. **Progressive Loading**: Only loads requested directories and files, not the entire documentation tree
2. **File System Interface**: Uses familiar URIs like `bun-doc://api/sqlite.md`
3. **Automatic MIME Type Detection**: Uses Bun's native `file.type` for accurate MIME types
4. **Directory Browsing**: Returns JSON-formatted directory listings
5. **Text File Support**: Reads and returns content of text files

## Technical Decisions

### URI Format
- Files keep their extensions: `bun-doc://quickstart.md`
- Directories have no special markers: `bun-doc://api`
- Follows standard file system conventions

### MIME Types
- Directories in listings: `inode/directory`
- Directory contents when read: `text/directory`
- Files: Detected automatically using `Bun.file().type`

### API Usage
- Uses `Bun.file()` for file operations and MIME detection
- Uses `node:fs` for directory operations (as recommended by Bun docs)
- Minimal dependencies - only MCP SDK required

## Development Guidelines

### Code Style
- Keep responses concise - this is a CLI tool
- No unnecessary comments in code
- Follow existing patterns in the codebase

### Performance
- Use Bun's native APIs where available
- Minimize system calls
- Lazy loading - don't read until requested

### Testing
Run the server locally:
```bash
bun run index.ts
```

## MCP Integration

This server implements:
- `ListResourcesRequestSchema`: Returns root directory contents
- `ReadResourceRequestSchema`: Returns file content or directory listing

## Future Improvements

Potential enhancements could include:
- Caching frequently accessed files
- Search functionality using Bun.glob
- Support for resource subscriptions
- Markdown parsing for better structured data

## Important Notes

- Always consult Bun documentation before making modifications
- Use pure Bun APIs whenever possible to complete tasks