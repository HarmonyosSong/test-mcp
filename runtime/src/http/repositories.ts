import { Hono } from 'hono';

import {
  RepositoryAlreadyExistsError,
  RepositoryCapability,
  RepositoryGitError,
  RepositoryNotFoundError,
} from '../capabilities/repository.js';
import { RegisterRepositoryRequestSchema } from '../domain/schemas.js';
import { ProductNotFoundError, ProductStore } from '../product/store.js';

function errorResponse(message: string, status: 404 | 409 | 422 | 502) {
  return new Response(JSON.stringify({ detail: message }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

export function createRepositoryRoutes(
  capability: RepositoryCapability,
  store: ProductStore,
): Hono {
  const routes = new Hono();

  routes.get('/repositories', async (context) => context.json(await capability.list()));
  routes.post('/repositories', async (context) => {
    try {
      const input = RegisterRepositoryRequestSchema.parse(await context.req.json());
      const record = await capability.register(input);
      await store.saveRepository(record);
      return context.json(record, 201);
    } catch (error) {
      if (error instanceof RepositoryAlreadyExistsError) return errorResponse(error.message, 409);
      if (error instanceof RepositoryGitError) return errorResponse(`仓库连接失败：${error.message}`, 502);
      return errorResponse(error instanceof Error ? error.message : 'invalid request', 422);
    }
  });

  routes.get('/repositories/:id/branches', async (context) => {
    try {
      return context.json(await capability.listBranches(context.req.param('id'), {
        query: context.req.query('query') ?? '',
        limit: Number(context.req.query('limit') ?? 200),
      }));
    } catch (error) {
      if (error instanceof RepositoryNotFoundError) return errorResponse('repository not found', 404);
      if (error instanceof RepositoryGitError) return errorResponse(`分支读取失败：${error.message}`, 502);
      throw error;
    }
  });

  routes.post('/repositories/:id/snapshots', async (context) => {
    try {
      const body = await context.req.json() as { branch?: unknown };
      const branch = typeof body.branch === 'string' ? body.branch.trim() : '';
      if (!branch) return errorResponse('branch is required', 422);
      const snapshot = await capability.prepareSnapshot(context.req.param('id'), branch);
      await store.saveSnapshot(snapshot);
      return context.json(snapshot, 201);
    } catch (error) {
      if (error instanceof RepositoryNotFoundError || error instanceof ProductNotFoundError) {
        return errorResponse('repository not found', 404);
      }
      if (error instanceof RepositoryGitError) return errorResponse(`快照创建失败：${error.message}`, 422);
      throw error;
    }
  });

  return routes;
}
