#!/usr/bin/env bun

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { join } from 'node:path';
import { readdirSync, statSync, existsSync } from 'node:fs';

const DOCS_DIR = join(process.cwd(), 'node_modules', 'bun-types', 'docs');

interface DocResource {
  uri: string;
  name: string;
  description: string;
  mimeType: string;
}

function getMimeType(filePath: string): string {
  const file = Bun.file(filePath);
  return file.type || 'application/x-unknown';
}

async function getFileDescription(
  filePath: string,
  fileName: string
): Promise<string> {
  // For .md files, try to get first line as description
  if (fileName.endsWith('.md')) {
    try {
      const file = Bun.file(filePath);
      // Use slice to read only first 500 bytes
      const partial = file.slice(0, 500);
      const text = await partial.text();

      const lines = text.split('\n');
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed) {
          // Remove markdown headers if present
          return trimmed.replace(/^#+\s*/, '');
        }
      }
      return `File: ${fileName}`;
    } catch {
      return `File: ${fileName}`;
    }
  }

  // For other files, use the current format
  return `File: ${fileName}`;
}

async function scanDirectory(
  relativePath: string = ''
): Promise<DocResource[]> {
  const resources: DocResource[] = [];
  const fullPath = relativePath ? join(DOCS_DIR, relativePath) : DOCS_DIR;

  // Check if directory exists
  if (!existsSync(fullPath)) {
    if (!relativePath) {
      console.error(`Docs directory not found: ${fullPath}`);
    }
    return resources;
  }

  try {
    const entries = readdirSync(fullPath, { withFileTypes: true });

    for (const entry of entries) {
      const name = entry.name;
      // Skip hidden files
      if (name.startsWith('.')) continue;

      const resourcePath = relativePath ? `${relativePath}/${name}` : name;

      if (entry.isDirectory()) {
        resources.push({
          uri: `bun-doc://${resourcePath}`,
          name: name,
          description: '',
          mimeType: 'text/directory',
        });
      } else if (entry.isFile()) {
        const filePath = join(fullPath, name);
        resources.push({
          uri: `bun-doc://${resourcePath}`,
          name: name,
          description: await getFileDescription(filePath, name),
          mimeType: getMimeType(filePath),
        });
      }
    }
  } catch (error) {
    if (!relativePath) {
      console.error('Error reading docs directory:', error);
    }
  }

  return resources;
}

// Load resources first
const rootResources = await scanDirectory();

// Generate dynamic instructions based on available directories
function generateInstructions(): string {
  return `This MCP server provides access to Bun documentation.

## How to use:
- Browse the documentation tree starting from the root
- Each .md file shows its first line content as description (usually the title or main topic)
- Read any documentation file to get full content

## APIs

- \`Bun.serve()\` supports WebSockets, HTTPS, and routes. Don't use \`express\`.
- \`bun:sqlite\` for SQLite. Don't use \`better-sqlite3\`.
- \`Bun.redis\` for Redis. Don't use \`ioredis\`.
- \`Bun.sql\` for Postgres. Don't use \`pg\` or \`postgres.js\`.
- \`WebSocket\` is built-in. Don't use \`ws\`.
- Prefer \`Bun.file\` over \`node:fs\`'s readFile/writeFile
- Bun.$\`ls\` instead of execa.

## Tips:
- **ALWAYS** read the documents to find if bun have a better version before you start use any node API
- Start with 'quickstart.md' for a quick introduction
- Check 'api/' directory for specific Bun APIs
- Look in 'guides/' for practical examples and tutorials`;
}

const instructions = generateInstructions();

const server = new Server(
  {
    name: 'bun-doc-mcp',
    version: '1.0.0',
  },
  {
    capabilities: {
      resources: {},
    },
    instructions: instructions,
  }
);

server.setRequestHandler(ListResourcesRequestSchema, async () => {
  return {
    resources: rootResources,
  };
});

server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  const { uri } = request.params;

  // Remove protocol prefix
  const path = uri.replace('bun-doc://', '');
  const fullPath = join(DOCS_DIR, path);

  // Check if path exists and what type it is
  try {
    const stat = statSync(fullPath);

    if (stat.isDirectory()) {
      // Handle directory
      const contents = await scanDirectory(path);
      return {
        contents: [
          {
            uri,
            mimeType: 'text/directory',
            text: JSON.stringify(
              {
                path: path,
                entries: contents,
              },
              null,
              2
            ),
          },
        ],
      };
    } else {
      // Handle file
      const file = Bun.file(fullPath);

      // Check file size (100KB limit for docs)
      if (file.size > 100 * 1024) {
        return {
          contents: [
            {
              uri,
              mimeType: 'text/plain',
              text: `[File too large: ${(file.size / 1024).toFixed(2)}KB]`,
            },
          ],
        };
      }

      const mimeType = file.type || 'application/x-unknown';

      // Try to read as text
      try {
        const content = await file.text();
        return {
          contents: [
            {
              uri,
              mimeType: mimeType,
              text: content,
            },
          ],
        };
      } catch (error) {
        // Cannot read as text
        return {
          contents: [
            {
              uri,
              mimeType: 'text/plain',
              text: `[Cannot read file: ${error instanceof Error ? error.message : 'Unknown error'}]`,
            },
          ],
        };
      }
    }
  } catch (error) {
    // Path doesn't exist or other IO error
    return {
      contents: [
        {
          uri,
          mimeType: 'text/plain',
          text: `[Resource error: ${error instanceof Error ? error.message : 'Resource not found'}]`,
        },
      ],
    };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
