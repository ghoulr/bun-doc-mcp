#!/usr/bin/env bun

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { join, dirname } from 'node:path';
import { readdirSync, statSync, existsSync, mkdirSync } from 'node:fs';
import { $ } from 'bun';
import { homedir } from 'node:os';

const args = process.argv.slice(2);
const githubOnly = args.includes('--github-only');

async function downloadDocsFromGitHub(
  version: string,
  targetDir: string
): Promise<void> {
  const gitTag = `bun-v${version}`;
  const repoUrl = 'https://github.com/oven-sh/bun.git';
  const tempDir = join(dirname(targetDir), '.tmp-git');

  try {
    mkdirSync(dirname(targetDir), { recursive: true });

    await $`git init ${tempDir}`.quiet();
    await $`cd ${tempDir} && git remote add origin ${repoUrl}`.quiet();
    await $`cd ${tempDir} && git sparse-checkout init --cone`.quiet();
    await $`cd ${tempDir} && git sparse-checkout set docs packages/bun-types`.quiet();
    await $`cd ${tempDir} && git fetch --depth 1 origin ${gitTag}`.quiet();
    await $`cd ${tempDir} && git checkout FETCH_HEAD`.quiet();

    let sourceDir: string;
    if (existsSync(join(tempDir, 'docs'))) {
      sourceDir = join(tempDir, 'docs');
    } else if (existsSync(join(tempDir, 'packages', 'bun-types', 'docs'))) {
      sourceDir = join(tempDir, 'packages', 'bun-types', 'docs');
    } else {
      throw new Error(`Documentation not found in tag ${gitTag}`);
    }

    await $`mv ${sourceDir} ${targetDir}`.quiet();
    await $`rm -rf ${tempDir}`.quiet();
  } catch (error) {
    await $`rm -rf ${tempDir}`.quiet().catch(() => {});
    throw new Error(
      `Failed to download docs: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
  }
}

async function initializeDocsDir(): Promise<string> {
  const bunVersion = Bun.version;
  const localDocsDir = join(process.cwd(), 'node_modules', 'bun-types', 'docs');
  const cacheDocsDir = join(
    homedir(),
    '.cache',
    'bun-doc-mcp',
    bunVersion,
    'bun-types',
    'docs'
  );

  if (githubOnly) {
    if (!existsSync(cacheDocsDir)) {
      await downloadDocsFromGitHub(bunVersion, cacheDocsDir);
    }
    return cacheDocsDir;
  }

  if (existsSync(localDocsDir)) {
    return localDocsDir;
  }

  if (!existsSync(cacheDocsDir)) {
    await downloadDocsFromGitHub(bunVersion, cacheDocsDir);
  }

  return cacheDocsDir;
}

const DOCS_DIR = await initializeDocsDir();

interface DocResource {
  uri: string;
  name: string;
  description: string;
  mimeType: string;
}

interface GrepResult {
  uri: string;
  matchCount: number;
}

function getMimeType(filePath: string): string {
  const file = Bun.file(filePath);
  return file.type || 'application/x-unknown';
}

function normalizePath(path: string): string {
  if (!path) return '';

  // Remove leading and trailing slashes
  path = path.replace(/^\/+|\/+$/g, '');

  // Replace multiple slashes with single slash
  path = path.replace(/\/+/g, '/');

  return path;
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

      const resourcePath = normalizePath(
        relativePath ? `${relativePath}/${name}` : name
      );

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

function isTextFile(fileName: string): boolean {
  const textExtensions = ['.md', '.txt', '.js', '.ts', '.tsx'];
  return textExtensions.some((ext) => fileName.toLowerCase().endsWith(ext));
}

async function countMatches(
  filePath: string,
  pattern: RegExp
): Promise<number> {
  try {
    const file = Bun.file(filePath);
    if (file.size > 100 * 1024) return 0;

    const content = await file.text();
    const matches = content.match(pattern);
    return matches ? matches.length : 0;
  } catch {
    return 0;
  }
}

async function grepDocuments(
  pattern: string,
  searchPath: string = '',
  limit: number = 30
): Promise<GrepResult[]> {
  const results: GrepResult[] = [];

  let regex: RegExp;
  try {
    regex = new RegExp(pattern, 'g');
  } catch {
    throw new Error(`Invalid regular expression: ${pattern}`);
  }

  // Normalize search path
  const normalizedSearchPath = normalizePath(searchPath);
  const fullPath = normalizedSearchPath
    ? join(DOCS_DIR, normalizedSearchPath)
    : DOCS_DIR;

  if (!existsSync(fullPath)) {
    return results;
  }

  async function searchDirectory(dirPath: string, relativePath: string = '') {
    try {
      const entries = readdirSync(dirPath, { withFileTypes: true });

      for (const entry of entries) {
        if (entry.name.startsWith('.')) continue;

        const entryPath = join(dirPath, entry.name);
        const entryRelativePath = normalizePath(
          relativePath ? `${relativePath}/${entry.name}` : entry.name
        );

        if (entry.isDirectory()) {
          await searchDirectory(entryPath, entryRelativePath);
        } else if (entry.isFile() && isTextFile(entry.name)) {
          const matchCount = await countMatches(entryPath, regex);
          if (matchCount > 0) {
            results.push({
              uri: `bun-doc://${entryRelativePath}`,
              matchCount,
            });
          }
        }
      }
    } catch {
      // Skip unreadable directories
    }
  }

  const stat = statSync(fullPath);
  if (stat.isDirectory()) {
    await searchDirectory(fullPath, normalizedSearchPath);
  } else if (stat.isFile() && isTextFile(fullPath)) {
    const matchCount = await countMatches(fullPath, regex);
    if (matchCount > 0) {
      results.push({
        uri: `bun-doc://${normalizedSearchPath}`,
        matchCount,
      });
    }
  }

  return results.sort((a, b) => b.matchCount - a.matchCount).slice(0, limit);
}

