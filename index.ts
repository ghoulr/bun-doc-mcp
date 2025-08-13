#!/usr/bin/env bun

import {
  McpServer,
  ResourceTemplate,
} from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { join, dirname } from 'node:path';
import { readdirSync, statSync, existsSync, mkdirSync } from 'node:fs';
import { $ } from 'bun';
import { homedir } from 'node:os';

// Import version as a compile-time macro - executed at bundle-time, zero runtime overhead
import { getPackageVersion } from './macros.ts' with { type: 'macro' };
const VERSION = await getPackageVersion();

// Constants
const MAX_FILE_SIZE = 100 * 1024; // 100KB
const PREVIEW_SIZE = 500; // bytes
const DEFAULT_SEARCH_LIMIT = 30;
const TEXT_EXTENSIONS = new Set(['.md', '.txt', '.js', '.ts', '.tsx']);

// Type definitions
type Resource = {
  uri: string;
  name: string;
  description: string;
  mimeType: string;
};

type SearchResult = {
  uri: string;
  matchCount: number;
};

const args = process.argv.slice(2);
const githubOnly = args.includes('--github-only');

if (args.includes('--version') || args.includes('-v')) {
  console.log(VERSION);
  process.exit(0);
}

async function downloadDocsFromGitHub(
  version: string,
  targetDir: string
): Promise<void> {
  const gitTag = `bun-v${version}`;
  const repoUrl = 'https://github.com/oven-sh/bun.git';
  const tempDir = join(dirname(targetDir), '.tmp-git');

  const cleanupTemp = async () => {
    try {
      await $`rm -rf ${tempDir}`.quiet();
    } catch {
      // Ignore cleanup errors
    }
  };

  try {
    mkdirSync(dirname(targetDir), { recursive: true });

    await cleanupTemp();
    await $`git clone --filter=blob:none --sparse --depth 1 --branch ${gitTag} ${repoUrl} ${tempDir}`.quiet();
    await $`cd ${tempDir} && git sparse-checkout set packages/bun-types/docs`.quiet();

    const sourceDir = join(tempDir, 'packages', 'bun-types', 'docs');
    if (!existsSync(sourceDir)) {
      throw new Error(`Documentation not found in tag ${gitTag}`);
    }

    await $`rm -rf ${targetDir}`.quiet().catch(() => {});
    await $`mv ${sourceDir} ${targetDir}`.quiet();
  } catch (error) {
    throw new Error(
      `Failed to download docs: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
  } finally {
    await cleanupTemp();
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

// Helper functions
function normalizePath(path: string): string {
  if (!path) return '';
  return path.replace(/^\/+|\/+$/g, '').replace(/\/+/g, '/');
}

function getFullPath(relativePath: string): string {
  return relativePath ? join(DOCS_DIR, relativePath) : DOCS_DIR;
}

function isTextFile(fileName: string): boolean {
  const lastDot = fileName.lastIndexOf('.');
  if (lastDot === -1) return false;
  const ext = fileName.substring(lastDot).toLowerCase();
  return TEXT_EXTENSIONS.has(ext);
}

async function getFileDescription(
  filePath: string,
  fileName: string
): Promise<string> {
  const defaultDescription = `File: ${fileName}`;

  if (!fileName.endsWith('.md')) {
    return defaultDescription;
  }

  try {
    const file = Bun.file(filePath);
    const partial = file.slice(0, PREVIEW_SIZE);
    const text = await partial.text();

    const firstLine = text.split('\n').find((line) => line.trim());
    return firstLine
      ? firstLine.trim().replace(/^#+\s*/, '')
      : defaultDescription;
  } catch {
    return defaultDescription;
  }
}

async function scanDirectory(
  relativePath: string = ''
): Promise<{ resources: Resource[] }> {
  const resources: Resource[] = [];
  const fullPath = getFullPath(relativePath);

  if (!existsSync(fullPath)) {
    return { resources };
  }

  try {
    const entries = readdirSync(fullPath, { withFileTypes: true });

    for (const entry of entries) {
      const name = entry.name;
      if (name.startsWith('.')) continue;

      const resourcePath = normalizePath(
        relativePath ? `${relativePath}/${name}` : name
      );

      if (entry.isDirectory()) {
        resources.push({
          uri: `buncument://${resourcePath}`,
          name: name,
          description: '',
          mimeType: 'text/directory',
        });
      } else if (entry.isFile()) {
        const filePath = join(fullPath, name);
        resources.push({
          uri: `buncument://${resourcePath}`,
          name: name,
          description: await getFileDescription(filePath, name),
          mimeType: Bun.file(filePath).type || 'application/x-unknown',
        });
      }
    }
  } catch {
    // Skip errors for now
  }

  return { resources };
}

