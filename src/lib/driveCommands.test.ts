import { describe, expect, it, vi } from 'vitest';
import {
  createVirtualFolder,
  deleteDriveNode,
  deleteVirtualFolder,
  disconnectGoogleAccount,
  downloadDriveNode,
  renameDriveNode,
  renameVirtualFolder,
  uploadIntoVirtualFolder,
} from './driveBackend';

describe('drive command helpers', () => {
  it('routes folder and account management commands to the expected Tauri handlers', async () => {
    const invoke = vi.fn().mockResolvedValue(undefined);

    await createVirtualFolder('/Projects', 'Invoices', invoke);
    await disconnectGoogleAccount('drive-a', invoke);
    await renameVirtualFolder('/Projects', 'Client Work', invoke);
    await deleteVirtualFolder('/Projects/Archive', invoke);

    expect(invoke).toHaveBeenNthCalledWith(1, 'create_virtual_folder', {
      parentVirtualPath: '/Projects',
      folderName: 'Invoices',
    });
    expect(invoke).toHaveBeenNthCalledWith(2, 'delete_stored_tokens', {
      accountId: 'drive-a',
    });
    expect(invoke).toHaveBeenNthCalledWith(3, 'rename_virtual_folder', {
      virtualPath: '/Projects',
      nextName: 'Client Work',
    });
    expect(invoke).toHaveBeenNthCalledWith(4, 'delete_virtual_folder', {
      virtualPath: '/Projects/Archive',
    });
  });

  it('routes file operations to the expected Tauri handlers', async () => {
    const invoke = vi.fn().mockResolvedValue('C:/Downloads/Roadmap.pdf');

    await uploadIntoVirtualFolder('/Projects', invoke);
    await renameDriveNode('drive-a', 'file-1', 'Roadmap v2.pdf', invoke);
    await deleteDriveNode('drive-a', 'file-1', invoke);
    const savedPath = await downloadDriveNode(
      {
        accountId: 'drive-a',
        googleId: 'file-1',
        filename: 'Roadmap.pdf',
        mimeType: 'application/pdf',
      },
      invoke,
    );

    expect(invoke).toHaveBeenNthCalledWith(1, 'upload_into_virtual_folder', {
      targetVirtualPath: '/Projects',
    });
    expect(invoke).toHaveBeenNthCalledWith(2, 'rename_drive_node', {
      accountId: 'drive-a',
      googleId: 'file-1',
      nextName: 'Roadmap v2.pdf',
    });
    expect(invoke).toHaveBeenNthCalledWith(3, 'delete_drive_node', {
      accountId: 'drive-a',
      googleId: 'file-1',
    });
    expect(invoke).toHaveBeenNthCalledWith(4, 'download_drive_node', {
      accountId: 'drive-a',
      googleId: 'file-1',
      filename: 'Roadmap.pdf',
      mimeType: 'application/pdf',
    });
    expect(savedPath).toBe('C:/Downloads/Roadmap.pdf');
  });
});
