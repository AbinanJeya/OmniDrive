import { describe, expect, it } from 'vitest';
import { buildRouteSearch, parseRouteSearch } from './appRoute';

describe('appRoute', () => {
  it('parses browse routes with independent drive scope and category lens', () => {
    expect(
      parseRouteSearch(
        '?view=browse&scope=account&accountId=drive-b&category=pdfs&folder=%2FProjects%2F2026',
      ),
    ).toEqual({
      view: 'browse',
      scope: { kind: 'account', accountId: 'drive-b' },
      category: 'pdfs',
      folderPath: '/Projects/2026',
    });
  });

  it('parses preview routes for all-drive category views', () => {
    expect(
      parseRouteSearch(
        '?view=preview&scope=all&category=pdfs&folder=%2FContracts&nodeId=drive-a%3Afile-7',
      ),
    ).toEqual({
      view: 'preview',
      scope: { kind: 'all' },
      category: 'pdfs',
      folderPath: '/Contracts',
      nodeId: 'drive-a:file-7',
    });
  });

  it('serializes preview routes back into query strings', () => {
    expect(
      buildRouteSearch({
        view: 'preview',
        scope: { kind: 'account', accountId: 'drive-b' },
        category: 'spreadsheets',
        folderPath: '/Projects',
        nodeId: 'drive-a:file-1',
      }),
    ).toBe(
      '?view=preview&scope=account&accountId=drive-b&category=spreadsheets&folder=%2FProjects&nodeId=drive-a%3Afile-1',
    );
  });
});
