#!/usr/bin/env bun

import {
  McpServer,
  ResourceTemplate,
} from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { join, dirname } from 'node:path';
import { existsSync, mkdirSync } from 'node:fs';
import { $ } from 'bun';
import { homedir } from 'node:os';

// Import version as a compile-time macro - executed at bundle-time, zero runtime overhead
import { getPackageVersion } from './macros.ts' with { type: 'macro' };
const VERSION = await getPackageVersion();

// Constants
const DEFAULT_SEARCH_LIMIT = 30;

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

// Nav.ts type definitions
type NavPage = {
  type: 'page';
  slug: string;
  title: string;
  disabled?: boolean;
  href?: string;
  description?: string;
};

type NavDivider = {
  type: 'divider';
  title: string;
};

type NavItem = NavPage | NavDivider;

type Nav = {
  items: NavItem[];
};

type PageInfo = {
  title: string;
  description: string;
  divider: string;
  disabled?: boolean;
  href?: string;
};

if (process.argv.includes('--version') || process.argv.includes('-v')) {
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
    console.error(`Downloading Bun documents for ${gitTag}`);
    await $`git clone --filter=blob:none --sparse --depth 1 --branch ${gitTag} ${repoUrl} ${tempDir}`.quiet();
    await $`cd ${tempDir} && git sparse-checkout set docs`.quiet();

    const sourceDir = join(tempDir, 'docs');
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
  const cacheDocsDir = join(
    homedir(),
    '.cache',
    'bun-doc-mcp',
    bunVersion,
    'docs'
  );

  // First check: if directory doesn't exist, download
  if (!existsSync(cacheDocsDir)) {
    await downloadDocsFromGitHub(bunVersion, cacheDocsDir);
  }

  // Second check: if nav.ts doesn't exist, delete and re-download
  const navPath = join(cacheDocsDir, 'nav.ts');
  if (!existsSync(navPath)) {
    console.error('nav.ts not found, re-downloading docs...');
    await $`rm -rf ${cacheDocsDir}`.quiet().catch(() => {});
    await downloadDocsFromGitHub(bunVersion, cacheDocsDir);

    // Final check: if nav.ts still doesn't exist, exit with error
    if (!existsSync(navPath)) {
      console.error(
        `Error: nav.ts not found in Bun ${bunVersion} documentation.`
      );
      console.error(
        'This may indicate an incompatible Bun version or repository structure change.'
      );
      process.exit(1);
    }
  }

  return cacheDocsDir;
}

const DOCS_DIR = await initializeDocsDir();

// Parse nav.ts to build page mapping
async function parseNavigation(): Promise<Map<string, PageInfo>> {
  const navPath = join(DOCS_DIR, 'nav.ts');
  const pageMap = new Map<string, PageInfo>();

  try {
    // Import the nav.ts file dynamically
    const navModule = await import(navPath);
    const nav: Nav = navModule.default;

    let currentDivider = '';

    for (const item of nav.items) {
      if (item.type === 'divider') {
        currentDivider = item.title;
      } else if (item.type === 'page') {
        pageMap.set(item.slug, {
          title: item.title,
          description: item.description || '',
          divider: currentDivider,
          disabled: item.disabled,
          href: item.href,
        });
      }
    }
  } catch (error) {
    console.error('Failed to parse nav.ts:', error);
  }

  return pageMap;
}

const PAGE_MAP = await parseNavigation();

// Helper functions

// Parse YAML frontmatter from markdown content
function parseFrontmatter(content: string): {
  name?: string;
  description?: string;
} {
  const lines = content.split('\n');
  if (lines[0] !== '---') return {};

  const frontmatter: Record<string, string> = {};
  let i = 1;
  while (i < lines.length && lines[i] !== '---') {
    const line = lines[i];
    if (line) {
      const match = line.match(/^(\w+):\s*(.*)$/);
      if (match && match[1] && match[2]) {
        frontmatter[match[1]] = match[2];
      }
    }
    i++;
  }

  return {
    name: frontmatter.name,
    description: frontmatter.description,
  };
}

// Get all guides subdirectories
async function getGuidesSubdirs(): Promise<string[]> {
  const guidesDir = join(DOCS_DIR, 'guides');
  if (!existsSync(guidesDir)) return [];

  const entries = await Bun.$`ls -d ${guidesDir}/*/`.text();
  return entries
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((path) => path.replace(guidesDir + '/', '').replace('/', ''));
}

// Get all ecosystem files
async function getEcosystemFiles(): Promise<string[]> {
  const ecosystemDir = join(DOCS_DIR, 'ecosystem');
  if (!existsSync(ecosystemDir)) return [];

  const entries = await Bun.$`ls ${ecosystemDir}/*.md`.text();
  return entries
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((path) => path.replace(ecosystemDir + '/', '').replace('.md', ''));
}

