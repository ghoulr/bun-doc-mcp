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
  description: string;
  mimeType: string;
}

function getMimeType(filePath: string): string {
  const file = Bun.file(filePath);
  return file.type || 'application/x-unknown';
}

function getRootResources(): DocResource[] {
  const resources: DocResource[] = [];

  // Check if docs directory exists
  if (!existsSync(DOCS_DIR)) {
    console.error(`Docs directory not found: ${DOCS_DIR}`);
    return resources;
  }

  try {
    const entries = readdirSync(DOCS_DIR, { withFileTypes: true });

    for (const entry of entries) {
      const name = entry.name;
      // Skip hidden files
      if (name.startsWith('.')) continue;

      if (entry.isDirectory()) {
        resources.push({
          uri: `bun-doc://${name}`,
          description: `Directory: ${name}`,
          mimeType: 'text/directory',
        });
      } else if (entry.isFile()) {
        const fullPath = join(DOCS_DIR, name);
        resources.push({
          uri: `bun-doc://${name}`,
          description: `File: ${name}`,
          mimeType: getMimeType(fullPath),
        });
      }
    }
  } catch (error) {
    console.error('Error reading docs directory:', error);
  }

  return resources;
}

function getDirectoryContents(dirPath: string): DocResource[] {
  const resources: DocResource[] = [];
  const fullPath = join(DOCS_DIR, dirPath);

  try {
    const entries = readdirSync(fullPath, { withFileTypes: true });

    for (const entry of entries) {
      const name = entry.name;
      // Skip hidden files
      if (name.startsWith('.')) continue;

      const subPath = dirPath ? `${dirPath}/${name}` : name;

      if (entry.isDirectory()) {
        resources.push({
          uri: `bun-doc://${subPath}`,
          description: `Directory: ${subPath}`,
          mimeType: 'text/directory',
        });
      } else if (entry.isFile()) {
        const filePath = join(fullPath, name);
        resources.push({
          uri: `bun-doc://${subPath}`,
          description: `File: ${subPath}`,
          mimeType: getMimeType(filePath),
        });
      }
    }
  } catch {
    // Directory doesn't exist or can't be read
  }

  return resources;
}

const server = new Server(
  {
    name: 'bun-doc-mcp',
    version: '1.0.0',
  },
  {
    capabilities: {
      resources: {},
    },
  }
);

// Initialize root resources
const rootResources = getRootResources();

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
      const contents = getDirectoryContents(path);
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
console.error(
  `Bun Doc MCP Server started - ${rootResources.length} root items available`
);
