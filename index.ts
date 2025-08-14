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

import { getPackageVersion } from './macros.ts' with { type: 'macro' };
const VERSION = await getPackageVersion();

const DEFAULT_SEARCH_LIMIT = 30;

type Resource = {
  uri: string;
  name: string;
  description: string;
  mimeType: string;
};

type IndexedResource = Resource & {
  filePath?: string;
  isDirectory?: boolean;
};

type SearchResult = {
  uri: string;
  matchCount: number;
};

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

function print(s: string): boolean {
  if (process.stdout.isTTY === true) {
    console.log(s);
    return true;
  }
  return false;
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

// Global resource index
const RESOURCE_INDEX = new Map<string, IndexedResource>();
let TOTAL_RESOURCE_COUNT = 0;

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

async function buildResourceIndex(): Promise<void> {
  let navIndexed = 0;
  let navMissing = 0;
  for (const [slug, pageInfo] of PAGE_MAP.entries()) {
    if (pageInfo.disabled || pageInfo.href) {
      continue;
    }

    let filePath = join(DOCS_DIR, `${slug}.md`);
    if (!existsSync(filePath)) {
      const indexPath = join(DOCS_DIR, slug, 'index.md');
      if (existsSync(indexPath)) {
        filePath = indexPath;
      } else {
        navMissing++;
        continue;
      }
    }

    const description =
      pageInfo.divider && pageInfo.description
        ? `${pageInfo.divider} / ${pageInfo.description}`
        : pageInfo.description || pageInfo.divider || '';

    RESOURCE_INDEX.set(`buncument://${slug}`, {
      uri: `buncument://${slug}`,
      name: pageInfo.title,
      description: description,
      mimeType: 'text/markdown',
      filePath: filePath,
    });
    navIndexed++;
  }
  print(
    `Indexed ${navIndexed} nav pages${navMissing > 0 ? ` (${navMissing} missing)` : ''}`
  );

  const guidesDir = join(DOCS_DIR, 'guides');
  let guidesIndexed = 0;
  if (existsSync(guidesDir)) {
    RESOURCE_INDEX.set('buncument://guides', {
      uri: 'buncument://guides',
      name: 'Guides',
      description:
        'A collection of code samples and walkthroughs for performing common tasks with Bun.',
      mimeType: 'application/json',
      isDirectory: true,
    });

    const allFiles =
      await Bun.$`find ${guidesDir} -type f -name "*.md" 2>/dev/null`
        .text()
        .catch(() => '');
    for (const filePath of allFiles.trim().split('\n').filter(Boolean)) {
      const relativePath = filePath
        .replace(DOCS_DIR + '/', '')
        .replace('.md', '');
      const file = Bun.file(filePath);
      const content = await file.text();
      const frontmatter = parseFrontmatter(content);
      const filename = filePath.split('/').pop()?.replace('.md', '') || '';
      const firstLine = content.split('\n')[0] || '';

      RESOURCE_INDEX.set(`buncument://${relativePath}`, {
        uri: `buncument://${relativePath}`,
        name: frontmatter.name || filename,
        description:
          frontmatter.description || firstLine.substring(0, 100) || '',
        mimeType: 'text/markdown',
        filePath: filePath,
      });
      guidesIndexed++;
    }

    const subdirs =
      await Bun.$`find ${guidesDir} -mindepth 1 -type d 2>/dev/null`
        .text()
        .catch(() => '');
    for (const dirPath of subdirs.trim().split('\n').filter(Boolean)) {
      const relativePath = dirPath.replace(DOCS_DIR + '/', '');
      const pathParts = dirPath.split('/');
      const dirname = pathParts[pathParts.length - 1] || '';
      const indexPath = join(dirPath, 'index.json');
      let dirName = dirname;
      let dirDescription = 'Directory';

      if (existsSync(indexPath)) {
        try {
          const indexFile = Bun.file(indexPath);
          const indexData = await indexFile.json();
          dirName = indexData.name || dirname;
          dirDescription = indexData.description || 'Directory';
        } catch {
          // Use default values if index.json cannot be read
        }
      }

      RESOURCE_INDEX.set(`buncument://${relativePath}`, {
        uri: `buncument://${relativePath}`,
        name: dirName,
        description: dirDescription,
        mimeType: 'application/json',
        isDirectory: true,
      });
    }
  }
  print(`Indexed ${guidesIndexed} guides files`);

  const ecosystemDir = join(DOCS_DIR, 'ecosystem');
  let ecosystemIndexed = 0;
  if (existsSync(ecosystemDir)) {
    const allFiles =
      await Bun.$`find ${ecosystemDir} -type f -name "*.md" 2>/dev/null`
        .text()
        .catch(() => '');
    for (const filePath of allFiles.trim().split('\n').filter(Boolean)) {
      const relativePath = filePath
        .replace(DOCS_DIR + '/', '')
        .replace('.md', '');
      const filename = filePath.split('/').pop()?.replace('.md', '') || '';
      const file = Bun.file(filePath);
      const content = await file.text();
      const firstLine = content.split('\n')[0] || filename;

      RESOURCE_INDEX.set(`buncument://${relativePath}`, {
        uri: `buncument://${relativePath}`,
        name: filename.charAt(0).toUpperCase() + filename.slice(1),
        description: firstLine.substring(0, 100),
        mimeType: 'text/markdown',
        filePath: filePath,
      });
      ecosystemIndexed++;
    }
  }
  print(`Indexed ${ecosystemIndexed} ecosystem files`);

  TOTAL_RESOURCE_COUNT = RESOURCE_INDEX.size;
  print(`Total indexed resources: ${TOTAL_RESOURCE_COUNT}`);
}

await buildResourceIndex();
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

function getAllPagesResources(): { resources: Resource[] } {
  const resources: Resource[] = [];

  for (const [uri, resource] of RESOURCE_INDEX.entries()) {
    const path = uri.replace('buncument://', '');

    // Include: nav pages, guides directory, top-level ecosystem files
    // Exclude: guides subdirectories and files
    if (
      path === 'guides' ||
      (!path.startsWith('guides/') &&
        (path.startsWith('ecosystem/')
          ? path.split('/').length === 2
          : !resource.isDirectory))
    ) {
      resources.push({
        uri: resource.uri,
        name: resource.name,
        description: resource.description,
        mimeType: resource.mimeType,
      });
    }
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

  for (const [uri, resource] of RESOURCE_INDEX.entries()) {
    if (resource.isDirectory || !resource.filePath) {
      continue;
    }

    if (searchPath) {
      const resourcePath = uri.replace('buncument://', '');
      if (!resourcePath.startsWith(searchPath)) {
        continue;
      }
    }

    const matchCount = await countMatches(resource.filePath, regex);
    if (matchCount > 0) {
      results.push({
        uri: resource.uri,
        matchCount,
      });
    }
  }

  return results.sort((a, b) => b.matchCount - a.matchCount).slice(0, limit);
}

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

async function handleResourceRequest(uri: URL) {
  let path = uri.hostname + uri.pathname;
  if (path.startsWith('/')) {
    path = path.slice(1);
  }

  if (!path || path === '') {
    const contents = getAllPagesResources();
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

  const resourceUri = `buncument://${path}`;
  const indexedResource = RESOURCE_INDEX.get(resourceUri);

  if (!indexedResource) {
    return {
      contents: [
        {
          uri: uri.toString(),
          mimeType: 'text/plain',
          text: `[Resource not found: ${path}]`,
        },
      ],
    };
  }

  if (indexedResource.isDirectory) {
    const resources: Resource[] = [];
    const pathPrefix = `buncument://${path}/`;

    for (const [childUri, childResource] of RESOURCE_INDEX.entries()) {
      if (childUri.startsWith(pathPrefix)) {
        const relativePath = childUri.replace(pathPrefix, '');
        if (!relativePath.includes('/')) {
          resources.push({
            uri: childResource.uri,
            name: childResource.name,
            description: childResource.description,
            mimeType: childResource.mimeType,
          });
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

  if (indexedResource.filePath) {
    try {
      const file = Bun.file(indexedResource.filePath);
      const content = await file.text();
      return {
        contents: [
          {
            uri: uri.toString(),
            mimeType: indexedResource.mimeType,
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

  return {
    contents: [
      {
        uri: uri.toString(),
        mimeType: 'text/plain',
        text: `[No file path for resource: ${path}]`,
      },
    ],
  };
}

const resourceTemplate = new ResourceTemplate('buncument://{+path}', {
  list: () => getAllPagesResources(),
});

server.registerResource(
  'bun-docs',
  resourceTemplate,
  {
    description: `Bun documentation with ${TOTAL_RESOURCE_COUNT} indexed resources`,
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

if (
  print(`Bun documents cached in ${DOCS_DIR}, please attach by a MCP client.`)
) {
  process.exit(0);
}

const transport = new StdioServerTransport();
await server.connect(transport);