async function getAllPagesResources(): Promise<{ resources: Resource[] }> {
  const resources: Resource[] = [];

  // Add nav.ts pages
  for (const [slug, pageInfo] of PAGE_MAP) {
    // Skip disabled pages
    if (pageInfo.disabled) continue;

    const description =
      pageInfo.divider && pageInfo.description
        ? `${pageInfo.divider} / ${pageInfo.description}`
        : pageInfo.description || pageInfo.divider || '';

    resources.push({
      uri: `buncument://${slug}`,
      name: pageInfo.title,
      description: description,
      mimeType: 'text/markdown',
    });
  }

  // Add guides directory
  resources.push({
    uri: 'buncument://guides',
    name: 'Guides',
    description:
      'A collection of code samples and walkthroughs for performing common tasks with Bun.',
    mimeType: 'application/json',
  });

  // Add ecosystem files
  try {
    const ecosystemFiles = await getEcosystemFiles();
    for (const filename of ecosystemFiles) {
      const filePath = join(DOCS_DIR, 'ecosystem', `${filename}.md`);
      const file = Bun.file(filePath);
      const content = await file.text();
      const firstLine = content.split('\n')[0] || filename;

      resources.push({
        uri: `buncument://ecosystem/${filename}`,
        name: filename.charAt(0).toUpperCase() + filename.slice(1),
        description: firstLine.substring(0, 100),
        mimeType: 'text/markdown',
      });
    }
  } catch (error) {
    console.error('Failed to load ecosystem files:', error);
  }

  return { resources };
}

