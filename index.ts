#!/usr/bin/env bun

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { Glob } from 'bun';
import { join, relative } from 'node:path';

const DOCS_DIR = join(process.cwd(), 'node_modules', 'bun-types', 'docs');

async function scanDocs(): Promise<
  Array<{ uri: string; name: string; description: string; path: string }>
> {
  const glob = new Glob('**/*.md');
  const resources: Array<{
    uri: string;
    name: string;
    description: string;
    path: string;
  }> = [];

  for await (const file of glob.scan({ cwd: DOCS_DIR, absolute: true })) {
    const relativePath = relative(DOCS_DIR, file);
    const pathWithoutExt = relativePath.replace(/\.md$/, '');
    const uri = `bun-doc://${pathWithoutExt}`;
    const parts = pathWithoutExt.split('/');

    resources.push({
      uri,
      name: pathWithoutExt,
      description: `Bun documentation: ${parts.join(' > ')}`,
      path: file,
    });
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
      tools: {},
    },
  }
);

const resources = await scanDocs();

server.setRequestHandler(ListResourcesRequestSchema, async () => {
  return {
    resources: resources.map(({ uri, name, description }) => ({
      uri,
      name,
      description,
      mimeType: 'text/markdown',
    })),
  };
});

server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  const resource = resources.find((r) => r.uri === request.params.uri);

  if (!resource) {
    throw new Error(`Resource not found: ${request.params.uri}`);
  }

  const content = await Bun.file(resource.path).text();

  return {
    contents: [
      {
        uri: resource.uri,
        mimeType: 'text/markdown',
        text: content,
      },
    ],
  };
});

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: 'get_docs_path',
        description:
          'Returns the absolute path of the Bun documentation folder',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },
    ],
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name !== 'get_docs_path') {
    throw new Error(`Unknown tool: ${request.params.name}`);
  }

  return {
    content: [
      {
        type: 'text',
        text: DOCS_DIR,
      },
    ],
  };
});

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(
  `Bun Doc MCP Server started - ${resources.length} documents available`
);