// Load resources after DOCS_DIR is initialized
const rootResources = await scanDirectory();

const INSTRUCTIONS = `This MCP server provides access to Bun documentation.

## How to use:
- Browse the documentation tree starting from the root
- Each .md file shows its first line content as description (usually the title or main topic)
- Read any documentation file to get full content
- Use the grep_docs tool to search through documentation content

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
- Use grep_docs to quickly find relevant documentation before reading specific files
- Check 'api/' directory for specific Bun APIs
- Look in 'guides/' for practical examples and tutorials`;

const GREP_DOCS_DESCRIPTION = `Search through Bun documentation using JavaScript regular expressions.
Returns: Array of objects with uri and matchCount, sorted by relevance.

Examples:
- Search for WebSocket: pattern: 'WebSocket'
- Find SQLite APIs: pattern: 'sqlite', path: 'api/'
- Complex patterns: pattern: 'Bun\\\\.(serve|file)'`;

const server = new Server(
  {
    name: 'bun-doc-mcp',
    version: '1.0.0',
  },
  {
    capabilities: {
      resources: {},
      tools: {},
    },
    instructions: INSTRUCTIONS,
  }
);

server.setRequestHandler(ListResourcesRequestSchema, async () => {
  return {
    resources: rootResources,
  };
});

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: 'grep_docs',
        description: GREP_DOCS_DESCRIPTION,
        inputSchema: {
          type: 'object',
          properties: {
            pattern: {
              type: 'string',
              description: 'JavaScript regex pattern to search for',
            },
            path: {
              type: 'string',
              description:
                "Optional path to search in (e.g., 'api/' or 'guides/')",
            },
            limit: {
              type: 'number',
              description: 'Maximum number of results to return (default: 30)',
            },
          },
          required: ['pattern'],
        },
      },
    ],
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

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  if (name !== 'grep_docs') {
    throw new Error(`Unknown tool: ${name}`);
  }

  const { pattern, path, limit } = args as {
    pattern: string;
    path?: string;
    limit?: number;
  };

  if (!pattern) {
    throw new Error('Pattern parameter is required');
  }

  try {
    const results = await grepDocuments(pattern, path, limit);
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(results, null, 2),
        },
      ],
    };
  } catch (error) {
    throw new Error(
      `Grep error: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
