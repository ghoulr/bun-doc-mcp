# Bun Documentation MCP Server

This is a Model Context Protocol (MCP) server that provides access to Bun documentation through a file system-like interface.

## Project Overview

This MCP server acts as a file system proxy for the Bun documentation located in `node_modules/bun-types/docs/`. It allows AI assistants to browse and read Bun documentation progressively, reducing unnecessary information transfer.

## Technical Decisions

### URI Format
- Files keep their extensions: `bun-doc://quickstart.md`
- Directories have no special markers: `bun-doc://api`
- Follows standard file system conventions

### MIME Types
- Directory typed as `text/directory`
- Files: Detected automatically using `Bun.file().type`

## Development Guidelines

### Code Style
- Keep responses concise - this is a CLI tool
- No unnecessary comments in code
- Follow existing patterns in the codebase

## Important Notes

- Always consult Bun documentation before making modifications
- Use pure Bun APIs whenever possible to complete tasks
- **MUST** use `bun run` instead of `npm run`