async function countMatches(
  filePath: string,
  pattern: RegExp
): Promise<number> {
  try {
    const file = Bun.file(filePath);
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

  // Search in nav.ts pages
  const slugsToSearch = Array.from(PAGE_MAP.keys());
  const filteredSlugs = searchPath
    ? slugsToSearch.filter((slug) => slug.startsWith(searchPath))
    : slugsToSearch;

  for (const slug of filteredSlugs) {
    const pageInfo = PAGE_MAP.get(slug);
    if (!pageInfo || pageInfo.disabled || pageInfo.href) {
      continue;
    }

    const filePath = join(DOCS_DIR, `${slug}.md`);
    if (!existsSync(filePath)) {
      continue;
    }

    const matchCount = await countMatches(filePath, regex);
    if (matchCount > 0) {
      results.push({
        uri: `buncument://${slug}`,
        matchCount,
      });
    }
  }

  // Search in guides if path matches or no path specified
  if (!searchPath || searchPath.startsWith('guides')) {
    const guidesDir = join(DOCS_DIR, 'guides');
    if (existsSync(guidesDir)) {
      const subdirs = await getGuidesSubdirs();

      for (const subdir of subdirs) {
        const subdirPath = join(guidesDir, subdir);
        const files = await Bun.$`ls ${subdirPath}/*.md`.text().catch(() => '');

        for (const filePath of files.trim().split('\n').filter(Boolean)) {
          const matchCount = await countMatches(filePath, regex);
          if (matchCount > 0) {
            const relativePath = filePath
              .replace(DOCS_DIR + '/', '')
              .replace('.md', '');
            results.push({
              uri: `buncument://${relativePath}`,
              matchCount,
            });
          }
        }
      }
    }
  }

  // Search in ecosystem if path matches or no path specified
  if (!searchPath || searchPath.startsWith('ecosystem')) {
    const ecosystemDir = join(DOCS_DIR, 'ecosystem');
    if (existsSync(ecosystemDir)) {
      const files = await Bun.$`ls ${ecosystemDir}/*.md`.text().catch(() => '');

      for (const filePath of files.trim().split('\n').filter(Boolean)) {
        const matchCount = await countMatches(filePath, regex);
        if (matchCount > 0) {
          const relativePath = filePath
            .replace(DOCS_DIR + '/', '')
            .replace('.md', '');
          results.push({
            uri: `buncument://${relativePath}`,
            matchCount,
          });
        }
      }
    }
  }

  return results.sort((a, b) => b.matchCount - a.matchCount).slice(0, limit);
}

// Get page count for description
const PAGE_COUNT = PAGE_MAP.size;

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

  // Handle root path - return all pages
  if (!path || path === '') {
    const contents = await getAllPagesResources();
    return {
      contents: [
        {
          uri: uri.toString(),
          mimeType: 'application/json',
          text: JSON.stringify(
            {
              path: '',
              entries: contents.resources,
            },
            null,
            2
          ),
        },
      ],
    };
  }

  // Handle guides directory
  if (path === 'guides') {
    const subdirs = await getGuidesSubdirs();
    const resources: Resource[] = [];

    for (const subdir of subdirs) {
      const indexPath = join(DOCS_DIR, 'guides', subdir, 'index.json');
      if (existsSync(indexPath)) {
        try {
          const indexFile = Bun.file(indexPath);
          const indexData = await indexFile.json();
          resources.push({
            uri: `buncument://guides/${subdir}`,
            name: indexData.name || subdir,
            description: indexData.description || '',
            mimeType: 'application/json',
          });
        } catch (error) {
          console.error(`Failed to read ${indexPath}:`, error);
        }
      }
    }

    return {
      contents: [
        {
          uri: uri.toString(),
          mimeType: 'application/json',
          text: JSON.stringify(
            {
              path: 'guides',
              entries: resources,
            },
            null,
            2
          ),
        },
      ],
    };
  }

  // Handle guides subdirectory
  if (path.startsWith('guides/')) {
    const parts = path.split('/');

    // Handle guides/subdir (list files in subdir)
    if (parts.length === 2 && parts[1]) {
      const subdir = parts[1];
      const subdirPath = join(DOCS_DIR, 'guides', subdir);

      if (!existsSync(subdirPath)) {
        return {
          contents: [
            {
              uri: uri.toString(),
              mimeType: 'text/plain',
              text: `[Directory not found: ${path}]`,
            },
          ],
        };
      }

      // Get all .md files in the subdirectory
      const files = await Bun.$`ls ${subdirPath}/*.md`.text().catch(() => '');
      const resources: Resource[] = [];

      for (const filePath of files.trim().split('\n').filter(Boolean)) {
        const filename = filePath
          .replace(subdirPath + '/', '')
          .replace('.md', '');
        const file = Bun.file(filePath);
        const content = await file.text();
        const frontmatter = parseFrontmatter(content);

        resources.push({
          uri: `buncument://guides/${subdir}/${filename}`,
          name: frontmatter.name || filename,
          description: frontmatter.description || '',
          mimeType: 'text/markdown',
        });
      }

      return {
        contents: [
          {
            uri: uri.toString(),
            mimeType: 'application/json',
            text: JSON.stringify(
              {
                path: path,
                entries: resources,
              },
              null,
              2
            ),
          },
        ],
      };
    }

    // Handle guides/subdir/file (return file content)
    if (parts.length === 3) {
      const filePath = join(DOCS_DIR, `${path}.md`);

      if (!existsSync(filePath)) {
        return {
          contents: [
            {
              uri: uri.toString(),
              mimeType: 'text/plain',
              text: `[File not found: ${path}.md]`,
            },
          ],
        };
      }

      const file = Bun.file(filePath);
      const content = await file.text();

      return {
        contents: [
          {
            uri: uri.toString(),
            mimeType: 'text/markdown',
            text: content,
          },
        ],
      };
    }
  }

  // Handle ecosystem files
  if (path.startsWith('ecosystem/')) {
    const filePath = join(DOCS_DIR, `${path}.md`);

    if (!existsSync(filePath)) {
      return {
        contents: [
          {
            uri: uri.toString(),
            mimeType: 'text/plain',
            text: `[File not found: ${path}.md]`,
          },
        ],
      };
    }

    const file = Bun.file(filePath);
    const content = await file.text();

    return {
      contents: [
        {
          uri: uri.toString(),
          mimeType: 'text/markdown',
          text: content,
        },
      ],
    };
  }

  // Handle specific page paths from nav.ts
  const pageInfo = PAGE_MAP.get(path);
  if (!pageInfo) {
    return {
      contents: [
        {
          uri: uri.toString(),
          mimeType: 'text/plain',
          text: `[Page not found: ${path}]`,
        },
      ],
    };
  }

  // Check if page is disabled
  if (pageInfo.disabled) {
    return {
      contents: [
        {
          uri: uri.toString(),
          mimeType: 'text/plain',
          text: `[Page disabled: ${pageInfo.title}]`,
        },
      ],
    };
  }

  // Check if page has external href
  if (pageInfo.href) {
    return {
      contents: [
        {
          uri: uri.toString(),
          mimeType: 'text/plain',
          text: `[External link: ${pageInfo.href}]`,
        },
      ],
    };
  }

  // Read the corresponding .md file
  const filePath = join(DOCS_DIR, `${path}.md`);

  try {
    const file = Bun.file(filePath);

    if (!existsSync(filePath)) {
      return {
        contents: [
          {
            uri: uri.toString(),
            mimeType: 'text/plain',
            text: `[File not found: ${path}.md]`,
          },
        ],
      };
    }

    const content = await file.text();
    return {
      contents: [
        {
          uri: uri.toString(),
          mimeType: 'text/markdown',
          text: content,
        },
      ],
    };
  } catch (error) {
    return {
      contents: [
        {
          uri: uri.toString(),
          mimeType: 'text/plain',
          text: `[File error: ${error instanceof Error ? error.message : 'Unknown error'}]`,
        },
      ],
    };
  }
}

const resourceTemplate = new ResourceTemplate('buncument://{+path}', {
  list: async () => {
    // Return all pages from nav.ts
    return await getAllPagesResources();
  },
});

server.registerResource(
  'bun-docs',
  resourceTemplate,
  {
    description: `Bun documentation with ${PAGE_COUNT} pages from nav.ts`,
    mimeType: 'application/json',
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

if (process.stdout.isTTY === true) {
  console.log(
    `Bun documents cached in ${DOCS_DIR}, please attach by a MCP client.`
  );
  process.exit(0);
}

const transport = new StdioServerTransport();
await server.connect(transport);