async function countMatches(
  filePath: string,
  pattern: RegExp
): Promise<number> {
  try {
    const file = Bun.file(filePath);
    if (file.size > MAX_FILE_SIZE) return 0;

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
  limit: number = DEFAULT_SEARCH_LIMIT
): Promise<SearchResult[]> {
  const results: SearchResult[] = [];

  let regex: RegExp;
  try {
    regex = new RegExp(pattern, 'g');
  } catch {
    throw new Error(`Invalid regular expression: ${pattern}`);
  }

  const normalizedSearchPath = normalizePath(searchPath);
  const fullPath = getFullPath(normalizedSearchPath);

  if (!existsSync(fullPath)) {
    return results;
  }

  async function processFile(filePath: string, relativePath: string) {
    const matchCount = await countMatches(filePath, regex);
    if (matchCount > 0) {
      results.push({
        uri: `buncument://${relativePath}`,
        matchCount,
      });
    }
  }

  async function searchDirectory(dirPath: string, relativePath: string = '') {
    try {
      const entries = readdirSync(dirPath, { withFileTypes: true });

      for (const entry of entries) {
        if (entry.name.startsWith('.')) continue;

        const entryPath = join(dirPath, entry.name);
        const entryRelativePath = relativePath
          ? normalizePath(`${relativePath}/${entry.name}`)
          : entry.name;

        if (entry.isDirectory()) {
          await searchDirectory(entryPath, entryRelativePath);
        } else if (entry.isFile() && isTextFile(entry.name)) {
          await processFile(entryPath, entryRelativePath);
        }
      }
    } catch {
      // Skip unreadable directories
    }
  }

  const stat = statSync(fullPath);
  if (stat.isDirectory()) {
    await searchDirectory(fullPath, normalizedSearchPath);
  } else if (
    stat.isFile() &&
    isTextFile(normalizedSearchPath.split('/').pop() || '')
  ) {
    await processFile(fullPath, normalizedSearchPath);
  }

  return results.sort((a, b) => b.matchCount - a.matchCount).slice(0, limit);
}

// Initialize root directories after scanDirectory is defined
const rootScan = await scanDirectory();
const ROOT_DIRECTORIES = rootScan.resources
  .filter((resource) => resource.mimeType === 'text/directory')
  .map((resource) => resource.name)
  .sort();

const server = new McpServer(
  {
    name: 'bun-doc-mcp',
    version: VERSION,
  },
  {
    capabilities: {
      resources: {},
      tools: {},
    },
    instructions: `This MCP server provides access to Bun documentation.

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
- Look in 'guides/' for practical examples and tutorials

## Search Strategy:
- If grep_docs doesn't find what you need, browse the resources
- Start from root to understand the documentation organization
- Key directories: 'api/' (APIs), 'bundler/' (build tools, macros), 'guides/' (examples), 'runtime/' (runtime features)`,
  }
);

async function handleResourceRequest(
  uri: URL,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  variables: Record<string, string | string[]>
) {
  // Extract path from URI: hostname + pathname
  // e.g., buncument://api/websockets.md -> api/websockets.md
  let path = uri.hostname + uri.pathname;

  // Remove leading slash from pathname if present
  if (path.startsWith('/')) {
    path = path.slice(1);
  }

  const fullPath = getFullPath(path);

  try {
    const stat = statSync(fullPath);

    if (stat.isDirectory()) {
      const contents = await scanDirectory(path);
      return {
        contents: [
          {
            uri: uri.toString(),
            mimeType: 'text/directory',
            text: JSON.stringify(
              {
                path: path,
                entries: contents.resources,
              },
              null,
              2
            ),
          },
        ],
      };
    } else {
      const file = Bun.file(fullPath);

      if (file.size > MAX_FILE_SIZE) {
        return {
          contents: [
            {
              uri: uri.toString(),
              mimeType: 'text/plain',
              text: `[File too large: ${(file.size / 1024).toFixed(2)}KB]`,
            },
          ],
        };
      }

      const content = await file.text();
      return {
        contents: [
          {
            uri: uri.toString(),
            mimeType: file.type || 'application/x-unknown',
            text: content,
          },
        ],
      };
    }
  } catch (error) {
    return {
      contents: [
        {
          uri: uri.toString(),
          mimeType: 'text/plain',
          text: `[Resource error: ${error instanceof Error ? error.message : 'Resource not found'}]`,
        },
      ],
    };
  }
}

const resourceTemplate = new ResourceTemplate('buncument://{+path}', {
  list: async () => {
    // List callback doesn't receive variables, only return root directory
    return await scanDirectory();
  },
});

server.registerResource(
  'bun-docs',
  resourceTemplate,
  {
    description: `Bun documentation directories: ${ROOT_DIRECTORIES.join(', ')}`,
    mimeType: 'text/directory',
  },
  handleResourceRequest
);

server.registerTool(
  'grep_bun_docs',
  {
    description: `Search through Bun documentation using JavaScript regular expressions.
Returns: Array of objects with uri and matchCount, sorted by relevance.

Examples:
- Search for WebSocket: pattern: 'WebSocket'
- Find SQLite APIs: pattern: 'sqlite', path: 'api/'
- Complex patterns: pattern: 'Bun\\\\.(serve|file)'`,
    inputSchema: {
      pattern: z.string().describe('JavaScript regex pattern to search for'),
      path: z
        .string()
        .optional()
        .describe("Optional path to search in (e.g., 'api/' or 'guides/')"),
      limit: z
        .number()
        .optional()
        .describe(
          `Maximum number of results to return (default: ${DEFAULT_SEARCH_LIMIT})`
        ),
    },
  },
  async ({ pattern, path, limit = DEFAULT_SEARCH_LIMIT }) => {
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
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
