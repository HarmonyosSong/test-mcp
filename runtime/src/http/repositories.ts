import { Hono } from 'hono';
import { ZodError } from 'zod';

import {
  RepositoryAlreadyExistsError,
  RepositoryBranchError,
  RepositoryCapability,
  RepositoryGitError,
  RepositoryNotFoundError,
} from '../capabilities/repository.js';
import { CreateSnapshotRequestSchema, RegisterRepositoryRequestSchema, UpdateRepositoryRequestSchema } from '../domain/schemas.js';
import { ProductNotFoundError, ProductStore } from '../product/store.js';
import { invalidJsonError, queryValidationError, requestValidationError } from './errors.js';
import { redactSensitiveText } from '../security/redaction.js';

function errorResponse(message: string, status: 404 | 409 | 422 | 502) {
  return new Response(JSON.stringify({ detail: redactSensitiveText(message) }), {
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
      let body: unknown;
      try { body = await context.req.json(); } catch { return invalidJsonError(); }
      const parsed = RegisterRepositoryRequestSchema.safeParse(body);
      if (!parsed.success) return requestValidationError(parsed.error.issues);
      const input = parsed.data;
      const record = await capability.register(input);
      await store.saveRepository(record);
      return context.json(record, 201);
    } catch (error) {
      if (error instanceof RepositoryAlreadyExistsError) return errorResponse(error.message, 409);
      if (error instanceof RepositoryGitError) return errorResponse(`仓库连接失败：${error.message}`, 502);
      throw error;
    }
  });

  routes.patch('/repositories/:id', async (context) => {
    try {
      let body: unknown;
      try { body = await context.req.json(); } catch { return invalidJsonError(); }
      const parsed = UpdateRepositoryRequestSchema.safeParse(body);
      if (!parsed.success) return requestValidationError(parsed.error.issues);
      const record = parsed.data.platform === undefined && parsed.data.version_map === undefined
        ? await capability.updateDefaultBranch(
          context.req.param('id'),
          parsed.data.default_branch!,
          (updated) => store.saveRepository(updated),
        )
        : await capability.updateRepositoryConfiguration(
          context.req.param('id'),
          parsed.data,
          (updated) => store.saveRepository(updated),
        );
      return context.json(record);
    } catch (error) {
      if (error instanceof RepositoryNotFoundError || error instanceof ProductNotFoundError) {
        return errorResponse('repository not found', 404);
      }
      if (error instanceof RepositoryBranchError) return errorResponse(`默认分支无效：${error.message}`, 422);
      if (error instanceof RepositoryGitError) return errorResponse(`分支校验失败：${error.message}`, 502);
      throw error;
    }
  });

  routes.get('/repositories/:id/branches', async (context) => {
    const query = context.req.query('query') ?? '';
    const rawLimit = context.req.query('limit') ?? '200';
    const limit = Number(rawLimit);
    const issues: Array<{ type: string; field: string; msg: string }> = [];
    if (query.length > 200) {
      issues.push({ type: 'string_too_long', field: 'query', msg: 'String should have at most 200 characters' });
    }
    if (!/^\d+$/.test(rawLimit) || !Number.isInteger(limit)) {
      issues.push({ type: 'int_parsing', field: 'limit', msg: 'Input should be a valid integer, unable to parse string as an integer' });
    } else if (limit < 1) {
      issues.push({ type: 'greater_than_equal', field: 'limit', msg: 'Input should be greater than or equal to 1' });
    } else if (limit > 500) {
      issues.push({ type: 'less_than_equal', field: 'limit', msg: 'Input should be less than or equal to 500' });
    }
    if (issues.length > 0) return queryValidationError(issues);
    try {
      return context.json(await capability.listBranches(context.req.param('id'), {
        query,
        limit,
      }));
    } catch (error) {
      if (error instanceof RepositoryNotFoundError) return errorResponse('repository not found', 404);
      if (error instanceof RepositoryGitError) return errorResponse(`分支读取失败：${error.message}`, 502);
      throw error;
    }
  });

  routes.post('/repositories/:id/snapshots', async (context) => {
    try {
      let body: unknown;
      try { body = await context.req.json(); } catch { return invalidJsonError(); }
      const parsed = CreateSnapshotRequestSchema.safeParse(body);
      if (!parsed.success) return requestValidationError(parsed.error.issues);
      const payload = parsed.data;
      const snapshot = await capability.prepareSnapshot(context.req.param('id'), payload.branch);
      await store.saveSnapshot(snapshot);
      return context.json(snapshot);
    } catch (error) {
      if (error instanceof RepositoryNotFoundError || error instanceof ProductNotFoundError) {
        return errorResponse('repository not found', 404);
      }
      if (error instanceof RepositoryGitError) return errorResponse(`快照创建失败：${error.message}`, 422);
      if (error instanceof SyntaxError) return invalidJsonError();
      if (error instanceof ZodError) return requestValidationError(error.issues);
      throw error;
    }
  });

  return routes;
}
