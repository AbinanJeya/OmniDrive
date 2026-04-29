import type { BrowseCategory, BrowseScope, FileCategory } from './types';

export type AppRoute =
  | {
      view: 'browse';
      scope: BrowseScope;
      category: BrowseCategory;
      folderPath: string;
    }
  | {
      view: 'preview';
      scope: BrowseScope;
      category: BrowseCategory;
      folderPath: string;
      nodeId: string;
    };

function normalizeFolderPath(folderPath: string | null): string {
  if (!folderPath || folderPath.trim() === '') {
    return '/';
  }

  const withSlashes = folderPath.replaceAll('\\', '/');
  if (withSlashes === '/') {
    return '/';
  }

  return withSlashes.endsWith('/') ? withSlashes.slice(0, -1) : withSlashes;
}

function parseScope(searchParams: URLSearchParams): BrowseScope {
  const scope = searchParams.get('scope');
  if (scope === 'account') {
    const accountId = searchParams.get('accountId');
    if (accountId) {
      return { kind: 'account', accountId };
    }
  }

  return { kind: 'all' };
}

function parseCategory(searchParams: URLSearchParams): BrowseCategory {
  const category = searchParams.get('category') as Exclude<FileCategory, 'folders'> | null;
  return category ?? 'all';
}

export function parseRouteSearch(search: string): AppRoute {
  const searchParams = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
  const view = searchParams.get('view');
  const scope = parseScope(searchParams);
  const category = parseCategory(searchParams);
  const folderPath = normalizeFolderPath(searchParams.get('folder'));

  if (view === 'preview') {
    const nodeId = searchParams.get('nodeId');
    if (nodeId) {
      return { view: 'preview', scope, category, folderPath, nodeId };
    }
  }

  return {
    view: 'browse',
    scope,
    category,
    folderPath,
  };
}

export function buildRouteSearch(route: AppRoute): string {
  const searchParams = new URLSearchParams();
  searchParams.set('view', route.view);

  if (route.scope.kind === 'account') {
    searchParams.set('scope', 'account');
    searchParams.set('accountId', route.scope.accountId);
  } else {
    searchParams.set('scope', 'all');
  }

  if (route.category !== 'all') {
    searchParams.set('category', route.category);
  }

  searchParams.set('folder', normalizeFolderPath(route.folderPath));

  if (route.view === 'preview') {
    searchParams.set('nodeId', route.nodeId);
  }

  return `?${searchParams.toString()}`;
}
